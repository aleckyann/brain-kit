// Vault sentinel and walk: the single definition of "what belongs to this
// vault" that the validator, the linter, the graph visualiser and the
// migrations all consume from here on, so they can never again disagree
// about it the way the original vault's separate readdir loops did.
import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../src/config.mjs';
import { ALWAYS_IGNORED, findVaultRoot, isVaultRoot, relativePosix, walkVault } from '../src/vault.mjs';
import { makeVault, writeVaultFile } from './helpers/vault-fixture.mjs';

// --- isVaultRoot -------------------------------------------------------------

test('isVaultRoot is true when the config file and a root index.md are both present', () => {
  const root = makeVault({ files: { 'index.md': '' } });
  assert.equal(isVaultRoot(root), true);
});

test('isVaultRoot is false when index.md is missing', () => {
  const root = makeVault({ files: {} });
  assert.equal(isVaultRoot(root), false);
});

test('isVaultRoot is false when the config file is missing', () => {
  const dir = makeTempDir('brain-kit-noconfig-');
  writeVaultFile(dir, 'index.md', '');
  assert.equal(isVaultRoot(dir), false);
});

test('isVaultRoot is false for a directory that has neither file', () => {
  const dir = makeTempDir('brain-kit-empty-');
  assert.equal(isVaultRoot(dir), false);
});

test('isVaultRoot does not require okf_version, or any frontmatter at all, in the root index', () => {
  // Whether the root index must declare okf_version is a house rule
  // (validate.require_root_okf_version) that defaults to off and is judged
  // by the house ruler, not the sentinel. A directory is a vault before it
  // is a conforming one: a hook that refused to recognise a vault over an
  // optional field would stop protecting it.
  const root = makeVault({ files: { 'index.md': 'no frontmatter here at all, just text\n' } });
  assert.equal(isVaultRoot(root), true);
});

// --- findVaultRoot -----------------------------------------------------------

test('findVaultRoot walks upward from a subdirectory and returns the vault root', () => {
  const root = makeVault({ files: { 'index.md': '', 'people/ana.md': '' } });
  assert.equal(findVaultRoot(join(root, 'people')), root);
});

test('findVaultRoot returns the root itself when started there', () => {
  const root = makeVault({ files: { 'index.md': '' } });
  assert.equal(findVaultRoot(root), root);
});

test('findVaultRoot returns null, not a throw, from a directory with no vault above it', () => {
  const dir = makeTempDir('brain-kit-novault-');
  assert.doesNotThrow(() => findVaultRoot(dir));
  assert.equal(findVaultRoot(dir), null);
});

test("findVaultRoot never returns a directory above the user's home, even if one exists there", () => {
  // A self-contained fake filesystem: fakeRoot itself looks like a vault (it
  // has both sentinel files), fakeRoot/home/someone is the fake HOME, and
  // start is a plain subdirectory under that fake home with no vault of its
  // own. If findVaultRoot ever walked past home, it would find fakeRoot and
  // wrongly report it as the vault for a directory that only happens to sit
  // under someone's home, not because it is one.
  const fakeRoot = makeTempDir('brain-kit-boundary-');
  writeVaultFile(fakeRoot, CONFIG_FILENAME, '{}');
  writeVaultFile(fakeRoot, 'index.md', '');
  assert.equal(isVaultRoot(fakeRoot), true, 'fakeRoot must look like a vault for this test to mean anything');

  const fakeHome = join(fakeRoot, 'home', 'someone');
  const start = join(fakeHome, 'projects', 'notes');
  mkdirSync(start, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    assert.equal(findVaultRoot(start), null);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

// findVaultRoot(startDir, home) takes an injectable home as an optional
// second argument (defaulting to the real os.homedir()) so the boundary
// can be probed hermetically, with no process.env mutation to restore.
// The test right below starts exactly at that injected home, which is
// itself not a vault, and pins down the simple floor case: the walk must
// stop there and never climb past it to the vault-looking fakeRoot one
// level up. It does not by itself catch an ordering bug, because
// isVaultRoot(home) is false there either way, before or after the
// boundary is checked. The test after it starts one level above home, at
// a directory that IS a vault, which is what actually forces the boundary
// to be checked before a vault-looking candidate gets accepted: see its
// own comment below.

test('findVaultRoot returns null when started exactly at an injected home that is not itself a vault, even though its parent looks like one', () => {
  const fakeRoot = makeTempDir('brain-kit-boundary2-');
  writeVaultFile(fakeRoot, CONFIG_FILENAME, '{}');
  writeVaultFile(fakeRoot, 'index.md', '');
  const fakeHome = join(fakeRoot, 'someone');
  mkdirSync(fakeHome, { recursive: true });

  assert.equal(findVaultRoot(fakeHome, fakeHome), null);
});

test("findVaultRoot returns null when started at an injected home's parent, even though that parent looks like a vault itself", () => {
  const fakeRoot = makeTempDir('brain-kit-boundary3-');
  writeVaultFile(fakeRoot, CONFIG_FILENAME, '{}');
  writeVaultFile(fakeRoot, 'index.md', '');
  const fakeHome = join(fakeRoot, 'someone');
  mkdirSync(fakeHome, { recursive: true });
  assert.equal(isVaultRoot(fakeRoot), true, 'fakeRoot must look like a vault for this test to mean anything');

  // Starting directly at fakeRoot, which is fakeHome's parent: the old,
  // buggy order checked isVaultRoot(fakeRoot) before ever comparing it to
  // home, and returned fakeRoot even though it sits strictly above home.
  assert.equal(findVaultRoot(fakeRoot, fakeHome), null);
});

// --- walkVault: basic listing --------------------------------------------------

// Every other fixture in this file spells the taxonomy in English
// (people/, projects/, decisions/, pending/, core/, memory/, attachments/)
// because the kit's whole claim is that the taxonomy is configuration, not
// something the engine hard-codes. This one test is the deliberate,
// single exception: it keeps the original vault's own Portuguese folder
// names (nucleo, pessoas) to prove that claim rather than just assert it,
// showing that walkVault's core listing and sorting behaviour does not
// care what the folders are called. Chosen here because this is
// walkVault's most basic contract, with no symlink or ignore_paths
// machinery entangled, so the proof stays legible as one clear
// demonstration instead of looking like a leftover.
test('walkVault returns every markdown file as root-relative forward-slash paths, sorted', () => {
  const root = makeVault({
    files: {
      'index.md': '',
      'nucleo/a.md': '',
      'pessoas/ana.md': '',
      'pessoas/note.md': '',
    },
  });
  const config = loadConfig(root);
  const expected = ['index.md', 'nucleo/a.md', 'pessoas/ana.md', 'pessoas/note.md'].sort();
  assert.deepEqual(walkVault(root, config), expected);
});

test('walkVault never returns a directory, only files', () => {
  const root = makeVault({ files: { 'index.md': '', 'people/ana.md': '' } });
  const config = loadConfig(root);
  const result = walkVault(root, config);
  assert.ok(!result.includes('people'), 'a directory must never appear in the walk result');
  for (const relPath of result) {
    assert.ok(statSync(join(root, relPath)).isFile(), `${relPath} must be a file`);
  }
});

// --- walkVault: always-ignored, whatever the configuration says ---------------

test('walkVault always skips dot-entries, at any depth, whatever the configuration says', () => {
  const root = makeVault({
    files: {
      'index.md': '',
      '.brain-kit/prompts/curate.md': '',
      'people/.hidden/ana.md': '',
      'people/visible.md': '',
    },
  });
  const config = loadConfig(root);
  const result = walkVault(root, config);
  assert.ok(!result.includes('.brain-kit/prompts/curate.md'));
  assert.ok(!result.some((p) => p.includes('/.hidden/')));
  assert.ok(result.includes('people/visible.md'));
  assert.ok(result.includes('index.md'));
});

test('walkVault always skips node_modules, at any depth, whatever the configuration says', () => {
  const root = makeVault({
    files: {
      'index.md': '',
      'node_modules/pkg/readme.md': '',
      'core/node_modules/nested.md': '',
      'core/keep.md': '',
    },
  });
  const config = loadConfig(root);
  const result = walkVault(root, config);
  assert.ok(!result.some((p) => p.split('/').includes('node_modules')));
  assert.ok(result.includes('core/keep.md'));
});

test('dot-entries and node_modules are skipped even with no config argument at all', () => {
  const root = makeVault({
    files: {
      'index.md': '',
      '.secret/x.md': '',
      'node_modules/y.md': '',
      'z.md': '',
    },
  });
  assert.deepEqual(walkVault(root), ['index.md', 'z.md']);
});

test('ALWAYS_IGNORED names node_modules', () => {
  assert.ok(ALWAYS_IGNORED.includes('node_modules'));
});

test('ALWAYS_IGNORED is frozen so no other module can add or remove an entry', () => {
  assert.ok(Object.isFrozen(ALWAYS_IGNORED));
});

// --- walkVault: validate.ignore_paths ------------------------------------------

test('walkVault skips every prefix listed in validate.ignore_paths, matched against the root-relative path', () => {
  const root = makeVault({
    config: { validate: { ignore_paths: ['drafts/', 'pending/draft.md'] } },
    files: {
      'index.md': '',
      'drafts/wip.md': '',
      'drafts/nested/also-wip.md': '',
      'pending/draft.md': '',
      'pending/follow-ups.md': '',
    },
  });
  const config = loadConfig(root);
  const expected = ['index.md', 'pending/follow-ups.md'].sort();
  assert.deepEqual(walkVault(root, config), expected);
});

test('validate.ignore_paths matches a path boundary, not a raw string prefix: "logs" ignores logs/ but keeps logs-2024/', () => {
  const root = makeVault({
    config: { validate: { ignore_paths: ['logs'] } },
    files: {
      'index.md': '',
      'logs/run.md': '',
      'logs-2024/jan.md': '',
    },
  });
  const config = loadConfig(root);
  const result = walkVault(root, config);
  assert.ok(!result.includes('logs/run.md'), 'a bare "logs" prefix must ignore logs/');
  assert.ok(result.includes('logs-2024/jan.md'), 'a bare "logs" prefix must not ignore logs-2024/');
});

test('a configured ignore prefix that does not exist in the vault is not an error', () => {
  const root = makeVault({
    config: { validate: { ignore_paths: ['this/prefix/does-not-exist/'] } },
    files: { 'index.md': '' },
  });
  const config = loadConfig(root);
  assert.doesNotThrow(() => walkVault(root, config));
  assert.deepEqual(walkVault(root, config), ['index.md']);
});

// --- walkVault: { all: true } ---------------------------------------------------

test('by default walkVault returns only markdown files', () => {
  const root = makeVault({ files: { 'index.md': '', 'attachments/plan.pdf': 'x', 'notes.txt': 'x' } });
  const config = loadConfig(root);
  assert.deepEqual(walkVault(root, config), ['index.md']);
});

test('walkVault returns every file, markdown or not, when called with { all: true }', () => {
  const root = makeVault({ files: { 'index.md': '', 'attachments/plan.pdf': 'x', 'notes.txt': 'x' } });
  const config = loadConfig(root);
  const expected = [CONFIG_FILENAME, 'index.md', 'attachments/plan.pdf', 'notes.txt'].sort();
  assert.deepEqual(walkVault(root, config, { all: true }), expected);
});

// --- walkVault: symbolic links ---------------------------------------------------
//
// Policy (see src/vault.mjs for the full rationale): a link whose real
// target lands outside the vault is skipped, exactly like a dangling one,
// whether it names a file or a directory. A link whose real target lands
// inside the vault is included when it is a file (a legitimate alias the
// link checker must be able to resolve) but never traversed when it is a
// directory (there is no supported use for one, and following it risks a
// walk that never returns the moment the link is even indirectly
// self-referential).

test('a symbolic link inside the vault pointing outside it is skipped, not read', () => {
  const outside = makeTempDir('brain-kit-outside-');
  const outsideFile = writeVaultFile(outside, 'secret.md', 'not vault content');
  const root = makeVault({ files: { 'index.md': '' } });
  symlinkSync(outsideFile, join(root, 'leaked.md'), 'file');

  const config = loadConfig(root);
  assert.deepEqual(walkVault(root, config), ['index.md']);
  assert.deepEqual(walkVault(root, config, { all: true }), [CONFIG_FILENAME, 'index.md'].sort());
});

test('a dangling symbolic link is skipped without throwing', () => {
  const root = makeVault({ files: { 'index.md': '' } });
  symlinkSync(join(tmpdir(), 'brain-kit-nonexistent-target-xyz'), join(root, 'dangling.md'), 'file');

  const config = loadConfig(root);
  assert.doesNotThrow(() => walkVault(root, config, { all: true }));
  assert.deepEqual(walkVault(root, config), ['index.md']);
});

test('two symbolic links pointing at each other are both skipped without throwing', () => {
  const root = makeVault({ files: { 'index.md': '' } });
  symlinkSync(join(root, 'b'), join(root, 'a'), 'file');
  symlinkSync(join(root, 'a'), join(root, 'b'), 'file');

  const config = loadConfig(root);
  assert.doesNotThrow(() => walkVault(root, config, { all: true }));
  assert.deepEqual(walkVault(root, config), ['index.md']);
});

test('a symbolic link inside the vault to a file inside the vault is included, at its own path', () => {
  const root = makeVault({ files: { 'index.md': '', 'core/real.md': 'real content' } });
  mkdirSync(join(root, 'people'), { recursive: true });
  symlinkSync(join(root, 'core', 'real.md'), join(root, 'people', 'alias.md'), 'file');

  const config = loadConfig(root);
  const expected = ['index.md', 'core/real.md', 'people/alias.md'].sort();
  assert.deepEqual(walkVault(root, config), expected);
});

test('a symbolic link inside the vault to a directory inside the vault is not traversed', () => {
  const root = makeVault({ files: { 'index.md': '', 'people/ana.md': '' } });
  symlinkSync(join(root, 'people'), join(root, 'shortcut'), 'dir');

  const config = loadConfig(root);
  const result = walkVault(root, config);
  assert.ok(result.includes('people/ana.md'));
  assert.ok(!result.some((p) => p.startsWith('shortcut')), `must not traverse the symlinked directory: ${result.join(', ')}`);
});

test('a self-referential symbolic link does not make walkVault recurse forever', () => {
  const root = makeVault({ files: { 'index.md': '', 'people/ana.md': '' } });
  symlinkSync(join(root, 'people'), join(root, 'people', 'loop'), 'dir');

  const config = loadConfig(root);
  const result = walkVault(root, config); // must return, not hang
  assert.ok(result.includes('people/ana.md'));
  assert.ok(!result.some((p) => p.includes('loop')));
});

// --- relativePosix ---------------------------------------------------------------

test('relativePosix returns the path relative to root, with forward slashes', () => {
  const root = makeVault({ files: { 'people/ana.md': '' } });
  assert.equal(relativePosix(root, join(root, 'people', 'ana.md')), 'people/ana.md');
  assert.equal(relativePosix(root, join(root, 'index.md')), 'index.md');
});

// --- fix round 3, finding G: what counts as a markdown file, in both directions ---
//
// The whole-slice review found this predicate undefended in BOTH
// directions: mutating `extname(name) === '.md'` to a case-insensitive
// comparison kept all 801 tests green, which means no test could tell
// the two readings apart. The reading was also wrong. On a
// case-insensitive filesystem (macOS by default, Windows always)
// `NOTE.MD` and `note.md` are the same file, so the old predicate made
// what belongs to a vault depend on which platform walked it, and a note
// somebody saved with a capitalised extension was invisible to both
// `validate` and `lint`, in silence. The two tests below pin the fold
// itself and the one thing that must still be excluded.
test('walkVault includes a note whose extension is capitalised, on every platform', () => {
  const root = makeVault({ files: { 'index.md': '# Index\n', 'notes/LOUD.MD': '# Loud\n', 'notes/Mixed.Md': '# Mixed\n' } });
  const config = loadConfig(root);
  assert.deepEqual(walkVault(root, config), ['index.md', 'notes/LOUD.MD', 'notes/Mixed.Md']);
});

test('walkVault still excludes a file whose extension is not markdown at all, whatever its case', () => {
  const root = makeVault({ files: { 'index.md': '# Index\n', 'notes/data.JSON': '{}\n', 'notes/photo.PNG': 'not really a photo\n', 'notes/readme.mdx': '# Not markdown\n' } });
  const config = loadConfig(root);
  assert.deepEqual(walkVault(root, config), ['index.md']);
  // And the same walk, asked for everything, still returns every file,
  // the vault's own configuration among them.
  assert.equal(walkVault(root, config, { all: true }).length, 5);
});
