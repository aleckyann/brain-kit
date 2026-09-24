// docs/incidents.md, 20/08/2026: the round recorded that the connectors had
// not come up, declared "no curation today" with its first two stages not
// executed, exited 0 and wrote the previous day into the high water mark.
// That day never reopened. The rule: the condition for advancing the mark
// cannot be the agent's exit code alone; a round that did not read its
// sources may not close the day as swept.
//
// These tests replay that round through the real pieces: a stream parsed
// by src/harness/stream.mjs, evidence from src/guards/read-evidence.mjs
// with a source that counts Read results against its plan, the model's
// final line through parseSourcesLine, and advanceWatermark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseStream } from '../../src/harness/stream.mjs';
import { evidenceFor } from '../../src/guards/read-evidence.mjs';
import { advanceWatermark, parseSourcesLine, readWatermark } from '../../src/guards/watermark.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const PLAN = { files: [{ path: '/home/ana/.claude/projects/-home-ana-brain/s1.jsonl' }, { path: '/home/ana/.claude/projects/-home-ana-brain/s2.jsonl' }] };

// A stub with the transcripts source's own rule: a kept file counts as read
// when a Read of exactly its path came back without error.
const transcripts = {
  id: 'transcripts',
  kind: 'local',
  required: true,
  collect: () => PLAN,
  readEvidence(record, plan) {
    const answered = new Map(record.toolResults.map((r) => [r.toolUseId, r.isError]));
    const read = new Set(record.toolUses.filter((u) => u.name === 'Read' && answered.get(u.id) === false).map((u) => u.input.file_path));
    const count = plan.files.filter((f) => read.has(f.path)).length;
    return { read: count, expected: plan.files.length, ok: plan.files.length === 0 || count > 0 };
  },
};

function stream({ reads = [], text }) {
  const lines = [{ type: 'system', subtype: 'init', permissionMode: 'dontAsk', tools: ['Read'], mcp_servers: [] }];
  reads.forEach((path, i) => {
    lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: path } }] } });
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: false, content: 'x' }] } });
  });
  lines.push({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.01, result: text });
  return lines.map((l) => JSON.stringify(l));
}

function roundAdvance(stateDir, lines, modelExit = 0) {
  const record = parseStream(lines);
  const evidence = evidenceFor([transcripts], { transcripts: PLAN }, record);
  const sourcesLine = parseSourcesLine(record.result?.text);
  return advanceWatermark(stateDir, 'transcripts', '2026-08-19', { modelExit, evidence: evidence.transcripts, sourcesLine });
}

test('20/08/2026 replayed: exit 0, "no curation today", nothing read: the day stays open', () => {
  const state = makeTempDir('brain-kit-incident-0820-');
  const r = roundAdvance(state, stream({ text: 'The connectors did not come up. No curation today.' }));
  assert.equal(r.advanced, false);
  assert.equal(existsSync(join(state, 'watermark.json')), false);
});

test('the model claiming every source ok does not close a day it never read', () => {
  const state = makeTempDir('brain-kit-incident-0820-');
  const r = roundAdvance(state, stream({ text: 'All done.\nBRAIN_KIT_SOURCES: transcripts=ok' }));
  assert.deepEqual(r, { advanced: false, reason: 'no_evidence' });
  const empty = roundAdvance(state, stream({ text: 'BRAIN_KIT_SOURCES: transcripts=empty' }));
  assert.equal(empty.advanced, false, '"empty" over a plan with two files is not nothing');
  assert.deepEqual(readWatermark(state), { sources: {} });
});

test('reads that happened, with no final line, still leave the day open', () => {
  const state = makeTempDir('brain-kit-incident-0820-');
  const r = roundAdvance(state, stream({ reads: [PLAN.files[0].path], text: 'Curated the day.' }));
  assert.deepEqual(r, { advanced: false, reason: 'no_sources_line' });
});

test('reads, the final line and exit 0 together close the day; the same round with a non-zero exit does not', () => {
  const lines = stream({ reads: [PLAN.files[0].path, PLAN.files[1].path], text: 'Curated.\nBRAIN_KIT_SOURCES: transcripts=ok' });
  const failed = makeTempDir('brain-kit-incident-0820-');
  assert.equal(roundAdvance(failed, lines, 1).advanced, false);
  const state = makeTempDir('brain-kit-incident-0820-');
  assert.deepEqual(roundAdvance(state, lines), { advanced: true, previous: null });
  assert.equal(readWatermark(state).sources.transcripts, '2026-08-19');
});
