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
  says(r, 'update.offered', { file: 'CONVENTIONS.md', new: `CONVENTIONS.md${NEW_SUFFIX}`, command: 'brain-kit update --accept CONVENTIONS.md' });
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
  says(check, 'update.missing', { file: 'SECURITY.md', command: 'brain-kit update --accept SECURITY.md' });
  const r = update(v);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  says(r, 'update.missing', { file: 'SECURITY.md', command: 'brain-kit update --accept SECURITY.md' });
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
    says(check, 'update.offer_blocked', { file: 'AGENTS.md', new: `AGENTS.md${NEW_SUFFIX}`, command: 'brain-kit update --accept AGENTS.md' });
    const r = update(v);
    assert.equal(r.status, EXIT.DEGRADED, `${kind}: ${r.stdout}\n${r.stderr}`);
    assert.deepEqual(snapshot(v.vault), before, `${kind}: nothing written`);
    assert.ok(!existsSync(outside), `${kind}: nothing written through the link`);
    says(r, 'update.offer_blocked', { file: 'AGENTS.md', new: `AGENTS.md${NEW_SUFFIX}`, command: 'brain-kit update --accept AGENTS.md' });
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
  assert.ok(stdout.text.includes(T('update.offer_blocked', { file: 'AGENTS.md', new: `AGENTS.md${NEW_SUFFIX}`, command: 'brain-kit update --accept AGENTS.md' })), stdout.text);
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
  says(r, 'update.offered', { file: HOOK_PATH, new: `${HOOK_PATH}${NEW_SUFFIX}`, command: `brain-kit update --accept ${HOOK_PATH}` });
  assert.equal(statSync(`${hook}${NEW_SUFFIX}`).mode & 0o777, 0o755, 'the offered hook has the hook\'s mode, so taking it wholesale keeps the gate running');
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

// --- fix round 1 ------------------------------------------------------------------

function crlf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

function edit(abs, line) {
  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n${line}\n`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function setConfig(vault, key, value) {
  const file = join(vault, 'brain-kit.config.json');
  const config = readJson(file);
  config[key] = value;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

// Line endings.

test('a CRLF checkout of an untouched file with the kit unchanged is current: nothing written, exit 0', () => {
  const v = initVault();
  const abs = join(v.vault, 'AGENTS.md');
  writeFileSync(abs, crlf(readFileSync(abs, 'utf8')));
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  assert.equal(update(v, ['--check']).status, EXIT.OK);
});

test('a CRLF checkout of an untouched file from an older kit is refreshed, in CRLF, and the manifest records the LF hash', () => {
  const v = initVault();
  const older = makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  writeFileSync(abs, crlf(older.toString('utf8')));
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  says(r, 'update.refreshed', { file: 'AGENTS.md' });
  const now = readFileSync(abs, 'utf8');
  assert.ok(now.includes('\r\n') && !/[^\r]\n/.test(now), 'every line ends in CRLF');
  const asLf = now.replace(/\r\n/g, '\n');
  assert.equal(asLf, stampGenerated(kitSkeleton('en', 'AGENTS.md'), stampOf(asLf)));
  assert.equal(manifestEntry(v.vault, 'AGENTS.md').sha256, sha(Buffer.from(asLf)));
  assert.equal(update(v, ['--check']).status, EXIT.OK);
});

test('an edited CRLF file with a newer kit version keeps its bytes, and the offer beside it is in CRLF', () => {
  const v = initVault();
  const older = makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  writeFileSync(abs, crlf(`${older.toString('utf8')}\nAna's line.\n`));
  const edited = readFileSync(abs);
  const r = update(v);
  assert.equal(r.status, EXIT.DEGRADED, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(abs), edited);
  const offered = readFileSync(`${abs}${NEW_SUFFIX}`, 'utf8');
  assert.ok(offered.includes('\r\n') && !/[^\r]\n/.test(offered));
});

// --accept.

test('--accept after a hand merge that kept a line of the person\'s: the offer goes, the file is untouched, and the next run keeps it', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  edit(abs, "Ana's own rule.");
  assert.equal(update(v).status, EXIT.DEGRADED);
  // The merge: the kit's new text, with Ana's rule carried over.
  const offered = readFileSync(`${abs}${NEW_SUFFIX}`, 'utf8');
  writeFileSync(abs, `${offered}\nAna's own rule.\n`);
  const merged = readFileSync(abs);
  const a = update(v, ['--accept', 'AGENTS.md']);
  assert.equal(a.status, EXIT.OK, a.stdout + a.stderr);
  says(a, 'update.accept_recorded', { file: 'AGENTS.md' });
  says(a, 'update.accept_removed_new', { new: `AGENTS.md${NEW_SUFFIX}` });
  assert.ok(!existsSync(`${abs}${NEW_SUFFIX}`));
  assert.deepEqual(readFileSync(abs), merged);
  // The baseline is the kit's version, never the merged file: with the
  // merged file as baseline the next run would read it as untouched and
  // replace it, deleting Ana's rule.
  assert.equal(manifestEntry(v.vault, 'AGENTS.md').sha256, sha(Buffer.from(offered)));
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  says(r, 'update.kept', { file: 'AGENTS.md' });
  assert.deepEqual(snapshot(v.vault), before);
  assert.equal(update(v, ['--check']).status, EXIT.OK);
});

test('--accept after taking the offer wholesale records the file\'s own hash, and the file then reads as current', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  edit(abs, "Ana's line.");
  assert.equal(update(v).status, EXIT.DEGRADED);
  renameSync(`${abs}${NEW_SUFFIX}`, abs);
  // Named by the offer's own path, which is accepted too.
  const a = update(v, ['--accept', `AGENTS.md${NEW_SUFFIX}`]);
  assert.equal(a.status, EXIT.OK, a.stdout + a.stderr);
  assert.equal(manifestEntry(v.vault, 'AGENTS.md').sha256, sha(readFileSync(abs)));
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(T('update.summary', { managed: 5, refreshed: 0, current: 5, kept: 0, seeded: 27, attention: 0 })), r.stdout);
});

test('--accept clears a blocked offer, so the loop of "run update again" ends', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  edit(abs, "Ana's line.");
  writeFileSync(`${abs}${NEW_SUFFIX}`, 'Ana was half way through this.\n');
  assert.equal(update(v).status, EXIT.DEGRADED);
  const edited = readFileSync(abs);
  assert.equal(update(v, ['--accept', 'AGENTS.md']).status, EXIT.OK);
  assert.ok(!existsSync(`${abs}${NEW_SUFFIX}`));
  assert.deepEqual(readFileSync(abs), edited);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  says(r, 'update.kept', { file: 'AGENTS.md' });
});

test('--accept of a deleted managed file drops it from the manifest, and update stops reporting it', () => {
  const v = initVault();
  unlinkSync(join(v.vault, 'SECURITY.md'));
  const count = readManifest(v.vault).files.length;
  const a = update(v, ['--accept', 'SECURITY.md']);
  assert.equal(a.status, EXIT.OK, a.stdout + a.stderr);
  says(a, 'update.accept_dropped', { file: 'SECURITY.md' });
  assert.equal(readManifest(v.vault).files.length, count - 1);
  assert.equal(manifestEntry(v.vault, 'SECURITY.md'), undefined);
  assert.equal(readManifest(v.vault).lang, 'en', 'the manifest keeps its language');
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.ok(!existsSync(join(v.vault, 'SECURITY.md')));
});

test('--accept of a hook that is not executable is refused with nothing written, and accepted once it is', () => {
  const v = initVault();
  hookOnly(v.vault);
  makeOlder(v.vault, HOOK_PATH);
  const hook = join(v.vault, HOOK_PATH);
  edit(hook, "# Ana's local addition");
  assert.equal(update(v).status, EXIT.DEGRADED);
  renameSync(`${hook}${NEW_SUFFIX}`, hook);
  chmodSync(hook, 0o644);
  const before = snapshot(v.vault);
  const a = update(v, ['--accept', HOOK_PATH]);
  assert.equal(a.status, EXIT.FAILURE, a.stdout + a.stderr);
  assert.ok(a.stderr.includes(T('update.accept_not_executable', { file: HOOK_PATH, command: `chmod +x ${HOOK_PATH}` })), a.stderr);
  assert.deepEqual(snapshot(v.vault), before);
  chmodSync(hook, 0o744);
  assert.equal(update(v, ['--accept', HOOK_PATH]).status, EXIT.OK);
  assert.equal(manifestEntry(v.vault, HOOK_PATH).sha256, sha(readFileSync(TEMPLATE_HOOK)));
});

test('--accept refuses a seeded note, a path outside the vault, a linked managed file, and --check alongside, writing nothing', () => {
  const v = initVault();
  const claude = join(v.vault, 'CLAUDE.md');
  const target = join(v.base, 'claude-elsewhere.md');
  writeFileSync(target, readFileSync(claude));
  unlinkSync(claude);
  symlinkSync(target, claude);
  const before = snapshot(v.vault);
  const outsideRun = update(v, ['--accept', '../answers.json']);
  assert.ok(outsideRun.stderr.includes(T('update.accept_outside', { path: '../answers.json' })), outsideRun.stderr);
  const linkedRun = update(v, ['--accept', 'CLAUDE.md']);
  assert.ok(linkedRun.stderr.includes(T('update.not_regular', { file: 'CLAUDE.md' })), linkedRun.stderr);
  for (const [args, code] of [
    [['--accept', 'core/identity.md'], EXIT.USAGE],
    [['--accept', '../answers.json'], EXIT.USAGE],
    [['--accept', 'no-such-file.md'], EXIT.USAGE],
    [['--accept', 'CLAUDE.md'], EXIT.FAILURE],
    [['--accept', 'AGENTS.md', '--check'], EXIT.USAGE],
    [['--accept'], EXIT.USAGE],
    [['--accept', 'AGENTS.md', '--accept', 'CLAUDE.md'], EXIT.USAGE],
  ]) {
    const r = update(v, args);
    assert.equal(r.status, code, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
    assert.deepEqual(snapshot(v.vault), before, args.join(' '));
  }
  assert.deepEqual(readFileSync(target), readFileSync(target));
});

test('--accept with nothing to accept writes nothing and says so', () => {
  const v = initVault();
  const before = snapshot(v.vault);
  const a = update(v, ['--accept', 'AGENTS.md']);
  assert.equal(a.status, EXIT.OK, a.stdout + a.stderr);
  says(a, 'update.accept_nothing', { file: 'AGENTS.md' });
  assert.deepEqual(snapshot(v.vault), before);
});

// Kit version.

test('a kit older than the configuration\'s kit_version is refused in every mode, nothing written', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  unlinkSync(join(v.vault, 'SECURITY.md'));
  setConfig(v.vault, 'kit_version', '0.0.2');
  const before = snapshot(v.vault);
  for (const args of [[], ['--check'], ['--accept', 'SECURITY.md']]) {
    const r = update(v, args);
    assert.equal(r.status, EXIT.FAILURE, `${args}: ${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(T('update.kit_older', { running: '0.0.1', configured: '0.0.2' })), r.stderr);
    assert.deepEqual(snapshot(v.vault), before);
  }
});

test('a kit newer than the configuration\'s kit_version sets it after a run, the rest of the file byte for byte; --check reports it and writes nothing', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const file = join(v.vault, 'brain-kit.config.json');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('"kit_version": "0.0.1"', '"kit_version": "0.0.0"'));
  const before = snapshot(v.vault);
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.FAILURE, check.stdout + check.stderr);
  says(check, 'update.would_bump', { from: '0.0.0', to: '0.0.1' });
  assert.deepEqual(snapshot(v.vault), before);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  says(r, 'update.bumped', { from: '0.0.0', to: '0.0.1' });
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(update(v, ['--check']).status, EXIT.OK);
});

test('with only the kit version newer, --check exits 1 and a real run sets it', () => {
  const v = initVault();
  setConfig(v.vault, 'kit_version', '0.0.1-rc.1');
  assert.equal(update(v, ['--check']).status, EXIT.FAILURE);
  assert.equal(update(v).status, EXIT.OK);
  assert.equal(readJson(join(v.vault, 'brain-kit.config.json')).kit_version, '0.0.1');
});

test('kit_version is not set when a write failed', async () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  setConfig(v.vault, 'kit_version', '0.0.0');
  const code = await runUpdate([v.vault], { stdout: collector(), stderr: collector() }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: (path) => {
      if (path === 'AGENTS.md') throw new Error('disk full (simulated)');
    },
  });
  assert.equal(code, EXIT.FAILURE);
  assert.equal(readJson(join(v.vault, 'brain-kit.config.json')).kit_version, '0.0.0');
});

test('compareVersions orders by x.y.z, a pre-release below its release, and knows nothing of what is not a version', async () => {
  const { compareVersions } = await import('../src/commands/update.mjs');
  assert.equal(compareVersions('0.0.1', '0.0.1'), 0);
  assert.equal(compareVersions('0.0.1', '0.0.2'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('x', '1.0.0'), null);
});

// The manifest's location, before the first write.

test('a .brain-kit linked outside the vault is refused before any write, and nothing outside changes', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const outside = join(v.base, 'bk-elsewhere');
  renameSync(join(v.vault, '.brain-kit'), outside);
  symlinkSync(outside, join(v.vault, '.brain-kit'));
  const before = snapshot(v.vault);
  const outsideBefore = snapshot(outside);
  for (const args of [[], ['--check'], ['--accept', 'AGENTS.md']]) {
    const r = update(v, args);
    assert.equal(r.status, EXIT.FAILURE, `${args}: ${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(T('update.manifest_outside', { file: join(v.vault, MANIFEST_PATH) })), r.stderr);
    assert.deepEqual(snapshot(v.vault), before);
    assert.deepEqual(snapshot(outside), outsideBefore);
  }
});

test('a manifest that is itself a link is refused before any write', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const file = join(v.vault, MANIFEST_PATH);
  const real = join(v.vault, '.brain-kit', 'real.json');
  renameSync(file, real);
  symlinkSync(real, file);
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(T('update.manifest_not_regular', { file })), r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
});

test('a manifest directory that is not writable is refused before any write', { skip: process.getuid?.() === 0 ? 'root writes anywhere' : false }, () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const dir = join(v.vault, '.brain-kit');
  chmodSync(dir, 0o555);
  try {
    const before = snapshot(v.vault);
    const r = update(v);
    assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(T('update.manifest_not_writable', { dir })), r.stderr);
    assert.deepEqual(snapshot(v.vault), before);
  } finally {
    chmodSync(dir, 0o755);
  }
});

// The offered file's mode.

test('an offer carries the managed file\'s own mode, under any umask', async () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const abs = join(v.vault, 'AGENTS.md');
  edit(abs, "Ana's line.");
  chmodSync(abs, 0o640);
  const previous = process.umask(0o077);
  try {
    const code = await runUpdate([v.vault], { stdout: collector(), stderr: collector() }, createTranslator('en'), { cwd: v.cwd });
    assert.equal(code, EXIT.DEGRADED);
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(`${abs}${NEW_SUFFIX}`).mode & 0o777, 0o640);
});

// Language.

test('init records the language in the manifest, and a changed lang is refused in every mode, nothing written', () => {
  for (const lang of ['en', 'pt-BR']) {
    const v = initVault(lang);
    assert.equal(readManifest(v.vault).lang, lang);
    makeOlder(v.vault, 'AGENTS.md');
    const other = lang === 'en' ? 'pt-BR' : 'en';
    setConfig(v.vault, 'lang', other);
    const before = snapshot(v.vault);
    for (const args of [[], ['--check'], ['--accept', 'AGENTS.md']]) {
      const r = update(v, args);
      assert.equal(r.status, EXIT.FAILURE, `${lang} ${args}: ${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes(createTranslator(other)('update.lang_changed', { recorded: lang, configured: other })), r.stderr);
      assert.deepEqual(snapshot(v.vault), before);
    }
  }
});

test('a manifest written before it recorded a language still reads, and update proceeds with the configuration\'s', () => {
  const v = initVault();
  const file = join(v.vault, MANIFEST_PATH);
  const manifest = readJson(file);
  delete manifest.lang;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  makeOlder(v.vault, 'AGENTS.md');
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  says(r, 'update.refreshed', { file: 'AGENTS.md' });
  assert.equal(Object.hasOwn(readJson(file), 'lang'), false, 'update does not invent a language the manifest never recorded');
});

// .gitignore.

test('a vault from init ignores offered files and update\'s temporary files', () => {
  const v = initVault();
  const r = spawnSync('git', ['check-ignore', '--no-index', 'AGENTS.md.brain-kit-new', '.githooks/pre-push.brain-kit-new', '.AGENTS.md.brain-kit-tmp-12-ab', '.brain-kit/.manifest.json.brain-kit-tmp-1-a'], { cwd: v.vault, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 4, r.stdout);
  const n = spawnSync('git', ['check-ignore', '--no-index', 'AGENTS.md'], { cwd: v.vault, encoding: 'utf8' });
  assert.equal(n.status, 1, 'the managed file itself is not ignored');
});

// The clauses the review found undefended.

test('a failed write outranks a file that needs the person: exit 1, not 3', async () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  unlinkSync(join(v.vault, 'CLAUDE.md'));
  const stdout = collector();
  const code = await runUpdate([v.vault], { stdout, stderr: collector() }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: () => {
      throw new Error('disk full (simulated)');
    },
  });
  assert.equal(code, EXIT.FAILURE, stdout.text);
  assert.ok(stdout.text.includes(T('update.missing', { file: 'CLAUDE.md', command: 'brain-kit update --accept CLAUDE.md' })));
});

test('a managed file this kit no longer ships is left alone: exit 0, --check 0', () => {
  const v = initVault();
  writeFileSync(join(v.vault, 'EXTRA.md'), 'A file an older kit managed.\n');
  const file = join(v.vault, MANIFEST_PATH);
  const manifest = readJson(file);
  manifest.files.push({ path: 'EXTRA.md', sha256: '0'.repeat(64), class: 'managed' });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const before = snapshot(v.vault);
  const check = update(v, ['--check']);
  assert.equal(check.status, EXIT.OK, check.stdout + check.stderr);
  const r = update(v);
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  says(r, 'update.not_in_kit', { file: 'EXTRA.md' });
  assert.deepEqual(snapshot(v.vault), before);
});

test('a refresh under umask 077 keeps each file\'s own mode', async () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  makeOlder(v.vault, HOOK_PATH);
  chmodSync(join(v.vault, 'AGENTS.md'), 0o644);
  const previous = process.umask(0o077);
  try {
    const code = await runUpdate([v.vault], { stdout: collector(), stderr: collector() }, createTranslator('en'), { cwd: v.cwd });
    assert.equal(code, EXIT.OK);
  } finally {
    process.umask(previous);
  }
  assert.equal(statSync(join(v.vault, 'AGENTS.md')).mode & 0o777, 0o644);
  assert.equal(statSync(join(v.vault, HOOK_PATH)).mode & 0o777, 0o755);
});

test('--check\'s summary says what would be updated, never that anything was', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const check = update(v, ['--check']);
  says(check, 'update.check_summary', { managed: 5, refreshed: 1, current: 4, kept: 0, seeded: 27, attention: 0 });
  assert.ok(!check.stdout.includes(T('update.summary', { managed: 5, refreshed: 1, current: 4, kept: 0, seeded: 27, attention: 0 })));
});

// A directory swapped for a link between the read and the write.

test('a directory swapped for a link to outside the vault just before a refresh or an offer: nothing is written outside', async () => {
  for (const kind of ['refresh', 'offer']) {
    const v = initVault();
    hookOnly(v.vault);
    makeOlder(v.vault, HOOK_PATH);
    const hook = join(v.vault, HOOK_PATH);
    if (kind === 'offer') edit(hook, "# Ana's line");
    const outside = join(v.base, 'hooks-moved');
    let outsideBefore = null;
    const stdout = collector();
    const code = await runUpdate([v.vault], { stdout, stderr: collector() }, createTranslator('en'), {
      cwd: v.cwd,
      beforeWrite: () => {
        renameSync(join(v.vault, '.githooks'), outside);
        symlinkSync(outside, join(v.vault, '.githooks'));
        outsideBefore = snapshot(outside).filter((line) => !line.includes('brain-kit-tmp'));
      },
    });
    assert.equal(code, EXIT.DEGRADED, `${kind}: ${stdout.text}`);
    assert.deepEqual(snapshot(outside), outsideBefore, `${kind}: nothing written outside`);
    assert.ok(stdout.text.includes(T('update.raced', { file: HOOK_PATH })), stdout.text);
  }
});

test('a configuration update cannot edit, with a newer kit, is refused before any write', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const file = join(v.vault, 'brain-kit.config.json');
  const text = readFileSync(file, 'utf8').replace('"kit_version": "0.0.1"', '"kit_version": "0.0.0"');
  const real = join(v.base, 'config-elsewhere.json');
  writeFileSync(real, text);
  unlinkSync(file);
  symlinkSync(real, file);
  const before = snapshot(v.vault);
  for (const args of [[], ['--check']]) {
    const r = update(v, args);
    assert.equal(r.status, EXIT.FAILURE, `${args}: ${r.stdout}\n${r.stderr}`);
    assert.ok(r.stderr.includes(T('update.config_not_editable', { file })), r.stderr);
    assert.deepEqual(snapshot(v.vault), before);
  }
  assert.equal(readFileSync(real, 'utf8'), text);
});

test('a configuration that changes while update runs is not overwritten, and kit_version is left for the next run', async () => {
  const v = initVault();
  setConfig(v.vault, 'kit_version', '0.0.0');
  const file = join(v.vault, 'brain-kit.config.json');
  let theirs = null;
  const stderr = collector();
  const code = await runUpdate([v.vault], { stdout: collector(), stderr }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: (path) => {
      if (path === 'brain-kit.config.json') {
        theirs = `${readFileSync(file, 'utf8')}\n`;
        writeFileSync(file, theirs);
      }
    },
  });
  assert.equal(code, EXIT.FAILURE, stderr.text);
  assert.equal(readFileSync(file, 'utf8'), theirs);
});

test('a configuration holding a second kit_version key elsewhere is refused before any write, and neither is changed', () => {
  const v = initVault();
  makeOlder(v.vault, 'AGENTS.md');
  const file = join(v.vault, 'brain-kit.config.json');
  const config = readJson(file);
  config.kit_version = '0.0.0';
  config.taxonomy.columns.followups.labels.kit_version = '0.0.0';
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const before = snapshot(v.vault);
  const r = update(v);
  assert.equal(r.status, EXIT.FAILURE, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(T('update.config_not_editable', { file })), r.stderr);
  assert.deepEqual(snapshot(v.vault), before);
});

test('--accept does not overwrite a manifest that changed while it ran', async () => {
  const v = initVault();
  unlinkSync(join(v.vault, 'SECURITY.md'));
  const file = join(v.vault, MANIFEST_PATH);
  let theirs = null;
  const stderr = collector();
  const code = await runUpdate([v.vault, '--accept', 'SECURITY.md'], { stdout: collector(), stderr }, createTranslator('en'), {
    cwd: v.cwd,
    beforeWrite: () => {
      theirs = `${readFileSync(file, 'utf8')}\n`;
      writeFileSync(file, theirs);
    },
  });
  assert.equal(code, EXIT.FAILURE, stderr.text);
  assert.equal(readFileSync(file, 'utf8'), theirs);
  assert.ok(manifestEntry(v.vault, 'SECURITY.md'), 'the entry is still there');
});
