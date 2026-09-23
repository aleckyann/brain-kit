import {
  accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { createTranslator } from '../lang.mjs';
import { kitVersion } from '../version.mjs';
import { splitFrontmatter, readMapping } from '../frontmatter.mjs';
import { MANIFEST_PATH, readManifest, serializeManifest, sha256Of } from '../manifest.mjs';
import {
  HOOK_PATH, TEMPLATE_HOOK, isInside, isoStamp, listSkeleton, skeletonDir, stampGenerated, writeNew,
} from '../init/skeleton.mjs';

// brain-kit update [dir] [--check]
// brain-kit update [dir] --accept <path>
//
// Refreshes the files the kit manages, by checksum, in the vault found
// from `dir` (default: the current directory). For every entry of
// .brain-kit/manifest.json:
//
//   seeded    never read, never written: it is the person's note.
//   managed   its bytes are hashed and compared with the manifest's hash.
//     equal   (untouched) and this kit's version differs: replaced with
//             this kit's version, and its manifest hash updated;
//     differ  (edited) and this kit has a newer version: the file is left
//             as it is, and this kit's version is written beside it as
//             <name>.brain-kit-new, with the file's own mode, created
//             exclusively, so one already there, whatever it is, is never
//             overwritten;
//     absent  reported, never recreated;
//     a link, or reached through a linked directory: never written through.
//
// Line endings: every comparison reads CRLF as LF, and the manifest
// records hashes of that form, so a checkout that converts line endings
// (core.autocrlf) still reads as untouched; whatever update writes into a
// file that uses CRLF uses CRLF too.
//
// "This kit's version" of a managed file: the hook is the template's
// bytes; a note is the language skeleton's text with generated.at
// re-stamped, the same way init writes it. Which stamp: to decide whether
// anything is new, the file's own generated.at, so a file init wrote and
// this kit has not changed compares equal to what is on disk; to write a
// new version, the moment of this update, since that is when its content
// was generated. An edited file has "nothing newer" when this kit's text,
// at a stamp the recorded bytes could have carried, hashes to the
// manifest's hash: that of any managed note on disk, the file's own
// included, since init stamps every file with one moment and an agent
// re-stamps generated.at on an edit. When no such stamp is found the new
// version is offered anyway: writing beside a file never destroys it.
//
// --accept <path> (vault-relative, or absolute) records that the person
// has dealt with this kit's version of a managed file: its baseline
// becomes this kit's version at the file's own stamp, and its
// .brain-kit-new is removed. The person's file is not touched, and from
// then on reads as "kept" (nothing newer) until the kit changes it again,
// when it is offered again. The baseline is the kit's version, not the
// file's own bytes, on purpose: a baseline equal to a merged file that
// still holds lines of the person's would make that file read as
// untouched, and the next run would replace it with the kit's text,
// deleting those lines. When the person took the kit's version wholesale
// the two are the same. For a managed file that no longer exists,
// --accept drops its entry. The hook is accepted only when executable:
// git skips a hook without the execute bit, so accepting one would record
// a vault whose gate never runs.
//
// Refusals, exit 1, nothing written, in every mode: a manifest that cannot
// be read (read as "nothing is managed" it would exit zero having checked
// nothing); a running kit older than the configuration's kit_version (it
// would "refresh" files back to older text); a configuration whose lang
// differs from the language the manifest records (the managed files'
// language is fixed at install); a manifest that is not a regular file
// inside the vault, or whose directory is not writable, checked before the
// first write rather than after every file was replaced.
//
// After a real run with no failed write, the configuration's kit_version
// is set to the running kit's version when it was older: its one value,
// edited in place, the rest of the file byte for byte.
//
// Exit codes: 0 when every managed file is current or kept as edited with
// nothing newer; 3 when something needs a person (a new version written
// beside an edit, one already there, a deleted or linked managed file, a
// file that changed while update ran); 1 when a write failed, which
// outranks 3. With --check nothing is written, and it exits 1 when
// anything other than "current" or "kept" would be reported, a
// kit_version to set included, 0 otherwise.
//
// update calls no git command.
//
// `deps` is not part of the CLI surface: tests may supply `now`, `cwd`,
// `running` (the kit version this engine reports), and `beforeWrite`,
// called with the vault-relative path of each file just before it is
// written (the managed file for a refresh, the .brain-kit-new for an
// offer, the manifest, the configuration), to prove what happens when something changes there between
// update reading and writing.

export const NEW_SUFFIX = '.brain-kit-new';
const TMP_MARK = '.brain-kit-tmp-';

// Outcomes that need a person, and so make a real run exit 3 and a check
// exit 1; `refresh` and `offer` are the ones that write.
const ATTENTION = Object.freeze(['offer', 'blocked', 'missing', 'not_regular', 'unreadable', 'raced']);
const PENDING = Object.freeze(['refresh', 'offer', 'blocked', 'missing', 'not_regular', 'unreadable']);

function parseArgs(argv) {
  const result = { dir: undefined, check: false, help: false, accept: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') result.check = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--accept') {
      const value = argv[++i];
      if (value === undefined || value === '') return { missingValue: arg };
      if (result.accept !== undefined) return { error: arg };
      result.accept = value;
    } else if (arg.startsWith('-')) return { error: arg };
    else if (result.dir === undefined) result.dir = arg;
    else return { error: arg };
  }
  if (result.check && result.accept !== undefined) return { conflict: true };
  return result;
}

// --- line endings ---------------------------------------------------------

function usesCrlf(bytes) {
  return bytes.includes('\r\n');
}

// The bytes with every CRLF read as LF; latin1 keeps every other byte.
function lf(bytes) {
  return usesCrlf(bytes) ? Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : bytes;
}

// LF bytes written in the line endings of the file they go into or beside.
function inEol(bytes, crlf) {
  return crlf ? Buffer.from(lf(bytes).toString('latin1').replace(/\n/g, '\r\n'), 'latin1') : bytes;
}

// --- versions -------------------------------------------------------------

// -1, 0 or 1. A version is compared by its leading x.y.z; with those
// equal, one carrying a pre-release suffix ("-rc.1") is the older.
// Anything without a leading x.y.z compares as unknown (null).
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(-[^+]*)?/.exec(typeof v === 'string' ? v : '');
    return m === null ? null : { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// The configuration's text with kit_version set to `to`, the rest byte for
// byte; null when there is not exactly one kit_version to set, or the
// result does not read back with it.
function withKitVersion(text, to) {
  const re = /("kit_version"\s*:\s*)"[^"\\]*"/g;
  if ([...text.matchAll(re)].length !== 1) return null;
  const out = text.replace(re, (_, head) => `${head}${JSON.stringify(to)}`);
  try {
    return JSON.parse(out).kit_version === to ? out : null;
  } catch {
    return null;
  }
}

// --- the kit's version of a file ------------------------------------------

function stampOf(bytes) {
  const { frontmatter } = splitFrontmatter(lf(bytes).toString('utf8'));
  if (frontmatter === null) return null;
  const at = readMapping(frontmatter, 'generated')?.at;
  return typeof at === 'string' && at !== '' ? at : null;
}

// Where this kit's version of a managed path comes from, or null when
// this kit ships no such file.
function kitSource(rel, skeleton, lang) {
  if (rel === HOOK_PATH) return { bytes: readFileSync(TEMPLATE_HOOK), stampable: false };
  if (!skeleton.includes(rel)) return null;
  return { bytes: readFileSync(join(skeletonDir(lang), rel)), stampable: rel.endsWith('.md') };
}

// This kit's version at `stamp`, in LF; the skeleton's own bytes when the
// stamp is null; null when the kit's text cannot take the stamp, never a
// guess.
function kitVersionAt(source, stamp) {
  if (!source.stampable || stamp === null) return source.bytes;
  try {
    return Buffer.from(stampGenerated(source.bytes.toString('utf8'), stamp), 'utf8');
  } catch {
    return null;
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function insideVault(abs, realRoot) {
  return isInside(realpathSync(dirname(abs)), realRoot);
}

// Reads a managed file for a decision: { st, bytes } for a regular file
// inside the vault, or { kind } naming why it cannot be.
function readManaged(abs, realRoot) {
  try {
    const st = lstatOrNull(abs);
    if (st === null) return { kind: 'missing' };
    if (!st.isFile()) return { kind: 'not_regular' };
    if (!insideVault(abs, realRoot)) return { kind: 'not_regular' };
    return { st, bytes: readFileSync(abs) };
  } catch (error) {
    return { kind: 'unreadable', detail: error.code ?? error.message };
  }
}

// Reads only. Returns { kind, ... } for one manifest entry.
function classify(root, realRoot, entry, { skeleton, lang, stamps, nowStamp }) {
  if (entry.class !== 'managed') return { kind: 'seeded' };
  const abs = join(root, entry.path);
  const read = readManaged(abs, realRoot);
  if (read.kind !== undefined) return read;
  const { st, bytes } = read;
  const source = kitSource(entry.path, skeleton, lang);
  if (source === null) return { kind: 'not_in_kit' };
  const text = lf(bytes);
  const crlf = usesCrlf(bytes);
  const atOwnStamp = kitVersionAt(source, stampOf(text));
  if (atOwnStamp !== null && atOwnStamp.equals(text)) return { kind: 'current' };

  const fresh = kitVersionAt(source, nowStamp);
  if (fresh === null) return { kind: 'unreadable', detail: 'generated.at' };
  const mode = st.mode & 0o7777;
  if (sha256Of(text) === entry.sha256) {
    return { kind: 'refresh', bytes: inEol(fresh, crlf), sha256: sha256Of(fresh), mode, expected: entry.sha256 };
  }
  // null stands for the kit's own bytes, which is the whole answer for the
  // hook, whose version takes no stamp, in a vault where no managed note
  // is left to read a stamp from.
  for (const stamp of new Set([null, ...stamps])) {
    const candidate = kitVersionAt(source, stamp);
    if (candidate !== null && sha256Of(candidate) === entry.sha256) return { kind: 'kept' };
  }
  const beside = `${entry.path}${NEW_SUFFIX}`;
  if (lstatOrNull(join(root, beside)) !== null) return { kind: 'blocked', beside };
  return { kind: 'offer', bytes: inEol(fresh, crlf), mode, beside };
}

// Writes `bytes` to a new temporary file beside `abs` and renames it over
// `abs`, but only if, at that moment, `abs` is still a regular file inside
// the vault whose bytes `unchanged` accepts. Returns true when replaced,
// false when the file had changed (the temporary file is removed either
// way).
function replaceIfUnchanged(abs, bytes, mode, unchanged, realRoot, before) {
  const tmp = join(dirname(abs), `.${basename(abs)}${TMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`);
  writeNew([], tmp, bytes, mode);
  try {
    chmodSync(tmp, mode);
    before();
    const st = lstatOrNull(abs);
    if (st === null || !st.isFile() || !insideVault(abs, realRoot) || !unchanged(readFileSync(abs))) {
      unlinkSync(tmp);
      return false;
    }
    renameSync(tmp, abs);
    return true;
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone: the rename happened, or nothing was created.
    }
    throw error;
  }
}

// null when update may rewrite the manifest, or the refusal line.
function manifestLocationProblem(t, root, realRoot) {
  const file = join(root, MANIFEST_PATH);
  const st = lstatOrNull(file);
  if (st === null || !st.isFile()) return t('update.manifest_not_regular', { file });
  if (!insideVault(file, realRoot)) return t('update.manifest_outside', { file });
  try {
    accessSync(dirname(file), fsConstants.W_OK);
  } catch {
    return t('update.manifest_not_writable', { dir: dirname(file) });
  }
  return null;
}

function acceptCommand(rel) {
  return `brain-kit update --accept ${rel}`;
}

function reportLine(t, rel, outcome, check) {
  switch (outcome.kind) {
    case 'refresh': return check ? t('update.would_refresh', { file: rel }) : t('update.refreshed', { file: rel });
    case 'offer': return check
      ? t('update.would_offer', { file: rel, new: outcome.beside })
      : t('update.offered', { file: rel, new: outcome.beside, command: acceptCommand(rel) });
    case 'blocked': return t('update.offer_blocked', { file: rel, new: outcome.beside, command: acceptCommand(rel) });
    case 'missing': return t('update.missing', { file: rel, command: acceptCommand(rel) });
    case 'not_regular': return t('update.not_regular', { file: rel });
    case 'unreadable': return t('update.unreadable', { file: rel, detail: outcome.detail });
    case 'kept': return t('update.kept', { file: rel });
    case 'not_in_kit': return t('update.not_in_kit', { file: rel });
    case 'raced': return t('update.raced', { file: rel });
    default: return null; // current, seeded: counted in the summary only
  }
}

export async function runUpdate(argv, io, t, {
  now = () => new Date(), cwd = process.cwd(), running = kitVersion(), beforeWrite = () => {},
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.missingValue || parsed.error || parsed.conflict) {
    if (parsed.missingValue) io.stderr.write(`${t('update.missing_value', { flag: parsed.missingValue })}\n`);
    else if (parsed.error) io.stderr.write(`${t('update.bad_argument', { arg: parsed.error })}\n`);
    else io.stderr.write(`${t('update.accept_with_check')}\n`);
    io.stderr.write(`${t('update.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('update.usage')}\n`);
    return EXIT.OK;
  }
  const startDir = resolve(cwd, parsed.dir ?? '.');
  if (!existsSync(startDir)) {
    io.stderr.write(`${t('update.path_not_found', { dir: startDir })}\n`);
    return EXIT.USAGE;
  }
  if (!statSync(startDir).isDirectory()) {
    io.stderr.write(`${t('update.path_not_a_directory', { dir: startDir })}\n`);
    return EXIT.USAGE;
  }
  const root = findVaultRoot(startDir);
  if (root === null) {
    io.stderr.write(`${t('update.no_vault', { dir: startDir, config: CONFIG_FILENAME })}\n`);
    return EXIT.USAGE;
  }
  const config = loadConfig(root); // may throw ConfigError; src/cli.mjs maps it to exit 2
  t = createTranslator(config.lang, { warn: (message) => io.stderr.write(`${message}\n`) });

  const manifestFile = join(root, MANIFEST_PATH);
  let manifest;
  let manifestSha;
  try {
    manifest = readManifest(root);
    manifestSha = sha256Of(readFileSync(manifestFile));
  } catch (error) {
    io.stderr.write(`${t('update.manifest_unreadable', { detail: error.message })}\n`);
    return EXIT.FAILURE;
  }

  // --- refusals: every one before anything is written, in every mode ------
  const versionOrder = compareVersions(running, config.kit_version);
  if (versionOrder === null || versionOrder < 0) {
    io.stderr.write(`${t('update.kit_older', { running, configured: config.kit_version })}\n`);
    return EXIT.FAILURE;
  }
  if (manifest.lang !== undefined && manifest.lang !== config.lang) {
    io.stderr.write(`${t('update.lang_changed', { recorded: manifest.lang, configured: config.lang })}\n`);
    return EXIT.FAILURE;
  }
  const realRoot = realpathSync(root);
  const location = manifestLocationProblem(t, root, realRoot);
  if (location !== null) {
    io.stderr.write(`${location}\n`);
    return EXIT.FAILURE;
  }
  const skeleton = listSkeleton(config.lang);

  if (parsed.accept !== undefined) {
    return accept(io, t, {
      root, realRoot, manifest, manifestFile, manifestSha, skeleton, lang: config.lang, path: parsed.accept, beforeWrite,
    });
  }

  // The configuration's kit_version, when this kit is newer: prepared now,
  // so a configuration update cannot edit is a refusal before any write.
  const configFile = join(root, CONFIG_FILENAME);
  let bump = null;
  if (versionOrder > 0) {
    const st = lstatOrNull(configFile);
    const text = st !== null && st.isFile() ? readFileSync(configFile) : null;
    const edited = text === null ? null : withKitVersion(text.toString('utf8'), running);
    if (edited === null) {
      io.stderr.write(`${t('update.config_not_editable', { file: configFile })}\n`);
      return EXIT.FAILURE;
    }
    bump = { from: config.kit_version, bytes: Buffer.from(edited, 'utf8'), sha: sha256Of(text), mode: st.mode & 0o7777 };
  }

  // --- reading: every decision is made before anything is written ----------
  const stamps = [];
  for (const entry of manifest.files) {
    if (entry.class !== 'managed' || !entry.path.endsWith('.md')) continue;
    const read = readManaged(join(root, entry.path), realRoot);
    if (read.kind === undefined) stamps.push(stampOf(read.bytes));
  }
  const context = { skeleton, lang: config.lang, stamps: stamps.filter((s) => s !== null), nowStamp: isoStamp(now()) };
  const outcomes = manifest.files.map((entry) => ({ entry, outcome: classify(root, realRoot, entry, context) }));

  if (parsed.check) {
    let pending = 0;
    for (const { entry, outcome } of outcomes) {
      const line = reportLine(t, entry.path, outcome, true);
      if (line !== null) io.stdout.write(`${line}\n`);
      if (PENDING.includes(outcome.kind)) pending++;
    }
    if (bump !== null) {
      io.stdout.write(`${t('update.would_bump', { from: bump.from, to: running })}\n`);
      pending++;
    }
    writeSummary(io, t, outcomes, true);
    if (pending > 0) {
      io.stdout.write(`${t('update.check_pending', { count: pending })}\n`);
      return EXIT.FAILURE;
    }
    io.stdout.write(`${t('update.check_clean')}\n`);
    return EXIT.OK;
  }

  // --- writing -------------------------------------------------------------
  let failed = false;
  let refreshed = false;
  const files = manifest.files.map((entry) => ({ ...entry }));
  for (const [index, item] of outcomes.entries()) {
    const { entry, outcome } = item;
    const abs = join(root, entry.path);
    try {
      if (outcome.kind === 'refresh') {
        const unchanged = (bytes) => sha256Of(lf(bytes)) === outcome.expected;
        if (replaceIfUnchanged(abs, outcome.bytes, outcome.mode, unchanged, realRoot, () => beforeWrite(entry.path))) {
          files[index].sha256 = outcome.sha256;
          refreshed = true;
        } else {
          item.outcome = { kind: 'raced' };
        }
      } else if (outcome.kind === 'offer') {
        const beside = join(root, outcome.beside);
        beforeWrite(outcome.beside);
        if (!insideVault(beside, realRoot)) {
          item.outcome = { kind: 'raced' };
        } else {
          writeNew([], beside, outcome.bytes, outcome.mode);
          chmodSync(beside, outcome.mode);
        }
      }
    } catch (error) {
      if (outcome.kind === 'offer' && error.code === 'EEXIST') {
        item.outcome = { kind: 'blocked', beside: outcome.beside };
      } else {
        io.stderr.write(`${t('update.write_failed', { file: entry.path, detail: error.message })}\n`);
        item.outcome = { kind: 'failed' };
        failed = true;
      }
    }
    const line = reportLine(t, entry.path, item.outcome, false);
    if (line !== null) io.stdout.write(`${line}\n`);
  }

  // The manifest is replaced the same way, and only if it is still the one
  // read above; one that changed or vanished meanwhile is a failure, never
  // a silent skip.
  if (refreshed) {
    try {
      const mode = statSync(manifestFile).mode & 0o7777;
      const text = Buffer.from(serializeManifest({ ...manifest, files }), 'utf8');
      const unchanged = (bytes) => sha256Of(bytes) === manifestSha;
      if (!replaceIfUnchanged(manifestFile, text, mode, unchanged, realRoot, () => beforeWrite(MANIFEST_PATH))) {
        throw new Error(`${MANIFEST_PATH} changed while update was running`);
      }
    } catch (error) {
      io.stderr.write(`${t('update.manifest_write_failed', { detail: error.message })}\n`);
      failed = true;
    }
  }
  if (bump !== null && !failed) {
    try {
      const unchanged = (bytes) => sha256Of(bytes) === bump.sha;
      if (!replaceIfUnchanged(configFile, bump.bytes, bump.mode, unchanged, realRoot, () => beforeWrite(CONFIG_FILENAME))) {
        throw new Error(`${CONFIG_FILENAME} changed while update was running`);
      }
      io.stdout.write(`${t('update.bumped', { from: bump.from, to: running })}\n`);
    } catch (error) {
      io.stderr.write(`${t('update.write_failed', { file: CONFIG_FILENAME, detail: error.message })}\n`);
      failed = true;
    }
  }
  writeSummary(io, t, outcomes, false);
  if (failed) return EXIT.FAILURE;
  if (outcomes.some(({ outcome }) => ATTENTION.includes(outcome.kind))) return EXIT.DEGRADED;
  return EXIT.OK;
}

function writeSummary(io, t, outcomes, check) {
  const count = (...kinds) => outcomes.filter(({ outcome }) => kinds.includes(outcome.kind)).length;
  const managed = outcomes.filter(({ entry }) => entry.class === 'managed').length;
  const current = count('current', 'not_in_kit');
  const kept = count('kept');
  const seeded = count('seeded');
  const attention = count(...ATTENTION, 'failed');
  if (check) {
    io.stdout.write(`${t('update.check_summary', { managed, refreshed: count('refresh'), current, kept, seeded, attention })}\n`);
  } else {
    io.stdout.write(`${t('update.summary', { managed, refreshed: count('refresh'), current, kept, seeded, attention })}\n`);
  }
}

// --- --accept ------------------------------------------------------------------

function accept(io, t, { root, realRoot, manifest, manifestFile, manifestSha, skeleton, lang, path, beforeWrite }) {
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const target = abs.endsWith(NEW_SUFFIX) ? abs.slice(0, -NEW_SUFFIX.length) : abs;
  const relNative = relative(root, target);
  if (relNative === '' || relNative === '..' || relNative.startsWith(`..${sep}`) || isAbsolute(relNative)) {
    io.stderr.write(`${t('update.accept_outside', { path })}\n`);
    return EXIT.USAGE;
  }
  const rel = relNative.split(sep).join('/');
  const index = manifest.files.findIndex((entry) => entry.path === rel);
  if (index === -1 || manifest.files[index].class !== 'managed') {
    io.stderr.write(`${t('update.accept_not_managed', { file: rel })}\n`);
    return EXIT.USAGE;
  }

  const read = readManaged(target, realRoot);
  const files = manifest.files.map((entry) => ({ ...entry }));
  let line;
  if (read.kind === 'missing') {
    files.splice(index, 1);
    line = t('update.accept_dropped', { file: rel });
  } else if (read.kind !== undefined) {
    io.stderr.write(`${reportLine(t, rel, read, false)}\n`);
    return EXIT.FAILURE;
  } else {
    if (rel === HOOK_PATH && (read.st.mode & 0o100) === 0) {
      const command = `chmod +x ${rel}`;
      io.stderr.write(`${t('update.accept_not_executable', { file: rel, command })}\n`);
      return EXIT.FAILURE;
    }
    const source = kitSource(rel, skeleton, lang);
    const text = lf(read.bytes);
    const baseline = source === null ? text : kitVersionAt(source, stampOf(text)) ?? source.bytes;
    files[index].sha256 = sha256Of(baseline);
    line = t('update.accept_recorded', { file: rel });
  }
  if (files.length === 0) {
    io.stderr.write(`${t('update.accept_last_entry', { file: rel })}\n`);
    return EXIT.FAILURE;
  }

  const changed = JSON.stringify(files) !== JSON.stringify(manifest.files);
  if (changed) {
    try {
      const mode = statSync(manifestFile).mode & 0o7777;
      const text = Buffer.from(serializeManifest({ ...manifest, files }), 'utf8');
      const unchanged = (bytes) => sha256Of(bytes) === manifestSha;
      if (!replaceIfUnchanged(manifestFile, text, mode, unchanged, realRoot, () => beforeWrite(MANIFEST_PATH))) {
        throw new Error(`${MANIFEST_PATH} changed while update was running`);
      }
    } catch (error) {
      io.stderr.write(`${t('update.manifest_write_failed', { detail: error.message })}\n`);
      return EXIT.FAILURE;
    }
  }

  // The offer, once the manifest no longer asks for it.
  const beside = `${target}${NEW_SUFFIX}`;
  const besideRel = `${rel}${NEW_SUFFIX}`;
  let removed = false;
  const st = read.kind === undefined ? lstatOrNull(beside) : null;
  if (st !== null) {
    if (st.isDirectory()) {
      io.stdout.write(`${t('update.accept_new_left', { new: besideRel })}\n`);
    } else {
      try {
        unlinkSync(beside);
        removed = true;
      } catch (error) {
        io.stderr.write(`${t('update.write_failed', { file: besideRel, detail: error.message })}\n`);
        return EXIT.FAILURE;
      }
    }
  }
  if (!changed && !removed) {
    io.stdout.write(`${t('update.accept_nothing', { file: rel })}\n`);
    return EXIT.OK;
  }
  io.stdout.write(`${line}\n`);
  if (removed) io.stdout.write(`${t('update.accept_removed_new', { new: besideRel })}\n`);
  return EXIT.OK;
}
