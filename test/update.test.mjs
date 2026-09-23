// `brain-kit update`: refresh the files the kit manages, by checksum, and
// never overwrite a file the person edited. Every test starts from a vault
// the REAL `init` made in a temporary directory whose path has a space, an
// accented letter and a quote in it, then reshapes it to the case under
// test and runs the real command.
//
// How an "older kit" is simulated: a managed file whose bytes differ from
// what this kit would write, with the manifest recording exactly those
// bytes' hash. That is what a vault written by an earlier kit looks like
// to this one: untouched (the hash matches), and not current (the kit's
// version differs). An edit on top of that, with the manifest left at the
// older bytes' hash, is a file the person edited since that kit wrote it.
//
// What is proved, each by listing the vault (names, modes and content
// hashes) before and after:
// - right after a real init, update writes nothing, exits 0, and calls
//   every managed file current; `--check` exits 0;
// - an untouched managed file (a contract file, and the hook) is
//   rewritten with this kit's version, stamped with the moment of the
//   update, its mode kept and its manifest hash updated;
// - an edited managed file keeps its bytes, and this kit's version lands
//   beside it as <name>.brain-kit-new, named in the output, exit 3;
// - an edited managed file the kit has nothing newer for is left alone
//   with nothing beside it, including when the edit re-stamped
//   generated.at, as the vault's own conventions tell an agent to;
// - a seeded file is never touched, even when it looks exactly like an
//   untouched managed file whose kit version differs;
// - a managed file that was deleted is reported and not recreated;
// - `--check` writes nothing, and exits 1 exactly when something is
//   pending;
// - a manifest that is missing, empty, not JSON, of the wrong shape or
//   without entries is a refusal, exit 1, nothing written;
// - an existing .brain-kit-new is never overwritten, whatever it is;
// - a managed path that is a link, or reached through a linked directory,
//   is never written through;
// - a file that changes between update reading it and replacing it is
//   left with the person's bytes.
//
// Example data: the fictional owner Ana, example.invalid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { splitFrontmatter, readMapping } from '../src/frontmatter.mjs';
import { HOOK_PATH, ROOT_CONTRACT_FILES, stampGenerated } from '../src/init/skeleton.mjs';
import { MANIFEST_PATH, readManifest } from '../src/manifest.mjs';
import { runUpdate } from '../src/commands/update.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const TEMPLATE_HOOK = join(KIT_ROOT, 'templates', 'githooks', 'pre-push');
const NEW_SUFFIX = '.brain-kit-new';
const AWKWARD_DIR = `My Vault ${String.fromCharCode(0xc1)}rea 'quoted'`;

const ANSWERS = Object.freeze({
  en: { lang: 'en', name: 'Ana Souza', handle: 'asouza', title: 'Field Notes', repo: null, private: true, timezone: 'UTC' },
  'pt-BR': { lang: 'pt-BR', name: 'Ana Lima', handle: 'alima', title: 'Notas', repo: null, private: true, timezone: 'UTC' },
});

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function env(state, extra = {}) {
  return { ...process.env, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: state, USER: 'ana', LOGNAME: 'ana', TZ: 'UTC', ...extra };
}

// A vault from the real init. Returns its paths and an empty working
// directory beside it that every command runs from, so a lost directory
// argument can never reach the checkout the suite runs from.
function initVault(lang = 'en') {
  const base = join(makeTempDir('brain-kit-update-'), AWKWARD_DIR);
  mkdirSync(base, { recursive: true });
  const cwd = join(base, 'cwd');
  mkdirSync(cwd);
  const state = join(base, 'state');
  const vault = join(base, 'vault');
  const answers = join(base, 'answers.json');
  writeFileSync(answers, JSON.stringify(ANSWERS[lang]));
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--from-answers', answers], { encoding: 'utf8', env: env(state), cwd });
  assert.equal(r.status, EXIT.OK, `init failed:\n${r.stdout}\n${r.stderr}`);
  return { base, vault, state, cwd, lang };
}

function update(v, args = []) {
  return spawnSync(process.execPath, [BIN, 'update', v.vault, ...args], { encoding: 'utf8', env: env(v.state), cwd: v.cwd });
}

// Everything under `root`, .git included: path, kind, mode and a file's
// hash. Two equal listings mean nothing was created, removed, rewritten or
// re-permissioned.
function snapshot(root) {
  const out = [];
  const walk = (rel) => {
    const abs = rel === '' ? root : join(root, rel);
    const st = lstatSync(abs);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isDirectory()) {
      out.push(`${rel || '.'} dir ${mode}`);
      for (const name of readdirSync(abs).sort()) walk(rel === '' ? name : `${rel}/${name}`);
    } else if (st.isFile()) {
      out.push(`${rel} file ${mode} ${sha(readFileSync(abs))}`);
    } else {
      out.push(`${rel} link`);
    }
  };
  walk('');
  return out;
}

function manifestEntry(vault, path) {
  return readManifest(vault).files.find((f) => f.path === path);
}

// Rewrites one manifest entry's hash, bypassing writeManifest on purpose:
// this is the fixture, not the code under test.
function setManifestHash(vault, path, hash) {
  const file = join(vault, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const entry = manifest.files.find((f) => f.path === path);
  assert.ok(entry, `${path} is not in the manifest`);
  entry.sha256 = hash;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Makes `path` look written by an older kit: different bytes, hash
// recorded. Returns the older bytes.
function makeOlder(vault, path) {
  const abs = join(vault, path);
  const current = readFileSync(abs, 'utf8');
  const older = path === HOOK_PATH
    ? current.replace('\n', '\n# an older version of this hook\n')
    : current.replace(/^(title: .*)$/m, '$1 (an older wording)');
  assert.notEqual(older, current, 'the fixture must actually change the file');
  writeFileSync(abs, older);
  setManifestHash(vault, path, sha(Buffer.from(older)));
  return Buffer.from(older);
}

function stampOf(text) {
  const { frontmatter } = splitFrontmatter(text);
  return frontmatter === null ? null : readMapping(frontmatter, 'generated')?.at ?? null;
}

function kitSkeleton(lang, path) {
  return readFileSync(join(KIT_ROOT, 'lang', lang, 'vault', path), 'utf8');
}

const T = createTranslator('en');

function says(r, key, params) {
  const line = T(key, params);
  assert.ok(r.stdout.includes(line), `expected "${line}" on stdout:\n${r.stdout}\n${r.stderr}`);
}

function withoutPaths(list, ...paths) {
  return list.filter((line) => !paths.some((p) => line.startsWith(`${p} `)));
}

// --- untouched right after init ------------------------------------------------

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: right after a real init, update writes nothing, exits 0, and calls every managed file current`, () => {
    const v = initVault(lang);
    const before = snapshot(v.vault);
    const check = update(v, ['--check']);
    assert.equal(check.status, EXIT.OK, check.stdout + check.stderr);
    assert.deepEqual(snapshot(v.vault), before);
    const r = update(v);
    assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
    assert.deepEqual(snapshot(v.vault), before, 'update right after init must not write a byte');
    const managed = readManifest(v.vault).files.filter((f) => f.class === 'managed').length;
    const seeded = readManifest(v.vault).files.filter((f) => f.class === 'seeded').length;
    assert.ok(managed >= 5 && seeded >= 20, `managed ${managed}, seeded ${seeded}`);
    const t = createTranslator(lang);
    assert.ok(
      r.stdout.includes(t('update.summary', { managed, refreshed: 0, current: managed, kept: 0, seeded, attention: 0 })),
      `the summary, in the vault's language, must count every managed file current:\n${r.stdout}`,
    );
  });
}

// --- untouched and older: refreshed ---------------------------------------------

test('an untouched managed file from an older kit is rewritten with this kit\'s version, stamped now, and its manifest hash updated', () => {
  const v = initVault();
  const older = makeOlder(v.vault, 'AGENTS.md');
  const before = snapshot(v.vault);
  const start = Math.floor(Date.now() / 1000) * 1000;
  const r = update(v);
  const end = Date.now();
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  says(r, 'update.refreshed', { file: 'AGENTS.md' });

  const now = readFileSync(join(v.vault, 'AGENTS.md'), 'utf8');
  assert.notDeepEqual(Buffer.from(now), older);
  const stamp = stampOf(now);
  const at = Date.parse(stamp);
  assert.ok(at >= start && at <= end, `generated.at ${stamp} is not the moment of the update`);
  assert.equal(now, stampGenerated(kitSkeleton('en', 'AGENTS.md'), stamp), 'the file is exactly this kit\'s version at that stamp');
  assert.equal(manifestEntry(v.vault, 'AGENTS.md').sha256, sha(Buffer.from(now)));
  assert.equal(manifestEntry(v.vault, 'AGENTS.md').class, 'managed');

  // Nothing else changed: only AGENTS.md and the manifest differ.
  assert.deepEqual(withoutPaths(snapshot(v.vault), 'AGENTS.md', MANIFEST_PATH), withoutPaths(before, 'AGENTS.md', MANIFEST_PATH));
  assert.ok(!existsSync(join(v.vault, `AGENTS.md${NEW_SUFFIX}`)));
  assert.deepEqual(readdirSync(v.vault).filter((n) => n.includes('brain-kit-tmp')), [], 'no temporary file is left behind');

  // And the next run finds it current.
  const again = update(v, ['--check']);
  assert.equal(again.status, EXIT.OK, again.stdout + again.stderr);
});

test('an untouched hook from an older kit is replaced by the template, byte for byte, and stays executable', () => {
  const v = initVault();
  makeOlder(v.vault, HOOK_PATH);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const hook = join(v.vault, HOOK_PATH);
  assert.deepEqual(readFileSync(hook), readFileSync(TEMPLATE_HOOK));
  assert.equal(statSync(hook).mode & 0o777, 0o755);
  assert.equal(manifestEntry(v.vault, HOOK_PATH).sha256, sha(readFileSync(TEMPLATE_HOOK)));
});

// --- edited: kept, new version beside it ---------------------------------------

test('an edited managed file keeps its bytes, and this kit\'s version is written beside it as .brain-kit-new, named, exit 3', () => {
  const v = initVault();
  const manifestBefore = readFileSync(join(v.vault, MANIFEST_PATH));
  makeOlder(v.vault, 'CONVENTIONS.md');
  const abs = join(v.vault, 'CONVENTIONS.md');
  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\nAna's own rule: every note links its source.\n`);
  const edited = readFileSync(abs);
  const manifestFixture = readFileSync(join(v.vault, MANIFEST_PATH));
  assert.notDeepEqual(manifestFixture, manifestBefore);

  const r = update(v);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(abs), edited, 'the person\'s bytes are kept');
  const beside = `${abs}${NEW_SUFFIX}`;
  assert.ok(existsSync(beside), 'the new version is written beside it');
  const offered = readFileSync(beside, 'utf8');
  assert.equal(offered, stampGenerated(kitSkeleton('en', 'CONVENTIONS.md'), stampOf(offered)));
  says(r, 'update.offered', { file: 'CONVENTIONS.md', new: `CONVENTIONS.md${NEW_SUFFIX}` });
  assert.deepEqual(readFileSync(join(v.vault, MANIFEST_PATH)), manifestFixture, 'the manifest is not rewritten for an offer');
});

test('an edited managed file the kit has nothing newer for is left alone, nothing beside it, exit 0, even with generated.at re-stamped', () => {
  const v = initVault();
  const abs = join(v.vault, 'AGENTS.md');
  // The edit an agent following the vault's own conventions makes: new
  // text, and generated.at moved to the moment of the edit.
  const text = readFileSync(abs, 'utf8').replace(/^(\s+at: ).*$/m, '$12030-01-01T00:00:00+00:00');
  writeFileSync(abs, `${text}\nAna's addition.\n`);
  // And one keeping the stamp, in another file.
  const claude = join(v.vault, 'CLAUDE.md');
  writeFileSync(claude, `${readFileSync(claude, 'utf8')}\nAna's other addition.\n`);
  const before = snapshot(v.vault);
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.OK, check.stdout + check.stderr);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  says(r, 'update.kept', { file: 'AGENTS.md' });
  says(r, 'update.kept', { file: 'CLAUDE.md' });
});

// --- seeded: never touched ------------------------------------------------------

test('a seeded file is never touched, even when it looks like an untouched managed file whose kit version differs', () => {
  const v = initVault();
  const path = 'core/identity.md';
  assert.equal(manifestEntry(v.vault, path)?.class, 'seeded', 'fixture: the note must be seeded');
  makeOlder(v.vault, path);
  const before = snapshot(v.vault);
  const mtime = statSync(join(v.vault, path)).mtimeMs;
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.OK, check.stdout + check.stderr);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  assert.equal(statSync(join(v.vault, path)).mtimeMs, mtime);
  assert.ok(!existsSync(join(v.vault, `${path}${NEW_SUFFIX}`)));
});

// --- deleted: reported, not recreated -------------------------------------------

test('a managed file that was deleted is reported and not recreated; --check exits 1 and a real run exits 3', () => {
  const v = initVault();
  unlinkSync(join(v.vault, 'SECURITY.md'));
  const before = snapshot(v.vault);
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.FAILURE, check.stdout + check.stderr);
  says(check, 'update.missing', { file: 'SECURITY.md' });
  const r = update(v);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  says(r, 'update.missing', { file: 'SECURITY.md' });
  assert.ok(!existsSync(join(v.vault, 'SECURITY.md')), 'not recreated');
  assert.ok(!existsSync(join(v.vault, `SECURITY.md${NEW_SUFFIX}`)), 'nothing written in its place either');
  assert.deepEqual(snapshot(v.vault), before);
});

// --- --check ---------------------------------------------------------------------

test('--check writes nothing and exits 1 with a refresh pending, then 0 once update has applied it', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const before = snapshot(v.vault);
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.FAILURE, check.stdout + check.stderr);
  says(check, 'update.would_refresh', { file: 'AGENTS.md' });
  assert.deepEqual(snapshot(v.vault), before, '--check writes nothing');
  assert.equal(update(v).status, EXIT.OK);
  const after = update(v, ['--check']);
  assert.equal(after.status, EXIT.OK, after.stdout + after.stderr);
});

test('--check writes nothing and exits 1 with an offer pending', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\nAna's line.\n`);
  const before = snapshot(v.vault);
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.FAILURE, check.stdout + check.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  says(check, 'update.would_offer', { file: 'AGENTS.md', new: `AGENTS.md${NEW_SUFFIX}` });
});

// --- the manifest: unreadable is a refusal --------------------------------------

const BAD_MANIFESTS = [
  ['missing', null],
  ['empty', ''],
  ['whitespace only', '  \n'],
  ['not JSON', '{ files: '],
  ['an array', '[]'],
  ['no entries', '{"files": []}'],
  ['an unknown key', '{"files": [{"path": "AGENTS.md", "sha256": "' + '0'.repeat(64) + '", "class": "managed", "extra": 1}]}'],
  ['a path leaving the vault', '{"files": [{"path": "../AGENTS.md", "sha256": "' + '0'.repeat(64) + '", "class": "managed"}]}'],
];

for (const [label, content] of BAD_MANIFESTS) {
  test(`a manifest that is ${label} is a refusal: exit 1, nothing written, with or without --check`, () => {
    const v = initVault();
    // A refresh would be pending if the manifest were read as "nothing
    // wrong": the refusal is what makes the exit code non-zero.
    makeOlder(v.vault, 'AGENTS.md');
    const file = join(v.vault, MANIFEST_PATH);
    if (content === null) unlinkSync(file);
    else writeFileSync(file, content);
    const before = snapshot(v.vault);
    for (const args of [[], ['--check']]) {
      const r = update(v, args);
      assert.equal(r.status, EXIT.FAILURE, `${args}: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /manifest\.json/);
      assert.deepEqual(snapshot(v.vault), before, 'nothing written');
    }
  });
}

test('a manifest that cannot be read (a directory in its place) is a refusal, exit 1, nothing written', () => {
  const v = initVault();
  const file = join(v.vault, MANIFEST_PATH);
  unlinkSync(file);
  mkdirSync(file);
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
});

// --- an existing .brain-kit-new is never overwritten ----------------------------

test('an existing .brain-kit-new is not overwritten: file, and link pointing nowhere', () => {
  for (const kind of ['file', 'dangling link']) {
    const v = initVault();
    makeOlder(v.vault, 'AGENTS.md');
    const abs = join(v.vault, 'AGENTS.md');
    writeFileSync(abs, `${readFileSync(abs, 'utf8')}\nAna's line.\n`);
    const beside = `${abs}${NEW_SUFFIX}`;
    const outside = join(v.base, 'outside-target');
    if (kind === 'file') writeFileSync(beside, 'Ana was half way through merging this.\n');
    else symlinkSync(outside, beside);
    const before = snapshot(v.vault);
    const check = update(v, ['--check']);
    assert.equal(check.status, EXIT.FAILURE, `${kind}: ${check.stdout}\n${check.stderr}`);
    says(check, 'update.offer_blocked', { file: 'AGENTS.md', new: `AGENTS.md${NEW_SUFFIX}` });
    const r = update(v);
    assert.equal(r.status, EXIT.DEGRADED, `${kind}: ${r.stdout}\n${r.stderr}`);
    assert.deepEqual(snapshot(v.vault), before, `${kind}: nothing written`);
    assert.ok(!existsSync(outside), `${kind}: nothing written through the link`);
    says(r, 'update.offer_blocked', { file: 'AGENTS.md', new: `AGENTS.md${NEW_SUFFIX}` });
  }
});

// --- links are never written through -------------------------------------------

test('a managed file that is a link is left alone, and so is its target, even when the link resolves to the recorded bytes', () => {
  const v = initVault();
  const older = makeOlder(v.vault, 'CLAUDE.md');
  const abs = join(v.vault, 'CLAUDE.md');
  const target = join(v.base, 'claude-elsewhere.md');
  writeFileSync(target, older);
  unlinkSync(abs);
  symlinkSync(target, abs);
  const before = snapshot(v.vault);
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.FAILURE, check.stdout + check.stderr);
  const r = update(v);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  assert.deepEqual(readFileSync(target), older);
  says(r, 'update.not_regular', { file: 'CLAUDE.md' });
});

test('a managed file reached through a linked directory is left alone, and nothing is written outside the vault', () => {
  const v = initVault();
  makeOlder(v.vault, HOOK_PATH);
  const outsideDir = join(v.base, 'hooks-elsewhere');
  renameSync(join(v.vault, '.githooks'), outsideDir);
  symlinkSync(outsideDir, join(v.vault, '.githooks'));
  const outsideBefore = snapshot(outsideDir);
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  assert.deepEqual(snapshot(outsideDir), outsideBefore);
  says(r, 'update.not_regular', { file: HOOK_PATH });
});

// --- a file that changes under update ------------------------------------------

function collector() {
  let text = '';
  return { write(chunk) { text += chunk; return true; }, get text() { return text; } };
}

test('a file edited between update reading it and replacing it keeps the person\'s bytes, and no temporary file is left', async () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  const edit = 'Ana saved this while update was running.\n';
  const stdout = collector();
  const stderr = collector();
  const code = await runUpdate([v.vault], { stdout, stderr }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: (path) => {
      if (path === 'AGENTS.md') writeFileSync(abs, edit);
    },
  });
  assert.equal(code, EXIT.DEGRADED, stdout.text + stderr.text);
  assert.equal(readFileSync(abs, 'utf8'), edit);
  assert.deepEqual(readdirSync(v.vault).filter((n) => n.includes('brain-kit-tmp')), []);
  assert.ok(stdout.text.includes(T('update.raced', { file: 'AGENTS.md' })), stdout.text);
});

test('a file replaced by a link between update reading it and replacing it keeps the link, and its target is untouched', async () => {
  const v = initVault();
  const older = makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  const target = join(v.base, 'agents-elsewhere.md');
  writeFileSync(target, older);
  const stdout = collector();
  const code = await runUpdate([v.vault], { stdout, stderr: collector() }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: (path) => {
      if (path === 'AGENTS.md') {
        unlinkSync(abs);
        symlinkSync(target, abs);
      }
    },
  });
  assert.equal(code, EXIT.DEGRADED, stdout.text);
  assert.ok(lstatSync(abs).isSymbolicLink(), 'the link is still a link');
  assert.deepEqual(readFileSync(target), older);
  assert.deepEqual(readdirSync(v.vault).filter((n) => n.includes('brain-kit-tmp')), []);
});

test('a .brain-kit-new that appears between update looking and writing is not overwritten', async () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\nAna's line.\n`);
  const beside = `${abs}${NEW_SUFFIX}`;
  const theirs = 'Written by another process in the gap.\n';
  const stdout = collector();
  const code = await runUpdate([v.vault], { stdout, stderr: collector() }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: (path) => {
      if (path === `AGENTS.md${NEW_SUFFIX}`) writeFileSync(beside, theirs);
    },
  });
  assert.equal(code, EXIT.DEGRADED, stdout.text);
  assert.equal(readFileSync(beside, 'utf8'), theirs);
  assert.ok(stdout.text.includes(T('update.offer_blocked', { file: 'AGENTS.md', new: `AGENTS.md${NEW_SUFFIX}` })), stdout.text);
});

test('a managed file that cannot be read is left alone: a real run exits 3, --check exits 1', { skip: process.getuid?.() === 0 ? 'root reads a mode 000 file' : false }, () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  chmodSync(abs, 0o000);
  try {
    const before = snapshot(join(v.vault, '.githooks'));
    const check = update(v, ['--check']);
    assert.equal(check.status, EXIT.FAILURE, check.stdout + check.stderr);
    const r = update(v);
    assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
    says(r, 'update.unreadable', { file: 'AGENTS.md', detail: 'EACCES' });
    assert.equal(statSync(abs).mode & 0o777, 0, 'not replaced');
    assert.deepEqual(snapshot(join(v.vault, '.githooks')), before);
  } finally {
    chmodSync(abs, 0o644);
  }
});

// A vault whose manifest manages only the hook, the shape an adopted vault
// can have: no managed note to read a stamp from.
function hookOnly(vault) {
  const file = join(vault, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  for (const entry of manifest.files) if (entry.path !== HOOK_PATH) entry.class = 'seeded';
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('an edited hook the kit has nothing newer for is kept, even with no managed note to read a stamp from', () => {
  const v = initVault();
  hookOnly(v.vault);
  const hook = join(v.vault, HOOK_PATH);
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n# Ana's local addition\n`);
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  says(r, 'update.kept', { file: HOOK_PATH });
});

test('an edited hook with a newer kit version keeps its bytes and mode, and gets the template beside it', () => {
  const v = initVault();
  hookOnly(v.vault);
  makeOlder(v.vault, HOOK_PATH);
  const hook = join(v.vault, HOOK_PATH);
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n# Ana's local addition\n`);
  const edited = readFileSync(hook);
  const r = update(v);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(hook), edited);
  assert.equal(statSync(hook).mode & 0o777, 0o755);
  assert.deepEqual(readFileSync(`${hook}${NEW_SUFFIX}`), readFileSync(TEMPLATE_HOOK));
  says(r, 'update.offered', { file: HOOK_PATH, new: `${HOOK_PATH}${NEW_SUFFIX}` });
});

test('a failed write is exit 1, and the manifest keeps the old hash for the file that was not replaced', async () => {
  const v = initVault();
  const older = makeOlder(v.vault, 'AGENTS.md');
  const stdout = collector();
  const stderr = collector();
  const code = await runUpdate([v.vault], { stdout, stderr }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: () => {
      throw new Error('disk full (simulated)');
    },
  });
  assert.equal(code, EXIT.FAILURE, stdout.text + stderr.text);
  assert.match(stderr.text, /disk full/);
  assert.deepEqual(readFileSync(join(v.vault, 'AGENTS.md')), older);
  assert.equal(manifestEntry(v.vault, 'AGENTS.md').sha256, sha(older));
  assert.deepEqual(readdirSync(v.vault).filter((n) => n.includes('brain-kit-tmp')), []);
});

// --- usage ----------------------------------------------------------------------

test('outside a vault, update exits 2; an unknown argument exits 2; --help exits 0', () => {
  const v = initVault();
  rmSync(join(v.vault, 'brain-kit.config.json'));
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  const w = initVault();
  assert.equal(update(w, ['--force']).status, EXIT.USAGE);
  const h = spawnSync(process.execPath, [BIN, 'update', '--help'], { encoding: 'utf8', env: env(w.state), cwd: w.cwd });
  assert.equal(h.status, EXIT.OK);
  assert.match(h.stdout, /--check/);
});

test('with no directory argument, update acts on the vault it is run from', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const r = spawnSync(process.execPath, [BIN, 'update', '--check'], { encoding: 'utf8', env: env(v.state), cwd: join(v.vault, 'core') });
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.match(r.stdout, /AGENTS\.md/);
});

test('every root contract file and the hook are managed, so the tests above cover what update refreshes', () => {
  const v = initVault();
  const managed = readManifest(v.vault).files.filter((f) => f.class === 'managed').map((f) => f.path).sort();
  assert.deepEqual(managed, [...ROOT_CONTRACT_FILES, HOOK_PATH].sort());
});

test('a manifest that changes while update runs is not overwritten, and the run exits 1 saying so', async () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const file = join(v.vault, MANIFEST_PATH);
  const stderr = collector();
  let theirs = null;
  const code = await runUpdate([v.vault], { stdout: collector(), stderr }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: () => {
      theirs = `${readFileSync(file, 'utf8')}\n`;
      writeFileSync(file, theirs);
    },
  });
  assert.equal(code, EXIT.FAILURE, stderr.text);
  assert.equal(readFileSync(file, 'utf8'), theirs);
  assert.match(stderr.text, /manifest\.json/);
  assert.deepEqual(readdirSync(join(v.vault, '.brain-kit')), ['manifest.json'], 'no temporary file is left');
});

test('a refreshed file carries the moment of the update in generated.at, not the stamp it had', async () => {
  const v = initVault();
  makeOlder(v.vault, 'CONVENTIONS.md');
  const stamp = '2031-02-03T04:05:06+00:00';
  const stdout = collector();
  const code = await runUpdate([v.vault], { stdout, stderr: collector() }, createTranslator('en'), {
    cwd: v.cwd,
    now: () => new Date(Date.parse(stamp)),
  });
  assert.equal(code, EXIT.OK, stdout.text);
  const text = readFileSync(join(v.vault, 'CONVENTIONS.md'), 'utf8');
  assert.equal(text, stampGenerated(kitSkeleton('en', 'CONVENTIONS.md'), stamp));
});
