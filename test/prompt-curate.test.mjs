// The generic curate prompt and the tool lists the round passes
// (docs/superpowers/plans/2026-09-24-phase-2-scheduled-curator.md, task 4).
//
// The contract test here is decision 2's acceptance criterion: every
// contract rule is present, by its `<!-- rule:<id> -->` marker, in the
// rendered prompt of both languages; every command the prompt tells the
// model to run is `{{kit}}` plus one of KIT_SUBCOMMANDS, and allowedTools()
// grants it; nothing is left unresolved. Vaults are real (`init --yes`)
// under a temporary directory, with the state directory pinned there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { loadConfig } from '../src/config.mjs';
import { CURATE_RULES, renderCuratePrompt, runPrompt } from '../src/commands/prompt.mjs';
import { KIT_SUBCOMMANDS, allowedTools, disallowedTools, kitCommand } from '../src/curate/tools.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const LANGS = ['pt-BR', 'en'];

function testEnv(state, extra = {}) {
  return {
    ...process.env, BRAIN_KIT_STATE_DIR: state, USER: 'ana', LOGNAME: 'ana', TZ: 'UTC',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

const vaults = {};
function vaultFor(lang) {
  if (vaults[lang]) return vaults[lang];
  const base = makeTempDir('brain-kit-curate-prompt-');
  const vault = join(base, 'vault');
  const state = join(base, 'state');
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], { encoding: 'utf8', env: testEnv(state), cwd: base });
  assert.equal(r.status, 0, `init failed: ${r.stdout}${r.stderr}`);
  vaults[lang] = { vault, state, config: loadConfig(vault) };
  return vaults[lang];
}

function freshVault(lang) {
  const base = makeTempDir('brain-kit-curate-prompt-');
  const vault = join(base, 'vault');
  const state = join(base, 'state');
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], { encoding: 'utf8', env: testEnv(state), cwd: base });
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

const PARAMS = 'PARAMETERS-BLOCK-FOR-THIS-TEST';
const NOW = new Date(2026, 8, 24, 10, 0, 0);

function rendered(lang) {
  const { vault, config } = vaultFor(lang);
  return renderCuratePrompt({ vaultRoot: vault, config, lang, parameters: PARAMS, now: NOW });
}

function codeSpans(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// --- src/curate/tools.mjs ----------------------------------------------

test('KIT_SUBCOMMANDS is exactly validate, lint, propose', () => {
  assert.deepEqual([...KIT_SUBCOMMANDS], ['validate', 'lint', 'propose']);
});

test('kitCommand() is the kit\'s own bin/brain-kit.mjs, double quoted and absolute, with no node in front', () => {
  const kit = kitCommand();
  assert.match(kit, /^"[^"]+"$/);
  const path = kit.slice(1, -1);
  assert.equal(path, join(KIT_ROOT, 'bin', 'brain-kit.mjs'));
  assert.ok(existsSync(path));
  assert.doesNotMatch(kit, /\bnode\b/);
});

test('allowedTools() is exactly the list task 6 names, each subcommand bare and behind node, then the extras', () => {
  const kit = kitCommand();
  assert.deepEqual(allowedTools(), [
    'Read', 'Glob', 'Grep', 'Edit', 'Write',
    `Bash(${kit} validate:*)`, `Bash(node ${kit} validate:*)`,
    `Bash(${kit} lint:*)`, `Bash(node ${kit} lint:*)`,
    `Bash(${kit} propose:*)`, `Bash(node ${kit} propose:*)`,
  ]);
  assert.deepEqual(allowedTools(['mcp__x__y']).slice(-1), ['mcp__x__y']);
});

test('disallowedTools() is exactly the list task 6 names, then the extras, and never carries Bash(node:*)', () => {
  assert.deepEqual(disallowedTools(), [
    'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(rm:*)', 'WebFetch', 'WebSearch',
  ]);
  assert.deepEqual(disallowedTools(['Bash(scp:*)']).slice(-1), ['Bash(scp:*)']);
  assert.ok(!disallowedTools().includes('Bash(node:*)'));
});

// --- the contract ------------------------------------------------------

test('CURATE_RULES lists the nine contract rules', () => {
  assert.deepEqual([...CURATE_RULES], [
    'read-index-first', 'sample-from-end', 'log-before-note', 'never-verified', 'never-empty-unopened',
    'closed-uncertainty', 'only-kit-commands', 'propose-only', 'sources-line',
  ]);
});

for (const lang of LANGS) {
  test(`${lang}: the rendered prompt carries every contract marker, once each`, () => {
    const text = rendered(lang);
    for (const rule of CURATE_RULES) {
      const count = text.split(`<!-- rule:${rule} -->`).length - 1;
      assert.equal(count, 1, `${lang}: rule ${rule} appears ${count} times`);
    }
  });

  test(`${lang}: the first line is the vault's signature and no placeholder is left unresolved`, () => {
    const text = rendered(lang);
    const { config } = vaultFor(lang);
    assert.equal(text.split('\n')[0], config.curate.signature);
    assert.doesNotMatch(text, /\{\{\w+\}\}/);
    assert.ok(text.includes(PARAMS));
    assert.ok(text.includes(`## 2026-09-24`));
    assert.ok(text.includes(config.taxonomy.log));
    assert.ok(text.includes(`**${config.taxonomy.log_markers.capture}**`));
    assert.ok(text.includes(`${config.actors.agent_prefix}/<model>`));
  });

  test(`${lang}: every command the prompt names is the kit plus one of KIT_SUBCOMMANDS, and allowedTools() grants it`, () => {
    const text = rendered(lang);
    const kit = kitCommand();
    const allowed = allowedTools();
    const kitSpans = codeSpans(text).filter((span) => span.includes(kit));
    const seen = new Set();
    for (const span of kitSpans) {
      assert.ok(span.startsWith(`${kit} `), `${lang}: "${span}" does not start with the kit command`);
      const sub = span.slice(kit.length + 1).split(' ')[0];
      assert.ok(KIT_SUBCOMMANDS.includes(sub), `${lang}: "${span}" runs "${sub}", not a kit subcommand the round allows`);
      const granted = allowed.some((rule) => {
        const m = /^Bash\((.+):\*\)$/.exec(rule);
        return m !== null && span.startsWith(m[1]);
      });
      assert.ok(granted, `${lang}: "${span}" is not granted by allowedTools()`);
      seen.add(sub);
    }
    assert.deepEqual([...seen].sort(), [...KIT_SUBCOMMANDS].sort(), `${lang}: every subcommand is named`);
    // Nothing else reads as a command to run, and the kit never appears
    // behind node.
    for (const span of codeSpans(text)) {
      assert.doesNotMatch(span, /^(git|gh|node|npm|npx|rm|curl|wget|bash|sh|cat|ls|cd|mv|cp)\s/, `${lang}: "${span}" reads as a command outside the kit`);
    }
    assert.ok(!text.includes(`node ${kit}`), `${lang}: the kit appears behind node`);
    assert.ok(text.includes(`${kit} lint --base worktree`));
    assert.ok(text.includes(`${kit} propose "`));
  });

  test(`${lang}: the last-line contract is spelled exactly`, () => {
    assert.ok(rendered(lang).includes('`BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed>`'));
  });
}

test('the two packs\' curate prompts carry no em dash and no work vocabulary', () => {
  const banned = {
    en: /\b(company|companies|team|teams|calendar|meeting|meetings|CRM|sales|customer|customers|client|clients|colleague|colleagues|employee|manager|boss)\b/i,
    'pt-BR': /\b(empresa|empresas|equipe|equipes|agenda|reunião|reuniões|CRM|vendas|cliente|clientes|colega|colegas|funcionário|chefe|gestor)\b/iu,
  };
  for (const lang of LANGS) {
    const text = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
    assert.ok(!text.includes(String.fromCodePoint(0x2014)), `${lang}: em dash`);
    assert.doesNotMatch(text, banned[lang], `${lang}: work vocabulary`);
  }
});

// --- brain-kit prompt curate --------------------------------------------

test('prompt curate renders the pack prompt in the vault\'s language, with the standalone parameters line', async () => {
  for (const lang of LANGS) {
    const { vault, state, config } = vaultFor(lang);
    const c = collector();
    const code = await runPrompt(['curate'], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state), now: NOW });
    assert.equal(code, EXIT.OK, c.stdout + c.stderr);
    assert.equal(c.stderr, '');
    assert.equal(c.stdout.split('\n')[0], config.curate.signature);
    assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/);
    const line = createTranslator(lang)('prompt.curate_parameters_standalone');
    assert.ok(c.stdout.includes(line), `${lang}: the standalone parameters line`);
  }
});

test('prompt curate outside a vault renders by the locale with the pack defaults', async () => {
  const outside = makeTempDir('brain-kit-curate-outside-');
  for (const lang of LANGS) {
    const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
    const c = collector();
    const code = await runPrompt(['curate'], c.io, createTranslator('en'), { cwd: outside, env: { ...process.env, BRAIN_KIT_LANG: lang } });
    assert.equal(code, EXIT.OK, c.stdout + c.stderr);
    assert.equal(c.stdout.split('\n')[0], defaults.curate.signature);
    assert.ok(c.stdout.includes(defaults.taxonomy.log));
    assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/);
  }
});

test('prompt curate --vault points at a vault other than the working directory', async () => {
  const { vault, state } = vaultFor('en');
  const c = collector();
  const code = await runPrompt(['curate', '--vault', vault], c.io, createTranslator('en'), { cwd: makeTempDir('brain-kit-curate-elsewhere-'), env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.ok(c.stdout.includes('memory/log.md'));
});

test('an unreadable pack prompt prints one translated line to stdout and exits 1', async () => {
  const packs = makeTempDir('brain-kit-curate-packs-');
  cpSync(join(KIT_ROOT, 'lang'), packs, { recursive: true });
  rmSync(join(packs, 'en', 'prompts', 'curate.md'));
  const c = collector();
  const code = await runPrompt(['curate'], c.io, createTranslator('en'), {
    cwd: makeTempDir('brain-kit-curate-outside-'), env: { ...process.env, BRAIN_KIT_LANG: 'en' }, packsDir: packs,
  });
  assert.equal(code, EXIT.FAILURE);
  assert.notEqual(c.stdout.trim(), '');
  assert.equal(c.stdout.trim().split('\n').length, 1);
  assert.match(c.stdout, /doctor/);
});

// --- the vault's overlay -------------------------------------------------

function writeOverlay(vault, text) {
  mkdirSync(join(vault, '.brain-kit', 'prompts'), { recursive: true });
  writeFileSync(join(vault, '.brain-kit', 'prompts', 'curate.md'), text);
}

test('an overlay in the vault is rendered instead of the pack prompt, frontmatter stripped, placeholders filled', async () => {
  const { vault, state } = freshVault('en');
  writeOverlay(vault, '---\ntype: prompt\n---\n{{signature}}\nOVERLAY BODY {{log}} {{kit}} {{parameters}}\n');
  const c = collector();
  const code = await runPrompt(['curate'], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.equal(c.stdout.split('\n')[0], loadConfig(vault).curate.signature);
  assert.ok(c.stdout.includes(`OVERLAY BODY memory/log.md ${kitCommand()}`));
  assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/);
  assert.doesNotMatch(c.stdout, /type: prompt/);
});

test('--check warns, and still passes, when the vault\'s overlay lacks contract markers', async () => {
  const { vault, state } = freshVault('en');
  writeOverlay(vault, '{{signature}}\n<!-- rule:read-index-first -->\nOverlay.\n');
  const c = collector();
  const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  for (const rule of CURATE_RULES.filter((r) => r !== 'read-index-first')) assert.ok(c.stderr.includes(rule), `warns about ${rule}`);
  assert.ok(!c.stderr.includes('"read-index-first"'));
});

test('--check says nothing about an overlay that carries every marker', async () => {
  const { vault, state } = freshVault('en');
  writeOverlay(vault, `{{signature}}\n${CURATE_RULES.map((r) => `<!-- rule:${r} -->\nx\n`).join('')}`);
  const c = collector();
  const code = await runPrompt(['--check'], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.equal(c.stderr, '');
});

// --- --check on the packs' prompts ---------------------------------------

function scratchPacks() {
  const dir = makeTempDir('brain-kit-curate-check-');
  cpSync(join(KIT_ROOT, 'lang'), dir, { recursive: true });
  return dir;
}

async function checkOn(dir) {
  const c = collector();
  const code = await runPrompt(['--check'], c.io, createTranslator('en'), { packsDir: dir, cwd: makeTempDir('brain-kit-curate-outside-') });
  return { code, out: c.stdout, err: c.stderr };
}

test('--check passes on the real packs', async () => {
  const { code, out } = await checkOn(join(KIT_ROOT, 'lang'));
  assert.equal(code, EXIT.OK, out);
});

test('--check fails when a pack prompt loses a contract marker', async () => {
  const dir = scratchPacks();
  const file = join(dir, 'pt-BR', 'prompts', 'curate.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('<!-- rule:never-verified -->', ''));
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /never-verified/);
  assert.match(out, /pt-BR/);
});

test('--check fails when a pack has no curate prompt', async () => {
  const dir = scratchPacks();
  rmSync(join(dir, 'en', 'prompts', 'curate.md'));
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /curate/);
  assert.match(out, /\ben\b/);
});

test('--check fails on an unknown placeholder in a prompt, and on placeholders that differ between packs', async () => {
  const dir = scratchPacks();
  const file = join(dir, 'en', 'prompts', 'curate.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n{{nonexistent_value}}\n`);
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /nonexistent_value/);
  assert.match(out, /differ/);
});

test('--check fails when a prompt\'s first line is not the signature placeholder', async () => {
  const dir = scratchPacks();
  const file = join(dir, 'en', 'prompts', 'curate.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('{{signature}}\n', '# Title\n{{signature}}\n'));
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /first line/);
});

// --- through the real binary ----------------------------------------------

test('brain-kit prompt curate, run through the real binary inside a real vault, exits 0', () => {
  const { vault, state, config } = vaultFor('pt-BR');
  const r = spawnSync(process.execPath, [BIN, 'prompt', 'curate'], { encoding: 'utf8', cwd: vault, env: testEnv(state) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split('\n')[0], config.curate.signature);
  for (const rule of CURATE_RULES) assert.ok(r.stdout.includes(`<!-- rule:${rule} -->`));
});
