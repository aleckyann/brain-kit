import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { KIT_ROOT } from '../version.mjs';
import { CONFIG_FILENAME } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { splitFrontmatter, readMapping } from '../frontmatter.mjs';
import { MANIFEST_PATH, serializeManifest, sha256Of } from '../manifest.mjs';

// Everything `init` does to the filesystem inside the target directory:
// the checks that must all pass before a single byte is written
// (inspectTarget), and the writes themselves (writeVault).
//
// The split is the safety property. A refusal found halfway through the
// writes would leave half a vault in a person's directory, so every
// precondition is decided by inspectTarget first, which only reads, and
// writeVault is called only once all of them have passed. writeVault
// also creates every file exclusively ('wx'), so even a directory filled
// in the window between the check and the write (a person typing answers
// while something else writes there) makes it fail on the first existing
// file rather than replace it; and it records everything it creates in a
// ledger, so a failure after the first write is undone exactly.

export const HOOK_PATH = '.githooks/pre-push';
export const TEMPLATE_HOOK = join(KIT_ROOT, 'templates', 'githooks', 'pre-push');
export const GITIGNORE_PATH = '.gitignore';

// The root contract files: what an agent reads before anything else, the
// kit's to keep current, so `managed` in the manifest. Every other file
// of the skeleton is a note the person owns from the moment of init.
export const ROOT_CONTRACT_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'CONVENTIONS.md', 'SECURITY.md']);

// The pull request body template `propose` renders (git.pr_body's
// default): the kit's text, so `managed` as well, and refreshed by
// `update` like the contract files.
export const PR_BODY_PATH = '.brain-kit/pr-body.md';

// The documental Claude Code settings: no permission, no hook, no path,
// only the marketplace and plugin entries that let a clone of the vault
// offer to install the plugin. The kit's text, so `managed` like the
// other root files; `init --adopt` never writes it (see src/init/adopt.mjs
// and buildAdoptionManifest, which record only what a vault already has).
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';

// Every skeleton file the kit keeps current: `managed` in the manifest.
export const MANAGED_SKELETON_FILES = Object.freeze([...ROOT_CONTRACT_FILES, PR_BODY_PATH, CLAUDE_SETTINGS_PATH]);

export function skeletonDir(lang) {
  return join(KIT_ROOT, 'lang', lang, 'vault');
}

export function listSkeleton(lang) {
  const root = skeletonDir(lang);
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk('');
  return out.sort();
}

// True when something is at `path`, a symbolic link included, even one
// pointing nowhere (existsSync follows links and says false for those).
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// The nearest ancestor of `dir` (itself included) that is present, so a
// target that does not exist yet can still be checked for sitting inside
// a vault, or under a path component that is a file or a dangling link.
export function nearestExisting(dir) {
  let current = dir;
  while (!present(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

// Returns null when `target` may become a vault, or { key, params } naming
// the first reason it may not. Reads only. The order matters for the
// message a person sees, not for safety: every check refuses on its own.
export function inspectTarget(target) {
  const dir = resolve(target);
  const existing = nearestExisting(dir);
  let isDirectory = false;
  try {
    isDirectory = statSync(existing).isDirectory();
  } catch {
    // A dangling symbolic link: not a directory init can write into.
  }
  if (!isDirectory) return { key: 'not_a_directory', params: { dir: existing } };

  // A vault inside another vault is walked by the outer one's validate
  // and lint as ordinary notes, and its configuration fights the outer
  // one's; and a directory that already holds a vault's configuration or
  // manifest is a vault, whether or not the rest is there yet. (A vault
  // root findVaultRoot would return has the configuration by definition,
  // so the configuration check covers it.)
  const enclosing = findVaultRoot(existing);
  if (enclosing !== null && enclosing !== dir) return { key: 'inside_vault', params: { dir, vault: enclosing } };
  if (existsSync(join(dir, CONFIG_FILENAME)) || existsSync(join(dir, MANIFEST_PATH))) {
    return { key: 'already_vault', params: { dir } };
  }
  if (existing !== dir) return null; // does not exist yet: nothing in it to overwrite

  if (existsSync(join(dir, '.git'))) return { key: 'already_repository', params: { dir } };
  // A directory init cannot list is a directory whose contents it cannot
  // promise not to overwrite.
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    return { key: 'unreadable', params: { dir, detail: error.code ?? error.message } };
  }
  if (entries.length > 0) return { key: 'not_empty', params: { dir, count: entries.length } };
  return null;
}

// The hook: the template's bytes (`bytes`, read by the caller before its
// first write when it prepares everything first), created exclusively
// with the ordinary file mode and then made executable here, so whether
// the hook runs never depends on the mode the template happened to have
// in a checkout or a package (git skips a hook without the execute bit,
// with only a hint). Recorded in `ledger` like every other file. Returns
// the hook's manifest entry, `managed`. The one writer of the hook: init
// calls it through writeVault, and installGate (src/init/gate.mjs) for a
// vault that already exists.
export function writeGateHook(ledger, root, bytes = readFileSync(TEMPLATE_HOOK)) {
  const hook = join(root, HOOK_PATH);
  writeNew(ledger, hook, bytes);
  chmodSync(hook, 0o755);
  return { path: HOOK_PATH, sha256: sha256Of(readFileSync(hook)), class: 'managed' };
}

// The .gitignore init writes, in the vault's language (`t`): the kit's
// file, `managed` in the manifest, so update compares a vault's copy with
// this text.
export function gitignoreText(t) {
  return [
    `# ${t('init.gitignore_header')}`,
    '',
    `# ${t('init.gitignore_dependencies')}`,
    'node_modules/',
    '',
    `# ${t('init.gitignore_environment')}`,
    '.env',
    '.env.*',
    '!.env.example',
    '',
    `# ${t('init.gitignore_system')}`,
    '.DS_Store',
    'Thumbs.db',
    '*.swp',
    '*~',
    '',
    `# ${t('init.gitignore_update')}`,
    '*.brain-kit-new',
    '.*.brain-kit-tmp-*',
    '',
  ].join('\n');
}

// The ISO form every seeded note already uses, in UTC, to the second.
export function isoStamp(date) {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

// Replaces the value of `generated.at` inside a note's frontmatter, the
// block form the skeleton uses (`generated:` then an indented `at:`), and
// nothing outside the frontmatter. Returns the new text, or the text
// unchanged when the note has no `generated` mapping at all. A note that
// HAS one but whose `at` did not come out as the stamp throws: that is a
// skeleton written in a form this function does not handle, and a note
// silently left with the seed's date is the failure this exists to stop.
export function stampGenerated(text, stamp) {
  const { frontmatter } = splitFrontmatter(text);
  if (frontmatter === null || readMapping(frontmatter, 'generated') === null) return text;
  const open = text.indexOf('\n') + 1;
  const end = open + frontmatter.length;
  const replaced = frontmatter.replace(/^(generated:[ \t]*\n(?:[ \t]+[^\n]*\n)*?[ \t]+at:[ \t]*)[^\n]*$/m, (_, head) => `${head}${stamp}`);
  const result = `${text.slice(0, open)}${replaced}${text.slice(end)}`;
  const check = readMapping(splitFrontmatter(result).frontmatter, 'generated');
  if (check?.at !== stamp) throw new Error(`cannot stamp generated.at in a note whose frontmatter is in an unexpected form`);
  return result;
}

// --- the ledger: what this run created, so a failure can undo it exactly ---
//
// Every directory and file init creates is recorded the moment it exists,
// in order, and a failure removes the ledger in reverse. Removal never
// reaches past what init itself made:
//   - a file is recorded AFTER its exclusive open succeeds, so one that
//     already existed (EEXIST, another process in the gap) is never
//     recorded and never removed, and BEFORE a byte is written, so a
//     write that fails halfway (a full disk) is still removed;
//   - a directory is removed with a plain rmdir, never recursively: the
//     files init wrote into it are in the ledger and go first, so an
//     rmdir that fails (ENOTEMPTY) means someone else wrote there, and
//     that directory is reported as left behind rather than deleted;
//   - `.git` is the one tree removed recursively, because git fills it,
//     and it is recorded only after init itself created it, empty, with a
//     non-recursive mkdir: a repository another process made in the gap
//     makes that mkdir fail and is never claimed (git init accepts an
//     empty .git it did not create);
//   - a directory that already existed and whose mode init changed (the
//     state directory, tightened to 0700) gets its old mode back.

// Creates `dir` and any missing parents, recording every directory it
// created, outermost first, so the reverse order removes innermost first.
export function makeDirs(ledger, dir) {
  const first = mkdirSync(dir, { recursive: true });
  if (first === undefined) return;
  const chain = [];
  for (let current = dir; ; current = dirname(current)) {
    chain.unshift(current);
    if (current === first || dirname(current) === current) break;
  }
  for (const path of chain) ledger.push({ path, kind: 'dir' });
}

// Creates `dir` itself, which must not exist, recording it as a tree the
// ledger may remove recursively. Used for .git only.
export function makeOwnTree(ledger, dir) {
  mkdirSync(dir);
  ledger.push({ path: dir, kind: 'tree' });
}

// Records that `dir` existed with `mode` before init changed it.
export function recordMode(ledger, dir, mode) {
  ledger.push({ path: dir, kind: 'mode', mode });
}

// Creates `path` exclusively, records it, then writes all of `bytes`
// into it. writeSync may write fewer bytes than asked and return without
// an error (a file-size limit, a disk filling up), so it is called until
// every byte is down; the call after a short write is the one that
// throws, and a truncated file is never left looking finished.
export function writeNew(ledger, path, bytes, mode = 0o666) {
  makeDirs(ledger, dirname(path));
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const fd = openSync(path, 'wx', mode);
  ledger.push({ path, kind: 'file' });
  try {
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
  } finally {
    closeSync(fd);
  }
}

// Undoes the ledger in reverse. Returns the paths it could not undo,
// empty when the undo was exact. A path already gone is not a failure.
export function rollback(ledger) {
  const left = [];
  for (const entry of [...ledger].reverse()) {
    try {
      if (entry.kind === 'file') unlinkSync(entry.path);
      else if (entry.kind === 'dir') rmdirSync(entry.path);
      else if (entry.kind === 'tree') rmSync(entry.path, { recursive: true, force: false });
      else chmodSync(entry.path, entry.mode);
    } catch (error) {
      if (error.code !== 'ENOENT') left.push(entry.path);
    }
  }
  return left;
}

// Writes the vault into `target`, which inspectTarget has already
// accepted, recording everything it creates in `ledger`. `files` maps
// each vault-relative path init writes beyond the skeleton (the
// configuration and .gitignore) to its text; .gitignore is recorded
// `managed`, the configuration not at all. Every byte is prepared in
// memory first, stamping included, so a skeleton this function cannot
// stamp throws before anything reaches the disk. Returns the manifest.
export function writeVault(target, { lang, stamp, files, ledger = [] }) {
  const skeleton = listSkeleton(lang);
  for (const rel of MANAGED_SKELETON_FILES) {
    if (!skeleton.includes(rel)) throw new Error(`the ${lang} skeleton has no ${rel}`);
  }
  const prepared = skeleton.map((rel) => {
    const raw = readFileSync(join(skeletonDir(lang), rel));
    const bytes = rel.endsWith('.md') ? Buffer.from(stampGenerated(raw.toString('utf8'), stamp), 'utf8') : raw;
    return { rel, bytes, class: MANAGED_SKELETON_FILES.includes(rel) ? 'managed' : 'seeded' };
  });
  const hookBytes = readFileSync(TEMPLATE_HOOK);

  makeDirs(ledger, target);
  const entries = [];
  for (const { rel, bytes, class: cls } of prepared) {
    writeNew(ledger, join(target, rel), bytes);
    entries.push(cls === 'managed' ? { path: rel, sha256: sha256Of(bytes), class: cls } : { path: rel, class: cls });
  }
  // .gitignore is the kit's (managed), so `update` can carry a rule this
  // kit adds into a vault that has not edited it; the configuration is
  // the person's from the first answer, and is not recorded.
  for (const [rel, text] of Object.entries(files)) {
    writeNew(ledger, join(target, rel), text);
    if (rel === GITIGNORE_PATH) entries.push({ path: rel, sha256: sha256Of(Buffer.from(text, 'utf8')), class: 'managed' });
  }

  entries.push(writeGateHook(ledger, target, hookBytes));

  const manifest = { lang, files: entries };
  writeNew(ledger, join(target, MANIFEST_PATH), serializeManifest(manifest));
  return manifest;
}

// True when `path` is `dir` or lies under it, compared as resolved paths
// (the same path gives an empty relative path, which is inside). The
// absolute check only matters on Windows, where relative() across two
// drives returns an absolute path.
export function isInside(path, dir) {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
