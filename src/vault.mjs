// The vault sentinel and the vault walk.
//
// findVaultRoot/isVaultRoot answer "is this directory a brain-kit vault, and
// where is its root", using nothing but the presence of two files: the
// config and a root index.md. That is deliberately a *structural* check,
// not a validity one: it does not parse either file, and does not call
// loadConfig. A directory is a vault before it is a conforming one - a
// vault whose config has a schema error, or whose index doesn't yet declare
// okf_version (a house rule, defaulting to off; see the house ruler in a
// later task), is still a vault. Layering it any other way would make a
// hook's decision to protect a vault fragile to exactly the kind of small,
// human config mistake the hook exists to help catch in the first place.
//
// walkVault is the one exported walk every later tool uses: the graph
// visualiser, the leak scanner, the linter's orphan check and the
// migrations all call this instead of rolling their own readdir loop, which
// is the defect this module exists to remove (see docs/superpowers/plans/
// 2026-09-18-phase-1a-vault-core-and-validate.md, "Source being ported",
// defect 4: the original vault's tools disagreed about what belongs to it).
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILENAME } from './config.mjs';

const ROOT_INDEX = 'index.md';

// Names always skipped, at any depth, no matter what a vault's own config
// says. Dot-entries (.git, .brain-kit, an editor's .DS_Store) are matched by
// a name *prefix* and so are not listed here; this array holds the exact
// extra names that join that rule.
//
// Why these are hard-coded rather than left to validate.ignore_paths: the
// vault carries its own .brain-kit/ directory of prompts with no
// frontmatter, and a package manager can drop node_modules anywhere a
// vault's own tooling lives. If either were configurable, a correctly
// laid-out vault could be made to fail its own validator simply because
// nobody had set the option yet (or, before the vault exists, could not
// have), so this is a rule, not a default.
export const ALWAYS_IGNORED = Object.freeze(['node_modules']);

function isAlwaysIgnoredName(name) {
  return name.startsWith('.') || ALWAYS_IGNORED.includes(name);
}

// True when `prefix` (an entry of validate.ignore_paths) matches
// `relPosixPath` (already root-relative, forward-slash). A prefix is a path
// boundary, not a raw string prefix: "logs" matches "logs/x.md" and "logs"
// itself, but not "logs-2024/x.md". A trailing slash on the configured
// prefix is accepted and stripped, so a vault owner does not have to guess
// which form is expected.
function matchesIgnorePrefix(relPosixPath, prefix) {
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (normalized === '') return false;
  return relPosixPath === normalized || relPosixPath.startsWith(`${normalized}/`);
}

// A directory is a vault before it is a conforming one: this checks
// structure only (do the two sentinel files exist), never content, and
// never throws, so callers can use it as a plain predicate while walking
// upward through directories they may not even be able to read.
export function isVaultRoot(dir) {
  return existsSync(join(dir, CONFIG_FILENAME)) && existsSync(join(dir, ROOT_INDEX));
}

// Walks upward from startDir looking for a vault root. Stops, and returns
// null, at the user's home directory (never returning anything above it,
// even if something above it happens to look like a vault) or at the
// filesystem root, whichever comes first. Never throws: an unrelated
// directory simply yields null.
export function findVaultRoot(startDir) {
  const home = resolve(homedir());
  let current = resolve(startDir);
  for (;;) {
    if (isVaultRoot(current)) return current;
    if (current === home) return null;
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root: nowhere further to go
    current = parent;
  }
}

// A path relative to root, with forward slashes, so every path this module
// hands out reads the same on Linux, macOS and Windows, and matches one to
// one with how a link inside a markdown file spells a vault-relative path.
export function relativePosix(root, file) {
  return relative(root, file).split(sep).join('/');
}

// True when `target` (an absolute, already-resolved path) is `root` itself
// or lies under it.
function isPathInside(root, target) {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Resolves a symlink entry to its real target. Returns null when it cannot
// be resolved at all (a dangling target, a permission error, a chain that
// loops back on itself), so the walk can skip it silently: broken vault
// debris left behind by some other tool is not a reason for a validator to
// crash.
function resolveSymlinkTarget(fullPath) {
  try {
    return realpathSync(fullPath);
  } catch {
    return null;
  }
}

// Walks `root`, returning file paths relative to it (forward-slash,
// sorted). By default only `.md` files come back; pass `{ all: true }` to
// get every file, which the link checker needs so it can tell a link to a
// real attachment from a broken one. `config` is the vault's loaded config,
// or any object shaped like it (only config.validate.ignore_paths is read),
// so a caller may omit config entirely to get just the always-ignored
// rules.
//
// Symbolic links: an entry whose real target resolves outside the vault is
// never read, exactly like a dangling one - this walk is the one place that
// decides what belongs to the vault, and content a leak scanner or a
// published PR could otherwise quote from outside it (a file elsewhere in
// the user's home, anything else reachable from the machine) is not vault
// content, however a note happens to link to it. An entry whose real target
// resolves to a directory, inside the vault or outside it, is never
// traversed either way: the vault has no supported use for a symlinked
// directory, and following one risks a walk that never returns the moment
// the link is even indirectly self-referential (e.g. a link one level down
// pointing back at its own parent), which a validator must never be able to
// hang on. A symlink to a *file* inside the vault is the one case treated
// as real content: it is a legitimate alias (the same note kept reachable
// under a second name), the link checker must see it as existing or a
// working link gets reported broken, and reading it costs nothing the walk
// was not already going to do when it reaches the real file by its own
// path.
export function walkVault(root, config = {}, { all = false } = {}) {
  const ignorePaths = config?.validate?.ignore_paths ?? [];
  const rootReal = realpathSync(root);
  const results = [];

  function includeFile(name, relPosixPath) {
    if (all || extname(name) === '.md') results.push(relPosixPath);
  }

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isAlwaysIgnoredName(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const relPosixPath = relativePosix(root, fullPath);
      if (ignorePaths.some((prefix) => matchesIgnorePrefix(relPosixPath, prefix))) continue;

      if (entry.isSymbolicLink()) {
        const real = resolveSymlinkTarget(fullPath);
        if (real === null || !isPathInside(rootReal, real)) continue;
        if (statSync(real).isFile()) includeFile(entry.name, relPosixPath);
        continue; // a symlinked directory, inside or outside, is never traversed
      }
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        includeFile(entry.name, relPosixPath);
      }
      // anything else (socket, fifo, device) is neither file, directory nor
      // symlink, and cannot be vault content.
    }
  }

  visit(root);
  return results.sort();
}
