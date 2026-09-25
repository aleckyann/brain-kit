// The briefing's blocks (src/briefing/blocks.mjs): the catalog, the
// validation of `briefing.blocks`, and the rendering of every block from
// facts the kit computed, in both languages.
//
// Facts here are fixtures in briefingFacts' own shape, so each block is
// proven to present exactly what it is given; test/prompt-briefing.test.mjs
// renders them from real facts of real vaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { createTranslator } from '../src/lang.mjs';
import {
  BLOCKS, briefingBlocks, briefingLimits, briefingReadList, renderBlocks, renderLimits, renderNeverRead, renderReadList, selectQuestions,
  strategyDoc, validateBriefingBlocks,
} from '../src/briefing/blocks.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const LANGS = ['en', 'pt-BR'];
const KIT = '"/opt/brain-kit/bin/brain-kit.mjs"';
const DEFAULT_BLOCKS = ['sources', 'due', 'upcoming', 'undated', 'open_prs', 'stale', 'blind_spots', 'strategy', 'questions'];

function packConfig(lang) {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
  config.lang = lang;
  config.vault.timezone = 'UTC';
  return config;
}

// A config of `lang` with `briefing` keys replaced (a key set to undefined
// is removed, as a configuration that predates it).
function configWith(lang, briefing = {}) {
  const config = packConfig(lang);
  for (const [key, value] of Object.entries(briefing)) {
    if (value === undefined) delete config.briefing[key];
    else config.briefing[key] = value;
  }
  return config;
}

// A scratch vault with the files each test names.
function vault(files = {}) {
  const root = join(makeTempDir('brain-kit-blocks-'), 'vault');
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function question(id, text, { createdOn = '2026-09-20', askedOn = [], ageDays = 5 } = {}) {
  return { id, text, createdOn, ageDays, askedOn, askedCount: askedOn.length, lastAskedOn: askedOn.at(-1) ?? null };
}

const Q_ESCALATED = question('q-0000000a', 'Is the grant report still due?', { createdOn: '2026-09-10', askedOn: ['2026-09-21', '2026-09-22', '2026-09-23'], ageDays: 15 });
const Q_NEW = question('q-0000000b', 'Which projects end this quarter?');
const Q_OLD = question('q-0000000c', 'Does the old plan still hold?', { createdOn: '2026-08-01', askedOn: ['2026-08-02'], ageDays: 55 });

function facts(over = {}) {
  return {
    today: '2026-09-25',
    todayHuman: '25/09/2026',
    weekday: 'friday',
    tz: 'UTC',
    lastRun: {
      at: '2026-09-24T09:30:00Z', atHuman: '24/09/2026 09:30', exit: 0, reasonCode: null, problem: null,
      sources: { transcripts: { state: null, advanced: true }, calendar: { state: 'needs_auth', advanced: false }, meeting_notes: { state: 'tools_missing', advanced: false } },
    },
    connectorStates: { calendar: { state: 'needs_auth', at: '2026-09-24T09:30:00Z', atHuman: '24/09/2026 09:30' } },
    openPullRequests: { ok: true, reason: null, detail: null, items: [{ number: 7, title: 'curation of 24/09', url: 'https://example.invalid/pr/7', createdHuman: '24/09/2026' }] },
    stale: { ok: true, reason: null, count: 1, notes: [{ path: 'projects/old.md', staleAfter: '2026-09-01', staleAfterHuman: '01/09/2026' }] },
    pending: {
      overdue: [{ file: 'pending/follow-ups.md', line: 16, what: 'Send the report', deadline: '2026-09-24', raw: '24/09/2026' }],
      today: [{ file: 'pending/follow-ups.md', line: 17, what: 'Call the bank', deadline: '2026-09-25', raw: '25/09/2026 or 3/4' }],
      upcoming: [{ file: 'pending/promises.md', line: 14, what: 'Send the deck', deadline: '2026-09-29', raw: '2026-09-29' }],
      undated: [{ file: 'pending/follow-ups.md', line: 18, what: 'Plan Q4', deadline: null, raw: '31/02/2026' }],
      later: 2,
      upcomingDays: 7,
      problems: [
        { code: 'table_missing', detail: { path: 'pending/other.md', heading: '## Open' } },
        { code: 'ambiguous_deadline', detail: { path: 'pending/follow-ups.md', line: 17, deadline: '2026-09-25', others: ['3/4'] } },
        { code: 'invalid_date', detail: { path: 'pending/follow-ups.md', line: 18, value: '31/02/2026' } },
      ],
    },
    git: { branch: 'main', defaultBranch: 'main', upstream: 'origin/main', ahead: 0, behind: 2, dirty: 0, reason: null },
    lock: { held: false, command: null, reason: null },
    questions: {
      ok: true, reason: null, file: '/state/questions.log', escalateAfter: 3, maxAgeDays: 45,
      open: [Q_OLD, Q_ESCALATED, Q_NEW], escalated: [Q_ESCALATED], toArchive: [Q_OLD],
      corrupt: [{ line: 4, reason: 'json', field: null, text: '{oops' }],
    },
    ...over,
  };
}

function renderAll(lang, config, root, { list, f = facts(), mark = null, selection = null } = {}) {
  const cfg = list === undefined ? config : { ...config, briefing: { ...config.briefing, blocks: list } };
  const { blocks, problems } = briefingBlocks(cfg, root);
  return renderBlocks({ blocks, problems, facts: f, config: cfg, root, t: createTranslator(lang), kit: KIT, log: cfg.taxonomy.log, selection, mark });
}

// ------------------------------------------------------------ the catalog and the default

test('BLOCKS is the catalog: seven fact blocks and three judgement blocks', () => {
  assert.deepEqual(BLOCKS, {
    sources: 'fact', due: 'fact', upcoming: 'fact', undated: 'fact', open_prs: 'fact', stale: 'fact', questions: 'fact',
    blind_spots: 'judgement', strategy: 'judgement', today_calendar: 'judgement',
  });
});

test('both packs default briefing.blocks to the same neutral list, and every limit to null', () => {
  for (const lang of LANGS) {
    const briefing = packConfig(lang).briefing;
    assert.deepEqual(briefing.blocks, DEFAULT_BLOCKS, lang);
    assert.equal(briefing.max_words, null, lang);
    assert.equal(briefing.max_questions, null, lang);
    assert.deepEqual(briefing.write_caps, { captures: null, pending_changes: null }, lang);
  }
});

test('a configuration without briefing.blocks reads its pack\'s default list; one that sets it is taken as written', () => {
  const root = vault();
  for (const lang of LANGS) {
    const { blocks, problems } = briefingBlocks(configWith(lang, { blocks: undefined }), root);
    assert.deepEqual(blocks.map((b) => b.id), DEFAULT_BLOCKS);
    assert.deepEqual(problems, []);
  }
  const { blocks } = briefingBlocks(configWith('en', { blocks: ['stale', 'sources'] }), root);
  assert.deepEqual(blocks, [{ id: 'stale', kind: 'fact' }, { id: 'sources', kind: 'fact' }]);
});

// ------------------------------------------------------------ validation

test('an unknown id, a duplicate and an entry that is no block are named problems; the rest keeps its order', () => {
  const root = vault();
  const { blocks, problems } = briefingBlocks(configWith('en', { blocks: ['due', 'agenda', 'stale', 'due', 7, 'sources'] }), root);
  assert.deepEqual(blocks.map((b) => b.id), ['due', 'stale', 'sources']);
  assert.deepEqual(problems, [
    { code: 'unknown', position: 2, id: 'agenda' },
    { code: 'duplicate', position: 4, id: 'due' },
    { code: 'not_a_block', position: 5, value: '7' },
  ]);
});

test('an empty list is a problem and no block appears, the default list included', () => {
  const root = vault();
  const config = configWith('en', { blocks: [] });
  const { blocks, problems } = briefingBlocks(config, root);
  assert.deepEqual(blocks, []);
  assert.deepEqual(problems, [{ code: 'empty' }]);
  const text = renderAll('en', config, root);
  assert.match(text, /briefing\.blocks is an empty list, so this briefing has no block/);
  assert.match(text, /No block is left to give/);
  assert.doesNotMatch(text, /^### /m);
});

test('a custom block: bad id, an id of the catalog, a repeated id, a missing title or instruction, each a named problem', () => {
  const root = vault({ 'projects/a.md': '# A\n' });
  const ok = { id: 'weekly-focus', title: 'Focus', instruction: 'Say what to focus on.', read: ['projects/a.md'] };
  const { blocks, problems } = briefingBlocks(configWith('en', {
    blocks: [
      ok,
      { ...ok, id: 'Weekly Focus' },
      { ...ok, id: 'stale' },
      { ...ok, id: 'weekly-focus' },
      { id: 'no-title', instruction: 'x' },
      { id: 'no-instruction', title: 'T', instruction: '  ' },
      { title: 'no id', instruction: 'x' },
    ],
  }), root);
  assert.deepEqual(blocks, [{ id: 'weekly-focus', kind: 'custom', title: 'Focus', instruction: 'Say what to focus on.', read: ['projects/a.md'] }]);
  assert.deepEqual(problems, [
    { code: 'bad_id', position: 2, id: 'Weekly Focus' },
    { code: 'custom_id_taken', position: 3, id: 'stale' },
    { code: 'duplicate', position: 4, id: 'weekly-focus' },
    { code: 'missing_field', position: 5, id: 'no-title', field: 'title' },
    { code: 'missing_field', position: 6, id: 'no-instruction', field: 'instruction' },
    { code: 'bad_id', position: 7, id: 'null' },
  ]);
});

test('a custom block\'s read paths are normalised; outside the vault, missing, a folder: each a problem, and the block is left out', () => {
  const outside = join(makeTempDir('brain-kit-blocks-outside-'), 'secret.md');
  writeFileSync(outside, 'x\n');
  const root = vault({ 'projects/a.md': '# A\n', 'projects/b.md': '# B\n' });
  symlinkSync(outside, join(root, 'projects', 'link.md'));
  const custom = (read) => ({ id: 'mine', title: 'Mine', instruction: 'Do it.', read });
  const run = (read) => briefingBlocks(configWith('en', { blocks: [custom(read)] }), root);
  assert.deepEqual(run(['./projects/x/../a.md', 'projects/a.md', 'projects//b.md']).blocks[0].read, ['projects/a.md', 'projects/b.md']);
  for (const [path, code] of [
    ['../outside.md', 'read_outside'], ['/etc/hostname', 'read_outside'], ['~/notes.md', 'read_outside'], ['projects/../../x.md', 'read_outside'],
    ['projects/link.md', 'read_outside'], ['projects/missing.md', 'read_missing'], ['projects', 'read_not_file'], ['', 'read_empty'],
  ]) {
    const { blocks, problems } = run(['projects/a.md', path]);
    assert.deepEqual(blocks, [], path);
    assert.deepEqual(problems.map((p) => [p.code, p.position, p.id, p.path]), [[code, 1, 'mine', path]], path);
  }
});

test('a custom block reading a never_read path is refused by name, before the path is looked for, with or without the trailing slash, a fragment, or a link', () => {
  const root = vault({ 'people/ana.md': '# Ana\n', 'memory/log.md': '# Log\n', 'projects/a.md': '# A\n' });
  symlinkSync(join(root, 'people', 'ana.md'), join(root, 'projects', 'ana-link.md'));
  const custom = (read) => ({ id: 'mine', title: 'Mine', instruction: 'Do it.', read: ['projects/a.md', read] });
  for (const [neverRead, path, entry] of [
    [['people/'], 'people/ana.md', 'people/'],
    [['people'], 'people/ana.md', 'people'],
    [['people/'], 'people/nobody.md', 'people/'], // never looked for: not "missing"
    [['people/'], './people/../people/ana.md', 'people/'],
    [['memory/log.md#full'], 'memory/log.md', 'memory/log.md#full'],
    [['people/'], 'projects/ana-link.md', 'people/'],
  ]) {
    const { blocks, problems } = briefingBlocks(configWith('en', { never_read: neverRead, blocks: [custom(path)] }), root);
    assert.deepEqual(blocks, [], path);
    assert.deepEqual(problems, [{ code: 'read_never_read', position: 1, id: 'mine', path, entry }], path);
  }
  // "people" never covers "peoplex/".
  const near = vault({ 'peoplex/a.md': '# A\n' });
  assert.deepEqual(validateBriefingBlocks(configWith('en', { never_read: ['people'], blocks: [{ id: 'mine', title: 'M', instruction: 'x', read: ['peoplex/a.md'] }] }), near), []);
});

test('the left-out blocks are named at the top of the rendered blocks, in both languages, and never rendered', () => {
  const root = vault({ 'people/ana.md': '# Ana\n' });
  for (const lang of LANGS) {
    const config = configWith(lang, { never_read: ['people/'], blocks: ['stale', 'agenda', 'stale', { id: 'mine', title: 'Mine', instruction: 'Read Ana.', read: ['people/ana.md'] }] });
    const text = renderAll(lang, config, root);
    const [head] = text.split('### 1.');
    assert.match(head, lang === 'en' ? /3 problem\(s\) in briefing\.blocks/ : /3 problema\(s\) em briefing\.blocks/);
    assert.match(head, /"agenda"/);
    assert.match(head, /"stale"/);
    assert.match(head, /people\/ana\.md/);
    assert.equal(text.split('\n').filter((line) => line.startsWith('### ')).length, 1);
    assert.doesNotMatch(text, /Read Ana\./);
  }
});

// ------------------------------------------------------------ rendering

const ALL = Object.keys(BLOCKS);

for (const lang of LANGS) {
  test(`${lang}: every catalog block renders from the facts, in the configured order, with nothing left unfilled`, () => {
    const root = vault({ 'decisions/index.md': '# Decisions\n' });
    const t = createTranslator(lang);
    const text = renderAll(lang, packConfig(lang), root, { list: ALL });
    const headings = text.split('\n').filter((line) => line.startsWith('### '));
    assert.deepEqual(headings.map((line) => /\(([a-z_]+)\)$/.exec(line)[1]), ALL);
    assert.deepEqual(headings.map((line) => /^### (\d+)\./.exec(line)[1]), ALL.map((_, i) => String(i + 1)));
    for (const id of ALL) assert.ok(text.includes(t(`briefing.title_${id}`)), `${lang}: ${id}`);
    assert.doesNotMatch(text, /\{[a-z_]+\}/);
    assert.doesNotMatch(text, /\{\{/);
    for (const fact of ['24/09/2026 09:30', '#7 curation of 24/09', 'projects/old.md', '01/09/2026', 'Send the report', '24/09/2026', 'Call the bank',
      '25/09/2026', 'Send the deck', '29/09/2026', 'Plan Q4', '"31/02/2026"', 'q-0000000a', 'q-0000000b', 'q-0000000c', '/state/questions.log', '{oops']) {
      assert.ok(text.includes(fact), `${lang}: ${fact}`);
    }
  });
}

test('en: each pending problem is written under its own item, matched by file and line; a problem with no item heads the first pending block', () => {
  const text = renderAll('en', packConfig('en'), vault(), { list: ['undated', 'due', 'upcoming'] });
  const lines = text.split('\n');
  const at = (needle) => lines.findIndex((line) => line.includes(needle));
  const call = at('Call the bank, deadline 25/09/2026 (pending/follow-ups.md:17)');
  assert.notEqual(call, -1);
  assert.match(lines[call + 1], /^ {4}pending\/follow-ups\.md:17: the deadline was taken as 25\/09\/2026, .*"3\/4", which may also be a date/);
  const plan = at('Plan Q4, deadline cell "31/02/2026" (pending/follow-ups.md:18)');
  assert.match(lines[plan + 1], /^ {4}pending\/follow-ups\.md:18: "31\/02\/2026" is not a real date/);
  // The table that is not there: at the top of the first pending block in
  // the list (undated here), and pointed to from the others.
  const blocks = text.split(/^### /m).slice(1);
  assert.match(blocks[0], /^1\. Pending with no date/);
  assert.match(blocks[0], /Problems reading the pending tables \(1\):\n {2}pending\/other\.md has no table under "## Open"/);
  for (const other of blocks.slice(1)) {
    assert.match(other, /The 1 problem\(s\) reading the pending tables, listed under "Pending with no date", hold here too/);
    assert.doesNotMatch(other, /pending\/other\.md/);
  }
  // Each item problem is written once, under its item only.
  assert.equal(text.split('which may also be a date').length - 1, 1);
});

test('en: a row problem whose item no enabled block shows is not lost: it heads the first pending block', () => {
  const text = renderAll('en', packConfig('en'), vault(), { list: ['upcoming'] });
  assert.match(text, /Problems reading the pending tables \(3\):/);
  assert.match(text, /pending\/follow-ups\.md:17: the deadline was taken as 25\/09\/2026/);
  assert.match(text, /pending\/follow-ups\.md:18: "31\/02\/2026" is not a real date/);
  assert.doesNotMatch(text, /Call the bank/);
});

test('en: the sources block says what to do for every source not read, and git is as of the last fetch', () => {
  const text = renderAll('en', packConfig('en'), vault(), { list: ['sources'] });
  assert.match(text, /Last curator round: 24\/09\/2026 09:30, exit 0/);
  assert.match(text, /What to do about calendar: its mark did not advance .* signed in again/);
  assert.match(text, /What to do about meeting_notes: .* tools were not in the curator's session/);
  assert.doesNotMatch(text, /What to do about transcripts/);
  assert.match(text, /Git: main is 2 commit\(s\) behind and 0 ahead of origin\/main, as of the last fetch\./);
  assert.match(text, /Vault lock: free\./);
  const none = renderAll('en', packConfig('en'), vault(), { list: ['sources'], f: facts({ lastRun: null }) });
  assert.match(none, /no curator round has run on this machine/);
  const failed = renderAll('en', packConfig('en'), vault(), { list: ['sources'], f: facts({ lastRun: { ...facts().lastRun, exit: 4 } }) });
  assert.match(failed, /the last round did not complete \(exit 4\)/);
});

test('en: a pull request list that cannot be known says so, never "none"', () => {
  const text = renderAll('en', packConfig('en'), vault(), { list: ['open_prs'], f: facts({ openPullRequests: { ok: false, reason: 'absent', detail: null, items: null } }) });
  assert.match(text, /Open pull requests: not known, gh is not installed/);
  assert.doesNotMatch(text, /awaiting merge: none/);
});

// ------------------------------------------------------------ the questions

test('selectQuestions: escalated first, then open, in the queue\'s order; null places every open question', () => {
  const q = facts().questions;
  const all = selectQuestions(q, null);
  assert.deepEqual(all.placed.map((x) => x.id), ['q-0000000a', 'q-0000000c', 'q-0000000b']);
  assert.deepEqual([all.notShown, all.room], [0, null]);
  assert.deepEqual(all.placed.map((x) => [x.escalated, x.dueForArchive]), [[true, false], [false, true], [false, false]]);
  const one = selectQuestions(q, 1);
  assert.deepEqual(one.placed.map((x) => x.id), ['q-0000000a']);
  assert.deepEqual([one.notShown, one.room], [2, 0]);
  const five = selectQuestions(q, 5);
  assert.deepEqual([five.placed.length, five.notShown, five.room], [3, 0, 2]);
  const zero = selectQuestions(q, 0);
  assert.deepEqual([zero.placed.length, zero.notShown, zero.room], [0, 3, 0]);
  assert.deepEqual(selectQuestions({ ok: false }, null).placed, []);
});

for (const lang of LANGS) {
  test(`${lang}: the questions block lists the escalated, then the open, the corrupt lines, the sweep and the room`, () => {
    const config = configWith(lang, { max_questions: 2 });
    const selection = selectQuestions(facts().questions, 2);
    const text = renderAll(lang, config, vault(), { list: ['questions'], selection, mark: { ok: true } });
    const a = text.indexOf('q-0000000a');
    const c = text.indexOf('q-0000000c');
    assert.ok(a !== -1 && c !== -1 && a < c, text);
    assert.equal(text.includes('q-0000000b'), false, 'the cut question is not shown');
    assert.match(text, lang === 'en' ? /1 more open question\(s\) not shown: briefing\.max_questions is 2/ : /Mais 1 pergunta\(s\) aberta\(s\) fora da lista: briefing\.max_questions é 2/);
    assert.ok(text.includes(`${KIT} questions sweep`));
    assert.ok(text.includes(`${KIT} questions add`));
    assert.ok(text.includes('{oops'));
    assert.match(text, /25\/09\/2026/);
  });
}

test('en: with no limit every open question is placed and nothing is announced as cut', () => {
  const text = renderAll('en', packConfig('en'), vault(), { list: ['questions'] });
  for (const id of ['q-0000000a', 'q-0000000b', 'q-0000000c']) assert.ok(text.includes(id), id);
  assert.doesNotMatch(text, /not shown/);
  assert.match(text, /No limit on questions is set/);
});

test('en: a queue that cannot be read says so and places nothing', () => {
  const text = renderAll('en', packConfig('en'), vault(), { list: ['questions'], f: facts({ questions: { ok: false, reason: 'EACCES', file: '/state/questions.log', escalateAfter: 3, maxAgeDays: 45, open: null, escalated: null, toArchive: null, corrupt: null } }) });
  assert.match(text, /The question queue cannot be read \(\/state\/questions\.log: EACCES\)/);
  assert.doesNotMatch(text, /q-0000000/);
});

test('en: a failed record of the asked questions is said in the block', () => {
  const text = renderAll('en', packConfig('en'), vault(), { list: ['questions'], mark: { ok: false, detail: 'the queue lock cannot be read' } });
  assert.match(text, /could not record the questions above as asked today \(the queue lock cannot be read\)/);
});

// ------------------------------------------------------------ the judgement and custom blocks

test('strategy: the document linked from the index by its title is named; not configured, not found, or in never_read are each said', () => {
  const root = vault({
    'decisions/index.md': '# Decisions\n\n- [Charter of the lab](charter.md): what the lab is for\n- [Budget](budget.md)\n',
    'decisions/charter.md': '# Charter\n',
  });
  assert.deepEqual(strategyDoc(packConfig('en'), root), { found: true, index: 'decisions/index.md', paths: ['decisions/charter.md'] });
  const text = renderAll('en', packConfig('en'), root, { list: ['strategy'] });
  assert.match(text, /Read `decisions\/charter\.md` \(linked from decisions\/index\.md\)/);
  assert.deepEqual(strategyDoc(configWith('en', { strategy_doc: { index: 'decisions/index.md', title_contains: 'roadmap' } }), root).reason, 'no_match');
  assert.deepEqual(strategyDoc(configWith('en', { strategy_doc: {} }), root), { found: false, reason: 'not_configured' });
  assert.match(renderAll('en', configWith('en', { strategy_doc: {} }), root, { list: ['strategy'] }), /Skipped: briefing\.strategy_doc names no strategy document/);
  const hidden = strategyDoc(configWith('en', { never_read: ['decisions/'] }), root);
  assert.deepEqual([hidden.found, hidden.reason, hidden.detail], [false, 'index_unusable', 'read_never_read']);
  const linkHidden = strategyDoc(configWith('en', { never_read: ['decisions/charter.md'] }), root);
  assert.deepEqual([linkHidden.found, linkHidden.reason], [false, 'targets_unusable']);
});

test('today_calendar: the calendar, the tool prefix, the privacy policy and what to do without the tools', () => {
  for (const lang of LANGS) {
    const config = configWith(lang, { calendar_id: 'ana@example.com' });
    const text = renderAll(lang, config, vault(), { list: ['today_calendar'] });
    assert.ok(text.includes('`ana@example.com`'), lang);
    assert.ok(text.includes('mcp__claude_ai_Google_Calendar__'), lang);
    assert.ok(text.includes('OUT_OF_OFFICE, FOCUS_TIME'), lang);
    assert.ok(text.includes('25/09/2026'), lang);
    assert.match(text, lang === 'en' ? /When those tools are not in your session, say so in one line and skip this block/ : /Quando essas ferramentas não estiverem na sua sessão, diga isso em uma linha e pule este bloco/);
  }
  assert.match(renderAll('en', configWith('en', { calendar_id: null }), vault(), { list: ['today_calendar'] }), /the owner's primary calendar/);
});

test('custom blocks render in their place, with their own title, instruction and paths', () => {
  const root = vault({ 'projects/a.md': '# A\n' });
  const list = [
    { id: 'first', title: 'Before anything', instruction: 'Greet Ana by name.' },
    'stale',
    { id: 'reading', title: 'The reading list', instruction: 'Say which book comes next.', read: ['projects/a.md'] },
  ];
  const text = renderAll('en', packConfig('en'), root, { list });
  const headings = text.split('\n').filter((line) => line.startsWith('### '));
  assert.deepEqual(headings, ['### 1. Before anything (first)', '### 2. Notes due for review (stale)', '### 3. The reading list (reading)']);
  assert.match(text, /Instruction: Greet Ana by name\.\nRead: nothing beyond the read list\./);
  assert.match(text, /Instruction: Say which book comes next\.\nRead: `projects\/a\.md`, and nothing else/);
});

// ------------------------------------------------------------ the other placeholders

test('limits: nothing at all when every limit is null or absent; a set limit renders its own line', () => {
  for (const lang of LANGS) {
    assert.equal(renderLimits(packConfig(lang), createTranslator(lang)), '', lang);
    assert.equal(renderLimits(configWith(lang, { max_words: undefined, max_questions: undefined, write_caps: undefined }), createTranslator(lang)), '', lang);
  }
  const t = createTranslator('en');
  assert.equal(renderLimits(configWith('en', { max_words: 300 }), t), '- The briefing message holds at most 300 words (briefing.max_words).');
  assert.equal(renderLimits(configWith('en', { max_questions: 0 }), t), '- At most 0 questions are asked in this briefing (briefing.max_questions); the questions block already applies it.');
  assert.equal(renderLimits(configWith('en', { write_caps: { captures: 2, pending_changes: null, notes: 1 } }), t),
    '- At most 2 captures are written to the log by this briefing (briefing.write_caps.captures).\n- At most 1 for briefing.write_caps.notes.');
  assert.deepEqual(briefingLimits(configWith('en', { max_words: undefined })), { maxWords: null, maxQuestions: null, writeCaps: { captures: null, pending_changes: null } });
});

test('the read list leaves out, and says so, every entry in never_read or outside the vault; never_read is listed as written', () => {
  const t = createTranslator('en');
  const config = configWith('en', { read: ['index.md', './projects/index.md', 'people/ana.md', '../x.md', 'index.md'], never_read: ['people', 'memory/log.md#full'] });
  assert.deepEqual(briefingReadList(config, vault()).paths, ['index.md', 'projects/index.md']);
  assert.equal(renderReadList(config, vault(), t), [
    '- `index.md`', '- `projects/index.md`',
    '- (left out: `people/ana.md` is covered by the never-read entry `people`; do not open it)',
    '- (left out: `../x.md` is not a path inside the vault; do not open it)',
  ].join('\n'));
  assert.equal(renderNeverRead(config, t), '- `people`\n- `memory/log.md#full`');
  assert.equal(renderNeverRead(configWith('en', { never_read: [] }), t), '(the list is empty)');
});
