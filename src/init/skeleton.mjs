import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { KIT_ROOT } from '../version.mjs';
import { CONFIG_FILENAME } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { splitFrontmatter, readMapping } from '../frontmatter.mjs';
import { MANIFEST_PATH, sha256Of, writeManifest } from '../manifest.mjs';

// Everything `init` does to the filesystem inside the target directory:
// the checks that must all pass before a single byte is written
// (inspectTarget), and the writes themselves (writeVault).
//
// The split is the safety property. A refusal found halfway through the
// writes would leave half a vault in a person's directory, so every
// precondition is decided by inspectTarget first, which only reads, and
// writeVault is called only once all of them have passed. writeVault
// also creates every file exclusively ('wx', COPYFILE_EXCL), so even a
// directory filled in the window between the check and the write (a
// person typing answers while something else writes there) makes it
// fail on the first existing file rather than replace it.

export const HOOK_PATH = '.githooks/pre-push';
export const TEMPLATE_HOOK = join(KIT_ROOT, 'templates', 'githooks', 'pre-push');
export const GITIGNORE_PATH = '.gitignore';

// The root contract files: what an agent reads before anything else, the
// kit's to keep current, so `managed` in the manifest. Every other file
// of the skeleton is a note the person owns from the moment of init.
export const ROOT_CONTRACT_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'CONVENTIONS.md', 'SECURITY.md']);

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
function nearestExisting(dir) {
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
  const entries = readdirSync(dir);
  if (entries.length > 0) return { key: 'not_empty', params: { dir, count: entries.length } };
  return null;
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

// Writes the vault into `target`, which inspectTarget has already
// accepted. `files` maps each vault-relative path init writes beyond the
// skeleton (the configuration and .gitignore) to its text. Every byte is
// prepared in memory first, stamping included, so a skeleton this
// function cannot stamp throws before anything reaches the disk. Returns
// the manifest it wrote.
export function writeVault(target, { lang, stamp, files }) {
  const skeleton = listSkeleton(lang);
  for (const rel of ROOT_CONTRACT_FILES) {
    if (!skeleton.includes(rel)) throw new Error(`the ${lang} skeleton has no ${rel}`);
  }
  const prepared = skeleton.map((rel) => {
    const raw = readFileSync(join(skeletonDir(lang), rel));
    const bytes = rel.endsWith('.md') ? Buffer.from(stampGenerated(raw.toString('utf8'), stamp), 'utf8') : raw;
    return { rel, bytes, class: ROOT_CONTRACT_FILES.includes(rel) ? 'managed' : 'seeded' };
  });
  const hookBytes = readFileSync(TEMPLATE_HOOK);

  mkdirSync(target, { recursive: true });
  const writeNew = (rel, bytes) => {
    const abs = join(target, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes, { flag: 'wx' });
  };
  const entries = [];
  for (const { rel, bytes, class: cls } of prepared) {
    writeNew(rel, bytes);
    entries.push({ path: rel, sha256: sha256Of(bytes), class: cls });
  }
  for (const [rel, text] of Object.entries(files)) writeNew(rel, text);

  // The hook is copied byte for byte, then made executable; its hash is
  // of the bytes that landed, not of the template read a moment earlier.
  const hook = join(target, HOOK_PATH);
  mkdirSync(dirname(hook), { recursive: true });
  copyFileSync(TEMPLATE_HOOK, hook, constants.COPYFILE_EXCL);
  chmodSync(hook, 0o755);
  const landed = readFileSync(hook);
  if (!landed.equals(hookBytes)) throw new Error(`${HOOK_PATH} changed while init was copying it`);
  entries.push({ path: HOOK_PATH, sha256: sha256Of(landed), class: 'managed' });

  if (existsSync(join(target, MANIFEST_PATH))) throw new Error(`${MANIFEST_PATH} appeared while init was writing`);
  const manifest = { files: entries };
  writeManifest(target, manifest);
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
