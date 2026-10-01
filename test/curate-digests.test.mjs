// A round and the digests of its transcripts (01/10/2026, docs/incidents.md):
// the round hands the model one digest per kept transcript, grants it those
// and nothing of the transcripts, counts a whole read of a digest as the
// transcript read and nothing else, and removes the digests on every end
// it lives to see (the next round removes what a kill left), unless the
// stream is kept. Every round is `brain-kit curate` with the fake claude
// (test/helpers/curate-world.mjs), whose Read answers as the real one does
// (test/helpers/read-tool.mjs): denied without a rule, refused over 256 KB
// or 25 000 tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT } from '../src/exit-codes.mjs';
import { BIN, FAKE, makeCurateWorld, note, PROJECT, STREAMS, utcDay } from './helpers/curate-world.mjs';
import { assistant, user, userBlocks } from './helpers/transcripts-world.mjs';

const SENTINEL = 'SENTINEL-DIGEST-zq9x';
const propose = (w) => [{ write: { path: 'notes/reading.md', content: note('Reading') } }, w.proposeAction('notes/reading.md')];

// A second session of yesterday, with a tool result and a thought the
// digest must never carry.
function secondSession(w, name = 'bbbbbbbb-1111-4222-8333-444444444444.jsonl') {
  const at = (hh) => `${utcDay(-1)}T${hh}:00:00.000Z`;
  const path = join(w.projects, PROJECT, name);
  const lines = [
    user('Ana chose the cheaper printer', at('09')),
    { ...assistant('', at('10')), message: { role: 'assistant', content: [{ type: 'thinking', thinking: `${SENTINEL} thought`, signature: 'c2ln' }, { type: 'text', text: 'Noted, the cheaper one.' }] } },
    userBlocks([{ type: 'tool_result', tool_use_id: 'toolu_1', content: `${SENTINEL} tool output` }], at('11')),
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

function allowedOf(argv) {
  return argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
}

test('a round hands the model one digest per kept transcript, owner-only, reads it whole, advances, and leaves no digest behind', () => {
  const w = makeCurateWorld();
  const second = secondSession(w);
  w.scenario({ actions: propose(w) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  assert.deepEqual(w.lastRun().sources.transcripts, { kept: 2, read: 2, advanced: true, noTimestamp: 0 }, 'N of M transcripts, in the same terms as before');
  // What the model read, while it ran.
  const reads = w.reads();
  assert.equal(reads.length, 2);
  for (const read of reads) {
    assert.equal(read.isError, false, read.content);
    assert.equal(read.mode, '600');
    assert.equal(read.dirMode, '700');
    assert.ok(read.path.startsWith(join(w.state, 'digests')), read.path);
    assert.doesNotMatch(read.text, new RegExp(SENTINEL), 'no tool result and no thought in a digest');
  }
  const bySession = Object.fromEntries(reads.map((read) => [basename(read.path).slice(3, 11), read.text]));
  assert.match(bySession.aaaaaaaa, /\n\[12:00 user\] Ana decided to cite the newer survey\n\[12:00 assistant\] Noted\.\n$/);
  assert.match(bySession.bbbbbbbb, /\n\[09:00 user\] Ana chose the cheaper printer\n\[10:00 assistant\] Noted, the cheaper one\.\n$/);
  // Granted: the digests, never the transcripts.
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  const allowed = allowedOf(argv);
  for (const read of reads) assert.ok(allowed.includes(`Read(//${read.path.slice(1)})`), read.path);
  assert.equal(JSON.stringify(argv).includes(w.transcript) || JSON.stringify(argv).includes(second), false);
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.equal(prompt.includes(w.transcript) || prompt.includes(second), false, 'the prompt names the digests only');
  // Gone with the round, and never in the log or last-run beyond counts.
  assert.deepEqual(w.digestDirs(), []);
  assert.deepEqual(readdirSync(join(w.state, 'digests')), []);
  for (const text of [w.logText(), JSON.stringify(w.lastRun())]) {
    assert.equal(text.includes('cheaper printer'), false, 'no digest text in the log or last-run');
    assert.equal(text.includes(SENTINEL), false);
  }
  assert.match(w.logText(), / digests \{"source":"transcripts","written":2,"cut":\[\]\}/);
});

test('a model that reads only some of the digests exits 4 naming how many of how many, the day stays open, and the digests are removed', () => {
  const w = makeCurateWorld();
  secondSession(w);
  w.scenario({ actions: propose(w), rewrite: { readGranted: ['aaaaaaaa'] } });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'source_unread');
  assert.match(last.reason, /transcripts \(1\/2\)/);
  assert.deepEqual(last.sources.transcripts, { kept: 2, read: 1, advanced: false, noTimestamp: 0 });
  assert.equal(w.watermark(), null);
  assert.equal(w.reads().length, 1);
  assert.deepEqual(w.digestDirs(), [], 'removed on exit 4 too');
});

test('a model that Reads or Greps a transcript itself reads nothing: the Read is denied, neither is granted, neither counts, exit 4', () => {
  const w = makeCurateWorld();
  w.scenario({
    actions: propose(w),
    rewrite: {
      readGranted: false,
      toolUses: [
        { name: 'Read', input: { file_path: w.transcript }, emulate: true },
        { name: 'Read', input: { file_path: w.transcript, offset: 1, limit: 15 }, emulate: true },
        { name: 'Grep', input: { pattern: 'Ana', path: w.transcript, output_mode: 'content' } },
      ],
    },
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  assert.match(w.lastRun().reason, /transcripts \(0\/1\)/);
  assert.equal(w.watermark(), null);
  assert.deepEqual(w.reads().map((read) => [read.isError, read.content]), [
    [true, 'Permission to use Read has been denied.'], [true, 'Permission to use Read has been denied.'],
  ]);
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(argv.some((arg) => arg.includes(w.transcript) || arg.includes(w.projects)), false, 'no rule names a transcript or its folder');
  assert.deepEqual(w.digestDirs(), []);
});

test('the digests are removed when the model fails too, after it read them', () => {
  const w = makeCurateWorld();
  w.scenario({ stream: join(STREAMS, 'max-turns.jsonl'), rewrite: { finalText: undefined }, exitCode: 1 });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'model_failed');
  assert.equal(w.reads().length, 1, 'the digest was there while the model ran');
  assert.equal(w.reads()[0].isError, false);
  assert.deepEqual(w.digestDirs(), []);
});

test('--keep-stream keeps the digests beside the stream, owner-only; a later round leaves them, and the logs\' retention removes them', () => {
  const w = makeCurateWorld();
  const r = w.curate(['--keep-stream']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const kept = w.digestDirs();
  assert.equal(kept.length, 1);
  const name = basename(kept[0]);
  assert.match(name, /^curate-[0-9TZ-]+-[0-9a-f]{8}\.digests$/);
  assert.equal(statSync(kept[0]).mode & 0o777, 0o700);
  const files = readdirSync(kept[0]);
  assert.deepEqual(files, ['01-aaaaaaaa.txt']);
  assert.equal(statSync(join(kept[0], files[0])).mode & 0o777, 0o600);
  const streams = readdirSync(join(w.state, 'logs')).filter((n) => n.endsWith('.stream.jsonl'));
  assert.equal(streams.length, 1);
  assert.ok(name.startsWith(streams[0].replace(/\.stream\.jsonl$/, '-')), `${name} pairs with ${streams[0]}`);
  assert.equal(w.reads()[0].path, join(kept[0], files[0]), 'the model read the kept digest itself');

  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: {} }));
  const again = w.curate();
  assert.equal(again.status, EXIT.OK, again.stderr);
  assert.deepEqual(w.digestDirs(), kept, 'a round without the option leaves a kept folder alone');

  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(kept[0], old, old);
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: {} }));
  const pruned = w.curate();
  assert.equal(pruned.status, EXIT.OK, pruned.stderr);
  assert.deepEqual(w.digestDirs(), [], 'older than log_retention_days: removed with the old logs');
});

test('a round killed outright leaves its digests, and the next round removes them as soon as it holds the lock', async () => {
  const w = makeCurateWorld();
  const pidFile = join(w.base, 'fake-claude.pid');
  const seen = join(w.base, 'digests-seen.json');
  const digestsRoot = join(w.state, 'digests');
  w.scenario({
    actions: [
      { run: [process.execPath, '-e', `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(fs.readdirSync(${JSON.stringify(digestsRoot)})))`] },
      { run: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.ppid))`] },
    ],
    delayMs: 60000,
  });
  assert.equal(w.machine.claude_bin, FAKE);
  const child = spawn(process.execPath, [BIN, 'curate'], { cwd: w.vault, env: w.env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  const until = Date.now() + 30000;
  while (!existsSync(pidFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  const fakePid = Number(readFileSync(pidFile, 'utf8'));
  child.kill('SIGKILL');
  assert.deepEqual(await exited, { code: null, sig: 'SIGKILL' });
  // The model outlives a SIGKILL of its round; it ends here, as it would
  // on its own, so the next round can take the lock back.
  process.kill(fakePid, 'SIGKILL');
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(fakePid, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(JSON.parse(readFileSync(seen, 'utf8')).length, 1, 'the digests were there while the model ran');
  assert.equal(w.digestDirs().length, 1, 'nothing can remove them on a SIGKILL');

  w.scenario();
  const next = w.curate();
  assert.equal(next.status, EXIT.OK, next.stderr);
  assert.deepEqual(w.digestDirs(), []);
  assert.match(w.logText(), / digests_swept \{"count":1\}/);
});

test('--dry writes no digest and says how many a round would write; --check writes none either', () => {
  const w = makeCurateWorld();
  secondSession(w);
  const dry = w.curate(['--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stderr);
  assert.match(dry.stdout, /A round would write 2 digest\(s\) of these transcripts for the model to read/);
  assert.equal(existsSync(join(w.state, 'digests')), false, 'not even the folder');
  const check = w.curate(['--check']);
  assert.equal(check.status, EXIT.OK, check.stderr);
  assert.match(check.stdout, /session aaaaaaaa: .*\/digests\/[0-9TZ-]+-[0-9a-f]{8}\/0[12]-aaaaaaaa\.txt \(project /);
  assert.equal(existsSync(join(w.state, 'digests')), false);
  assert.deepEqual(w.digestDirs(), []);
  assert.equal(w.lastRun(), null);
});

test('a transcript whose window holds more than a digest carries: the model reads the last messages, and the round says the cut on its output and in last-run, with counts only in the log', () => {
  const w = makeCurateWorld();
  const path = join(w.projects, PROJECT, 'cccccccc-1111-4222-8333-444444444444.jsonl');
  const lines = [];
  for (let i = 0; i < 100; i += 1) lines.push(user(`m${String(i).padStart(2, '0')} ${'w'.repeat(996)}`, new Date(Date.parse(`${utcDay(-1)}T08:00:00.000Z`) + i * 60_000).toISOString()));
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const said = 'transcripts: the digest of session cccccccc keeps the last 39 of its 100 messages in the window; cut: the first 61 messages and 61000 characters were left out.';
  assert.ok(r.stderr.includes(said), r.stderr);
  assert.ok(w.lastRun().warnings.some((line) => line.includes(said)), JSON.stringify(w.lastRun().warnings));
  assert.match(w.logText(), / digests \{"source":"transcripts","written":2,"cut":\[\{"session":"cccccccc","kept":39,"held":100,"messages":61,"chars":61000\}\]\}/);
  assert.equal(w.logText().includes('wwwwwwwwww'), false);
  const read = w.reads().find((entry) => basename(entry.path).includes('cccccccc'));
  assert.match(read.text.split('\n')[0], /cut: the first 61 messages and 61000 characters were left out\.$/);
  assert.ok(read.text.includes('] m99 ') && !read.text.includes('] m60 '));
});

test('a state directory whose path no read rule can name: exit 1 before the model, no mark, the same from --dry', () => {
  const w = makeCurateWorld();
  const state = join(w.base, 'state (copy)');
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  copyFileSync(w.machineFile, join(state, 'machine.json'));
  const env = { BRAIN_KIT_STATE_DIR: state };
  const r = w.curate([], env);
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  const last = JSON.parse(readFileSync(join(state, 'last-run.json'), 'utf8'));
  assert.equal(last.reasonCode, 'digest_dir_unsafe');
  assert.ok(last.reason.includes(join(state, 'digests')), last.reason);
  assert.match(last.reason, /holds \( \), which no read permission can name exactly/);
  assert.equal(existsSync(w.files.stdinFile), false, 'the model was never started');
  assert.equal(existsSync(join(state, 'watermark.json')), false);
  const dry = w.curate(['--dry'], env);
  assert.equal(dry.status, EXIT.FAILURE, dry.stderr);
  assert.match(dry.stderr, /holds \( \), which no read permission can name exactly/);
});
