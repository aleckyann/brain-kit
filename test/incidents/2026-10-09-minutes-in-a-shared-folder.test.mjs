// 09/10/2026 (docs/incidents.md, "committee minutes lived in a folder no
// door reached"): the minutes of a recurring board-style committee lived in
// a shared folder of another company. A meeting-notes service wrote them,
// but they were neither attached to the calendar event nor titled like the
// vault's literal, so neither door of the meeting-notes source reached
// them: the vault knew the committee only from its third session on, and
// two sessions were recovered by hand two months later. On the same days
// the folder showed two traps: 25 transcripts of old sessions uploaded as
// PDF in one evening, all created that day, and the next morning dozens of
// documents from 2024 modified in bulk, all in the same minute.
// The rule: a folder of minutes is a door of its own, searched to its last
// page every round, and only its native documents created shortly before
// the window count, so neither trap is read as new minutes.
//
// Where it lives: the meeting-notes source. `search_folders` names the
// folders; each one gets an exact query (parentId, mimeType, createdTime
// seven days before the modification bound, modifiedTime) and a line of
// the prompt block in the vault's language, and the source is read only
// when every folder's search, like the title search, reached its last page.
// A round that skips a folder leaves the day open. Example data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { parseStream } from '../../src/harness/stream.mjs';
import { meetingNotesSource } from '../../src/sources/meeting-notes-google-drive.mjs';

const SEARCH = 'mcp__claude_ai_Google_Drive__search_files';
const FOLDER = '1AbCdEfGhIjKlMnOpQrStUv';
// The day of the incident at UTC-3, and the pack's 12 hours before it.
const WINDOW = Object.freeze({ from: new Date('2026-10-09T03:00:00Z'), to: new Date('2026-10-10T03:00:00Z') });
const FOLDER_QUERY = `parentId = '${FOLDER}' and mimeType = 'application/vnd.google-apps.document' and createdTime > '2026-10-01T15:00:00Z' and modifiedTime > '2026-10-08T15:00:00Z'`;

function turnedOn(lang, folders) {
  const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
  const config = { lang, sources: { meeting_notes: { ...defaults.sources.meeting_notes, enabled: true, search_folders: folders } } };
  return { defaults, plan: meetingNotesSource.collect({ window: WINDOW, config, now: WINDOW.to }) };
}

// A round's searches as the CLI streams them, each [query, files, pageToken,
// nextPageToken]: the connector's answer is a string of compact JSON.
function round(searches) {
  const lines = [];
  searches.forEach(([query, files, pageToken, nextPageToken], index) => {
    const id = `toolu_folder_${String(index + 1).padStart(4, '0')}`;
    const input = pageToken === undefined ? { query } : { query, pageToken };
    const answer = nextPageToken === undefined ? { files } : { files, nextPageToken };
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: SEARCH, input }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(answer) }] } }));
  });
  return parseStream(lines);
}

const MINUTES = (n) => ({ id: `file-${n}`, title: `Committee minutes ${n}`, mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-09T13:30:00.000Z' });

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: the pack ships no folder, and a folder listed gets its exact query and its own line in the prompt block`, () => {
    const { defaults, plan } = turnedOn(lang, [FOLDER]);
    assert.deepEqual(defaults.sources.meeting_notes.search_folders, [], 'no folder until the person names one');
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.folderQueries, [FOLDER_QUERY], 'native documents only, created at most seven days before the bound');
    const line = createTranslator(lang)('sources.meeting_notes.folder', { tool: SEARCH, query: FOLDER_QUERY });
    assert.ok(plan.promptBlock.split('\n').includes(line));
    assert.equal(turnedOn(lang, []).plan.promptBlock.includes(FOLDER_QUERY), false, 'no folder, no line');
  });

  test(`${lang}: the round the incident describes, the title search alone, leaves the day open; the folder searched to its last page reads it`, () => {
    const { plan } = turnedOn(lang, [FOLDER]);
    const titleOnly = round([[plan.query, []]]);
    assert.deepEqual(meetingNotesSource.readEvidence(titleOnly, plan), { read: 0, expected: 1, ok: false, documents: { read: 0, failed: 0 }, listed: null });
    const withFolder = round([
      [plan.query, []],
      [FOLDER_QUERY, [MINUTES(1)], undefined, 'page-2'],
      [FOLDER_QUERY, [MINUTES(2)], 'page-2'],
    ]);
    assert.deepEqual(meetingNotesSource.readEvidence(withFolder, plan), { read: 1, expected: 1, ok: true, documents: { read: 0, failed: 0 }, listed: 2 });
    const firstPageOnly = round([[plan.query, []], [FOLDER_QUERY, [MINUTES(1)], undefined, 'page-2']]);
    assert.equal(meetingNotesSource.readEvidence(firstPageOnly, plan).read, 0, 'a first page is not every page');
  });
}

test('the two traps: a search of the folder that lets in its transcripts or its old documents touched in bulk is no read', () => {
  const { plan } = turnedOn('en', [FOLDER]);
  const withPdfs = FOLDER_QUERY.replace(" and mimeType = 'application/vnd.google-apps.document'", '');
  const withOld = FOLDER_QUERY.replace(" and createdTime > '2026-10-01T15:00:00Z'", '');
  for (const query of [withPdfs, withOld]) {
    assert.deepEqual(meetingNotesSource.readEvidence(round([[plan.query, []], [query, [MINUTES(1)]]]), plan).read, 0, query);
  }
});
