// `brain-kit prompt`: renders a skill body, in the vault's own language,
// for the plugin's SKILL.md files (docs/superpowers/plans/
// 2026-09-24-phase-1e-plugin-surface.md, task 3).
//
// Real vaults are built with `init --yes`, one per language, under a
// temporary directory; the state directory is always pinned so nothing
// here touches the real machine's own state. `--check`'s scratch-copy
// tests point `packsDir` (an injected parameter, never an environment
// variable) at a throwaway copy of lang/, so a missing body or an
// unknown placeholder can be proved without ever editing the real packs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { runPrompt, SKILL_NAMES } from '../src/commands/prompt.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

function testEnv(state, extra = {}) {
  return {
    ...process.env, BRAIN_KIT_STATE_DIR: state, USER: 'ana', LOGNAME: 'ana', TZ: 'UTC',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

function freshVault(lang) {
  const base = makeTempDir('brain-kit-prompt-');
  const vault = join(base, 'vault');
  const state = join(base, 'state');
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], {
    encoding: 'utf8', env: testEnv(state), cwd: base,
  });
  assert.equal(r.status, 0, `init failed: ${r.stdout}${r.stderr}`);
  return { vault, state };
}

function collector() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (chunk) => { out += chunk; return true; } },
      stderr: { write: (chunk) => { err += chunk; return true; } },
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

function noopT(lang = 'en') {
  return createTranslator(lang);
}

const KNOWN_PLACEHOLDER_NAMES = ['today', 'today_iso', 'vault', 'log', 'capture_marker', 'human', 'agent', 'kit'];

function assertEveryPlaceholderResolved(text, names = KNOWN_PLACEHOLDER_NAMES) {
  for (const name of names) {
    assert.doesNotMatch(text, new RegExp(`\\{\\{${name}\\}\\}`), `{{${name}}} was left unresolved in:\n${text}`);
  }
}

test('SKILL_NAMES lists exactly the nine skills, in order', () => {
  assert.deepEqual([...SKILL_NAMES], ['setup', 'curate-session', 'capture', 'ask', 'lint', 'review-stale', 'approve', 'seed-rituals', 'briefing']);
});

// Phase 4, task 4: the briefing's body says only that the briefing below
// is the session's instructions, and what to do when it is the one line
// saying it could not be loaded.
test('the briefing body renders in both languages, under 60 lines, naming the kit\'s doctor for the could-not-load line', async () => {
  const words = {
    en: [/The briefing below, printed by the kit, is this session's instructions/, /a single line saying the briefing could not be loaded or prepared, or that no vault was found/, /and stop\. Write no file\./],
    'pt-BR': [/O briefing abaixo, impresso pelo kit, é a instrução desta sessão/, /uma única linha dizendo que o briefing não pôde ser carregado ou preparado, ou que nenhum vault foi encontrado/, /e pare\. Não escreva nenhum arquivo\./],
  };
  for (const [lang, patterns] of Object.entries(words)) {
    const { vault, state } = freshVault(lang);
    const c = collector();
    const code = await runPrompt(['skill', 'briefing'], c.io, noopT(), { cwd: vault, env: testEnv(state) });
    assert.equal(code, EXIT.OK, `${lang}: ${c.stdout}${c.stderr}`);
    assert.equal(c.stderr, '', lang);
    assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/, lang);
    assert.ok(c.stdout.split('\n').length < 60, lang);
    for (const pattern of patterns) assert.match(c.stdout, pattern, lang);
    assert.match(c.stdout, /`node "[^"]+bin[/\\]brain-kit\.mjs" doctor`/, lang);
  }
});

test('the seed-rituals body renders in both languages inside a vault, every placeholder resolved, the four weeks ending today', async () => {
  const expected = { en: /Today is 25\/09\/2026\./, 'pt-BR': /Hoje é 25\/09\/2026\./ };
  for (const [lang, today] of Object.entries(expected)) {
    const { vault, state } = freshVault(lang);
    const c = collector();
    const code = await runPrompt(['skill', 'seed-rituals'], c.io, noopT(), {
      cwd: vault, env: testEnv(state), now: new Date(2026, 8, 25, 10, 0, 0),
    });
    assert.equal(code, EXIT.OK, `${lang}: ${c.stdout}${c.stderr}`);
    assert.equal(c.stderr, '', lang);
    assertEveryPlaceholderResolved(c.stdout);
    assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/, `${lang}: unresolved placeholder`);
    assert.match(c.stdout, today, lang);
    // The window's end is today's own date, rendered from {{today_iso}}.
    assert.match(c.stdout, /2026-09-25T00:00:00/, lang);
    assert.match(c.stdout, /node "[^"]+bin[/\\]brain-kit\.mjs" propose "<[^>]+>" --only /, lang);
    // A title holding a privacy keyword never becomes a row (review M2 of task 7).
    assert.ok(c.stdout.includes('`privacy.third_party_keywords`'), `${lang}: the privacy keywords are named`);
  }
});

test('renders the capture skill in pt-BR inside a pt-BR vault', async () => {
  const { vault, state } = freshVault('pt-BR');
  const c = collector();
  const code = await runPrompt(['skill', 'capture'], c.io, noopT(), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.equal(c.stderr, '');
  assertEveryPlaceholderResolved(c.stdout);
  assert.match(c.stdout, /Hoje é/);
  assert.match(c.stdout, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(c.stdout, /memoria\/log\.md/);
  assert.match(c.stdout, /Captura/);
});

test('renders the capture skill in en inside an en vault', async () => {
  const { vault, state } = freshVault('en');
  const c = collector();
  const code = await runPrompt(['skill', 'capture'], c.io, noopT(), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.equal(c.stderr, '');
  assertEveryPlaceholderResolved(c.stdout);
  assert.match(c.stdout, /Today is/);
  assert.match(c.stdout, /memory\/log\.md/);
  assert.match(c.stdout, /Capture/);
});

test('every skill renders in both languages inside a vault with every placeholder resolved, and the actors come from the vault', async () => {
  for (const lang of ['pt-BR', 'en']) {
    const { vault, state } = freshVault(lang);
    let all = '';
    for (const name of SKILL_NAMES) {
      const c = collector();
      const code = await runPrompt(['skill', name], c.io, noopT(), { cwd: vault, env: testEnv(state) });
      assert.equal(code, EXIT.OK, `${lang} ${name}: ${c.stdout}${c.stderr}`);
      assert.equal(c.stderr, '');
      assertEveryPlaceholderResolved(c.stdout);
      assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/, `${lang} ${name}: unresolved placeholder`);
      all += c.stdout;
    }
    assert.match(all, /human:ana/, lang);
    assert.match(all, /brain-kit-curator\/<model>/, lang);
  }
});

test('renders outside a vault, by the locale, falling back to pack defaults', async () => {
  const outside = makeTempDir('brain-kit-prompt-outside-');
  const c = collector();
  const code = await runPrompt(['skill', 'capture'], c.io, noopT(), {
    cwd: outside, env: { ...process.env, BRAIN_KIT_LANG: 'pt-BR' },
  });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assertEveryPlaceholderResolved(c.stdout);
  assert.match(c.stdout, /Hoje é/);
  // No vault: the "vault" placeholder holds the translated words for
  // "no vault found", never a literal path.
  assert.match(c.stdout, /nenhum vault encontrado/);
  // No config either: the log and marker fall back to the pack's own
  // default configuration (lang/pt-BR/config.defaults.json).
  assert.match(c.stdout, /memoria\/log\.md/);
  assert.match(c.stdout, /Captura/);

  const c2 = collector();
  const code2 = await runPrompt(['skill', 'capture'], c2.io, noopT(), {
    cwd: outside, env: { ...process.env, BRAIN_KIT_LANG: 'en' },
  });
  assert.equal(code2, EXIT.OK, c2.stdout + c2.stderr);
  assertEveryPlaceholderResolved(c2.stdout);
  assert.match(c2.stdout, /Today is/);
  assert.match(c2.stdout, /no vault found/);
  assert.match(c2.stdout, /memory\/log\.md/);
});

test('outside a vault a vault-only skill starts with one line saying to write nothing and suggesting setup; setup itself does not', async () => {
  const outside = makeTempDir('brain-kit-prompt-outside-');
  const expected = {
    en: /^No brain-kit vault was found from .+: do not write any file; tell the person no vault was found here, and suggest opening the session inside the vault or running the setup skill\.\n\n/,
    'pt-BR': /^Nenhum vault do brain-kit foi encontrado a partir de .+: não escreva nenhum arquivo; diga à pessoa que não há vault aqui e sugira abrir a sessão dentro do vault ou rodar a skill setup\.\n\n/,
  };
  for (const [lang, pattern] of Object.entries(expected)) {
    for (const name of SKILL_NAMES.filter((n) => n !== 'setup')) {
      const c = collector();
      const code = await runPrompt(['skill', name], c.io, noopT(), { cwd: outside, env: { ...process.env, BRAIN_KIT_LANG: lang } });
      assert.equal(code, EXIT.OK, c.stdout + c.stderr);
      assert.match(c.stdout, pattern, `${lang} ${name}`);
      assert.ok(c.stdout.split('\n')[0].includes(outside), `${lang} ${name} names the directory`);
    }
    const c = collector();
    await runPrompt(['skill', 'setup'], c.io, noopT(), { cwd: outside, env: { ...process.env, BRAIN_KIT_LANG: lang } });
    assert.doesNotMatch(c.stdout, pattern, `${lang} setup`);
    assert.doesNotMatch(c.stdout, /No brain-kit vault was found|Nenhum vault do brain-kit/, `${lang} setup`);
  }
  // Inside a vault no skill carries the line.
  for (const lang of ['en', 'pt-BR']) {
    const { vault, state } = freshVault(lang);
    const c = collector();
    await runPrompt(['skill', 'capture'], c.io, noopT(), { cwd: vault, env: testEnv(state) });
    assert.doesNotMatch(c.stdout, /No brain-kit vault was found|Nenhum vault do brain-kit/, lang);
  }
});

test('{{kit}} names an existing file, quoted, and survives a path with a space', async () => {
  const spacedBase = mkdtempSync(join(tmpdir(), 'brain kit prompt '));
  try {
    const c = collector();
    const code = await runPrompt(['skill', 'setup'], c.io, noopT(), {
      cwd: spacedBase, env: { ...process.env, BRAIN_KIT_LANG: 'en' },
    });
    assert.equal(code, EXIT.OK, c.stdout + c.stderr);
    const match = /Run the kit with: node "([^"]+)"/.exec(c.stdout);
    assert.ok(match, `expected a quoted kit command in:\n${c.stdout}`);
    assert.ok(existsSync(match[1]), `${match[1]} must be a real file`);
    assert.match(match[1], /bin[/\\]brain-kit\.mjs$/);
  } finally {
    rmSync(spacedBase, { recursive: true, force: true });
  }
});

test('an unknown skill name exits 2 with a non-empty stdout naming the known skills', async () => {
  const c = collector();
  const code = await runPrompt(['skill', 'nonexistent'], c.io, noopT('en'), { cwd: makeTempDir('brain-kit-prompt-') });
  assert.equal(code, EXIT.USAGE);
  assert.notEqual(c.stdout.trim(), '');
  for (const name of SKILL_NAMES) assert.match(c.stdout, new RegExp(name.replace(/-/g, '\\-')));
});

test('a skill body that cannot be read prints one translated line to stdout and exits 1', async () => {
  const c = collector();
  const scratch = buildScratchPacks();
  // The pack's own default configuration stays; only the body is gone.
  rmSync(join(scratch, 'en', 'skills', 'capture.md'));
  const code = await runPrompt(['skill', 'capture'], c.io, noopT('en'), {
    cwd: makeTempDir('brain-kit-prompt-'),
    env: { ...process.env, BRAIN_KIT_LANG: 'en' },
    packsDir: scratch,
  });
  assert.equal(code, EXIT.FAILURE);
  assert.notEqual(c.stdout.trim(), '');
  assert.doesNotMatch(c.stdout, /\{\{/);
});

test('--vault points at a specific vault directory rather than the working directory', async () => {
  const { vault, state } = freshVault('en');
  const elsewhere = makeTempDir('brain-kit-prompt-elsewhere-');
  const c = collector();
  const code = await runPrompt(['skill', 'capture', '--vault', vault], c.io, noopT(), { cwd: elsewhere, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.match(c.stdout, /Today is/);
  assert.match(c.stdout, /memory\/log\.md/);
});

// --- --check ----------------------------------------------------------

function buildScratchPacks() {
  const dir = makeTempDir('brain-kit-prompt-check-');
  cpSync(join(KIT_ROOT, 'lang'), dir, { recursive: true });
  return dir;
}

test('--check passes on the real packs', async () => {
  const c = collector();
  const code = await runPrompt(['--check'], c.io, noopT('en'), { packsDir: join(KIT_ROOT, 'lang') });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
});

test('--check fails on a scratch copy with a missing en body', async () => {
  const dir = buildScratchPacks();
  rmSync(join(dir, 'en', 'skills', 'capture.md'));
  const c = collector();
  const code = await runPrompt(['--check'], c.io, noopT('en'), { packsDir: dir });
  assert.equal(code, EXIT.FAILURE);
  assert.match(c.stdout, /capture/);
  assert.match(c.stdout, /en/);
});

test('--check fails on a scratch copy with an unknown placeholder', async () => {
  const dir = buildScratchPacks();
  writeFileSync(join(dir, 'pt-BR', 'skills', 'capture.md'), 'texto com um {{placeholder_desconhecido}} aqui\n');
  const c = collector();
  const code = await runPrompt(['--check'], c.io, noopT('en'), { packsDir: dir });
  assert.equal(code, EXIT.FAILURE);
  assert.match(c.stdout, /placeholder_desconhecido/);
});

test('--check fails when a skill in SKILL_NAMES has no body in either pack, even with the packs in parity', async () => {
  const dir = buildScratchPacks();
  rmSync(join(dir, 'en', 'skills', 'approve.md'));
  rmSync(join(dir, 'pt-BR', 'skills', 'approve.md'));
  const c = collector();
  const code = await runPrompt(['--check'], c.io, noopT('en'), { packsDir: dir });
  assert.equal(code, EXIT.FAILURE);
  assert.match(c.stdout, /approve \(en\)/);
  assert.match(c.stdout, /approve \(pt-BR\)/);
});

test('--check never touches the real packs even when it reports a problem', async () => {
  const dir = buildScratchPacks();
  rmSync(join(dir, 'pt-BR', 'skills', 'capture.md'));
  const c = collector();
  await runPrompt(['--check'], c.io, noopT('en'), { packsDir: dir });
  assert.ok(existsSync(join(KIT_ROOT, 'lang', 'pt-BR', 'skills', 'capture.md')));
  assert.ok(existsSync(join(KIT_ROOT, 'lang', 'en', 'skills', 'capture.md')));
});

// --- through the real CLI, end to end ----------------------------------

test('the CLI registers prompt and lists it in the usage text', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\bprompt\b/);
});

test('brain-kit prompt skill capture, run through the real binary inside a real vault, exits 0 with a rendered body', () => {
  const { vault, state } = freshVault('en');
  const r = spawnSync(process.execPath, [BIN, 'prompt', 'skill', 'capture'], { encoding: 'utf8', cwd: vault, env: testEnv(state) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assertEveryPlaceholderResolved(r.stdout);
  assert.match(r.stdout, /Today is/);
});

test('brain-kit prompt --check, run through the real binary, exits 0', () => {
  const r = spawnSync(process.execPath, [BIN, 'prompt', '--check'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
