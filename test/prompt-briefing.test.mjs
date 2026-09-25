// `brain-kit prompt briefing` and the briefing prompt in both packs (phase
// 4, task 3). Vaults are real (`init --yes`) under a temporary directory,
// with the state directory and HOME pinned there; gh is never run (the
// facts get a findExecutable that finds nothing, and the binary runs with a
// PATH holding only git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { loadConfig } from '../src/config.mjs';
import { BRIEFING_PLACEHOLDERS, BRIEFING_RULES, PROMPT_NAMES, runPrompt } from '../src/commands/prompt.mjs';
import { kitCommand } from '../src/curate/tools.mjs';
import { addQuestion, markAsked, readQueue } from '../src/briefing/questions.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const LANGS = ['pt-BR', 'en'];
const UTC3 = 'America/Argentina/Buenos_Aires';
// 09:00 of Friday 25/09/2026 at UTC-3.
const NOW = new Date('2026-09-25T12:00:00Z');
const TODAY = '2026-09-25';
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const NO_GH = { findExecutable: () => null };

function testEnv(base, extra = {}) {
  return {
    ...process.env, BRAIN_KIT_STATE_DIR: join(base, 'state'), HOME: join(base, 'home'), USER: 'ana', LOGNAME: 'ana', TZ: 'UTC',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

// A fresh vault of `lang`, its configuration's briefing keys replaced by
// `briefing` (undefined removes one).
function freshVault(lang, briefing = {}) {
  const base = makeTempDir('brain-kit-briefing-prompt-');
  mkdirSync(join(base, 'home'));
  const vault = join(base, 'vault');
  const env = testEnv(base);
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], { encoding: 'utf8', env, cwd: base });
  assert.equal(r.status, 0, `init failed: ${r.stdout}${r.stderr}`);
  const file = join(vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.vault.timezone = UTC3;
  for (const [key, value] of Object.entries(briefing)) {
    if (value === undefined) delete config.briefing[key];
    else config.briefing[key] = value;
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { base, vault, env, state: env.BRAIN_KIT_STATE_DIR };
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

async function briefing(world, { argv = ['briefing', '--vault', world.vault], now = NOW, env = {}, lang = 'en', packsDir } = {}) {
  const c = collector();
  const code = await runPrompt(argv, c.io, createTranslator(lang), { cwd: world.base, env: { ...world.env, ...env }, now, deps: { facts: NO_GH }, ...(packsDir ? { packsDir } : {}) });
  return { code, out: c.stdout, err: c.stderr };
}

const packPrompt = (lang) => readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'briefing.md'), 'utf8');
const placeholdersIn = (text) => [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();

// ------------------------------------------------------------ the packs

test('the briefing is one of the kit\'s prompts, with its own seven contract rules', () => {
  assert.deepEqual([...PROMPT_NAMES], ['curate', 'briefing']);
  assert.deepEqual([...BRIEFING_RULES], ['never-read', 'facts-from-kit', 'closed-uncertainty', 'never-empty-unopened', 'questions-by-command', 'propose-only', 'honour-limits']);
});

for (const lang of LANGS) {
  test(`${lang}: the pack prompt starts with the signature, uses every briefing placeholder and only those, and carries each marker once`, () => {
    const text = packPrompt(lang);
    assert.equal(text.split('\n')[0], '{{signature}}');
    assert.deepEqual(placeholdersIn(text), [...BRIEFING_PLACEHOLDERS].sort());
    for (const rule of BRIEFING_RULES) assert.equal(text.split(`<!-- rule:${rule} -->`).length - 1, 1, `${lang}: ${rule}`);
  });

  test(`${lang}: the pack prompt names no one but Ana, no product and no field of work, and writes human dates DD/MM/YYYY`, () => {
    const text = packPrompt(lang);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), 'no em dash');
    assert.doesNotMatch(text, /\b\d{4}-\d{2}-\d{2}\b/);
    assert.match(text, /\b12\/10\/2026\b/);
    // Every capitalised word that is not at the start of a sentence or a
    // list item is Ana, a heading word or a marker.
    const names = new Set();
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || line.startsWith('<!--')) continue;
      for (const m of line.matchAll(/(?<=[a-z,;:(] )([A-Z][a-z]+)/g)) names.add(m[1]);
    }
    assert.deepEqual([...names].filter((word) => word !== 'Ana'), []);
  });
}

// ------------------------------------------------------------ the render

for (const lang of LANGS) {
  test(`${lang}: prompt briefing renders every placeholder, the signature first, the blocks in the default order, and the vault's dates`, async () => {
    const world = freshVault(lang);
    const { code, out, err } = await briefing(world);
    assert.equal(code, EXIT.OK, out + err);
    const config = loadConfig(world.vault);
    assert.equal(out.split('\n')[0], config.briefing.signature);
    assert.doesNotMatch(out, /\{\{\w+\}\}/);
    for (const rule of BRIEFING_RULES) assert.equal(out.split(`<!-- rule:${rule} -->`).length - 1, 1, `${lang}: ${rule}`);
    assert.ok(out.includes('25/09/2026'));
    assert.ok(out.includes(`## ${TODAY}`));
    assert.ok(out.includes('2026-09-25T09:00:00-03:00'));
    assert.ok(out.includes(`**${config.taxonomy.log_markers.capture}**`));
    assert.ok(out.includes(`${config.actors.agent_prefix}/<model>`));
    assert.ok(out.includes(`${kitCommand()} questions add`));
    assert.ok(out.includes(`${kitCommand()} propose "`));
    const ids = out.split('\n').filter((line) => line.startsWith('### ')).map((line) => /\(([a-z_]+)\)$/.exec(line)[1]);
    assert.deepEqual(ids, ['sources', 'due', 'upcoming', 'undated', 'open_prs', 'stale', 'blind_spots', 'strategy', 'questions']);
    for (const entry of config.briefing.never_read) assert.ok(out.includes(`- \`${entry}\``), entry);
    assert.equal(err, '');
  });

  test(`${lang}: with every limit null the limits list is empty; a limit the person set renders its line`, async () => {
    const world = freshVault(lang);
    const { out } = await briefing(world);
    const rule = out.indexOf('<!-- rule:honour-limits -->');
    const section = out.slice(rule, out.indexOf('\n## ', rule));
    assert.equal(section.split('\n').filter((line) => line.startsWith('- ')).length, 0, section);
    assert.doesNotMatch(section, /max_words|max_questions|write_caps/);
    const limited = freshVault(lang, { max_words: 250, write_caps: { captures: 4, pending_changes: null } });
    const again = (await briefing(limited)).out;
    const at = again.indexOf('<!-- rule:honour-limits -->');
    const lines = again.slice(at, again.indexOf('\n## ', at)).split('\n').filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /250.*briefing\.max_words/);
    assert.match(lines[1], /4.*briefing\.write_caps\.captures/);
  });
}

test('the configured blocks, custom ones included, render in their order, and the problems are named in the prompt and on stderr', async () => {
  const world = freshVault('en', {
    blocks: ['questions', { id: 'reading', title: 'The reading list', instruction: 'Say which book comes next.', read: ['references/books/index.md'] }, 'agenda', 'stale', 'stale',
      { id: 'secret', title: 'Secret', instruction: 'x', read: ['people/ana.md'] }],
  });
  const { code, out, err } = await briefing(world);
  assert.equal(code, EXIT.OK, out + err);
  const headings = out.split('\n').filter((line) => line.startsWith('### '));
  assert.deepEqual(headings, ['### 1. Questions (questions)', '### 2. The reading list (reading)', '### 3. Notes due for review (stale)']);
  for (const needle of ['"agenda"', 'entry 5, "stale"', 'entry 6, "secret"']) {
    assert.ok(out.includes(needle), needle);
    assert.ok(err.includes(needle), needle);
  }
  assert.equal(err.trim().split('\n').length, 3, err);
});

// ------------------------------------------------------------ the questions

test('the real render records exactly the questions it places as asked today, escalated first; a second render the same day counts once', async () => {
  const world = freshVault('en');
  const a = addQuestion(world.state, 'Which projects end this quarter?', { today: '2026-09-20' }).id;
  const b = addQuestion(world.state, 'Is the grant report still due?', { today: '2026-09-18' }).id;
  for (const day of ['2026-09-21', '2026-09-22', '2026-09-23']) markAsked(world.state, [b], day);
  const { code, out } = await briefing(world);
  assert.equal(code, EXIT.OK);
  const block = out.slice(out.indexOf('### 9. Questions'));
  assert.ok(block.indexOf(b) < block.indexOf(a), 'the escalated question first');
  assert.match(block, /The kit recorded the questions above as asked on 25\/09\/2026\./);
  const asked = () => Object.fromEntries(readQueue(world.state).map((q) => [q.id, q.askedOn]));
  assert.deepEqual(asked(), { [a]: [TODAY], [b]: ['2026-09-21', '2026-09-22', '2026-09-23', TODAY] });
  await briefing(world);
  assert.deepEqual(asked(), { [a]: [TODAY], [b]: ['2026-09-21', '2026-09-22', '2026-09-23', TODAY] });
});

test('with briefing.max_questions set, only the questions placed are recorded, and the cut is announced', async () => {
  const world = freshVault('en', { max_questions: 1 });
  const a = addQuestion(world.state, 'First question?', { today: '2026-09-20' }).id;
  const b = addQuestion(world.state, 'Second question?', { today: '2026-09-21' }).id;
  const { out } = await briefing(world);
  assert.match(out, /1 more open question\(s\) not shown: briefing\.max_questions is 1/);
  assert.ok(out.includes(a));
  assert.equal(out.includes(`[${b}]`), false);
  assert.deepEqual(readQueue(world.state).map((q) => [q.id, q.askedOn]), [[a, [TODAY]], [b, []]]);
});

test('no questions block in the list, --check, and a refused render record nothing', async () => {
  const world = freshVault('en', { blocks: ['stale'] });
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  await briefing(world);
  await briefing(world, { argv: ['--check', '--vault', world.vault] });
  const refused = freshVault('en', { prompt: '../outside.md' });
  const other = addQuestion(refused.state, 'Anything?', { today: '2026-09-20' }).id;
  const r = await briefing(refused);
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.out, /briefing\.prompt in brain-kit\.config\.json points at .*outside\.md, outside the vault/);
  assert.deepEqual(readQueue(world.state).map((q) => [q.id, q.askedOn]), [[id, []]]);
  assert.deepEqual(readQueue(refused.state).map((q) => [q.id, q.askedOn]), [[other, []]]);
});

test('a briefing prompt that cannot be read is one line, exit 1, and records nothing', async () => {
  const world = freshVault('en');
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  const packs = makeTempDir('brain-kit-briefing-packs-');
  cpSync(join(KIT_ROOT, 'lang'), packs, { recursive: true });
  unlinkSync(join(packs, 'en', 'prompts', 'briefing.md'));
  const { code, out } = await briefing(world, { packsDir: packs });
  assert.equal(code, EXIT.FAILURE);
  assert.equal(out.trim().split('\n').length, 1);
  assert.match(out, /The briefing prompt could not be loaded \(.*briefing\.md: ENOENT\)/);
  assert.deepEqual(readQueue(world.state).map((q) => q.askedOn), [[]]);
});

// ------------------------------------------------------------ the overlay

test('the overlay replaces the pack\'s prompt, frontmatter stripped, with the signature line put in front and every placeholder filled', async () => {
  const world = freshVault('en');
  mkdirSync(join(world.vault, '.brain-kit', 'prompts'), { recursive: true });
  writeFileSync(join(world.vault, '.brain-kit', 'prompts', 'briefing.md'), '---\ntype: prompt\n---\nMY OWN BRIEFING for {{today_human}} in {{log}}\n{{blocks}}\n{{limits}}END\n');
  const { code, out } = await briefing(world);
  assert.equal(code, EXIT.OK);
  const config = loadConfig(world.vault);
  assert.ok(out.startsWith(`${config.briefing.signature}\n\nMY OWN BRIEFING for 25/09/2026 in memory/log.md\n`), out.slice(0, 200));
  assert.ok(out.includes('### 1. The curator and the sources (sources)'));
  assert.ok(out.endsWith('\nEND\n'));
  assert.doesNotMatch(out, /type: prompt/);
  assert.doesNotMatch(out, /\{\{\w+\}\}/);
});

test('--check warns, without failing, about the briefing overlay and the blocks; it fails for a briefing.prompt outside the vault', async () => {
  const world = freshVault('en', { blocks: ['stale', 'agenda'] });
  mkdirSync(join(world.vault, '.brain-kit', 'prompts'), { recursive: true });
  writeFileSync(join(world.vault, '.brain-kit', 'prompts', 'briefing.md'), '# Mine\n<!-- rule:never-read -->\n{{parameters}}\n');
  const r = await briefing(world, { argv: ['--check', '--vault', world.vault] });
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.err, /briefing prompt .* does not start with \{\{signature\}\}/);
  for (const rule of BRIEFING_RULES.filter((x) => x !== 'never-read')) assert.ok(r.err.includes(`"${rule}"`), rule);
  assert.match(r.err, /"\{\{parameters\}\}", which the briefing does not fill/);
  assert.match(r.err, /warning: briefing\.blocks: entry 2, "agenda"/);
  const outside = freshVault('en', { prompt: '/tmp/elsewhere.md' });
  const bad = await briefing(outside, { argv: ['--check', '--vault', outside.vault] });
  assert.equal(bad.code, EXIT.FAILURE);
  assert.match(bad.out, /briefing\.prompt in brain-kit\.config\.json points at \/tmp\/elsewhere\.md, outside the vault/);
});

// ------------------------------------------------------------ --check over the packs

function scratchPacks() {
  const dir = makeTempDir('brain-kit-briefing-check-');
  cpSync(join(KIT_ROOT, 'lang'), dir, { recursive: true });
  return dir;
}

async function checkOn(dir) {
  const c = collector();
  const code = await runPrompt(['--check'], c.io, createTranslator('en'), { packsDir: dir, cwd: makeTempDir('brain-kit-briefing-outside-') });
  return { code, out: c.stdout };
}

test('--check covers the briefing prompt: a lost marker, an unknown placeholder, a placeholder in one pack only, a wrong first line, a missing file', async () => {
  assert.equal((await checkOn(join(KIT_ROOT, 'lang'))).code, EXIT.OK);
  const edits = [
    ['pt-BR', (s) => s.replace('<!-- rule:questions-by-command -->', ''), /briefing\.md \(pt-BR\).*"questions-by-command"/],
    ['en', (s) => s.replace('{{limits}}', '{{limits}} {{sources_line}}'), /briefing\.md \(en\): unknown placeholder "\{\{sources_line\}\}"/],
    ['en', (s) => s.replace('{{today_iso}}', 'TODAY'), /briefing\.md: the placeholders differ between/],
    ['pt-BR', (s) => s.replace('{{signature}}\n', 'Briefing\n'), /briefing\.md \(pt-BR\): the first line must be exactly \{\{signature\}\}/],
  ];
  for (const [lang, edit, expected] of edits) {
    const dir = scratchPacks();
    const file = join(dir, lang, 'prompts', 'briefing.md');
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
    const { code, out } = await checkOn(dir);
    assert.equal(code, EXIT.FAILURE, String(expected));
    assert.match(out, expected);
  }
  const dir = scratchPacks();
  unlinkSync(join(dir, 'en', 'prompts', 'briefing.md'));
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /prompts\/briefing\.md \(en\): missing/);
});

// ------------------------------------------------------------ refusals

test('outside a vault, and with a configuration that cannot be used, one line on stdout and exit 2', async () => {
  const base = makeTempDir('brain-kit-briefing-none-');
  const c = collector();
  const code = await runPrompt(['briefing'], c.io, createTranslator('en'), { cwd: base, env: testEnv(base, { BRAIN_KIT_LANG: 'en' }), now: NOW });
  assert.equal(code, EXIT.USAGE);
  assert.match(c.stdout, /^No brain-kit vault was found from .*: write no file/);
  assert.equal(c.stdout.trim().split('\n').length, 1);
  const world = freshVault('pt-BR');
  writeFileSync(join(world.vault, 'brain-kit.config.json'), '{ "lang": "pt-BR" }\n');
  const r = await briefing(world, { env: { BRAIN_KIT_LANG: 'pt-BR' } });
  assert.equal(r.code, EXIT.USAGE);
  assert.match(r.out, /^O briefing não pode ser preparado: o brain-kit\.config\.json do vault não pode ser usado/);
  assert.equal(r.out.trim().split('\n').length, 1);
});

test('the real binary renders the briefing in a scratch vault, with only git on PATH', () => {
  const world = freshVault('en');
  const bin = join(world.base, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_GIT, join(bin, 'git'));
  const r = spawnSync(process.execPath, [BIN, 'prompt', 'briefing', '--vault', world.vault], { encoding: 'utf8', env: { ...world.env, PATH: bin }, cwd: world.base });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split('\n')[0], loadConfig(world.vault).briefing.signature);
  assert.match(r.stdout, /Open pull requests: not known, gh is not installed or not on PATH\./);
});
