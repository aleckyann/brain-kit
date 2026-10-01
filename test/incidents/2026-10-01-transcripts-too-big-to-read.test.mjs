// 01/10/2026, the first real round on a real vault (docs/incidents.md): the
// transcripts source is required, and its proof of reading was a Read of
// each kept transcript that returned without error. The tests had used
// tiny transcripts; real ones were 386 to 512 KB of JSONL with enormous
// lines. Read refuses a whole file over 256 KB, and a slice over 25 000
// tokens even of 15 lines. The model tried, failed, fell back to Grep over
// the files (which gave it the person's messages and counts for nothing),
// the round recorded 1 of 8 transcripts read, exited 4 and moved no mark,
// at a cost of 3.88 USD, and opened a pull request anyway.
//
// The rule: arithmetic in code, judgement in the model. The kit writes a
// digest of each kept transcript before the model starts (only the text
// the person and the assistant wrote inside the window, sampled from the
// end, every cut said), grants the model those digests and nothing of the
// transcripts, and counts a whole read of a digest as its transcript read.
//
// Replayed below with eight transcripts of 400 KB and more, each line of a
// tool result over 100 KB, in the curate world (the fake claude, whose Read
// answers with the real tool's limits: test/helpers/read-tool.mjs). Before:
// the reads the old prompt asked for (the whole file, or 15 lines from the
// sample line) are refused, so the source can never be proven read. After:
// every digest is read whole, and the day closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { transcriptsSource } from '../../src/sources/transcripts-claude-code.mjs';
import { makeCurateWorld, note, PROJECT, utcDay } from '../helpers/curate-world.mjs';
import { emulateRead, estimateTokens, READ_MAX_BYTES, READ_MAX_TOKENS } from '../helpers/read-tool.mjs';
import { assistant, defaultConfig, user, userBlocks } from '../helpers/transcripts-world.mjs';

const TOOL_OUTPUT = 'TOOL-OUTPUT-NEVER-IN-A-DIGEST';
const propose = (w) => [{ write: { path: 'notes/reading.md', content: note('Reading') } }, w.proposeAction('notes/reading.md')];

// Eight sessions of yesterday, 400 KB and more each: a few words from Ana
// and the assistant around tool results of more than 100 KB on one line.
function bigSessions(w) {
  const files = [];
  for (let s = 0; s < 8; s += 1) {
    const at = (minute) => new Date(Date.parse(`${utcDay(-1)}T${String(9 + s).padStart(2, '0')}:00:00.000Z`) + minute * 60_000).toISOString();
    const lines = [user(`Ana starts session ${s}`, at(0))];
    for (let k = 0; k < 3; k += 1) {
      lines.push({ ...assistant('', at(1 + 3 * k)), message: { role: 'assistant', content: [{ type: 'text', text: `Looking at part ${k} of session ${s}` }, { type: 'tool_use', id: `toolu_${s}_${k}`, name: 'Bash', input: { command: 'cat data.json' } }] } });
      lines.push(userBlocks([{ type: 'tool_result', tool_use_id: `toolu_${s}_${k}`, content: `${TOOL_OUTPUT} ${'{"row":[1,2,3],"name":"x"},'.repeat(4500 + 400 * s)}` }], at(2 + 3 * k)));
    }
    lines.push(user(`Ana decides what session ${s} was for`, at(20)));
    lines.push(assistant(`Recorded the decision of session ${s}`, at(21)));
    const path = join(w.projects, PROJECT, `${String(s).repeat(8)}-1111-4222-8333-444444444444.jsonl`);
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    files.push(path);
  }
  return files;
}

test('before: a transcript of 400 KB and more cannot be read whole, nor 15 lines of it from where the old prompt said to start', () => {
  const w = makeCurateWorld();
  const files = bigSessions(w);
  const config = defaultConfig();
  config.vault.timezone = 'UTC';
  config.sources.transcripts.include_projects = [PROJECT];
  const from = new Date(`${utcDay(-1)}T00:00:00.000Z`);
  const plan = transcriptsSource.collect({ window: { from, to: new Date(from.getTime() + 86_400_000), timezone: 'UTC' }, config, machine: { transcripts_dir: w.projects }, now: new Date() });
  assert.equal(plan.files.length, 9, 'the eight sessions and the world\'s own');
  for (const path of files) {
    assert.ok(statSync(path).size > 400 * 1024, `${basename(path)}: ${statSync(path).size} bytes`);
    const whole = emulateRead({ file_path: path });
    assert.equal(whole.isError, true);
    assert.match(whole.content, /^File content \(\d+KB\) exceeds maximum allowed size \(256KB\)/);
    const { sampleLine } = plan.files.find((file) => file.path === path);
    const slice = emulateRead({ file_path: path, offset: sampleLine, limit: 15 });
    assert.equal(slice.isError, true, `${basename(path)} from line ${sampleLine}`);
    assert.match(slice.content, /^File content \(\d+ tokens\) exceeds maximum allowed tokens \(25000\)/);
  }
});

test('the replay of the round: a model that tries the transcripts themselves and falls back to Grep reads nothing; exit 4, no mark, and the transcripts were never granted', () => {
  const w = makeCurateWorld();
  const files = bigSessions(w);
  w.scenario({
    actions: propose(w),
    rewrite: {
      readGranted: false,
      toolUses: [
        ...files.map((file_path) => ({ name: 'Read', input: { file_path }, emulate: true })),
        ...files.map((file_path) => ({ name: 'Read', input: { file_path, offset: 1, limit: 15 }, emulate: true })),
        ...files.map((path) => ({ name: 'Grep', input: { pattern: 'Ana', path, output_mode: 'content' } })),
      ],
    },
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'source_unread');
  assert.match(last.reason, /transcripts \(0\/9\)/);
  assert.equal(w.watermark(), null, 'no mark moves');
  assert.ok(w.reads().every((read) => read.isError), 'every read of a transcript itself fails');
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(argv.some((arg) => files.some((file) => arg.includes(file))), false, 'no transcript is granted');
});

test('after: the model reads one digest per transcript, each whole and under the Read tool\'s limits, holding the people\'s words and no tool output; the source proves read and the day closes', () => {
  const w = makeCurateWorld();
  const files = bigSessions(w);
  w.scenario({ actions: propose(w) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.lastRun().sources.transcripts, { kept: 9, read: 9, advanced: true, noTimestamp: 0 });
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  const reads = w.reads();
  assert.equal(reads.length, 9);
  for (const read of reads) {
    assert.equal(read.isError, false, read.content);
    assert.ok(Buffer.byteLength(read.text) < READ_MAX_BYTES / 10, `${basename(read.path)}: ${Buffer.byteLength(read.text)} bytes`);
    assert.ok(estimateTokens(read.text) < READ_MAX_TOKENS / 10);
    assert.equal(read.text.includes(TOOL_OUTPUT), false);
  }
  for (let s = 0; s < 8; s += 1) {
    const read = reads.find((entry) => basename(entry.path).endsWith(`-${String(s).repeat(8)}.txt`));
    assert.ok(read, `session ${s}`);
    assert.match(read.text, new RegExp(`\\] Ana starts session ${s}\\n`));
    assert.match(read.text, new RegExp(`\\] Ana decides what session ${s} was for\\n`));
    assert.match(read.text, new RegExp(`\\] Looking at part 2 of session ${s}\\n`));
  }
  assert.ok(files.every((file) => statSync(file).size > 400 * 1024));
  assert.deepEqual(w.digestDirs(), [], 'and the digests are gone');
});
