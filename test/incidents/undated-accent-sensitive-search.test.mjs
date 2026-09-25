// Undated (docs/incidents.md, "the document search is accent sensitive and
// fails silently"): the title the meeting service gives its automatic notes
// carries an accented word. Without the accent the search returns no
// document and no error; with it, it returns the notes. It was found while
// calibrating the source, so there is no date. The rule: copy the search
// string literally, accents included, and treat a silent failure as a risk
// of its own: a wrong query raises nothing, it makes a quiet night.
//
// Where it lives: the meeting-notes source. The literal lives in the
// configuration (the pt-BR pack ships the accented title), the query
// carries it untouched, the prompt block hands it to the model whole, and
// only a search whose query holds that exact literal counts as reading the
// source. The store's answer to a search without the accent (no file, no
// error, no next page) goes through the real stream parser below: it is
// not a read, so the day stays open for meeting notes. Example data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { parseStream } from '../../src/harness/stream.mjs';
import { meetingNotesSource } from '../../src/sources/meeting-notes-google-drive.mjs';

const SEARCH = 'mcp__claude_ai_Google_Drive__search_files';
const WINDOW = Object.freeze({ from: new Date('2026-05-12T03:00:00Z'), to: new Date('2026-05-13T03:00:00Z') });
const NOT_READ = Object.freeze({ read: 0, expected: 1, ok: false, documents: { read: 0, failed: 0 }, listed: null });
const READ_ONCE = Object.freeze({ read: 1, expected: 1, ok: true, documents: { read: 0, failed: 0 } });

function ptPlan() {
  const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'pt-BR', 'config.defaults.json'), 'utf8'));
  const config = { lang: 'pt-BR', sources: { meeting_notes: { ...defaults.sources.meeting_notes, enabled: true } } };
  return { defaults, plan: meetingNotesSource.collect({ window: WINDOW, config, now: WINDOW.to }) };
}

// One search and the store's answer to it, as the CLI streams them: the
// connector's answer is a string of compact JSON.
function searchStream(query, files) {
  const id = 'toolu_accent_0001';
  return parseStream([
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: SEARCH, input: { query, pageSize: 50 } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ files }) }] } }),
  ]);
}

const NOTE = Object.freeze({ id: 'file-0001', title: 'Anotações do Gemini - Reading group', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-05-12T13:30:00.000Z' });

test('pt-BR: a search without the accent, answered with no document and no error, is not a read; the literal one is', () => {
  const { defaults, plan } = ptPlan();
  assert.equal(defaults.sources.meeting_notes.search_title_contains, 'Anotações do Gemini');
  const unaccented = plan.literal.normalize('NFD').replace(/\p{M}/gu, '');
  assert.equal(unaccented, 'Anotacoes do Gemini');

  const quiet = searchStream(plan.query.replace(plan.literal, unaccented), []);
  assert.deepEqual(quiet.toolResults.map((r) => [r.isError, r.hasNextPage]), [[false, false]], 'no error and no next page: nothing says anything went wrong');
  assert.deepEqual(meetingNotesSource.readEvidence(quiet, plan), NOT_READ);

  assert.deepEqual(meetingNotesSource.readEvidence(searchStream(plan.query, [NOTE]), plan), { ...READ_ONCE, listed: 1 }, 'the one document the search found is counted');
});

test('pt-BR: the same letters in another Unicode form are another query, and not a read', () => {
  const { plan } = ptPlan();
  const decomposed = plan.query.normalize('NFD');
  assert.notEqual(decomposed, plan.query);
  assert.deepEqual(meetingNotesSource.readEvidence(searchStream(decomposed, []), plan), NOT_READ);
});

test('pt-BR: the prompt block hands the model the accented query whole, and says why no letter may change', () => {
  const { plan } = ptPlan();
  assert.equal(plan.query, "title contains 'Anotações do Gemini' and modifiedTime > '2026-05-11T15:00:00Z'");
  const t = createTranslator('pt-BR');
  assert.ok(plan.promptBlock.split('\n').includes(t('sources.meeting_notes.search', { tool: SEARCH, query: plan.query })));
  assert.ok(plan.promptBlock.includes(`\`${plan.query}\``));
  for (const why of ['incluindo aspas e acentos', 'Nunca encurte, traduza, corrija nem reescreva a query', 'a busca diferencia acentos', 'uma letra trocada não devolve nenhum documento nem erro']) {
    assert.ok(plan.promptBlock.includes(why), why);
  }
});
