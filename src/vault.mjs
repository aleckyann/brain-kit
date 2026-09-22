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

// True when `relPosixPath` (already root-relative, forward-slash) IS `dir`
// or lies under it. A path BOUNDARY, not a raw string prefix: "logs"
// matches "logs/x.md" and "logs" itself, but not "logs-2024/x.md". A
// trailing slash on `dir` is accepted and stripped, so a caller does not
// have to guess which form is expected, and an empty `dir` matches nothing
// rather than everything.
//
// Exported, and this is the point of exporting it: src/rules/house.mjs had
// its own copy under the name isUnderDir, deciding whether a note lies
// under taxonomy.templates_dir and therefore earns the placeholder
// exemption. The copy there even carried a comment naming this function as
// the thing it was mirroring, which is the tell: someone knew they were
// writing a second copy and wrote it anyway. Only this one was under test,
// so degrading the other to a raw startsWith failed nothing, and handed the
// placeholder exemption to any directory merely NAMED like the templates
// directory ("templates-old/"). One definition of what "under a directory"
// means, in the module that already defines what a vault path is.
export function isUnderPath(relPosixPath, dir) {
  if (!dir) return false;
  const normalized = dir.endsWith('/') ? dir.slice(0, -1) : dir;
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
// null, at the home directory (never returning anything strictly above it,
// even if something above it happens to look like a vault, and even when
// the search starts there or above it) or at the filesystem root, whichever
// comes first. Never throws: an unrelated directory simply yields null.
//
// The boundary is checked before a candidate is ever accepted, on every
// iteration including the first: a directory strictly above home is
// rejected outright, whether the walk arrived there by climbing from below
// or started there directly. Checking isVaultRoot first would let a start
// directory placed at or above home return something above home, which is
// exactly what this order forbids.
//
// `home` defaults to the real os.homedir(), read fresh on every call so it
// follows the live HOME/USERPROFILE environment; tests may inject a fake
// one directly, so the boundary can be exercised hermetically with no
// process-global state to mutate and restore.
export function findVaultRoot(startDir, home = resolve(homedir())) {
  home = resolve(home);
  let current = resolve(startDir);
  for (;;) {
    if (current !== home && isPathInside(current, home)) return null;
    if (isVaultRoot(current)) return current;
    if (current === home) return null; // at home, nothing found: don't climb past it
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

// True when `target` is `root` itself or lies under it. Both arguments must
// already be absolute, and consistent with each other: either both real
// (realpathSync'd, for the symlink-containment check below) or both merely
// lexical (resolve()'d, for findVaultRoot's home-boundary check above).
// Comparing one of each would be meaningless.
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

// Single-walk contract: the validate command, and everything after it,
// calls this exactly once, with { all: true }, and builds its rulers'
// context from that one result. The markdown subset (the result filtered
// to paths ending in .md) is what the spec and house rulers judge; the
// full, unfiltered result is what the house ruler's link-target-exists
// check resolves a link against, since a link may legitimately point at a
// non-markdown attachment. Both views come from this one call so nobody is
// tempted to add a second walk with different filtering later, which is
// exactly how the original vault's separate tools ended up disagreeing
// about what belongs to it.
//
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
    // Case-insensitive, fix round 3 (finding G): src/commands/validate.mjs's
    // own isMarkdown folds the case too, and these two are the pair that
    // must never disagree about what a markdown file is. See that
    // function's own comment for why the fold, and not the sensitive
    // comparison, is the defensible reading.
    if (all || extname(name).toLowerCase() === '.md') results.push(relPosixPath);
  }

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isAlwaysIgnoredName(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const relPosixPath = relativePosix(root, fullPath);
      if (ignorePaths.some((prefix) => isUnderPath(relPosixPath, prefix))) continue;

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

// What a vault-relative path IS, for a consumer holding the single walk
// and needing to answer a question the walk alone cannot answer.
//
// The walk is the one truth about what belongs to the vault, and this
// function does not touch that: membership is still `all`, the result of
// the one walkVault call, and nothing here adds a path to it or takes one
// away. What it adds is the ability to tell three DIFFERENT absences
// apart, which the walk flattens into one:
//
// - 'in-walk'   the path is a file the walk returned.
// - 'directory' the path is a directory. The walk returns files only, so a
//               directory is never in `all`, and a consumer asking "does
//               this exist" about one used to be told no. Section 8 of the
//               Open Knowledge Format prints a link to a subdirectory as
//               its own worked example of an index entry, so this is not
//               an edge case; it is the shape the format's own
//               progressive-disclosure design is built on.
// - 'unwalked'  the path is a real file on disk that this walk did not
//               return: it is under validate.ignore_paths, or under a
//               dot-entry or node_modules, or it is a symlink pointing
//               outside the vault. It EXISTS, and a consumer must say so
//               in those words rather than claim it is missing.
// - 'absent'    nothing is there.
// - 'outside'   the path climbs out of the vault, so it is not a vault
//               path at all and is never stat'd.
//
// Why a stat and not a second walk: a walk enumerates, and two
// enumerations of one tree are two answers to "what does this vault
// contain", which is defect 4 (see this module's header) and the thing the
// single-walk contract exists to forbid. One stat of one named path
// answers "is this particular thing there", a question the walk was never
// asked, and its answer only ever refines a MESSAGE. It can never move a
// file into or out of the set the rulers judge.
export function classifyTargetPath(root, relPosixPath, all) {
  if (relPosixPath === '..' || relPosixPath.startsWith('../')) return 'outside';
  if (all.has(relPosixPath)) return 'in-walk';
  const fullPath = join(root, ...relPosixPath.split('/'));
  let stats;
  try {
    stats = statSync(fullPath);
  } catch {
    return 'absent'; // no such path, a dangling symlink, or unreadable: nothing to point at
  }
  if (stats.isDirectory()) return 'directory';
  return 'unwalked';
}
