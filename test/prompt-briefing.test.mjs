// `brain-kit prompt briefing` and the briefing prompt in both packs (phase
// 4, task 3). Vaults are real (`init --yes`) under a temporary directory,
// with the state directory and HOME pinned there; gh is never run (the
// facts get a findExecutable that finds nothing, and the binary runs with a
// PATH holding only git).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { loadConfig } from '../src/config.mjs';
import { BRIEFING_PLACEHOLDERS, BRIEFING_RULES, PROMPT_NAMES, runPrompt } from '../src/commands/prompt.mjs';
import { kitCommand, kitCommandIn } from '../src/curate/tools.mjs';
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
  const code = await runPrompt(argv, c.io, createTranslator(lang), { cwd: world.base, env: { ...world.env, ...env }, now, facts: NO_GH, ...(packsDir ? { packsDir } : {}) });
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
    assert.ok(out.includes(`${kitCommandIn(world.vault)} questions add`));
    assert.ok(out.includes(`${kitCommandIn(world.vault)} propose "`));
    const ids = out.split('\n').filter((line) => line.startsWith('### ')).map((line) => /\(([a-z_]+)\)$/.exec(line)[1]);
    assert.deepEqual(ids, ['sources', 'due', 'upcoming', 'undated', 'open_prs', 'stale', 'blind_spots', 'strategy', 'questions']);
    for (const entry of config.briefing.never_read) assert.ok(out.includes(`- \`${entry}\``), entry);
    // The facts seam reached briefingFacts: gh was never looked for.
    assert.match(out, lang === 'en' ? /Open pull requests: not known, gh is not installed or not on PATH\./ : /Pull requests abertos: não se sabe, o gh não está instalado ou não está no PATH\./);
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
  assert.match(block, /the kit records the questions above as asked on 25\/09\/2026\./);
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
  assert.equal(r.code, EXIT.OK, 'the line is for the model: exit 0 (final review, I2)');
  assert.match(r.out, /briefing\.prompt in brain-kit\.config\.json points at .*outside\.md, outside the vault/);
  assert.equal(r.err, `${createTranslator('en')('prompt.briefing_not_rendered', { reason: 'prompt_outside' })}\n`);
  assert.deepEqual(readQueue(world.state).map((q) => [q.id, q.askedOn]), [[id, []]]);
  assert.deepEqual(readQueue(refused.state).map((q) => [q.id, q.askedOn]), [[other, []]]);
});

test('a briefing prompt that cannot be read is one line, exit 0 with the reason on stderr, and records nothing', async () => {
  const world = freshVault('en');
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  const packs = makeTempDir('brain-kit-briefing-packs-');
  cpSync(join(KIT_ROOT, 'lang'), packs, { recursive: true });
  unlinkSync(join(packs, 'en', 'prompts', 'briefing.md'));
  const { code, out, err } = await briefing(world, { packsDir: packs });
  assert.equal(code, EXIT.OK);
  assert.equal(err, `${createTranslator('en')('prompt.briefing_not_rendered', { reason: 'prompt_unreadable' })}\n`);
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

test('--check warns about the briefing overlay and the blocks, fails for one without the signature or {{blocks}}, and for a briefing.prompt outside the vault', async () => {
  const world = freshVault('en', { blocks: ['stale', 'agenda'] });
  mkdirSync(join(world.vault, '.brain-kit', 'prompts'), { recursive: true });
  const overlay = join(world.vault, '.brain-kit', 'prompts', 'briefing.md');
  writeFileSync(overlay, '# Mine\n<!-- rule:never-read -->\n{{parameters}}\n');
  const r = await briefing(world, { argv: ['--check', '--vault', world.vault] });
  assert.equal(r.code, EXIT.FAILURE, r.out + r.err);
  assert.ok(r.out.includes(`the vault's briefing prompt ${overlay} does not start with {{signature}}`), r.out);
  assert.ok(r.out.includes(`the vault's briefing prompt ${overlay} does not use {{blocks}}`), r.out);
  assert.match(r.err, /does not use \{\{never_read\}\}; the model is not given that list/);
  assert.match(r.err, /does not use \{\{read\}\}; the model is not given that list/);
  for (const rule of BRIEFING_RULES.filter((x) => x !== 'never-read')) assert.ok(r.err.includes(`"${rule}"`), rule);
  assert.match(r.err, /"\{\{parameters\}\}", which the briefing does not fill/);
  assert.match(r.err, /warning: briefing\.blocks: entry 2, "agenda"/);
  writeFileSync(overlay, `{{signature}}\n${BRIEFING_RULES.map((x) => `<!-- rule:${x} -->\n`).join('')}{{vault}}\n{{never_read}}\n{{read}}\n{{blocks}}\n`);
  const good = await briefing(world, { argv: ['--check', '--vault', world.vault] });
  assert.equal(good.code, EXIT.OK, good.out + good.err);
  assert.equal(good.err, 'warning: briefing.blocks: entry 2, "agenda": no block of the kit has this id (the kit\'s blocks: sources, due, upcoming, undated, open_prs, stale, questions, blind_spots, strategy, today_calendar); left out.\n');
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

test('outside a vault, and with a configuration that cannot be used, one line on stdout, the reason on stderr, and exit 0 (the line is for the model)', async () => {
  const base = makeTempDir('brain-kit-briefing-none-');
  const c = collector();
  const code = await runPrompt(['briefing'], c.io, createTranslator('en'), { cwd: base, env: testEnv(base, { BRAIN_KIT_LANG: 'en' }), now: NOW });
  assert.equal(code, EXIT.OK);
  assert.match(c.stdout, /^No brain-kit vault was found from .*: write no file/);
  assert.equal(c.stdout.trim().split('\n').length, 1);
  assert.equal(c.stderr, `${createTranslator('en')('prompt.briefing_not_rendered', { reason: 'no_vault' })}\n`);
  const world = freshVault('pt-BR');
  writeFileSync(join(world.vault, 'brain-kit.config.json'), '{ "lang": "pt-BR" }\n');
  const r = await briefing(world, { env: { BRAIN_KIT_LANG: 'pt-BR' } });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.err, `${createTranslator('pt-BR')('prompt.briefing_not_rendered', { reason: 'config_invalid' })}\n`);
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

// ------------------------------------------------------------ fix round 1

const asked = (state) => readQueue(state).map((q) => [q.id, q.askedOn]);

// Review, Important 1 (ruling R-T8): a strategy index that could not be
// read threw after the questions were recorded: exit 1, an empty stdout,
// and a question counted as asked that no one saw.
test('an unreadable strategy index renders as not verified in its block, and the render goes on and records the questions', async () => {
  const world = freshVault('en');
  appendFileSync(join(world.vault, '.gitignore'), 'decisions/index.md\n');
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  const index = join(world.vault, 'decisions', 'index.md');
  chmodSync(index, 0o000);
  try {
    const { code, out } = await briefing(world);
    assert.equal(code, EXIT.OK, out);
    assert.match(out, /Skipped, not verified: could not read decisions\/index\.md \(EACCES\)/);
    assert.ok(out.includes(`[${id}]`));
    assert.deepEqual(asked(world.state), [[id, [TODAY]]]);
  } finally {
    chmodSync(index, 0o644);
  }
});

test('a note the stale walk cannot read is a named problem of the stale block, never an empty prompt', async () => {
  const world = freshVault('en');
  const note = join(world.vault, 'projects', 'locked.md');
  writeFileSync(note, '---\ntype: note\n---\n');
  chmodSync(note, 0o000);
  try {
    const { code, out } = await briefing(world);
    assert.equal(code, EXIT.OK, out);
    assert.match(out, /projects\/locked\.md: not verified, it could not be read \(EACCES\)/);
  } finally {
    chmodSync(note, 0o644);
  }
});

test('whatever fails while rendering is one line on stdout, exit 0 with the reason on stderr, and no question is recorded', async () => {
  const world = freshVault('en');
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  const c = collector();
  const boom = () => { throw Object.assign(new Error('the disk went away'), { code: 'EIO' }); };
  const code = await runPrompt(['briefing', '--vault', world.vault], c.io, createTranslator('en'), { cwd: world.base, env: world.env, now: NOW, facts: { ...NO_GH, walkVault: boom } });
  assert.equal(code, EXIT.OK);
  assert.equal(c.stderr, `${createTranslator('en')('prompt.briefing_not_rendered', { reason: 'render_failed' })}\n`);
  assert.equal(c.stdout, 'The briefing could not be prepared (EIO). Write no file; tell the person, and suggest running brain-kit doctor.\n');
  assert.deepEqual(asked(world.state), [[id, []]]);
});

test('a record of the asked questions that fails is said on stderr, the text is still printed with its correction line, and the exit is 0', async () => {
  const world = freshVault('en');
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  writeFileSync(join(world.state, 'questions.log.lock'), 'not a lock\n');
  const { code, out, err } = await briefing(world);
  assert.equal(code, EXIT.OK);
  assert.equal(out.split('\n')[0], loadConfig(world.vault).briefing.signature);
  assert.ok(out.includes(`[${id}]`));
  assert.match(err, /brain-kit prompt briefing: the questions of this briefing could not be recorded as asked today \(.+\); the queue did not count this briefing\./);
  assert.ok(out.endsWith("\n\nCorrection: the kit could not record this briefing's questions as asked today, so the queue did not count them; say so in one line.\n"), out.slice(-300));
  assert.deepEqual(asked(world.state), [[id, []]]);
});

// Task 3 re-review: the reading rule named only judgement and custom
// blocks, so a fact block's own path (a pending table to update) was closed.
test('the reading rule opens any path a block names, never-read still wins, in both packs', () => {
  const en = packPrompt('en');
  const pt = packPrompt('pt-BR');
  assert.ok(en.includes('You may open these notes, and any path a block below names or gives you to read, and nothing else; a path the never-read list covers stays closed even then:'));
  assert.ok(pt.includes('Você pode abrir estas notas, e qualquer caminho que um bloco abaixo cite ou mande ler, e nada além; um caminho que a lista do que nunca se lê cobre continua fechado mesmo assim:'));
});

// Review, Important 2 (ruling R-T9): an overlay without {{blocks}} showed
// no question and still recorded every placed one as asked.
test('only the question ids the final text shows are recorded: an overlay without {{blocks}} records none', async () => {
  const world = freshVault('en');
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  mkdirSync(join(world.vault, '.brain-kit', 'prompts'), { recursive: true });
  writeFileSync(join(world.vault, '.brain-kit', 'prompts', 'briefing.md'), '{{signature}}\n\nGive a short briefing from index.md. Today is {{today_human}}.\n');
  const { code, out } = await briefing(world);
  assert.equal(code, EXIT.OK);
  assert.equal(out.includes(id), false);
  assert.deepEqual(asked(world.state), [[id, []]]);
});

// Review, Important 3 (ruling R-T10): the stale block listed a people note
// right under a line that read as leave to open any path a block names.
for (const lang of LANGS) {
  test(`${lang}: a stale note under never_read is marked, and the prompt says the never-read list wins over every block`, async () => {
    const world = freshVault(lang);
    const config = loadConfig(world.vault);
    const people = config.briefing.never_read.find((entry) => entry.endsWith('/') && entry !== '.brain-kit/' && entry !== 'attachments/' && entry !== 'anexos/');
    mkdirSync(join(world.vault, people), { recursive: true });
    writeFileSync(join(world.vault, people, 'ana.md'), '---\ntype: person\ntitle: Ana\ndescription: Ana.\nstale_after: 2026-01-01\n---\n\n# Ana\n');
    const { code, out } = await briefing(world);
    assert.equal(code, EXIT.OK);
    const line = out.split('\n').find((l) => l.includes(`${people}ana.md`) && l.includes('01/01/2026'));
    assert.ok(line !== undefined, out);
    assert.ok(line.endsWith(lang === 'en' ? ' (never read)' : ' (nunca lido)'), line);
    const rule = out.slice(out.indexOf('<!-- rule:never-read -->'), out.indexOf('<!-- rule:facts-from-kit -->'));
    assert.match(rule, lang === 'en'
      ? /This list wins over everything else in this prompt: a path it covers is never opened, even when a block below names it/
      : /Esta lista vale acima de tudo neste prompt: um caminho que ela cobre nunca é aberto, mesmo quando um bloco abaixo o cita/);
    assert.match(rule, lang === 'en'
      ? /a path the never-read list covers stays closed even then:/
      : /um caminho que a lista do que nunca se lê cobre continua fechado mesmo assim:/);
    assert.doesNotMatch(out, /Besides the paths a block below names|Além dos caminhos que um bloco abaixo citar/);
  });
}

// ------------------------------------------------------------ task 5 fix round 1

// Ruling R-T16: briefing.enabled false turns the briefing off in the vault,
// the one asked for by hand included: the real render prints one line in
// the vault's language, records no question and exits 0. With enabled true
// the briefing is unchanged (the schema requires the key), and --check is
// not affected either way.
for (const lang of LANGS) {
  test(`${lang}: with briefing.enabled false the real render is one line saying the briefing is off, records nothing and exits 0`, async () => {
    const world = freshVault(lang, { enabled: false });
    const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
    const { code, out, err } = await briefing(world, { lang: lang === 'en' ? 'pt-BR' : 'en' });
    assert.equal(code, EXIT.OK, out + err);
    assert.equal(err, '');
    assert.equal(out, `${createTranslator(lang)('prompt.briefing_disabled', { file: 'brain-kit.config.json' })}\n`);
    assert.match(out, /briefing\.enabled/);
    assert.match(out, lang === 'en' ? /^The morning briefing is turned off in this vault/ : /^O briefing matinal está desligado neste vault/);
    assert.equal(out.includes(loadConfig(world.vault).briefing.signature), false);
    assert.deepEqual(asked(world.state), [[id, []]]);
  });
}

test('with briefing.enabled true the briefing renders and records as before', async () => {
  const world = freshVault('en', { enabled: true });
  const id = addQuestion(world.state, 'Anything?', { today: '2026-09-20' }).id;
  const { code, out } = await briefing(world);
  assert.equal(code, EXIT.OK, out);
  assert.equal(out.split('\n')[0], loadConfig(world.vault).briefing.signature);
  assert.ok(out.includes('### 1. The curator and the sources (sources)'));
  assert.deepEqual(asked(world.state), [[id, [TODAY]]]);
});

test('--check is not affected by briefing.enabled false, and records nothing', async () => {
  const off = freshVault('en', { enabled: false });
  const on = freshVault('en');
  const id = addQuestion(off.state, 'Anything?', { today: '2026-09-20' }).id;
  const a = await briefing(off, { argv: ['--check', '--vault', off.vault] });
  const b = await briefing(on, { argv: ['--check', '--vault', on.vault] });
  assert.equal(a.code, b.code);
  assert.equal(a.code, EXIT.OK, a.out + a.err);
  assert.equal(a.out, b.out);
  assert.equal(a.err, b.err);
  assert.deepEqual(asked(off.state), [[id, []]]);
});

test('the real binary with briefing.enabled false prints the one line and exits 0', () => {
  const world = freshVault('en', { enabled: false });
  const bin = join(world.base, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_GIT, join(bin, 'git'));
  const r = spawnSync(process.execPath, [BIN, 'prompt', 'briefing', '--vault', world.vault], { encoding: 'utf8', env: { ...world.env, PATH: bin }, cwd: world.base });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout, /^The morning briefing is turned off in this vault: briefing\.enabled is false in brain-kit\.config\.json\./);
});

// ------------------------------------------------------------ the vault in every command (final review, C2)

// The desktop application's task starts a session whose working directory
// is not the vault, and every kit command finds its vault from there: the
// render names the vault in every kit command (`-C "<vault>"`) and says
// where every relative path lives.
for (const lang of LANGS) {
  test(`${lang}: every kit command the rendered briefing names carries -C and the vault, and the prompt says every path is relative to the vault`, async () => {
    const world = freshVault(lang);
    await addQuestion(world.state, 'Is the room booked?', { today: '2026-09-20' });
    const { code, out } = await briefing(world);
    assert.equal(code, EXIT.OK, out);
    const kit = kitCommand();
    const at = [...out.matchAll(new RegExp(kit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => m.index);
    assert.ok(at.length >= 7, `${lang}: only ${at.length} kit command(s) in the render`);
    for (const index of at) assert.ok(out.startsWith(`${kit} -C "${world.vault}" `, index), `${lang}: ${out.slice(index, index + kit.length + 60)}`);
    assert.ok(out.includes(`\`${world.vault}\``), `${lang}: the vault's path`);
    assert.ok(out.includes(`\`${world.vault}/<`), `${lang}: the absolute path under the vault`);
  });

  test(`${lang}: the commands the render names run from a directory outside the vault: questions add and answer, validate and lint act on this vault`, async () => {
    const world = freshVault(lang);
    const { out } = await briefing(world);
    const outside = join(world.base, 'home');
    const bin = join(world.base, 'onlygit');
    mkdirSync(bin);
    symlinkSync(REAL_GIT, join(bin, 'git'));
    symlinkSync(process.execPath, join(bin, 'node'));
    const bash = (command) => spawnSync('/bin/bash', ['-c', command], { cwd: outside, env: { ...world.env, PATH: bin }, encoding: 'utf8' });
    const command = (suffix) => {
      const found = out.match(new RegExp(`\`(${kitCommandIn(world.vault).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${suffix}[^\`]*)\``));
      assert.ok(found, `${lang}: no ${suffix} command in the render`);
      return found[1];
    };
    const added = bash(command('questions add').replace(/"<[^>]+>"/, '"Is the room booked for Thursday?"'));
    assert.equal(added.status, 0, added.stdout + added.stderr);
    const [question] = readQueue(world.state);
    assert.equal(question.text, 'Is the room booked for Thursday?');
    const answered = bash(`${command('questions answer').replace('<id>', question.id)}`);
    assert.equal(answered.status, 0, answered.stdout + answered.stderr);
    assert.equal(readQueue(world.state)[0].status, 'answered');
    for (const suffix of ['validate', 'lint --base worktree']) {
      const r = bash(command(suffix));
      assert.equal(r.status, 0, `${lang} ${suffix}: ${r.stdout}${r.stderr}`);
    }
  });
}

test('a vault path with a space, an accent, quotes, a dollar sign and a backtick is still one argument after -C, in the render and through bash', async () => {
  const world = freshVault('en');
  const odd = join(world.base, `Ana's "brain" $HOME \`x\` caf${String.fromCodePoint(0xe9)}`);
  cpSync(world.vault, odd, { recursive: true });
  const { code, out } = await briefing(world, { argv: ['briefing', '--vault', odd] });
  assert.equal(code, EXIT.OK, out);
  const found = out.match(/`("[^"]+" -C "(?:[^"\\]|\\.)*") questions add/);
  assert.ok(found, out);
  const ran = spawnSync('bash', ['-c', `printf '%s\\n' ${found[1]} questions`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.stdout.replace(/\n$/, '').split('\n'), [BIN, '-C', odd, 'questions']);
});

test('--check knows {{vault}} and warns about a briefing overlay without it', async () => {
  const world = freshVault('en');
  const overlay = join(world.vault, '.brain-kit', 'prompts', 'briefing.md');
  mkdirSync(join(overlay, '..'), { recursive: true });
  writeFileSync(overlay, '{{signature}}\n\nAt {{vault}}: {{blocks}} {{never_read}} {{read}}\n');
  const c = collector();
  const code = await runPrompt(['--check', '--vault', world.vault], c.io, createTranslator('en'), { cwd: world.base, env: world.env });
  assert.equal(code, EXIT.OK, c.stdout);
  assert.doesNotMatch(c.stderr, /\{\{vault\}\}/);
  writeFileSync(overlay, '{{signature}}\n\n{{blocks}} {{never_read}} {{read}}\n');
  const d = collector();
  assert.equal(await runPrompt(['--check', '--vault', world.vault], d.io, createTranslator('en'), { cwd: world.base, env: world.env }), EXIT.OK);
  assert.ok(d.stderr.includes(createTranslator('en')('prompt.check_briefing_overlay_no_vault', { path: overlay, placeholder: '{{vault}}' })), `${d.stderr}\n${d.stdout}`);
});

// ------------------------------------------------------------ answer after propose (final review, I1)

// A briefing that overlaps a curator round is refused with 75 by the kit's
// writing commands. The question must never be marked answered before its
// answer is in a pushed commit, and a refusal must stop the writing and be
// told to the owner with the command to run later.
for (const lang of LANGS) {
  test(`${lang}: questions answer is named once, as the step after a successful propose, and the Questions section only points there`, () => {
    const text = packPrompt(lang);
    const answer = '`{{kit}} questions answer <id>`';
    assert.equal(text.split(answer).length - 1, 1, `${lang}: questions answer named more than once`);
    const proposeAt = text.indexOf('`{{kit}} propose "');
    const answerAt = text.indexOf(answer);
    assert.ok(proposeAt !== -1 && proposeAt < answerAt, `${lang}: questions answer comes before propose`);
    const questions = text.slice(text.indexOf('<!-- rule:questions-by-command -->'), text.indexOf('\n## ', text.indexOf('<!-- rule:questions-by-command -->')));
    assert.ok(!questions.includes('questions answer'), `${lang}: the Questions section still runs answer itself`);
    const recording = text.slice(text.indexOf('<!-- rule:propose-only -->'));
    const step = recording.split('\n').find((line) => line.includes(answer));
    assert.match(step, /^5\. /, `${lang}: ${step}`);
    assert.match(step, / 0\b/);
    assert.match(step, / 3\b/);
    const refusal = recording.split('\n').find((line) => /\b75\b/.test(line));
    assert.ok(refusal, `${lang}: nothing is said about exit 75`);
    assert.ok(refusal.includes('`propose`') && refusal.includes('`questions answer`'), `${lang}: the 75 paragraph names the commands to run later: ${refusal}`);
    const never = { en: 'Never end the briefing with a file written and not proposed without telling the owner', 'pt-BR': 'Nunca termine o briefing com um arquivo escrito e não proposto sem dizer ao dono' }[lang];
    assert.ok(recording.includes(never), `${lang}: unproposed writes are never left untold`);
  });
}

// Final review of phase 4, I2: the skill's `!` line runs `prompt briefing`,
// and how Claude Code treats a failing `!` command is unmeasured. The real
// binary exits 0 on every path that wrote the model's text or line.
test('the real binary exits 0 with its one line outside a vault and with a bad time zone, the reason on stderr', () => {
  const base = makeTempDir('brain-kit-briefing-exit-');
  const none = spawnSync(process.execPath, [BIN, 'prompt', 'briefing'], { encoding: 'utf8', env: testEnv(base, { BRAIN_KIT_LANG: 'en' }), cwd: base });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout.trim().split('\n').length, 1);
  assert.equal(none.stderr, `${createTranslator('en')('prompt.briefing_not_rendered', { reason: 'no_vault' })}\n`);
  const world = freshVault('en');
  const file = join(world.vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.vault.timezone = 'Not/AZone';
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const bad = spawnSync(process.execPath, [BIN, 'prompt', 'briefing', '--vault', world.vault], { encoding: 'utf8', env: world.env, cwd: world.base });
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(bad.stdout.trim().split('\n').length, 1, bad.stdout);
  assert.match(bad.stderr, /\(bad_timezone\)/);
});

// ------------------------------------------------------------ an unreadable briefing.read entry (final review, M1)

for (const lang of LANGS) {
  test(`${lang}: a briefing.read entry whose directory cannot be read is said as not verified, never listed as a note to read, and kept out of the blind spots`, { skip: process.getuid?.() === 0 && 'root reads every directory' }, async () => {
    const world = freshVault(lang, { read: ['index.md', '.private/a.md'], blocks: ['blind_spots'] });
    const hidden = join(world.vault, '.private');
    mkdirSync(hidden);
    writeFileSync(join(hidden, 'a.md'), '# A\n');
    chmodSync(hidden, 0o000);
    try {
      const { code, out } = await briefing(world);
      assert.equal(code, EXIT.OK, out);
      assert.ok(!out.includes('- `.private/a.md`'), `${lang}: listed as an ordinary note`);
      assert.ok(out.includes(createTranslator(lang)('briefing.read_unreadable', { path: '.private/a.md', detail: 'EACCES' })), `${lang}: not said as unreadable`);
      assert.ok(out.includes('- `index.md`'));
      const blind = out.slice(out.indexOf('(blind_spots)'));
      assert.ok(!blind.includes('.private/a.md'), `${lang}: named among the notes to read in the blind spots`);
      assert.ok(blind.includes('`index.md`'));
    } finally {
      chmodSync(hidden, 0o700);
    }
  });
}
