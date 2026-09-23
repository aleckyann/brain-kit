import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
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
//                       the manifest (every existing file `seeded`, so
//                       `update` never touches one of them) and the two
//                       files adopt writes into the vault.
//
// The one rule this module is built around: adopt never creates, edits,
// renames or deletes a content file. The only paths it writes inside the
// vault are brain-kit.config.json and .brain-kit/manifest.json (and the
// .brain-kit directory when it is absent), each created exclusively, so
// a file already there is a failure, never an overwrite. It never writes
// the hook and runs no git command of its own (the validate and lint that
// follow only read, with GIT_OPTIONAL_LOCKS=0): an adopted vault's
// repository, history and hooks are exactly what they were.
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
  const collections = new Map();
  const domains = [];
  for (const [dir, entry] of [...folders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.notes > 0 && entry.untyped === 0 && entry.types.size === 1) {
      const [type] = entry.types;
      const collection = { type };
      const known = defaults.taxonomy.collections[dir];
      if (known?.type === type) {
        if (known.template && all.includes(known.template)) collection.template = known.template;
        if (known.filename_pattern) collection.filename_pattern = known.filename_pattern;
      }
      collections.set(dir, collection);
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
  const nonScalar = new Set();
  // A note may well carry `model:` or `paths:`, but the versioned
  // configuration refuses those names anywhere in it (they belong to
  // machine.json), so declaring one would make the whole configuration
  // invalid and adopt fail. Left undeclared, and said so.
  const machineOnly = new Set();
  for (const file of learnFrom) {
    const frontmatter = parsed.get(file);
    for (const key of topLevelKeys(frontmatter)) {
      if (skip.has(key)) continue;
      if (MACHINE_ONLY_KEYS.includes(key)) {
        machineOnly.add(key);
        continue;
      }
      const value = readScalar(frontmatter, key);
      const list = readList(frontmatter, key);
      const mapping = readMapping(frontmatter, key);
      if (value === undefined || Array.isArray(list) || (mapping !== null && mapping !== undefined)) {
        nonScalar.add(key);
        continue;
      }
      if (value === null || value.trim() === '') continue;
      if (!fieldValues.has(key)) fieldValues.set(key, []);
      fieldValues.get(key).push({ value: value.trim(), type: typeOf(file) });
    }
  }
  const extensions = new Map();
  for (const [field, entries] of fieldValues) {
    if (nonScalar.has(field)) continue;
    const kind = classifyValues(entries.map((entry) => entry.value));
    if (kind === 'enum') {
      const byType = new Map();
      for (const { value, type } of entries) {
        if (type === null) continue;
        if (!byType.has(type)) byType.set(type, new Set());
        byType.get(type).add(value);
      }
      const valuesByType = sortedObject(new Map([...byType].map(([type, set]) => [type, [...set].sort()])));
      extensions.set(field, { type: 'enum', values_by_type: valuesByType });
      const values = Object.entries(valuesByType).map(([type, list]) => `${type}: ${list.join(' / ')}`);
      notes.push({ messageKey: 'adopt.note.extension_enum', params: { field, values } });
    } else {
      extensions.set(field, { type: kind });
      notes.push({ messageKey: 'adopt.note.extension_kind', params: { field, kind } });
    }
  }
  for (const field of [...nonScalar].sort()) notes.push({ messageKey: 'adopt.note.extension_skipped', params: { field } });
  for (const field of [...machineOnly].sort()) notes.push({ messageKey: 'adopt.note.extension_reserved', params: { field } });

  // --- the confidentiality marker ------------------------------------------
  //
  // privacy.confidential_field must name a DECLARED BOOLEAN extension
  // (validateConfig says so), and the privacy rule reads it plus the
  // English spelling. The spellings the kit knows are the ones its
  // language defaults configure. Of those the vault uses, the one that is
  // not the English spelling is configured, because the rule reads the
  // English one anyway: both are then watched.
  const spellings = [...new Set(SUPPORTED_LANGS.map((code) => readDefaults(code).privacy.confidential_field))].filter((s) => typeof s === 'string');
  const used = spellings.filter((spelling) => fieldValues.has(spelling));
  const langField = defaults.privacy.confidential_field;
  const field = used.find((spelling) => spelling !== DEFAULT_CONFIDENTIAL_FIELD) ?? used[0] ?? langField;
  for (const spelling of used) {
    if (extensions.get(spelling)?.type !== 'boolean') {
      notes.push({ messageKey: 'adopt.note.confidential_not_boolean', params: { field: spelling } });
    }
    extensions.set(spelling, { type: 'boolean', default: false });
  }
  if (used.length === 0) {
    extensions.set(field, { type: 'boolean', default: false });
    notes.push({ messageKey: 'adopt.note.confidential_field_unused', params: { field } });
  } else if (field !== langField) {
    notes.push({ messageKey: 'adopt.note.confidential_field', params: { field, default: langField } });
  }
  config.frontmatter.extensions = sortedObject(extensions);
  config.privacy.confidential_field = field;

  // Where the marker actually sits. The privacy rule itself is asked
  // which marked notes lie outside the confidential directories, so this
  // reconciliation can never disagree with the lint that follows; each
  // one's own directory joins the list. A marked note at the vault root
  // has no directory to add short of the whole vault, and is named
  // instead. `.brain-kit/` rides along only so the rule never returns
  // early on an empty list: the walk never enters a dot-directory.
  const privacyRule = LINT_RULES.find((rule) => rule.id === 'privacy');
  const dirs = [...defaults.privacy.confidential_dirs];
  const probe = { root, all: new Set(all), readFile, config: { privacy: { confidential_dirs: [...dirs, '.brain-kit/'], confidential_field: field } } };
  const outside = privacyRule.check(markdown, probe).filter((finding) => finding.check === 'confidential-field-outside').map((finding) => finding.file);
  const atRoot = outside.filter((file) => posix.dirname(file) === '.');
  const added = [...new Set(outside.filter((file) => posix.dirname(file) !== '.').map((file) => withSlash(posix.dirname(file))))].sort();
  const covered = [...dirs, ...added].filter((dir, index, list) => !list.some((other, otherIndex) => otherIndex !== index && other !== dir && isUnderPath(dir.slice(0, -1), other)));
  const addedKept = added.filter((dir) => covered.includes(dir));
  config.privacy.confidential_dirs = covered;
  if (addedKept.length > 0) notes.push({ messageKey: 'adopt.note.confidential_dirs', params: { dirs: covered, added: addedKept } });
  if (atRoot.length > 0) notes.push({ messageKey: 'adopt.note.confidential_at_root', params: { files: atRoot } });
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
  if (offsets.size === 0) {
    notes.push({ messageKey: 'adopt.note.stale_defaults', params: {} });
  }
  for (const [dir, list] of [...offsets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [first] = list;
    if (first !== null && list.every((months) => months === first)) {
      config.stale_policy.months[dir] = first;
      notes.push({ messageKey: 'adopt.note.stale_months', params: { dir, months: first, count: list.length } });
    } else {
      notes.push({ messageKey: 'adopt.note.stale_inconsistent', params: { dir } });
    }
  }
  if (plainDates > 0) {
    config.validate.timestamp_deviation = 'allow';
    notes.push({ messageKey: 'adopt.note.plain_dates', params: { count: plainDates } });
  }

  return { config, notes };
}

// Every file of the vault as it is now, each `seeded`: the person's, from
// before the kit arrived, and never `update`'s to replace. Dot-entries are
// listed too (a .gitignore, a CI workflow), `.git` itself never.
export function buildAdoptionManifest(root) {
  const files = walkVault(root, {}, { all: true, dotEntries: true }).filter((path) => path !== CONFIG_FILENAME && path !== MANIFEST_PATH);
  return {
    files: files.map((path) => ({ path, sha256: sha256Of(readFileSync(join(root, ...path.split('/')))), class: 'seeded' })),
  };
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
