// The small guards of a round: read evidence, the empty window, the
// network wait and the dirty tree. None of these tests touches the
// network: the network check is always injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceFor, unreadRequired } from '../src/guards/read-evidence.mjs';
import { emptyWindow } from '../src/guards/empty-window.mjs';
import { DEFAULT_HOST, DEFAULT_PORT, waitForNetwork } from '../src/guards/network.mjs';
import { checkDirtyTree } from '../src/guards/dirty-tree.mjs';
import { CLEAN_ENV, git, makeRepo, write } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

// ------------------------------------------------------------ read evidence

function stub(id, readEvidence) {
  return { id, kind: 'local', required: true, collect: () => ({ files: [] }), readEvidence };
}

test('evidenceFor asks each source about its own plan and the round record', () => {
  const record = { toolUses: [{ id: 'u1', name: 'Read', input: { file_path: '/a' } }], toolResults: [{ toolUseId: 'u1', isError: false }] };
  const seen = [];
  const a = stub('transcripts', (rec, plan) => { seen.push([rec, plan]); return { read: 1, expected: 2, ok: true }; });
  const plans = { transcripts: { files: [{ path: '/a' }, { path: '/b' }] } };
  assert.deepEqual(evidenceFor([a], plans, record), { transcripts: { read: 1, expected: 2, ok: true } });
  assert.equal(seen[0][0], record);
  assert.equal(seen[0][1], plans.transcripts);
});

test('evidenceFor: no plan, a throwing source or a malformed answer is unread, and never "expected 0"', () => {
  const good = { read: 0, expected: 0, ok: true };
  const sources = [
    stub('noplan', () => good),
    stub('throws', () => { throw new Error('boom'); }),
    stub('nullanswer', () => null),
    stub('stringcount', () => ({ read: '1', expected: 1, ok: true })),
    stub('negative', () => ({ read: 0, expected: -1, ok: true })),
    stub('fraction', () => ({ read: 0.5, expected: 1, ok: true })),
    stub('okstring', () => ({ read: 1, expected: 1, ok: 'true' })),
    stub('missingexpected', () => ({ read: 0, ok: true })),
  ];
  const plans = Object.fromEntries(sources.filter((s) => s.id !== 'noplan').map((s) => [s.id, { files: [] }]));
  const evidence = evidenceFor(sources, plans, { toolUses: [], toolResults: [] });
  for (const s of sources) assert.deepEqual(evidence[s.id], { read: 0, expected: null, ok: false }, s.id);
});

test('evidenceFor with no record (no model ran) hands the sources an empty record', () => {
  let given;
  const s = stub('transcripts', (rec) => { given = rec; return { read: 0, expected: 0, ok: true }; });
  assert.deepEqual(evidenceFor([s], { transcripts: { files: [] } }, null), { transcripts: { read: 0, expected: 0, ok: true } });
  assert.deepEqual([given.toolUses, given.toolResults], [[], []]);
});

test('unreadRequired names each required source whose evidence is missing or not ok', () => {
  const evidence = { transcripts: { read: 0, expected: 2, ok: false }, calendar: { read: 1, expected: 1, ok: true } };
  assert.deepEqual(unreadRequired(evidence, ['transcripts', 'calendar', 'meeting_notes']), ['transcripts', 'meeting_notes']);
  assert.deepEqual(unreadRequired(evidence, ['calendar']), []);
  assert.deepEqual(unreadRequired(null, ['calendar']), ['calendar']);
});

// ------------------------------------------------------------ empty window

test('emptyWindow: true only when every plan keeps zero files', () => {
  assert.equal(emptyWindow({ transcripts: { files: [] }, calendar: { files: [] } }), true);
  assert.equal(emptyWindow({ transcripts: { files: [] }, calendar: { files: [{ path: '/x' }] } }), false);
  assert.equal(emptyWindow({ transcripts: { files: [{ path: '/x' }] } }), false);
  assert.equal(emptyWindow({}), true);
});

test('emptyWindow: a plan it cannot read is never "nothing"', () => {
  assert.equal(emptyWindow({ transcripts: {} }), false);
  assert.equal(emptyWindow({ transcripts: null }), false);
  assert.equal(emptyWindow({ transcripts: { files: 0 } }), false);
  assert.equal(emptyWindow(null), false);
});

// ------------------------------------------------------------ network

// A clock the test moves, and a sleep that only moves it.
function fakeClock() {
  let t = 1000;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
}

test('network: a check that succeeds at once is accepted, and reported as not having waited', async () => {
  const clock = fakeClock();
  const r = await waitForNetwork(async () => true, { timeoutMs: 60000 }, clock);
  assert.deepEqual(r, { ok: true, waitedMs: 0, attempts: 1, warning: 'did_not_wait' });
});

test('network: the did_not_wait line is minWaitMs, measured on the first try only', async () => {
  const at = (ms) => { const clock = fakeClock(); return { clock, check: async () => { clock.advance(ms); return true; } }; };
  let c = at(99);
  assert.equal((await waitForNetwork(c.check, { timeoutMs: 60000, minWaitMs: 100 }, c.clock)).warning, 'did_not_wait');
  c = at(100);
  assert.equal((await waitForNetwork(c.check, { timeoutMs: 60000, minWaitMs: 100 }, c.clock)).warning, null);
  c = at(300);
  assert.equal((await waitForNetwork(c.check, { timeoutMs: 60000, minWaitMs: 500 }, c.clock)).warning, 'did_not_wait');
});

test('network: a quick success after a failed first try did wait, and is not flagged', async () => {
  const clock = fakeClock();
  let calls = 0;
  const r = await waitForNetwork(async () => { calls += 1; return calls === 2; }, { timeoutMs: 60000, minWaitMs: 100, intervalMs: 10 }, clock);
  assert.deepEqual(r, { ok: true, waitedMs: 10, attempts: 2, warning: null });
});

test('network: fails, retries every interval, then succeeds without a warning', async () => {
  const clock = fakeClock();
  let calls = 0;
  const r = await waitForNetwork(async () => { calls += 1; return calls === 3; }, { timeoutMs: 60000 }, clock);
  assert.deepEqual(r, { ok: true, waitedMs: 2000, attempts: 3, warning: null });
  assert.deepEqual(clock.sleeps, [1000, 1000]);
});

test('network: no success within the timeout is ok false; a throwing check counts as a failure', async () => {
  const clock = fakeClock();
  const r = await waitForNetwork(async () => { throw new Error('ENETUNREACH'); }, { timeoutMs: 5000 }, clock);
  assert.equal(r.ok, false);
  assert.equal(r.warning, null);
  assert.ok(r.waitedMs <= 5000 && r.waitedMs >= 4000, String(r.waitedMs));
  assert.equal(r.attempts, 6, 'tries at 0, 1, 2, 3, 4 and 5 seconds');
  const truthy = await waitForNetwork(async () => 'yes', { timeoutMs: 2000 }, fakeClock());
  assert.equal(truthy.ok, false, 'only true is success');
});

test('network: unset check is a TCP connection to api.anthropic.com:443, bounded by what is left', async () => {
  const clock = fakeClock();
  const calls = [];
  const connect = async (host, port, limitMs) => { calls.push([host, port, limitMs]); clock.advance(250); return calls.length === 2; };
  const r = await waitForNetwork(undefined, { timeoutMs: 30000 }, { ...clock, connect });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(([h, p]) => [h, p]), [[DEFAULT_HOST, DEFAULT_PORT], [DEFAULT_HOST, DEFAULT_PORT]]);
  assert.deepEqual([DEFAULT_HOST, DEFAULT_PORT], ['api.anthropic.com', 443]);
  assert.ok(calls.every(([, , limit]) => limit > 0 && limit <= 10000));
  const nullCheck = await waitForNetwork(null, { timeoutMs: 1000 }, { ...fakeClock(), connect: async () => true });
  assert.equal(nullCheck.ok, true);
  const emptyCheck = await waitForNetwork([], { timeoutMs: 1000 }, { ...fakeClock(), connect: async () => true });
  assert.equal(emptyCheck.ok, true);
});

test('network: machine.network_check is an argument vector; exit 0 is success', async () => {
  const seen = [];
  const runArgv = async (argv, limit) => { seen.push([argv, limit]); return true; };
  const r = await waitForNetwork(['nm-online', '-q'], { timeoutMs: 30000 }, { ...fakeClock(), runArgv });
  assert.equal(r.ok, true);
  assert.deepEqual(seen[0][0], ['nm-online', '-q']);
  await assert.rejects(waitForNetwork('nm-online -q', {}), TypeError);
});

test('network: a real argument vector runs without a shell, and its exit status decides', async () => {
  const ok = await waitForNetwork([process.execPath, '-e', 'process.exit(0)'], { timeoutMs: 5000 });
  assert.equal(ok.ok, true);
  const fail = await waitForNetwork([process.execPath, '-e', 'process.exit(3)'], { timeoutMs: 300, intervalMs: 50 });
  assert.equal(fail.ok, false);
  assert.ok(fail.attempts >= 2);
  const missing = await waitForNetwork(['/nonexistent/brain-kit-check'], { timeoutMs: 200, intervalMs: 50 });
  assert.equal(missing.ok, false);
});

test('network: an argument vector still running at the timeout is killed, not left behind', async () => {
  const dir = makeTempDir('brain-kit-network-');
  const pidFile = join(dir, 'pid');
  const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 600000);`;
  const r = await waitForNetwork([process.execPath, '-e', script], { timeoutMs: 1500, intervalMs: 5000 });
  assert.equal(r.ok, false);
  assert.ok(existsSync(pidFile), 'the child started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `child ${pid} is still running`);
});

// ------------------------------------------------------------ dirty tree

test('dirty tree: a clean tree is ok with no files', () => {
  const root = makeRepo({ 'index.md': '# Index\n' });
  assert.deepEqual(checkDirtyTree(root, null, { env: CLEAN_ENV }), { ok: true, files: [] });
});

test('dirty tree: modified, staged, deleted and untracked are listed with mtimes; ignored is not', () => {
  const root = makeRepo({ 'index.md': '# Index\n', 'a.md': 'a\n', 'gone.md': 'g\n', 'staged.md': 's\n', '.gitignore': 'ignored.md\n' });
  write(root, 'a.md', 'changed\n');
  unlinkSync(join(root, 'gone.md'));
  write(root, 'staged.md', 'staged change\n');
  git(root, ['add', 'staged.md']);
  write(root, 'notes/new.md', 'new\n');
  write(root, 'ignored.md', 'draft\n');
  const when = new Date('2026-09-13T09:30:00Z');
  utimesSync(join(root, 'a.md'), when, when);
  const r = checkDirtyTree(root, null, { env: CLEAN_ENV });
  assert.equal(r.ok, false);
  assert.deepEqual(r.files.map((f) => f.path), ['a.md', 'gone.md', 'notes/new.md', 'staged.md']);
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, f.mtime]));
  assert.equal(byPath['a.md'], '2026-09-13T09:30:00.000Z');
  assert.equal(byPath['gone.md'], null);
  assert.match(byPath['notes/new.md'], /^\d{4}-\d{2}-\d{2}T/);
});

test('dirty tree: a list the caller already read is reported as given, without asking git', () => {
  const dir = makeTempDir('brain-kit-dirty-');
  writeFileSync(join(dir, 'x.md'), 'x\n');
  const r = checkDirtyTree(dir, ['x.md', 'y.md', 'x.md']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.files.map((f) => f.path), ['x.md', 'y.md']);
  assert.equal(r.files[1].mtime, null);
  assert.deepEqual(checkDirtyTree(dir, []), { ok: true, files: [] });
  rmSync(join(dir, 'x.md'));
});

test('dirty tree: git refusing to read the directory throws, never reads as clean', () => {
  const dir = makeTempDir('brain-kit-dirty-norepo-');
  assert.throws(() => checkDirtyTree(dir, null, { env: { ...CLEAN_ENV, GIT_CEILING_DIRECTORIES: dir } }));
});
