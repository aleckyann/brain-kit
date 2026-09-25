// 14/09/2026 (docs/incidents.md, "disabled is a state, and nobody reports
// it"): the session's connector status showed the calendar and document
// connectors as disabled, not failed and not needing authentication. Their
// tools simply did not exist for that session, and nothing anywhere said
// so. The rule: disabled is a state, read literally before anything else
// is investigated, and reported.
//
// In brain-kit a connector disabled for Claude Code is not in the init
// event's server list at all, which cannot be told apart from one never
// connected: both are `absent` (decision D2 of the phase 3 plan). The
// round reads that from its own init event, stops the model before its
// first turn, launches once more without the calendar, curates the rest,
// and says so everywhere a person looks: the round's output and log,
// last-run.json, one notification naming the state and docs/connectors.md,
// and the session's status line with the round's date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { connectorStateMessage, connectorStates } from '../../src/guards/connectors.mjs';
import { calendarSource } from '../../src/sources/calendar-google.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { BIN, connectorServers, makeCurateWorld, note, utcDay, withConnectors } from '../helpers/curate-world.mjs';

test('a calendar connector missing from the init event is absent, and its message says disabled and never connected cannot be told apart', () => {
  const config = { sources: { calendar: { enabled: true, calendars: ['primary'] } } };
  const spec = calendarSource.serverSpec(config);
  const init = { mcp_servers: connectorServers({ calendar: null, drive: null }), tools: ['Bash', 'Read'] };
  const entry = connectorStates(init, [spec]).calendar;
  assert.deepEqual(entry, { state: 'absent', rawStatus: null, observedPrefix: null });
  const message = connectorStateMessage(spec, entry);
  assert.match(createTranslator('en')(message.messageKey, message.params), /disabled for Claude Code, and the two cannot be told apart/);
});

test('a round whose calendar connector is disabled: the state is named in the output, the log and last-run, the transcripts are still curated and proposed, exit 0, one notification, and the session\'s status line says it with the round\'s date', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const y = utcDay(-1);
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: null, drive: null }) }, delayMs: 60000 },
      {
        actions: [{ write: { path: 'notes/reading.md', content: note('Reading') } }, w.proposeAction('notes/reading.md')],
        rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' },
      },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stderr, /the source calendar is unavailable this round \(absent\): claude\.ai Google Calendar is not in the session's server list/);
  assert.match(w.logText(), / connectors \{"launch":1,"states":\{"calendar":"absent"\}\}/);
  const last = w.lastRun();
  assert.equal(last.sources.calendar.state, 'absent');
  assert.equal(last.relaunched, true);
  assert.deepEqual(w.watermark(), { transcripts: y }, 'the calendar\'s day stays open');
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 1);
  const notes = w.notifications();
  assert.equal(notes.length, 1);
  assert.match(notes[0].at(-1), /the source calendar is now absent \(it was connected\)/);
  assert.match(notes[0].at(-1), /docs\/connectors\.md/);

  // The next session in the vault is told, with the round's date.
  const hook = spawnSync(process.execPath, [BIN, 'hook', 'session-start'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: w.vault, session_id: 's1', source: 'startup' }),
    env: w.env, cwd: join(w.base), encoding: 'utf8',
  });
  assert.equal(hook.status, 0, hook.stderr);
  const [yy, mm, dd] = last.at.slice(0, 10).split('-');
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, new RegExp(`Connector sources not connected in the last round: calendar absent \\(${dd}/${mm}/${yy}\\)`));
});
