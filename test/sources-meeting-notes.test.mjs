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

const evidence = (record, plan) => meetingNotesSource.readEvidence(record, plan);

// A round record from a list of calls, in order. Each call answers with no
// error and no next page unless it says otherwise; `answered: false` leaves
// it without a result, as a round killed mid-call does.
function record(calls) {
  const toolUses = [];
  const toolResults = [];
  calls.forEach((call, index) => {
    const id = `toolu_${String(index + 1).padStart(4, '0')}`;
    toolUses.push({ id, name: call.name, input: call.input });
    if (call.answered !== false) toolResults.push({ toolUseId: id, isError: call.isError === true, hasNextPage: call.hasNextPage === true });
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

test('isConfigured: enabled exactly true, and a title to search for', () => {
  const { isConfigured } = meetingNotesSource;
  assert.equal(isConfigured(configWith({})), true);
  assert.equal(isConfigured(configWith({ search_title_contains: "Ana's minutes" })), true);
  for (const enabled of [false, 'true', 1, null, undefined]) {
    assert.equal(isConfigured(configWith({ enabled })), false, `enabled ${String(enabled)}`);
  }
  for (const title of ['', '   ', 42, null, undefined]) {
    assert.equal(isConfigured(configWith({ search_title_contains: title })), false, `title ${JSON.stringify(title)}`);
  }
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

test('the prompt block, in the vault language, gives the exact query and every rule of the incidents, in order', () => {
  const labels = { en: '"no access (document store permission)"', 'pt-BR': '"sem acesso (permissão do repositório de documentos)"' };
  for (const lang of LANGS) {
    const t = createTranslator(lang);
    const plan = planFor({}, lang);
    assert.equal(plan.promptBlock, [
      t('sources.meeting_notes.heading'),
      t('sources.meeting_notes.search', { tool: SEARCH, query: plan.query }),
      t('sources.meeting_notes.attachments_any'),
      t('sources.meeting_notes.read', { tool: READ }),
      t('sources.meeting_notes.distill'),
      t('sources.meeting_notes.no_access'),
      t('sources.meeting_notes.speakers'),
      t('sources.meeting_notes.never_download'),
    ].join('\n'), lang);
    assert.ok(plan.promptBlock.includes(`\`${plan.query}\``), `${lang}: the query, whole, as a code span`);
    assert.ok(plan.promptBlock.includes('nextPageToken') && plan.promptBlock.includes('pageToken'), `${lang}: every page`);
    assert.ok(plan.promptBlock.includes('/d/'), `${lang}: where an attachment keeps the document id`);
    assert.ok(plan.promptBlock.includes(labels[lang]), `${lang}: the no-access label`);
    assert.doesNotMatch(plan.promptBlock, /\{\w+\}/, `${lang}: no placeholder left`);
  }
  assert.notEqual(planFor({}, 'en').promptBlock, planFor({}, 'pt-BR').promptBlock);
});

test('an attached title prefix narrows the second door, in the words of the vault language', () => {
  for (const lang of LANGS) {
    const t = createTranslator(lang);
    const lines = planFor({ attached_title_prefix: 'Minutes: ' }, lang).promptBlock.split('\n');
    assert.ok(lines.includes(t('sources.meeting_notes.attachments_prefix', { prefix: 'Minutes: ' })), lang);
    assert.ok(!lines.includes(t('sources.meeting_notes.attachments_any')), lang);
    const absent = planFor({ attached_title_prefix: undefined }, lang).promptBlock.split('\n');
    assert.ok(absent.includes(t('sources.meeting_notes.attachments_any')), `${lang}: an absent prefix takes any attached document`);
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
});

test('serverSpec names the connector, its prefix and the tools the source needs, never a write tool', () => {
  const spec = meetingNotesSource.serverSpec(configWith({}));
  assert.deepEqual(spec, { id: 'meeting_notes', serverDisplayName: 'claude.ai Google Drive', toolPrefix: PREFIX, toolSuffixes: ['search_files', 'read_file_content', 'get_file_metadata'] });
  assert.deepEqual(meetingNotesSource.serverSpec(configWith({ tool_suffixes: ['search_files', 'share_file'] })).toolSuffixes, ['search_files']);
  const init = parseStream(readFileSync(join(FIXTURES, 'connectors-connected.jsonl'), 'utf8')).init;
  assert.deepEqual(connectorStates(init, [spec]), { meeting_notes: { state: 'connected', rawStatus: 'connected', observedPrefix: PREFIX } },
    'the captured session holds every tool the pack configures');
});
