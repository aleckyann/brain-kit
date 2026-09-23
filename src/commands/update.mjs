import {
  chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { createTranslator } from '../lang.mjs';
import { splitFrontmatter, readMapping } from '../frontmatter.mjs';
import { MANIFEST_PATH, readManifest, serializeManifest, sha256Of } from '../manifest.mjs';
import {
  HOOK_PATH, TEMPLATE_HOOK, isInside, isoStamp, listSkeleton, skeletonDir, stampGenerated, writeNew,
} from '../init/skeleton.mjs';

// brain-kit update [dir] [--check]
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
//             <name>.brain-kit-new, created exclusively, so one already
//             there, whatever it is, is never overwritten;
//     absent  reported, never recreated;
//     a link, or reached through a linked directory: never written through.
//
// "This kit's version" of a managed file: the hook is the template's
// bytes; a note is the language skeleton's text with generated.at
// re-stamped, the same way init writes it. Which stamp: to decide whether
// anything is new, the file's own generated.at, so a file init wrote and
// this kit has not changed compares equal to what is on disk; to write a
// new version, the moment of this update, since that is when its content
// was generated. An edited file has "nothing newer" when this kit's text,
// at a stamp the recorded bytes could have carried, hashes to the
// manifest's hash: the file's own stamp, or that of any other managed
// file, since init stamps every file with one moment and an agent
// re-stamps generated.at on an edit. When no such stamp is found the new
// version is offered anyway: writing beside a file never destroys it.
//
// A manifest that cannot be read is a refusal, exit 1, nothing written:
// read as "nothing is managed" it would exit zero having checked nothing.
//
// Exit codes: 0 when every managed file is current or kept as edited with
// nothing newer; 3 when something needs a person (a new version written
// beside an edit, one already there, a deleted or linked managed file, a
// file that changed while update ran); 1 when a write failed. With
// --check nothing is written, and it exits 1 when anything other than
// "current" or "kept" would be reported, 0 otherwise.
//
// update calls no git command.
//
// `deps` is not part of the CLI surface: tests may supply `now`, `cwd`,
// and `beforeWrite`, called with the vault-relative path of each file just
// before it is written (the managed file for a refresh, the
// .brain-kit-new for an offer), to prove what happens when something
// changes there between update reading and writing.

export const NEW_SUFFIX = '.brain-kit-new';
const TMP_MARK = '.brain-kit-tmp-';

// Outcomes that need a person, and so make a real run exit 3 and a check
// exit 1; `refresh` and `offer` are the ones that write.
const ATTENTION = Object.freeze(['offer', 'blocked', 'missing', 'not_regular', 'unreadable', 'raced']);
const PENDING = Object.freeze(['refresh', 'offer', 'blocked', 'missing', 'not_regular', 'unreadable']);

function parseArgs(argv) {
  const result = { dir: undefined, check: false, help: false };
  for (const arg of argv) {
    if (arg === '--check') result.check = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('-')) return { error: arg };
    else if (result.dir === undefined) result.dir = arg;
    else return { error: arg };
  }
  return result;
}

function stampOf(bytes) {
  const { frontmatter } = splitFrontmatter(bytes.toString('utf8'));
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

// This kit's version at `stamp`; the skeleton's own bytes when the stamp
// is null or the kit's text cannot take it (null then, never a guess).
function kitVersion(source, stamp) {
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

// Reads only. Returns { kind, ... } for one manifest entry.
function classify(root, realRoot, entry, { skeleton, lang, stamps, nowStamp }) {
  if (entry.class !== 'managed') return { kind: 'seeded' };
  const abs = join(root, entry.path);
  let st;
  let bytes;
  try {
    st = lstatOrNull(abs);
    if (st === null) return { kind: 'missing' };
    if (!st.isFile()) return { kind: 'not_regular' };
    if (!isInside(realpathSync(dirname(abs)), realRoot)) return { kind: 'not_regular' };
    bytes = readFileSync(abs);
  } catch (error) {
    return { kind: 'unreadable', detail: error.code ?? error.message };
  }
  const source = kitSource(entry.path, skeleton, lang);
  if (source === null) return { kind: 'not_in_kit' };
  const own = stampOf(bytes);
  const atOwnStamp = kitVersion(source, own);
  if (atOwnStamp !== null && atOwnStamp.equals(bytes)) return { kind: 'current' };

  const fresh = kitVersion(source, nowStamp);
  if (fresh === null) return { kind: 'unreadable', detail: 'generated.at' };
  if (sha256Of(bytes) === entry.sha256) {
    return { kind: 'refresh', bytes: fresh, mode: st.mode & 0o7777, expected: entry.sha256 };
  }
  // The file's own stamp is among `stamps` (it is a managed note that was
  // just read); null stands for the kit's own bytes, which is the whole
  // answer for the hook, whose version takes no stamp, in a vault where
  // no managed note is left to read a stamp from.
  for (const stamp of new Set([null, ...stamps])) {
    const candidate = kitVersion(source, stamp);
    if (candidate !== null && sha256Of(candidate) === entry.sha256) return { kind: 'kept' };
  }
  const beside = `${entry.path}${NEW_SUFFIX}`;
  if (lstatOrNull(join(root, beside)) !== null) return { kind: 'blocked', beside };
  return { kind: 'offer', bytes: fresh, beside };
}

// Writes `bytes` to a new temporary file beside `abs` and renames it over
// `abs`, but only if `abs` is still a regular file whose bytes hash to
// `expected` at that moment. Returns true when replaced, false when the
// file had changed (the temporary file is removed either way).
function replaceIfUnchanged(abs, bytes, mode, expected, before) {
  const tmp = join(dirname(abs), `.${basename(abs)}${TMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`);
  writeNew([], tmp, bytes, mode);
  try {
    chmodSync(tmp, mode);
    before();
    const st = lstatOrNull(abs);
    if (st === null || !st.isFile() || sha256Of(readFileSync(abs)) !== expected) {
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

function reportLine(t, rel, outcome, check) {
  switch (outcome.kind) {
    case 'refresh': return check ? t('update.would_refresh', { file: rel }) : t('update.refreshed', { file: rel });
    case 'offer': return check ? t('update.would_offer', { file: rel, new: outcome.beside }) : t('update.offered', { file: rel, new: outcome.beside });
    case 'blocked': return t('update.offer_blocked', { file: rel, new: outcome.beside });
    case 'missing': return t('update.missing', { file: rel });
    case 'not_regular': return t('update.not_regular', { file: rel });
    case 'unreadable': return t('update.unreadable', { file: rel, detail: outcome.detail });
    case 'kept': return t('update.kept', { file: rel });
    case 'not_in_kit': return t('update.not_in_kit', { file: rel });
    case 'raced': return t('update.raced', { file: rel });
    default: return null; // current, seeded: counted in the summary only
  }
}

export async function runUpdate(argv, io, t, { now = () => new Date(), cwd = process.cwd(), beforeWrite = () => {} } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${t('update.bad_argument', { arg: parsed.error })}\n`);
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

  // --- reading: every decision is made before anything is written ----------
  const realRoot = realpathSync(root);
  const skeleton = listSkeleton(config.lang);
  const stamps = [];
  for (const entry of manifest.files) {
    if (entry.class !== 'managed' || !entry.path.endsWith('.md')) continue;
    try {
      const st = lstatSync(join(root, entry.path));
      if (st.isFile()) stamps.push(stampOf(readFileSync(join(root, entry.path))));
    } catch {
      // Absent or unreadable: classify reports it.
    }
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
    writeSummary(io, t, outcomes);
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
        if (replaceIfUnchanged(abs, outcome.bytes, outcome.mode, outcome.expected, () => beforeWrite(entry.path))) {
          files[index].sha256 = sha256Of(outcome.bytes);
          refreshed = true;
        } else {
          item.outcome = { kind: 'raced' };
        }
      } else if (outcome.kind === 'offer') {
        beforeWrite(outcome.beside);
        writeNew([], join(root, outcome.beside), outcome.bytes);
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
  // a silent skip, since the refreshed files would then read as edits.
  if (refreshed) {
    try {
      const mode = statSync(manifestFile).mode & 0o7777;
      const text = Buffer.from(serializeManifest({ files }), 'utf8');
      if (!replaceIfUnchanged(manifestFile, text, mode, manifestSha, () => {})) throw new Error(`${MANIFEST_PATH} changed while update was running`);
    } catch (error) {
      io.stderr.write(`${t('update.manifest_write_failed', { detail: error.message })}\n`);
      failed = true;
    }
  }
  writeSummary(io, t, outcomes);
  if (failed) return EXIT.FAILURE;
  if (outcomes.some(({ outcome }) => ATTENTION.includes(outcome.kind))) return EXIT.DEGRADED;
  return EXIT.OK;
}

function writeSummary(io, t, outcomes) {
  const count = (...kinds) => outcomes.filter(({ outcome }) => kinds.includes(outcome.kind)).length;
  const managed = outcomes.filter(({ entry }) => entry.class === 'managed').length;
  io.stdout.write(`${t('update.summary', {
    managed,
    refreshed: count('refresh'),
    current: count('current', 'not_in_kit'),
    kept: count('kept'),
    seeded: count('seeded'),
    attention: count(...ATTENTION, 'failed'),
  })}\n`);
}
