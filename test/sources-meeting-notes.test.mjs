// The meeting-notes source (src/sources/meeting-notes-google-drive.mjs):
// the query it hands the round, the prompt block around it, the tool rules
// and connector spec it gives the harness, and the read evidence measured on
// round records, hand-built and captured (test/fixtures/stream/). Its two
// incidents have their own files under test/incidents/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../src/version.mjs';
import { createTranslator } from '../src/lang.mjs';
import { validateConfig } from '../src/config.mjs';
import { validateSource } from '../src/sources/index.mjs';
import { parseStream } from '../src/harness/stream.mjs';
import { connectorStates } from '../src/guards/connectors.mjs';
import { meetingNotesSource } from '../src/sources/meeting-notes-google-drive.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/stream/', import.meta.url));
const PREFIX = 'mcp__claude_ai_Google_Drive__';
const SEARCH = `${PREFIX}search_files`;
const READ = `${PREFIX}read_file_content`;
const METADATA = `${PREFIX}get_file_metadata`;
const WRITE_TOOLS = ['create_file', 'update_file', 'copy_file', 'share_file', 'trash_file', 'download_file_content'];
const LANGS = ['en', 'pt-BR'];

// A day at UTC-3: it opens at 03:00 UTC, and the pack's 12 hours before it
// put the modification bound at 15:00 UTC the day before.
const WINDOW = Object.freeze({ from: new Date('2026-05-12T03:00:00Z'), to: new Date('2026-05-13T03:00:00Z') });
const NOW = new Date('2026-05-13T12:30:00Z');
const SINCE = '2026-05-11T15:00:00Z';

const NO_DOCUMENTS = Object.freeze({ read: 0, failed: 0 });
const READ_ONCE = Object.freeze({ read: 1, expected: 1, ok: true, documents: NO_DOCUMENTS });
const NOT_READ = Object.freeze({ read: 0, expected: 1, ok: false, documents: NO_DOCUMENTS });

function packDefaults(lang) {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

// A configuration holding `lang`'s pack settings for the source, turned on,
// with `overrides` on top.
function configWith(overrides = {}, lang = 'en') {
  return { lang, sources: { meeting_notes: { ...packDefaults(lang).sources.meeting_notes, enabled: true, ...overrides } } };
}

function planFor(overrides = {}, lang = 'en', window = WINDOW) {
  return meetingNotesSource.collect({ window, config: configWith(overrides, lang), now: NOW });
}

// Every field but `listed`, which the tests of ruling R-F1 below check on their own.
const evidence = (record, plan) => {
  const { listed, ...rest } = meetingNotesSource.readEvidence(record, plan);
  return rest;
};

// A round record from a list of calls, in order. Each call answers with no
// error and no next page unless it says otherwise; `answered: false` leaves
// it without a result, as a round killed mid-call does; `complete` is set on
// the result only when the call names it (a record from before the field
// existed has none).
function record(calls) {
  const toolUses = [];
  const toolResults = [];
  calls.forEach((call, index) => {
    const id = `toolu_${String(index + 1).padStart(4, '0')}`;
    toolUses.push({ id, name: call.name, input: call.input });
    if (call.answered === false) return;
    const result = { toolUseId: id, isError: call.isError === true, hasNextPage: call.hasNextPage === true };
    if (Object.hasOwn(call, 'complete')) result.complete = call.complete;
    if (Object.hasOwn(call, 'items')) result.items = call.items;
    toolResults.push(result);
  });
  return { toolUses, toolResults };
}

function search(query, { pageToken, name = SEARCH, ...rest } = {}) {
  return { name, input: pageToken === undefined ? { query } : { query, pageToken }, ...rest };
}

function readDoc(fileId, rest = {}) {
  return { name: READ, input: { fileId }, ...rest };
}

// --- the interface, the defaults and the schema ------------------------------

test('the meeting-notes source implements the source interface, as a best-effort connector source', () => {
  assert.deepEqual(validateSource(meetingNotesSource), []);
  assert.equal(meetingNotesSource.id, 'meeting_notes');
  assert.equal(meetingNotesSource.kind, 'connector');
  assert.equal(meetingNotesSource.required, false);
  assert.equal(meetingNotesSource.emptyMeansNothingListed, false);
  for (const member of ['isConfigured', 'serverSpec', 'toolRules', 'collect', 'readEvidence']) {
    assert.equal(typeof meetingNotesSource[member], 'function', member);
  }
});

test('both packs ship the source off, each with its own literal, any attached document, and the three read tools', () => {
  const literals = { en: 'Notes by Gemini', 'pt-BR': 'Anotações do Gemini' };
  for (const lang of LANGS) {
    const defaults = packDefaults(lang);
    const settings = defaults.sources.meeting_notes;
    assert.equal(settings.enabled, false, lang);
    assert.equal(settings.search_title_contains, literals[lang], lang);
    assert.equal(settings.attached_title_prefix, '', lang);
    assert.deepEqual(settings.tool_suffixes, ['search_files', 'read_file_content', 'get_file_metadata'], lang);
    assert.equal(meetingNotesSource.isConfigured(defaults), false, `${lang}: nothing is read until the person turns the source on`);
    assert.equal(meetingNotesSource.isConfigured(configWith({}, lang)), true, lang);
  }
});

test('the schema takes sources.meeting_notes.enabled as a boolean, and only as one', () => {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  assert.deepEqual(validateConfig(config), [], 'a configuration written before the key existed stays valid');
  config.sources.meeting_notes.enabled = true;
  assert.deepEqual(validateConfig(config), []);
  config.sources.meeting_notes.enabled = 'yes';
  assert.deepEqual(validateConfig(config), ['$.sources.meeting_notes.enabled: expected boolean, got string']);
});

test('isConfigured: enabled exactly true, a title to search for, an MCP prefix, and the three tools the block names', () => {
  const { isConfigured } = meetingNotesSource;
  assert.equal(isConfigured(configWith({})), true);
  assert.equal(isConfigured(configWith({ search_title_contains: "Ana's minutes" })), true);
  for (const enabled of [false, 'true', 1, null, undefined]) {
    assert.equal(isConfigured(configWith({ enabled })), false, `enabled ${String(enabled)}`);
  }
  for (const title of ['', '   ', 42, null, undefined, 'Notes\\by', 'Notes\\']) {
    assert.equal(isConfigured(configWith({ search_title_contains: title })), false, `title ${JSON.stringify(title)}`);
  }
  for (const prefix of ['mcp__Drive__', 'mcp__plugin_docs-server__', 'mcp__a__b__']) {
    assert.equal(isConfigured(configWith({ tool_prefix: prefix })), true, `prefix ${prefix}`);
  }
  for (const prefix of ['', 'mcp__', 'mcp____', 'mcp__Drive_', 'Bash(', 'mcp__Dri ve__', 'mcp__Drive__x', 7, undefined]) {
    assert.equal(isConfigured(configWith({ tool_prefix: prefix })), false, `prefix ${JSON.stringify(prefix)}`);
  }
  for (const suffixes of [['search_files', 'read_file_content'], ['read_file_content', 'get_file_metadata'], ['search_files', 'get_file_metadata'], ['Search_Files', 'read_file_content', 'get_file_metadata'], undefined]) {
    assert.equal(isConfigured(configWith({ tool_suffixes: suffixes })), false, `suffixes ${JSON.stringify(suffixes)}`);
  }
  assert.equal(isConfigured(configWith({ tool_suffixes: ['get_file_metadata', 'search_files', 'Bash(node:*)', 'read_file_content', 'list_recent_files'] })), true, 'extra tools of the right shape, or of another shape, do not matter');
  assert.equal(isConfigured({ sources: {} }), false);
  assert.equal(isConfigured({ sources: { meeting_notes: null } }), false);
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured(null), false);
  const bare = meetingNotesSource.collect({ window: WINDOW, config: { lang: 'en', sources: { meeting_notes: null } }, now: NOW });
  assert.deepEqual({ configured: bare.configured, query: bare.query, toolPrefix: bare.toolPrefix }, { configured: false, query: null, toolPrefix: '' });
  assert.deepEqual(meetingNotesSource.toolRules({}), { allow: [], deny: WRITE_TOOLS }, 'with no prefix configured, the write tools are still denied by name');
});

// --- the query ------------------------------------------------------------------

test('collect gives the exact query: the literal title clause and the modification bound, twelve hours before the window', () => {
  const plan = planFor();
  assert.equal(plan.configured, true);
  assert.equal(plan.literal, 'Notes by Gemini');
  assert.equal(plan.since, SINCE);
  assert.equal(plan.query, "title contains 'Notes by Gemini' and modifiedTime > '2026-05-11T15:00:00Z'");
  assert.equal(plan.toolPrefix, PREFIX);
  assert.deepEqual(plan.problems, []);
  assert.equal(planFor({}, 'pt-BR').query, "title contains 'Anotações do Gemini' and modifiedTime > '2026-05-11T15:00:00Z'");
});

test('the query writes each single quote of the literal as \\\' and every other character as it is', () => {
  assert.equal(planFor({ search_title_contains: "Ana's notes" }).query, "title contains 'Ana\\'s notes' and modifiedTime > '2026-05-11T15:00:00Z'");
  assert.equal(planFor({ search_title_contains: "'Notes' of Ana's" }).query, "title contains '\\'Notes\\' of Ana\\'s' and modifiedTime > '2026-05-11T15:00:00Z'");
  assert.equal(planFor({ search_title_contains: '  Notes | "draft" ' }).query, "title contains '  Notes | \"draft\" ' and modifiedTime > '2026-05-11T15:00:00Z'");
  assert.equal(planFor({ search_title_contains: "Ana's notes" }).literal, "Ana's notes", 'the plan keeps the literal itself, unescaped');
});

test('the since bound: window.from minus window_hours_before_day hours, RFC 3339 in UTC', () => {
  assert.equal(planFor({ window_hours_before_day: 0 }).since, '2026-05-12T03:00:00Z');
  assert.equal(planFor({ window_hours_before_day: 1 }).since, '2026-05-12T02:00:00Z');
  assert.equal(planFor({ window_hours_before_day: 36 }).since, '2026-05-10T15:00:00Z');
  for (const hours of [undefined, null, -1, 1.5, '12']) {
    assert.equal(planFor({ window_hours_before_day: hours }).since, '2026-05-12T03:00:00Z', `${JSON.stringify(hours)} counts as no hours`);
  }
  assert.equal(planFor({ window_hours_before_day: 1e12 }).since, '2026-05-12T03:00:00Z', 'hours reaching past the first instant a date can hold count as none, and never throw');
  const odd = planFor({ window_hours_before_day: 0 }, 'en', { from: new Date('2026-05-12T03:00:00.250Z'), to: WINDOW.to });
  assert.equal(odd.since, '2026-05-12T03:00:00.250Z', 'a fraction of a second is kept, never rounded away');
  assert.equal(planFor({ window_hours_before_day: 0 }).query, "title contains 'Notes by Gemini' and modifiedTime > '2026-05-12T03:00:00Z'");
});

// --- the prompt block -------------------------------------------------------------

// One token per rule of the incidents, per language: a pack edit that drops
// a rule's sentence fails here (review M1 of task 4). SECOND_DOOR_TOKENS are
// the rules of the attachments line, which both of its forms must carry.
const SECOND_DOOR_TOKENS = {
  en: [
    'privacy policy leaves out', "never look for minutes by searching for a person's name", 'never open an audio or video file',
    '"Transcript"', 'as not read', 'never distill them',
  ],
  'pt-BR': [
    'política de privacidade dele deixa de fora', 'nunca procure uma ata buscando o nome de uma pessoa', 'nunca abra um arquivo de áudio ou vídeo',
    '"Transcrição"', 'como não lidos', 'nunca os destile',
  ],
};
const RULE_TOKENS = {
  en: [
    'first-class source', 'accent sensitive', 'read all of it: every tab, not only the summary at the top', 'straight double quotes', 'not distilled again',
    'through both doors is distilled once', 'Never say that a document is empty or missing unless you opened it in this round',
    'divergence to confirm', 'never a fact', 'Never download or open a recording', ...SECOND_DOOR_TOKENS.en,
  ],
  'pt-BR': [
    'fonte de primeira classe', 'diferencia acentos', 'leia a nota inteira: todas as abas, não só o resumo do começo', 'aspas duplas retas', 'não é destilado de novo',
    'pelas duas portas é destilado uma vez só', 'Nunca diga que um documento está vazio ou não existe sem tê-lo aberto nesta rodada',
    'divergência a confirmar', 'nunca um fato', 'Nunca baixe nem abra uma gravação', ...SECOND_DOOR_TOKENS['pt-BR'],
  ],
};

test('the prompt block, in the vault language, gives the exact query and every rule of the incidents, in order', () => {
  const labels = { en: '"no access (document store permission)"', 'pt-BR': '"sem acesso (permissão do repositório de documentos)"' };
  for (const lang of LANGS) {
    const t = createTranslator(lang);
    const plan = planFor({}, lang);
    for (const token of RULE_TOKENS[lang]) assert.ok(plan.promptBlock.includes(token), `${lang}: ${token}`);
    assert.equal(plan.promptBlock, [
      t('sources.meeting_notes.heading'),
      t('sources.meeting_notes.search', { tool: SEARCH, query: plan.query }),
      t('sources.meeting_notes.attachments_any', { metadata: METADATA }),
      t('sources.meeting_notes.read', { tool: READ }),
      t('sources.meeting_notes.distill'),
      t('sources.meeting_notes.no_access'),
      t('sources.meeting_notes.speakers'),
      t('sources.meeting_notes.never_download'),
    ].join('\n'), lang);
    assert.ok(plan.promptBlock.includes(`\`${plan.query}\``), `${lang}: the query, whole, as a code span`);
    assert.ok(plan.promptBlock.includes('nextPageToken') && plan.promptBlock.includes('pageToken'), `${lang}: every page`);
    assert.ok(plan.promptBlock.includes('/d/'), `${lang}: where an attachment keeps the document id`);
    assert.ok(plan.promptBlock.includes(`${METADATA}:`), `${lang}: the attachment is checked with the metadata tool, named in full`);
    assert.ok(plan.promptBlock.includes(labels[lang]), `${lang}: the no-access label`);
    assert.doesNotMatch(plan.promptBlock, /\{\w+\}/, `${lang}: no placeholder left`);
  }
  assert.notEqual(planFor({}, 'en').promptBlock, planFor({}, 'pt-BR').promptBlock);
});

test('an attached title prefix narrows the second door, in the words of the vault language', () => {
  for (const lang of LANGS) {
    const t = createTranslator(lang);
    const lines = planFor({ attached_title_prefix: 'Minutes: ' }, lang).promptBlock.split('\n');
    const narrowed = t('sources.meeting_notes.attachments_prefix', { prefix: 'Minutes: ', metadata: METADATA });
    assert.ok(lines.includes(narrowed), lang);
    assert.ok(!lines.includes(t('sources.meeting_notes.attachments_any', { metadata: METADATA })), lang);
    for (const token of SECOND_DOOR_TOKENS[lang]) assert.ok(narrowed.includes(token), `${lang}, with a prefix: ${token}`);
    const absent = planFor({ attached_title_prefix: undefined }, lang).promptBlock.split('\n');
    assert.ok(absent.includes(t('sources.meeting_notes.attachments_any', { metadata: METADATA })), `${lang}: an absent prefix takes any attached document`);
    const elsewhere = planFor({ tool_prefix: 'mcp__Drive__', attached_title_prefix: 'Minutes: ' }, lang).promptBlock;
    assert.ok(elsewhere.includes('mcp__Drive__get_file_metadata:'), `${lang}: the metadata tool under the configured prefix`);
  }
});

test('a source that is off offers no query, tells the model to open nothing, and is never read', () => {
  for (const lang of LANGS) {
    const t = createTranslator(lang);
    const off = planFor({ enabled: false }, lang);
    assert.equal(off.configured, false);
    assert.equal(off.query, null);
    assert.equal(off.since, SINCE);
    assert.deepEqual(off.problems, [{ code: 'disabled', detail: '' }]);
    assert.equal(off.promptBlock, t('sources.meeting_notes.off'));
    const untitled = planFor({ search_title_contains: '   ' }, lang);
    assert.equal(untitled.configured, false);
    assert.equal(untitled.query, null);
    assert.deepEqual(untitled.problems, [{ code: 'no_title', detail: '' }]);
    assert.equal(untitled.promptBlock, t('sources.meeting_notes.off'));
    assert.deepEqual(planFor({ enabled: false, search_title_contains: '' }, lang).problems.map((p) => p.code), ['disabled', 'no_title']);
  }
  const cases = [
    [{ search_title_contains: 'Notes\\by' }, [{ code: 'title_backslash', detail: '' }]],
    [{ tool_prefix: 'mcp__Drive_' }, [{ code: 'bad_tool_prefix', detail: 'mcp__Drive_' }]],
    [{ tool_prefix: 7 }, [{ code: 'bad_tool_prefix', detail: '' }]],
    [{ tool_suffixes: ['search_files', 'Read_File_Content', 'trash_file'] }, [{ code: 'missing_tools', detail: 'read_file_content, get_file_metadata' }]],
    [{ enabled: false, search_title_contains: '', tool_prefix: '', tool_suffixes: [] }, [
      { code: 'disabled', detail: '' }, { code: 'no_title', detail: '' }, { code: 'bad_tool_prefix', detail: '' },
      { code: 'missing_tools', detail: 'search_files, read_file_content, get_file_metadata' },
    ]],
  ];
  for (const [overrides, problems] of cases) {
    const plan = planFor(overrides);
    assert.deepEqual(plan.problems, problems, JSON.stringify(overrides));
    assert.equal(plan.configured, false, JSON.stringify(overrides));
    assert.equal(plan.query, null, JSON.stringify(overrides));
    assert.equal(plan.promptBlock, createTranslator('en')('sources.meeting_notes.off'), JSON.stringify(overrides));
  }
  const off = planFor({ enabled: false });
  assert.equal(off.literal, 'Notes by Gemini');
  assert.equal(planFor({ search_title_contains: 42 }).literal, null);
  assert.deepEqual(evidence(record([search(planFor().query)]), off), NOT_READ, 'a search with the query it would have had is still not a read');
});

// --- read evidence ----------------------------------------------------------------

test('readEvidence: the exact query, answered with no error and no next page, is a read', () => {
  for (const lang of LANGS) {
    const plan = planFor({}, lang);
    assert.deepEqual(evidence(record([search(plan.query)]), plan), READ_ONCE, lang);
  }
  assert.deepEqual(evidence(record([]), planFor()), NOT_READ, 'no call at all');
  assert.deepEqual(evidence({}, planFor()), NOT_READ, 'a record with no lists');
  const plan = planFor();
  const withHole = record([search(plan.query)]);
  withHole.toolUses.unshift(null);
  withHole.toolResults.unshift(null);
  assert.deepEqual(evidence(withHole, plan), READ_ONCE, 'an entry that is not a tool use or a result is skipped, never fatal');
  assert.deepEqual(evidence(null, plan), NOT_READ, 'no record');
  assert.deepEqual(evidence(record([search(plan.query)]), null), NOT_READ, 'no plan');
});

test('readEvidence: a search with no query, or a query that is not text, is not a read and never throws', () => {
  const plan = planFor();
  assert.deepEqual(evidence(record([{ name: SEARCH, input: {} }]), plan), NOT_READ);
  assert.deepEqual(evidence(record([{ name: SEARCH }]), plan), NOT_READ);
  assert.deepEqual(evidence(record([{ name: SEARCH, input: { query: [plan.query] } }]), plan), NOT_READ);
  assert.deepEqual(evidence(record([search(plan.query, { hasNextPage: true }), { name: SEARCH }]), plan), NOT_READ, 'a later call with no input is no next page');
});

test('readEvidence: the literal without its accent, in another case, shortened or paraphrased is not a read', () => {
  const plan = planFor({}, 'pt-BR');
  const bound = `modifiedTime > '${SINCE}'`;
  for (const title of ['Anotacoes do Gemini', 'anotações do Gemini', 'Anotações do', 'Notas do Gemini', 'Anotações  do Gemini', 'Notes by Gemini']) {
    assert.deepEqual(evidence(record([search(`title contains '${title}' and ${bound}`)]), plan), NOT_READ, title);
  }
  assert.deepEqual(evidence(record([search(`title contains 'Anotações do Gemini extra' and ${bound}`)]), plan), NOT_READ, 'a longer title');
  const quoted = planFor({ search_title_contains: "Ana's notes" });
  assert.deepEqual(evidence(record([search(`title contains 'Ana's notes' and modifiedTime > '${SINCE}'`)]), quoted), NOT_READ, 'the quote left unescaped');
  assert.deepEqual(evidence(record([search(quoted.query)]), quoted), READ_ONCE);
});

test('readEvidence: no modification bound, a later or an earlier one, or one spelt another way is not a read', () => {
  const plan = planFor();
  const title = "title contains 'Notes by Gemini'";
  for (const query of [
    title,
    `${title} and modifiedTime > '2026-05-11T16:00:00Z'`,
    `${title} and modifiedTime > '2026-05-11T00:00:00Z'`,
    `${title} and modifiedTime > '2026-05-11T15:00:00.000Z'`,
    `${title} and modifiedTime >= '2026-05-11T15:00:00Z'`,
    `${title} and createdTime > '2026-05-11T15:00:00Z'`,
  ]) {
    assert.deepEqual(evidence(record([search(query)]), plan), NOT_READ, query);
  }
  assert.deepEqual(evidence(record([search(`modifiedTime > '${SINCE}'`)]), plan), NOT_READ, 'the bound with no title');
});

test('readEvidence: clauses the model adds, or the order it puts them in, do not matter while both clauses are there', () => {
  const plan = planFor();
  assert.deepEqual(evidence(record([search(`${plan.query} and mimeType = 'application/vnd.google-apps.document'`)]), plan), READ_ONCE);
  assert.deepEqual(evidence(record([search(`modifiedTime > '${SINCE}' and title contains 'Notes by Gemini'`)]), plan), READ_ONCE);
  const extra = record([{ name: SEARCH, input: { query: plan.query, pageSize: 50, excludeContentSnippets: true } }]);
  assert.deepEqual(evidence(extra, plan), READ_ONCE, 'other inputs are the model\'s own business');
});

test('readEvidence: an errored or unanswered search is not a read, and a successful retry of it is', () => {
  const plan = planFor();
  assert.deepEqual(evidence(record([search(plan.query, { isError: true })]), plan), NOT_READ);
  assert.deepEqual(evidence(record([search(plan.query, { answered: false })]), plan), NOT_READ);
  assert.deepEqual(evidence(record([search(plan.query, { isError: true }), search(plan.query)]), plan), READ_ONCE);
  const noVerdict = { toolUses: [{ id: 'a', name: SEARCH, input: { query: plan.query } }], toolResults: [{ toolUseId: 'a', hasNextPage: false }] };
  assert.deepEqual(evidence(noVerdict, plan), NOT_READ, 'a result that does not say it succeeded did not');
});

test('readEvidence: a result whose text was cut short (complete false) is a failed call; complete true or absent is whole', () => {
  const plan = planFor();
  const q = plan.query;
  assert.deepEqual(evidence(record([search(q, { complete: false })]), plan), NOT_READ, 'a truncated answer can look like a last page');
  assert.deepEqual(evidence(record([search(q, { complete: true })]), plan), READ_ONCE);
  assert.deepEqual(evidence(record([search(q, { complete: undefined })]), plan), READ_ONCE, 'the field present but undefined');
  assert.deepEqual(evidence(record([search(q)]), plan), READ_ONCE, 'the field absent');
  assert.deepEqual(evidence(record([search(q, { complete: false }), search(q, { complete: true })]), plan), READ_ONCE, 'a whole retry of it');
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', complete: false })]), plan), NOT_READ, 'the next page cut short');
  assert.deepEqual(evidence(record([
    search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', complete: false }), search(q, { pageToken: 'page-2' }),
  ]), plan), READ_ONCE, 'the next page cut short, then asked for again');
  const docs = record([search(q), readDoc('file-0001', { complete: false }), readDoc('file-0002', { complete: true }), readDoc('file-0003')]);
  assert.deepEqual(evidence(docs, plan), { read: 1, expected: 1, ok: true, documents: { read: 2, failed: 1 } }, 'a document read cut short counts as failed');
});

test('readEvidence: a negated title clause or bound is not a read; or, and additive clauses still are', () => {
  const plan = planFor();
  const title = "title contains 'Notes by Gemini'";
  const bound = `modifiedTime > '${SINCE}'`;
  for (const query of [
    `not ${title} and ${bound}`,
    `${title} and not ${bound}`,
    `${title} and not(${bound})`,
    `${title} and NOT ( ${bound})`,
    `(not ${title}) and ${bound}`,
    `${title} and ${bound} and not ${title}`,
  ]) {
    assert.deepEqual(evidence(record([search(query)]), plan), NOT_READ, query);
  }
  for (const query of [`${title} or ${bound}`, `${bound} and ${title}`, `(${title}) and (${bound})`, `${title} and ${bound} and not mimeType = 'application/pdf'`]) {
    assert.deepEqual(evidence(record([search(query)]), plan), READ_ONCE, query);
  }
  assert.deepEqual(evidence(record([search(`knot ${title} and ${bound}`)]), plan), READ_ONCE, 'only the word not negates, never a word ending in it');
});

test('readEvidence: a result that does not say whether a next page exists is not a last page', () => {
  const plan = planFor();
  const silent = { toolUses: [{ id: 'a', name: SEARCH, input: { query: plan.query } }], toolResults: [{ toolUseId: 'a', isError: false }] };
  assert.deepEqual(evidence(silent, plan), NOT_READ);
});

test('readEvidence: every advertised next page must be asked for, with the same query and a page token', () => {
  const plan = planFor();
  const q = plan.query;
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true })]), plan), NOT_READ, 'a first page is not every page');
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2' })]), plan), READ_ONCE);
  assert.deepEqual(evidence(record([
    search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', hasNextPage: true }), search(q, { pageToken: 'page-3' }),
  ]), plan), READ_ONCE, 'three pages');
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', hasNextPage: true })]), plan), NOT_READ, 'the second page advertises a third');
  assert.deepEqual(evidence(record([
    search(q, { hasNextPage: true }), search(`${q} and mimeType = 'application/pdf'`, { pageToken: 'page-2' }),
  ]), plan), NOT_READ, 'the next page of another query');
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true }), search(q, { pageToken: '', hasNextPage: true })]), plan), NOT_READ, 'an empty page token is no token');
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true }), search(q, { hasNextPage: true })]), plan), NOT_READ, 'the first page asked for twice');
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', name: 'mcp__plugin_example_docs__search_files' })]), plan), NOT_READ, 'the next page from another server');
  assert.deepEqual(evidence(record([search(q, { pageToken: 'page-2' }), search(q, { hasNextPage: true })]), plan), NOT_READ, 'a later page asked for before the first');
  assert.deepEqual(evidence(record([search(q, { pageToken: 'page-2' })]), plan), NOT_READ, 'a chain that starts with a page token');
  assert.deepEqual(evidence(record([search(q, { pageToken: '' })]), plan), READ_ONCE, 'an empty page token asks for the first page');
  assert.deepEqual(evidence(record([search(q, { pageToken: null })]), plan), READ_ONCE, 'so does a null one');
  assert.deepEqual(evidence(record([search(q, { pageToken: 7 })]), plan), NOT_READ, 'a token that is not text is no first page');
  assert.deepEqual(evidence(record([search(q, { hasNextPage: true }), search(q, { pageToken: 7 })]), plan), NOT_READ, 'nor a next page');
  assert.deepEqual(evidence(record([
    search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', isError: true }),
  ]), plan), NOT_READ, 'the next page errored');
  assert.deepEqual(evidence(record([
    search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', isError: true }), search(q, { pageToken: 'page-2' }),
  ]), plan), READ_ONCE, 'the next page errored, and a retry of it succeeded');
  assert.deepEqual(evidence(record([
    search(q, { hasNextPage: true }), search(q, { pageToken: 'page-2', answered: false }),
  ]), plan), NOT_READ, 'the next page never answered');
});

test('readEvidence: the search of another server, or another tool given the query, is not a read', () => {
  const plan = planFor();
  assert.deepEqual(evidence(record([search(plan.query, { name: 'mcp__plugin_example_docs__search_files' })]), plan), NOT_READ);
  assert.deepEqual(evidence(record([search(plan.query, { name: 'search_files' })]), plan), NOT_READ);
  assert.deepEqual(evidence(record([search(plan.query, { name: `${PREFIX}list_recent_files` })]), plan), NOT_READ);
  const otherPrefix = planFor({ tool_prefix: 'mcp__Drive__' });
  assert.deepEqual(evidence(record([search(otherPrefix.query)]), otherPrefix), NOT_READ, 'the default tool when the vault names another prefix');
  assert.deepEqual(evidence(record([search(otherPrefix.query, { name: 'mcp__Drive__search_files' })]), otherPrefix), READ_ONCE);
});

test('readEvidence counts the documents read and those that failed, and never makes them a condition', () => {
  const plan = planFor();
  const round = record([
    search(plan.query),
    readDoc('file-0001'),
    readDoc('file-0002', { isError: true }),
    readDoc('file-0003'),
    readDoc('file-0004', { answered: false }),
    readDoc('file-0005', { name: 'mcp__plugin_example_docs__read_file_content' }),
    readDoc('file-0006', { name: `${PREFIX}get_file_metadata` }),
  ]);
  assert.deepEqual(evidence(round, plan), { read: 1, expected: 1, ok: true, documents: { read: 2, failed: 1 } });
  assert.deepEqual(evidence(record([readDoc('file-0001'), readDoc('file-0002')]), plan), { read: 0, expected: 1, ok: false, documents: { read: 2, failed: 0 } },
    'documents opened without the search: counted, and the source is still not read');
  const noVerdict = { toolUses: [{ id: 'a', name: READ, input: { fileId: 'file-0001' } }], toolResults: [{ toolUseId: 'a', hasNextPage: false }] };
  assert.deepEqual(evidence(noVerdict, plan).documents, { read: 0, failed: 1 }, 'a result that does not say it succeeded counts as failed');
});

test('the captured stream: a search whose next page was never asked for is not a read, and asking for it makes one', () => {
  const round = parseStream(readFileSync(join(FIXTURES, 'connectors-connected.jsonl'), 'utf8'));
  const plan = planFor({ search_title_contains: 'Meeting notes' }, 'en', { from: new Date('2026-05-11T12:00:00Z'), to: new Date('2026-05-12T12:00:00Z') });
  assert.equal(plan.query, "title contains 'Meeting notes' and modifiedTime > '2026-05-11T00:00:00Z'");
  const searches = round.toolUses.filter((use) => use.name === SEARCH);
  assert.deepEqual(searches.map((use) => use.input.query), [plan.query], 'the capture holds one search, with this very query');
  assert.equal(round.toolResults.find((result) => result.toolUseId === searches[0].id).hasNextPage, true);
  assert.deepEqual(evidence(round, plan), NOT_READ);
  const followed = {
    ...round,
    toolUses: [...round.toolUses, { id: 'toolu_page_2', name: SEARCH, input: { query: plan.query, pageToken: 'page-2' } }],
    toolResults: [...round.toolResults, { toolUseId: 'toolu_page_2', isError: false, hasNextPage: false }],
  };
  assert.deepEqual(evidence(followed, plan), READ_ONCE);
});

// --- what the harness is given ------------------------------------------------------

test('toolRules allows the configured read tools and denies every write tool of the connector', () => {
  assert.deepEqual(meetingNotesSource.toolRules(configWith({})), {
    allow: [SEARCH, READ, `${PREFIX}get_file_metadata`],
    deny: WRITE_TOOLS.map((suffix) => PREFIX + suffix),
  });
  const listed = meetingNotesSource.toolRules(configWith({ tool_suffixes: ['search_files', 'trash_file', 'download_file_content', 'search_files', '', 7] }));
  assert.deepEqual(listed, { allow: [SEARCH], deny: WRITE_TOOLS.map((suffix) => PREFIX + suffix) }, 'a write tool listed among the suffixes is never allowed, and each tool is named once');
  assert.deepEqual(meetingNotesSource.toolRules(configWith({ tool_prefix: 'mcp__Drive__', tool_suffixes: ['search_files'] })), {
    allow: ['mcp__Drive__search_files'],
    deny: WRITE_TOOLS.map((suffix) => `mcp__Drive__${suffix}`),
  });
  assert.deepEqual(meetingNotesSource.toolRules(configWith({ tool_suffixes: undefined })).allow, []);
  const shaped = meetingNotesSource.toolRules(configWith({ tool_suffixes: ['search_files', 'Bash(node:*)', 'Read_File', 'get file', 'x-y', null, '9search', 'list_recent_files'] }));
  assert.deepEqual(shaped.allow, [SEARCH, `${PREFIX}list_recent_files`], 'only lower-case snake-case tool names become rules');
  for (const prefix of ['', 'Bash(', 'mcp__Drive_', 'mcp__Dri ve__']) {
    const rules = meetingNotesSource.toolRules(configWith({ tool_prefix: prefix, tool_suffixes: ['search_files', 'read_file_content'] }));
    assert.deepEqual(rules.allow, [], `nothing is allowed under the prefix ${JSON.stringify(prefix)}`);
    assert.deepEqual(rules.deny, WRITE_TOOLS.map((suffix) => prefix + suffix), `the write tools stay denied under ${JSON.stringify(prefix)}`);
  }
});

test('serverSpec names the connector, its prefix and the tools the source needs, never a write tool', () => {
  const spec = meetingNotesSource.serverSpec(configWith({}));
  assert.deepEqual(spec, { id: 'meeting_notes', serverDisplayName: 'claude.ai Google Drive', toolPrefix: PREFIX, toolSuffixes: ['search_files', 'read_file_content', 'get_file_metadata'] });
  assert.deepEqual(meetingNotesSource.serverSpec(configWith({ tool_suffixes: ['search_files', 'share_file'] })).toolSuffixes, ['search_files']);
  assert.deepEqual(meetingNotesSource.serverSpec(configWith({ tool_suffixes: ['search_files', 'Bash(node:*)', 7] })).toolSuffixes, ['search_files']);
  const init = parseStream(readFileSync(join(FIXTURES, 'connectors-connected.jsonl'), 'utf8')).init;
  assert.deepEqual(connectorStates(init, [spec]), { meeting_notes: { state: 'connected', rawStatus: 'connected', observedPrefix: PREFIX } },
    'the captured session holds every tool the pack configures');
});

// --- listed (ruling R-F1) -------------------------------------------------------------

test('readEvidence: listed sums the files on the pages of the search chain that read the source, and no other call', () => {
  const plan = planFor();
  const q = plan.query;
  const listed = (calls) => meetingNotesSource.readEvidence(record(calls), plan).listed;
  assert.equal(listed([search(q, { items: 0 })]), 0);
  assert.equal(listed([search(q, { items: 2 })]), 2);
  assert.equal(listed([search(q, { hasNextPage: true, items: 1 }), search(q, { pageToken: 'page-2', items: 2 })]), 3, 'every page');
  assert.equal(listed([search(q, { hasNextPage: true, items: 0 }), search(q, { pageToken: 'page-2', complete: false, items: 9 }), search(q, { pageToken: 'page-2', items: 0 })]), 0, 'a cut page taken over by its retry');
  assert.equal(listed([search('title contains \'x\'', { items: 5 }), search(q, { items: 0 })]), 0, 'another search does not count');
  assert.equal(listed([search(q, { items: 0 }), readDoc('file-0001', { items: 3 })]), 0, 'a document read is no listing');
  // Every search holding both clauses counts, not only the chain that proves the read (scoped re-review).
  assert.equal(listed([search(q, { items: 0 }), search(q, { items: 2 })]), 2, 'the same search again, which found two');
  assert.equal(listed([search(`${q} and mimeType = 'application/vnd.google-apps.document'`, { items: 0 }), search(q, { items: 2 })]), 2, 'a narrowed search first, then the plain one');
  assert.equal(listed([search(q, { items: 0 }), search(q, { hasNextPage: true, items: 0 }), search(q, { pageToken: 'page-2', items: 1 })]), 1, 'the next page of a second search');
  assert.equal(listed([search(q, { items: 0 }), search(q, { isError: true, items: 4 })]), 0, 'a failed search listed nothing the model can count');
  assert.equal(listed([search(q, { items: 0 }), search(q)]), null, 'a second search with no count');
  assert.equal(listed([search(q)]), null, 'a page with no count');
  assert.equal(listed([search(q, { hasNextPage: true, items: 0 }), search(q, { pageToken: 'page-2', items: null })]), null, 'one page with no count');
  assert.equal(listed([search('title contains \'x\'', { items: 0 })]), null, 'nothing read');
  assert.equal(meetingNotesSource.readEvidence(record([search(q, { items: 0 })]), { ...plan, configured: false }).listed, null, 'a source that is off');
});
