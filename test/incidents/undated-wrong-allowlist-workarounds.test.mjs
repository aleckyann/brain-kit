// Undated (docs/incidents.md, "a wrong allowlist burned every turn on
// workarounds"): a misconfigured tool allowlist made the agent spend all of
// its turns trying to reach the missing tools through the shell, and it
// died without producing anything. The rule: an external source is best
// effort; record the failure, skip that stage only and carry on, with
// shell workarounds forbidden in the prompt. A round without the calendar
// is still a valid round.
//
// In brain-kit the calendar's tools are named by a prefix in the vault's
// configuration; a wrong prefix leaves the source's tools out of the
// session (`tools_missing`, naming the prefix they were seen under). The
// round stops the model at the init event and launches once more without
// the calendar: the relaunched prompt names the source as unavailable, says
// to write it so and to reach it no other way (the `no-workaround` rule and
// the source's own line), and no tool of the calendar is in its allow
// list. The transcripts are curated, exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXIT } from '../../src/exit-codes.mjs';
import { CALENDAR_TOOLS, connectorServers, makeCurateWorld, note, PINNED_TOOLS, utcDay, withConnectors } from '../helpers/curate-world.mjs';

const WRONG_PREFIX = 'mcp__Google_Calendar__';

test('a calendar configured with the wrong tool prefix: the relaunched prompt names it unavailable and forbids every workaround, its tools are out of the allow list, and the round without it exits 0', () => {
  const w = makeCurateWorld({ config: (c) => { withConnectors({ meetingNotes: false })(c); c.sources.calendar.tool_prefix = WRONG_PREFIX; } });
  w.scenario({
    launches: [
      // Connected, and its tools in the session under their real prefix.
      { rewrite: { mcpServers: connectorServers({ calendar: 'connected', drive: null }), tools: [...PINNED_TOOLS, ...CALENDAR_TOOLS] }, delayMs: 60000 },
      {
        actions: [{ write: { path: 'notes/reading.md', content: note('Reading') } }, w.proposeAction('notes/reading.md')],
        rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' },
      },
    ],
  });
  const started = Date.now();
  const r = w.curate();
  assert.ok(Date.now() - started < 30000, 'stopped at init, before any turn could go on workarounds');
  assert.equal(r.status, EXIT.OK, r.stderr);
  const launches = w.launches();
  assert.equal(launches.length, 2);
  assert.ok(launches[0].argv.includes(`${WRONG_PREFIX}list_events`), 'the first launch allowed what the configuration named');

  const [relaunched] = launches.slice(1);
  assert.match(relaunched.stdin, /Source calendar:\nUnavailable this round \(state tools_missing\)\. Write calendar=unavailable in the last line, and do not try to reach it any other way: not through the shell and not through any other tool\./);
  assert.match(relaunched.stdin, /<!-- rule:no-workaround -->\nA source the parameters block marks unavailable, or whose tools are not in your session, is written `unavailable`/);
  assert.ok(relaunched.stdin.includes('`BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed> calendar=<ok|empty|failed|unavailable>`'), 'the calendar is still in the last line, to be written unavailable');
  const allowedAt = relaunched.argv.indexOf('--allowedTools');
  const allowed = relaunched.argv.slice(allowedAt + 1, relaunched.argv.indexOf('--disallowedTools'));
  assert.equal(allowed.some((rule) => rule.startsWith('mcp__')), false, 'no tool of the calendar, under either prefix, is allowed');
  assert.equal(allowed.some((rule) => /^Bash\((?!"[^"]+" (validate|lint|propose):\*\)|node ")/.test(rule)), false, 'the shell is still only the kit');

  const last = w.lastRun();
  assert.equal(last.sources.calendar.state, 'tools_missing');
  assert.equal(last.sources.calendar.observedPrefix, 'mcp__claude_ai_Google_Calendar__', 'the prefix the tools were seen under is named');
  assert.match(r.stderr, /its tools are in the session under mcp__claude_ai_Google_Calendar__, not under mcp__Google_Calendar__/);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 1, 'a round without the calendar is still a valid round');
});
