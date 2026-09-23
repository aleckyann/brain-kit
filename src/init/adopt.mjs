import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { run } from '../exec.mjs';
import { localGitVarNames, withoutLocalGitVars } from '../git-env.mjs';
import { KIT_ROOT } from '../version.mjs';
import { SUPPORTED_LANGS } from '../lang.mjs';
import { CONFIG_FILENAME, MACHINE_ONLY_KEYS } from '../config.mjs';
import { findVaultRoot, isUnderPath, walkVault } from '../vault.mjs';
import { readList, readMapping, readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { DAYS_IN_MONTH, isLeapYear, isValidCalendarDate, isValidIsoDate } from '../dates.mjs';
import { stripCode } from '../markdown.mjs';
import { DEFAULT_CONFIDENTIAL_FIELD, LINT_RULES, findFirstTableHeader } from '../rules/lint.mjs';
import { isMarkdown, makeReadFile } from '../commands/validate.mjs';
import { MANIFEST_PATH, serializeManifest, sha256Of } from '../manifest.mjs';
import { writeNew } from './skeleton.mjs';

// `brain-kit init --adopt`: an EXISTING vault brought under the kit by
// writing configuration and state only. Three parts live here:
//
//   inspectAdoptTarget  the checks, all reads, that decide whether a
//                       directory is a vault shape adopt can take on;
//   inferConfig         what the vault's own notes say its configuration
//                       is, every inference listed in `notes` so the
//                       person sees it (an inference a person never sees
//                       is a decision made for them);
//   buildAdoptionManifest / writeAdoption
//                       the manifest (every existing file git would
//                       publish, `seeded`, so `update` never touches one
//                       of them) and the two files adopt writes into the
//                       vault.
//
// The one rule this module is built around: adopt never creates, edits,
// renames or deletes a content file. The only paths this module writes
// inside the vault are brain-kit.config.json and .brain-kit/manifest.json
// (and the .brain-kit directory when it is absent), each created
// exclusively, so a file already there is a failure, never an overwrite.
// Its only git commands read (listing what git would publish, with
// GIT_OPTIONAL_LOCKS=0). The push gate is installed afterwards, by the
// command, through installGate (src/init/gate.mjs), which leaves a hook
// the person already has exactly as it is; `--no-hook` skips it, and then
// the repository, history and hooks are exactly what they were.
//
// Every note is a { messageKey, params } pair rendered by the command
// through the vault's own language pack, like a finding.

// Keys the Open Knowledge Format itself defines: never a house extension,
// whatever values a vault gives them. `status` is the format's lifecycle
// field, judged by the specification ruler.
const FORMAT_KEYS = Object.freeze([
  'type', 'title', 'description', 'tags', 'generated', 'status', 'stale_after', 'sources', 'verified', 'okf_version',
]);

// What an enum value looks like: one token of letters, digits, dots,
// underscores and dashes, short. A value with a space, a pipe or an
// angle bracket is prose or a placeholder, and a field holding one is a
// free string, not a closed list.
const ENUM_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,39}$/u;
// More distinct values than this is a free field that happens to use
// short words (names, slugs), not a closed list.
const MAX_ENUM_VALUES = 12;

const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const RESERVED_FILENAMES = Object.freeze(['index.md', 'log.md']);
const BRAIN_KIT_DIR = MANIFEST_PATH.split('/')[0];

function isReserved(file) {
  return RESERVED_FILENAMES.includes(posix.basename(file));
}

export function readDefaults(lang) {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Returns null when `target` is a vault adopt can take on, or
// { key, params } naming the first reason it is not. Reads only.
export function inspectAdoptTarget(target) {
  const dir = resolve(target);
  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch {
    // Absent, or a dangling link: nothing to adopt.
  }
  if (!isDirectory) return { key: 'not_a_directory', params: { dir } };

  const enclosing = findVaultRoot(dir);
  if (enclosing !== null && enclosing !== dir) return { key: 'inside_vault', params: { dir, vault: enclosing } };
  // Adopted already, whole or in part: the configuration or the manifest
  // alone is enough, because adopt would have to overwrite the one there.
  if (present(join(dir, CONFIG_FILENAME)) || present(join(dir, MANIFEST_PATH))) {
    return { key: 'already_vault', params: { dir } };
  }
  // .brain-kit is where the manifest goes, and it is created through: a
  // symbolic link there (to a confidential folder, to somewhere outside
  // the vault) would put the manifest wherever it points, and a file there
  // would fail the write halfway. Absent or a real directory, nothing else.
  let brainKitDir = null;
  try {
    brainKitDir = lstatSync(join(dir, BRAIN_KIT_DIR));
  } catch {
    // Absent: adopt creates it.
  }
  if (brainKitDir !== null && !brainKitDir.isDirectory()) {
    return { key: 'adopt_brain_kit_not_directory', params: { dir, path: join(dir, BRAIN_KIT_DIR) } };
  }
  try {
    readdirSync(dir);
  } catch (error) {
    return { key: 'unreadable', params: { dir, detail: error.code ?? error.message } };
  }
  // The root index is what makes a directory a vault (src/vault.mjs); a
  // directory without one is not a shape adopt can read, and a
  // configuration written beside it would describe nothing.
  let hasIndex = false;
  try {
    hasIndex = statSync(join(dir, 'index.md')).isFile();
  } catch {
    // Absent.
  }
  if (!hasIndex) return { key: 'adopt_no_index', params: { dir } };
  return null;
}

// The top-level keys of a frontmatter block, in order: a key at column 0,
// bare or quoted, followed by a colon.
function topLevelKeys(frontmatter) {
  const keys = [];
  for (const line of (frontmatter ?? '').split('\n')) {
    const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_-]*))[ \t]*:/.exec(line);
    if (match) keys.push(match[1] ?? match[2] ?? match[3]);
  }
  return keys;
}

// The whole number of months from `from` to `to`, both read as their
// leading ISO date, or null when the gap is not a whole number of months
// (the day of `to` must be the day of `from`, or the last day of a
// shorter month) or is not positive.
export function monthOffset(from, to) {
  const a = DATE_PREFIX.exec(String(from));
  const b = DATE_PREFIX.exec(String(to));
  if (!a || !b) return null;
  const [y1, m1, d1] = a.slice(1).map(Number);
  const [y2, m2, d2] = b.slice(1).map(Number);
  if (!isValidCalendarDate(y1, m1, d1) || !isValidCalendarDate(y2, m2, d2)) return null;
  const months = (y2 - y1) * 12 + (m2 - m1);
  const lastDay = m2 === 2 && isLeapYear(y2) ? 29 : DAYS_IN_MONTH[m2 - 1];
  if (d2 !== Math.min(d1, lastDay)) return null;
  return months >= 1 ? months : null;
}

// The kind of an extension field from every value it holds.
function classifyValues(values) {
  if (values.every((v) => v === 'true' || v === 'false')) return 'boolean';
  if (values.every((v) => isValidIsoDate(v))) return 'date';
  if (values.every((v) => NUMBER.test(v))) return 'number';
  const distinct = new Set(values);
  if (distinct.size <= MAX_ENUM_VALUES && values.length > distinct.size && values.every((v) => ENUM_TOKEN.test(v))) return 'enum';
  return 'string';
}

function withSlash(dir) {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// What the vault at `root` says its configuration is, for language
// `lang`. Returns { config, notes }: `config` is the language's defaults
// with every inference applied, the person's own answers (name, handle,
// title, time zone) still placeholders for completeDefaults
// (src/init/config.mjs) to fill; `notes` lists every inference.
export function inferConfig(root, { lang }) {
  const defaults = readDefaults(lang);
  const config = structuredClone(defaults);
  const notes = [];
  const readFile = makeReadFile(root);
  const all = walkVault(root, {}, { all: true });
  const markdown = all.filter(isMarkdown);
  const templatesDir = defaults.taxonomy.templates_dir;
  const attachmentsDir = defaults.taxonomy.attachments_dir;
  // The notes adopt learns from: not an index or a log (structure), and
  // not a template, whose values are placeholders by design.
  const learnFrom = markdown.filter((file) => !isReserved(file) && !isUnderPath(file, templatesDir));
  const parsed = new Map(learnFrom.map((file) => [file, splitFrontmatter(readFile(file)).frontmatter]));
  const typeOf = (file) => {
    const value = readScalar(parsed.get(file), 'type');
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };

  // --- collections and domains, from the first-level folders ---------------
  const folders = new Map();
  for (const file of markdown) {
    const parts = file.split('/');
    if (parts.length < 2) continue;
    const dir = parts[0];
    if (dir === templatesDir || dir === attachmentsDir) continue;
    if (!folders.has(dir)) folders.set(dir, { types: new Set(), notes: 0, untyped: 0 });
    if (!parsed.has(file)) continue;
    const entry = folders.get(dir);
    entry.notes++;
    const type = typeOf(file);
    if (type === null) entry.untyped++;
    else entry.types.add(type);
  }
  // A name the versioned configuration reserves for machine.json (see
  // MACHINE_ONLY_KEYS) is refused at ANY key position of it, so a folder
  // or a note type carrying one ("paths/", "type: model") cannot become a
  // key here: that one collection or that one type's list is left out,
  // said so, and the rest of the vault is adopted. A frontmatter key with
  // such a name is left undeclared the same way, further down.
  const reserved = (name) => MACHINE_ONLY_KEYS.includes(name);
  const collections = new Map();
  const domains = [];
  for (const [dir, entry] of [...folders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.notes > 0 && entry.untyped === 0 && entry.types.size === 1) {
      const [type] = entry.types;
      if (reserved(dir)) {
        notes.push({ messageKey: 'adopt.note.collection_reserved', params: { dir, type } });
        continue;
      }
      collections.set(dir, { type });
      notes.push({ messageKey: 'adopt.note.collection', params: { dir, type, count: entry.notes } });
    } else {
      domains.push(dir);
    }
  }
  config.taxonomy.collections = Object.fromEntries(collections);
  config.taxonomy.domains = domains;
  if (domains.length > 0) notes.push({ messageKey: 'adopt.note.domains', params: { dirs: domains } });

  // --- extensions, from the keys the notes carry beyond the format's -------
  const skip = new Set([...FORMAT_KEYS, ...defaults.frontmatter.required, ...defaults.frontmatter.forbidden]);
  const fieldValues = new Map();
  // A list or a mapping in some note: the field is not a scalar, and is
  // left undeclared. A value the reader could not read at all (a shape
  // it declines, PARSER_LIMITS): the field is declared from the notes it
  // could read, and validate points at the one it could not. Each names
  // the first file it was seen in.
  const collection = new Map();
  const unreadable = new Map();
  const machineOnly = new Set();
  for (const file of learnFrom) {
    const frontmatter = parsed.get(file);
    for (const key of topLevelKeys(frontmatter)) {
      if (skip.has(key)) continue;
      if (reserved(key)) {
        machineOnly.add(key);
        continue;
      }
      const value = readScalar(frontmatter, key);
      if (typeof value === 'string' && value.trim() === '') continue; // blank: nothing to learn from
      const list = readList(frontmatter, key);
      const mapping = readMapping(frontmatter, key);
      if (Array.isArray(list) || (mapping !== null && mapping !== undefined && typeof mapping === 'object')) {
        if (!collection.has(key)) collection.set(key, file);
        continue;
      }
      if (value === undefined) {
        if (!unreadable.has(key)) unreadable.set(key, file);
        continue;
      }
      if (value === null) continue;
      if (!fieldValues.has(key)) fieldValues.set(key, []);
      fieldValues.get(key).push({ value: value.trim(), type: typeOf(file) });
    }
  }

  // The confidentiality marker is settled before any extension is
  // described, so a spelling it re-declares is described once, as what it
  // ends up being. The spellings the kit knows are the ones its language
  // defaults configure; a spelling counts as used wherever the lint that
  // follows would see it, templates, indexes and logs included, so
  // "nothing is marked" is never said about a vault something is marked
  // in.
  const spellings = [...new Set(SUPPORTED_LANGS.map((code) => readDefaults(code).privacy.confidential_field))].filter((s) => typeof s === 'string');
  const everyFrontmatter = markdown.map((file) => splitFrontmatter(readFile(file)).frontmatter);
  const used = spellings.filter((spelling) => everyFrontmatter.some((frontmatter) => readScalar(frontmatter, spelling) !== null));
  const langField = defaults.privacy.confidential_field;
  // Of the spellings used, the one that is not the English spelling is
  // configured: the privacy rule reads the English one anyway, so both
  // are then watched.
  const field = used.find((spelling) => spelling !== DEFAULT_CONFIDENTIAL_FIELD) ?? used[0] ?? langField;
  const marker = new Set(used.length > 0 ? used : [field]);

  const extensions = new Map();
  const extensionNotes = [];
  for (const [name, entries] of fieldValues) {
    if (collection.has(name) || marker.has(name)) continue;
    const kind = classifyValues(entries.map((entry) => entry.value));
    if (kind === 'enum') {
      const byType = new Map();
      for (const { value, type } of entries) {
        if (type === null) continue;
        if (reserved(type)) {
          if (!byType.has(type)) extensionNotes.push({ messageKey: 'adopt.note.enum_type_reserved', params: { field: name, type } });
          byType.set(type, null);
          continue;
        }
        if (!byType.has(type)) byType.set(type, new Set());
        byType.get(type).add(value);
      }
      const kept = [...byType].filter(([, set]) => set !== null);
      if (kept.length === 0) {
        extensions.set(name, { type: 'string' });
        extensionNotes.push({ messageKey: 'adopt.note.extension_kind', params: { field: name, kind: 'string' } });
        continue;
      }
      const valuesByType = sortedObject(new Map(kept.map(([type, set]) => [type, [...set].sort()])));
      extensions.set(name, { type: 'enum', values_by_type: valuesByType });
      const values = Object.entries(valuesByType).map(([type, list]) => `${type}: ${list.join(' / ')}`);
      extensionNotes.push({ messageKey: 'adopt.note.extension_enum', params: { field: name, values } });
    } else {
      extensions.set(name, { type: kind });
      extensionNotes.push({ messageKey: 'adopt.note.extension_kind', params: { field: name, kind } });
    }
  }
  notes.push(...extensionNotes);
  for (const [name, file] of [...unreadable].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (marker.has(name) || collection.has(name)) continue;
    notes.push({ messageKey: 'adopt.note.extension_unreadable', params: { field: name, file } });
  }
  for (const [name, file] of [...collection].sort(([a], [b]) => (a < b ? -1 : 1))) {
    notes.push({ messageKey: 'adopt.note.extension_skipped', params: { field: name, file } });
  }
  for (const name of [...machineOnly].sort()) notes.push({ messageKey: 'adopt.note.extension_reserved', params: { field: name } });

  // --- the confidentiality marker ------------------------------------------
  //
  // privacy.confidential_field must name a DECLARED BOOLEAN extension
  // (validateConfig says so). Every spelling in use is declared boolean,
  // whatever values it holds: the privacy rule reads only "true", so a
  // "yes" is a marker the rule cannot see, and validate says so per note.
  for (const spelling of marker) {
    const values = fieldValues.get(spelling)?.map((entry) => entry.value) ?? [];
    if (used.includes(spelling) && (values.some((v) => v !== 'true' && v !== 'false') || unreadable.has(spelling) || collection.has(spelling))) {
      notes.push({ messageKey: 'adopt.note.confidential_not_boolean', params: { field: spelling } });
    } else if (used.includes(spelling)) {
      notes.push({ messageKey: 'adopt.note.extension_kind', params: { field: spelling, kind: 'boolean' } });
    }
    extensions.set(spelling, { type: 'boolean', default: false });
  }
  if (used.length === 0) {
    notes.push({ messageKey: 'adopt.note.confidential_field_unused', params: { field } });
  } else if (field !== langField) {
    notes.push({ messageKey: 'adopt.note.confidential_field', params: { field, default: langField } });
  }
  config.frontmatter.extensions = sortedObject(extensions);
  config.privacy.confidential_field = field;

  // Where the marker actually sits. The privacy rule itself is asked, over
  // the same files the lint that follows reads, which marked notes lie
  // outside the confidential directories, so this reconciliation can never
  // disagree with that lint; each one's own directory joins the list. Three
  // places never become a confidential directory, and their marked files
  // are named instead: the vault root (short of declaring the whole vault),
  // the templates directory (a template carries a marker as the default for
  // the notes made from it, not as a statement about itself), and an index
  // or a log (a marker there would declare a whole folder confidential
  // because of its table of contents). `.brain-kit/` rides along only so
  // the rule never returns early on an empty list: the walk never enters a
  // dot-directory.
  const privacyRule = LINT_RULES.find((rule) => rule.id === 'privacy');
  const dirs = [...defaults.privacy.confidential_dirs];
  const probe = { root, all: new Set(all), readFile, config: { privacy: { confidential_dirs: [...dirs, '.brain-kit/'], confidential_field: field } } };
  const outside = privacyRule.check(markdown, probe).filter((finding) => finding.check === 'confidential-field-outside').map((finding) => finding.file);
  const notCovered = (file) => posix.dirname(file) === '.' || isUnderPath(file, templatesDir) || isReserved(file);
  const uncovered = outside.filter(notCovered);
  const added = [...new Set(outside.filter((file) => !notCovered(file)).map((file) => withSlash(posix.dirname(file))))].sort();
  const covered = [...dirs, ...added].filter((dir, index, list) => !list.some((other, otherIndex) => otherIndex !== index && other !== dir && isUnderPath(dir.slice(0, -1), other)));
  const addedKept = added.filter((dir) => covered.includes(dir));
  config.privacy.confidential_dirs = covered;
  if (addedKept.length > 0) notes.push({ messageKey: 'adopt.note.confidential_dirs', params: { dirs: covered, added: addedKept } });
  else notes.push({ messageKey: 'adopt.note.confidential_dirs_default', params: { dirs: covered } });
  if (uncovered.length > 0) notes.push({ messageKey: 'adopt.note.confidential_uncovered', params: { files: uncovered } });
  // The price of those directories, said before the first lint says it:
  // a link from outside them into one of their notes is a leak by the
  // privacy rule's own definition, and each one is reported.
  const settled = { ...probe, config: { privacy: { confidential_dirs: covered, confidential_field: field } } };
  const links = privacyRule.check(markdown, settled).filter((finding) => finding.check === 'link-into-confidential').length;
  if (links > 0) notes.push({ messageKey: 'adopt.note.confidential_links', params: { count: links } });

  // --- tables with configured headings, and the files they live in --------
  const files = config.taxonomy.files;
  for (const key of Object.keys(defaults.taxonomy.columns)) {
    const path = files[key];
    if (typeof path !== 'string' || !markdown.includes(path)) continue;
    const table = findFirstTableHeader(stripCode(splitFrontmatter(readFile(path)).body));
    if (table === null) {
      notes.push({ messageKey: 'adopt.note.columns_no_table', params: { file: path } });
      continue;
    }
    config.taxonomy.columns[key].columns = table.headers;
    notes.push({ messageKey: 'adopt.note.columns', params: { file: path, columns: table.headers } });
  }
  for (const [key, path] of Object.entries(files)) {
    if (typeof path !== 'string' || all.includes(path)) continue;
    files[key] = null;
    notes.push({ messageKey: 'adopt.note.file_absent', params: { key, file: path } });
  }

  // --- the log -------------------------------------------------------------
  const defaultLog = defaults.taxonomy.log;
  if (!markdown.includes(defaultLog)) {
    const logs = markdown.filter((file) => posix.basename(file) === 'log.md' && file !== 'log.md');
    if (logs.length === 1) {
      config.taxonomy.log = logs[0];
      notes.push({ messageKey: 'adopt.note.log', params: { file: logs[0] } });
    } else if (logs.length === 0) {
      notes.push({ messageKey: 'adopt.note.log_absent', params: { file: defaultLog } });
    } else {
      notes.push({ messageKey: 'adopt.note.log_ambiguous', params: { file: defaultLog, files: logs } });
    }
  }

  // --- the stale policy, and plain dates -----------------------------------
  const offsets = new Map();
  let plainDates = 0;
  for (const file of learnFrom) {
    const frontmatter = parsed.get(file);
    const staleAfter = readScalar(frontmatter, 'stale_after');
    const generated = readMapping(frontmatter, 'generated');
    const at = generated && typeof generated.at === 'string' ? generated.at : null;
    if ((typeof staleAfter === 'string' && isValidIsoDate(staleAfter)) || (at !== null && isValidIsoDate(at))) plainDates++;
    if (typeof staleAfter !== 'string' || at === null) continue;
    const parts = file.split('/');
    if (parts.length < 2) continue;
    const dir = withSlash(parts[0]);
    if (!offsets.has(dir)) offsets.set(dir, []);
    offsets.get(dir).push(monthOffset(at, staleAfter));
  }
  // The policy starts from the folders this vault has: a language default
  // for a folder it does not have is left out, one for a folder it has is
  // kept and said so, and a folder whose notes agree on a whole-month
  // offset sets its own.
  const present = new Set(all.filter((path) => path.includes('/')).map((path) => withSlash(path.split('/')[0])));
  const months = {};
  for (const [dir, value] of Object.entries(defaults.stale_policy.months)) {
    if (present.has(withSlash(dir))) months[dir] = value;
  }
  for (const [dir, list] of [...offsets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [first] = list;
    if (first !== null && list.every((value) => value === first)) {
      months[dir] = first;
      notes.push({ messageKey: 'adopt.note.stale_months', params: { dir, months: first, count: list.length } });
    } else if (Object.hasOwn(months, dir)) {
      notes.push({ messageKey: 'adopt.note.stale_inconsistent_default', params: { dir, months: months[dir] } });
    } else {
      notes.push({ messageKey: 'adopt.note.stale_inconsistent', params: { dir } });
    }
  }
  for (const [dir, value] of Object.entries(months)) {
    if (!offsets.has(dir)) notes.push({ messageKey: 'adopt.note.stale_default_kept', params: { dir, months: value } });
  }
  config.stale_policy.months = months;
  if (Object.keys(months).length === 0) notes.push({ messageKey: 'adopt.note.stale_none', params: {} });
  if (plainDates > 0) {
    config.validate.timestamp_deviation = 'allow';
    notes.push({ messageKey: 'adopt.note.plain_dates', params: { count: plainDates } });
  }

  return { config, notes };
}

// Every file of the vault that git would publish, each `seeded`: the
// person's, from before the kit arrived, and never `update`'s to replace.
// `lang` is the language adopt inferred the configuration in, recorded at
// the manifest's top level as init records the language it installed.
//
// WHAT IS LISTED. Adopt tells the person to commit this manifest, so it
// must never name a file they kept out of git: a path and a hash in it
// are published with it, and an unsalted sha256 of a short secret (a
// `.env` holding one password) is recovered by a dictionary. Inside a
// repository the list is what git tracks plus what it would add, `git
// ls-files --cached --others --exclude-standard` run from the vault root
// (paths relative to it, and only below it), the same set the linter's
// `secrets` rule reads (src/git.mjs, publishablePaths); an ignored file is
// never read and never named. Of those, only a regular file, or a link to
// a regular file inside the vault, is recorded, as the walk records them:
// a tracked file deleted from the working tree, a submodule, a link out of
// the vault are not files of this vault. Outside a repository nothing is
// ignored, and the vault is walked: every file, dot-entries included,
// `.git` never.
//
// A vault that looks like a repository (a `.git` in it or above it) whose
// git cannot answer is a refusal, never a walk: the walk would read every
// file the person ignored.
export function buildAdoptionManifest(root, { lang, env = process.env }) {
  const files = adoptionPaths(root, env).filter((path) => path !== CONFIG_FILENAME && path !== MANIFEST_PATH);
  return {
    lang,
    files: files.map((path) => ({ path, sha256: sha256Of(readFileSync(join(root, ...path.split('/')))), class: 'seeded' })),
  };
}

function insideGitWorkTree(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (present(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}

function adoptionPaths(root, env) {
  const gitEnv = { ...withoutLocalGitVars(env, localGitVarNames(env)), GIT_OPTIONAL_LOCKS: '0' };
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, env: gitEnv });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    if (insideGitWorkTree(root)) throw new Error(`git could not read the repository this vault is in (${inside.stderr.trim() || `exit ${inside.status}`})`);
    return walkVault(root, {}, { all: true, dotEntries: true });
  }
  const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, env: gitEnv, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${String(listed.stderr).trim()}`);
  const rootReal = realpathSync(root);
  const paths = new Set();
  for (const bytes of splitNul(listed.stdout)) {
    const path = bytes.toString('utf8');
    if (!Buffer.from(path, 'utf8').equals(bytes)) throw new Error(`git lists a file name that is not UTF-8 (${JSON.stringify(path)})`);
    const abs = join(root, ...path.split('/'));
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (st === undefined) continue; // tracked, but deleted from the working tree
    if (st.isSymbolicLink()) {
      let real;
      try {
        real = realpathSync(abs);
      } catch {
        continue; // dangling
      }
      if (!real.startsWith(`${rootReal}${sep}`)) continue; // a link out of the vault
      if (!statSync(real).isFile()) continue;
    } else if (!st.isFile()) {
      continue; // a submodule's directory, or anything that is not a file
    }
    paths.add(path);
  }
  return [...paths].sort();
}

function splitNul(buffer) {
  const out = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      if (i > start) out.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buffer.length) out.push(buffer.subarray(start));
  return out;
}

// The two files adopt writes into the vault, each created exclusively and
// recorded in `ledger` for the rollback. Both texts are prepared before
// the first byte is written, so a manifest this module would refuse to
// read fails here, with nothing written.
export function writeAdoption(target, { ledger, configText, manifest }) {
  const manifestText = serializeManifest(manifest);
  writeNew(ledger, join(target, CONFIG_FILENAME), configText);
  writeNew(ledger, join(target, MANIFEST_PATH), manifestText);
}
