// 11/08/2026 (docs/incidents.md, "half the meeting notes were invisible"):
// only one door existed, a search of the document store by title prefix.
// Minutes people write by hand carry free-form titles, so they were
// invisible, and two internal meetings went unrecorded while the pointer to
// their minutes, the event's own attachment, sat in the curator's hands.
// The rule: two doors, a title search for the notes the meeting service
// writes on its own and the event's attachments for the minutes people
// write, deduplicated by the literal title in the log.
//
// Where it lives: the meeting-notes source. Its prompt block names both
// doors in the vault's language, and both packs default to any attached
// document (attached_title_prefix ""), so a free-form title is never the
// reason a minute is missed. The kit's evidence stays the title search
// alone (decision D7): it cannot know how many documents hang on the
// window's events, so it counts the documents opened and asks nothing of
// them. Example data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { meetingNotesSource } from '../../src/sources/meeting-notes-google-drive.mjs';

const PREFIX = 'mcp__claude_ai_Google_Drive__';
const WINDOW = Object.freeze({ from: new Date('2026-08-10T03:00:00Z'), to: new Date('2026-08-11T03:00:00Z') });

function turnedOn(lang, overrides = {}) {
  const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
  const config = { lang, sources: { meeting_notes: { ...defaults.sources.meeting_notes, enabled: true, ...overrides } } };
  return { defaults, plan: meetingNotesSource.collect({ window: WINDOW, config, now: WINDOW.to }) };
}

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: the prompt block names both doors, and the pack takes every attached document, whatever its title`, () => {
    const { defaults, plan } = turnedOn(lang);
    assert.equal(defaults.sources.meeting_notes.attached_title_prefix, '', 'no title prefix: a hand-written minute is found through its attachment alone');
    const t = createTranslator(lang);
    const lines = plan.promptBlock.split('\n');
    assert.ok(lines.includes(t('sources.meeting_notes.search', { tool: `${PREFIX}search_files`, query: plan.query })), 'first door: the title search, with its exact query');
    const second = t('sources.meeting_notes.attachments_any');
    assert.ok(lines.includes(second), 'second door: every document attached to an event of the window');
    assert.ok(second.includes('/d/'), 'an attachment gives a file URL and a title only, and the second door says where the document id is');
    assert.ok(lines.includes(t('sources.meeting_notes.distill')), 'one distillation per literal title, whichever door it came through');
  });

  test(`${lang}: a title prefix narrows the second door and never closes it, and the first door stays`, () => {
    const { plan } = turnedOn(lang, { attached_title_prefix: 'Minutes - ' });
    const t = createTranslator(lang);
    const lines = plan.promptBlock.split('\n');
    assert.ok(lines.includes(t('sources.meeting_notes.search', { tool: `${PREFIX}search_files`, query: plan.query })));
    assert.ok(lines.includes(t('sources.meeting_notes.attachments_prefix', { prefix: 'Minutes - ' })));
  });
}

test('the evidence is the title search alone: attachments opened without it leave the source unread, and the search reads it with none opened', () => {
  const { plan } = turnedOn('en');
  const round = (calls) => ({
    toolUses: calls.map(([name, input], index) => ({ id: `toolu_${index}`, name, input })),
    toolResults: calls.map((call, index) => ({ toolUseId: `toolu_${index}`, isError: false, hasNextPage: false })),
  });
  const attachmentsOnly = round([[`${PREFIX}read_file_content`, { fileId: 'file-0001' }], [`${PREFIX}read_file_content`, { fileId: 'file-0002' }]]);
  assert.deepEqual(meetingNotesSource.readEvidence(attachmentsOnly, plan), { read: 0, expected: 1, ok: false, documents: { read: 2, failed: 0 } });
  const searchOnly = round([[`${PREFIX}search_files`, { query: plan.query }]]);
  assert.deepEqual(meetingNotesSource.readEvidence(searchOnly, plan), { read: 1, expected: 1, ok: true, documents: { read: 0, failed: 0 } });
});
