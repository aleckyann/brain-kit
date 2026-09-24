// `brain-kit curate`: the round, run against a throwaway vault with a bare
// remote, a fake `gh` and the fake claude (test/helpers/curate-world.mjs).
// Every run that could reach a claude asserts first that machine.json names
// the fake; the stub case names a 12-byte file of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCurate } from '../src/commands/curate.mjs';
import { acquireLock } from '../src/guards/lock.mjs';
import { createTranslator } from '../src/lang.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { git } from './helpers/git-repo.mjs';
import { BIN, FAKE, makeCurateWorld, note, PROJECT, STREAMS, utcDay } from './helpers/curate-world.mjs';

const t = createTranslator('en');

function capture() {
  const out = [];
  const err = [];
  return { io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out: () => out.join(''), err: () => err.join('') };
}

// `curate` in this process, for what a CLI run cannot be handed: a short
// network timeout, a round timeout, a step observer.
async function curateInProcess(w, args = [], deps = {}) {
  assert.equal(w.machine.claude_bin, FAKE, 'this test must run the fake claude, never the real one');
  const c = capture();
  const status = await runCurate(args, c.io, t, { env: w.env, cwd: w.vault, networkIntervalMs: 10, ...deps });
  return { status, stdout: c.out(), stderr: c.err() };
}

// What each step leaves behind, for the order test.
function traces(w) {
  return {
    network: existsSync(w.networkMarker),
    fetched: existsSync(join(w.vault, '.git', 'FETCH_HEAD')),
    snapshot: existsSync(join(w.vault, '.git', 'brain-kit-snapshot.json')),
    cli: existsSync(w.files.argvFile),
    model: existsSync(w.files.stdinFile),
  };
}

const NONE = { network: false, fetched: false, snapshot: false, cli: false, model: false };

// A fake action that writes the token the model was handed to a file.
function tokenAction(file) {
  return { run: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, process.env.BRAIN_KIT_ROUND_TOKEN || '')`] };
}

test('a full round: the fake writes a note and runs the real propose with the round\'s environment; the pull request targets the default branch, the record is read and removed, the tree is clean, the mark advances, last-run names the branch and paths', () => {
  const w = makeCurateWorld();
  const tokenFile = join(w.base, 'token-seen');
  w.scenario({
    actions: [
      { write: { path: 'notes/meeting.md', content: note('Meeting') } },
      tokenAction(tokenFile),
      w.proposeAction('notes/meeting.md'),
    ],
  });
  assert.equal(existsSync(join(w.vault, '.git', 'FETCH_HEAD')), false, 'the world starts with no fetch');
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);

  const creates = w.ghCalls().filter((call) => call.args[1] === 'create');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].args[creates[0].args.indexOf('--base') + 1], 'main');
  const branch = creates[0].args[creates[0].args.indexOf('--head') + 1];
  assert.ok(w.remoteSha(`refs/heads/${branch}`), 'the branch is on the remote');

  assert.deepEqual(w.roundFiles(), [], 'no round record, no guard, no lock left');
  assert.equal(w.status(), '', 'the tree is clean');
  assert.equal(existsSync(join(w.vault, 'notes/meeting.md')), false, 'the proposed file is back to the default branch, which lacks it');
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });

  const last = w.lastRun();
  assert.equal(last.exit, 0);
  assert.equal(last.proposed.branch, branch);
  assert.deepEqual(last.proposed.paths, ['notes/meeting.md']);
  assert.equal(last.proposed.opened, true);
  assert.deepEqual(last.sources.transcripts, { kept: 1, read: 1, advanced: true });
  assert.deepEqual(last.leftovers, []);
  assert.equal(last.isolation.ok, true);
  assert.equal(last.costUsd, 0.041879);
  assert.equal(last.network.warning, 'did_not_wait', 'did_not_wait is a note, never a failure (R14)');
  assert.match(w.logText(), /network_did_not_wait/);

  const token = readFileSync(tokenFile, 'utf8');
  assert.match(token, /^[0-9a-f]{32}$/, 'the model was handed the round token');
  for (const text of [w.logText(), JSON.stringify(last), r.stdout, r.stderr]) assert.equal(text.includes(token), false, 'the token is never written');
  assert.deepEqual(w.notifications(), [], 'no notification on exit 0');
});

test('a round whose fake writes a file and does not propose exits 1, leaves the file, does not advance, and notifies with the reason', () => {
  const w = makeCurateWorld();
  w.scenario({ actions: [{ write: { path: 'notes/unproposed.md', content: note('Unproposed') } }] });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(existsSync(join(w.vault, 'notes/unproposed.md')), true);
  assert.equal(w.watermark(), null);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'leftovers');
  assert.deepEqual(last.leftovers, ['notes/unproposed.md']);
  assert.match(last.reason, /notes\/unproposed\.md/);
  const [call] = w.notifications();
  assert.equal(call.at(-1), last.reason, 'notify gets the reason as its last argument');
  assert.match(w.logText(), /"exit":1/);
});

test('a proposed path edited again after the push is left as it is and reported; the round exits 1 and the day stays open', () => {
  const w = makeCurateWorld();
  w.scenario({
    actions: [
      { write: { path: 'notes/a.md', content: note('A') } },
      { write: { path: 'notes/b.md', content: note('B') } },
      w.proposeAction('notes/a.md', 'notes/b.md'),
      { write: { path: 'notes/b.md', content: note('B edited after the push') } },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(r.stderr, /changed after the push, left as they are: notes\/b\.md/);
  assert.equal(existsSync(join(w.vault, 'notes/a.md')), false, 'the untouched one is cleaned');
  assert.match(readFileSync(join(w.vault, 'notes/b.md'), 'utf8'), /edited after the push/);
  assert.deepEqual(w.lastRun().leftovers, ['notes/b.md']);
  assert.equal(w.watermark(), null);
});

test('the cleanup restores a proposed path HEAD has from HEAD, byte for byte', () => {
  const w = makeCurateWorld();
  const original = readFileSync(join(w.vault, 'index.md'));
  w.scenario({ actions: [{ write: { path: 'index.md', content: '# Index\n\n- a new line\n' } }, w.proposeAction('index.md')] });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(readFileSync(join(w.vault, 'index.md')), original);
  assert.equal(w.status(), '');
});

test('a proposal whose pull request did not open exits 3, still cleans up and advances (the work is on a pushed branch)', () => {
  const w = makeCurateWorld();
  w.scenario({ actions: [{ write: { path: 'notes/meeting.md', content: note('Meeting') } }, w.proposeAction('notes/meeting.md')] });
  const r = w.curate([], { FAKE_GH_MODE: 'fail' });
  assert.equal(r.status, EXIT.DEGRADED, r.stderr);
  assert.equal(w.lastRun().proposed.opened, false);
  assert.equal(w.status(), '');
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  assert.equal(w.notifications().length, 1);
});

test('a round record that cannot be read is left with the files, and the round exits 1', () => {
  const w = makeCurateWorld();
  const write = "require('node:fs').writeFileSync('.git/brain-kit-round-' + process.env.BRAIN_KIT_ROUND_TOKEN + '.json', 'garbage')";
  w.scenario({ actions: [{ write: { path: 'notes/x.md', content: note('X') } }, { run: [process.execPath, '-e', write] }] });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'record_invalid');
  assert.equal(w.roundFiles().filter((n) => n.endsWith('.json')).length, 1, 'the record is left');
  assert.equal(existsSync(join(w.vault, 'notes/x.md')), true);
  assert.equal(w.watermark(), null);
});

test('a stream whose init reports permissionMode auto is killed at once and exits 1', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { permissionMode: 'auto' }, delayMs: 60000 });
  const started = Date.now();
  const r = w.curate();
  assert.ok(Date.now() - started < 30000, 'killed, not waited for');
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'isolation');
  assert.deepEqual(last.isolation.problems, ['permission_mode']);
  assert.equal(w.watermark(), null);
  assert.equal(w.notifications().length, 1);
});

test('a hook event in the stream is an isolation failure, exit 1', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { hookEvent: true } });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE);
  assert.ok(w.lastRun().isolation.problems.includes('hooks'));
  assert.equal(w.watermark(), null);
});

test('an API or login error from the model is 69; another model failure is 1 naming the result subtype, error_max_turns included', () => {
  const w = makeCurateWorld();
  w.scenario({ stream: undefined, stderr: 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}\n', exitCode: 1 });
  let r = w.curate();
  assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'model_unavailable');
  assert.equal(w.lastRun().numTurns, null);

  // The same error reported inside the stream, as a result with is_error.
  w.scenario({
    rewrite: { toolUses: [], finalText: 'API Error: 401 Invalid authentication credentials', replace: [['"is_error":false,"duration_ms"', '"is_error":true,"duration_ms"']] },
    exitCode: 1,
  });
  r = w.curate();
  assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);

  // An event with no init is still an isolation failure, never a model one.
  w.scenario({ rewrite: { dropInit: true }, stderr: 'API Error: 401\n', exitCode: 1 });
  r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'isolation');

  w.scenario({ stderr: 'something broke\n', exitCode: 1 });
  r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'model_failed');
  assert.match(w.lastRun().reason, /result success, exit 1/);

  w.scenario({ stream: join(STREAMS, 'max-turns.jsonl'), rewrite: { toolUses: [], finalText: undefined }, exitCode: 1 });
  r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(w.lastRun().reason, /error_max_turns/);
  assert.equal(w.watermark(), null);
});

test('a model that exits 0 without reading the listed transcript exits 4 and the day stays open', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { toolUses: [] } });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  assert.match(w.lastRun().reason, /transcripts \(0\/1\)/);
  assert.equal(w.watermark(), null);
});

test('exit 0 with no BRAIN_KIT_SOURCES line does not advance the mark', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { finalText: 'Round done.' } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.watermark(), null);
  assert.equal(w.lastRun().sources.transcripts.advanced, false);
  assert.match(r.stderr, /did not move \(no_sources_line\)/);
});

test('a lock held by a live process exits 75 naming it, and the round does nothing', () => {
  const w = makeCurateWorld();
  const held = acquireLock(w.vault, { command: 'sync', env: w.env });
  try {
    const r = w.curate();
    assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
    assert.match(r.stderr, new RegExp(`pid ${process.pid}`));
    assert.deepEqual(traces(w), NONE);
    assert.equal(w.lastRun().reasonCode, 'lock_held');
    assert.equal(w.notifications().length, 1);
  } finally {
    held.release();
  }
});

test('a dirty tree postpones the round with 75, naming the file, before anything is fetched', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.vault, 'draft.md'), 'draft\n');
  const r = w.curate();
  assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
  assert.match(r.stderr, /draft\.md/);
  assert.equal(traces(w).fetched, false);
  assert.equal(traces(w).model, false);
});

test('a diverged default branch fails the round with 1 and sync\'s message: a person must act, retrying cannot fix it', () => {
  const w = makeCurateWorld();
  w.publishNotes(1);
  w.write('local.md', note('Local'));
  git(w.vault, ['add', '-A']);
  git(w.vault, ['commit', '-q', '-m', 'local']);
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(r.stderr, /diverged/);
  assert.equal(w.lastRun().reasonCode, 'sync_diverged');
  assert.equal(w.notifications().length, 1);
  assert.equal(traces(w).model, false);
});

test('a mark later than yesterday exits 1 naming watermark reopen', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(3) } }));
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(r.stderr, new RegExp(`brain-kit watermark reopen transcripts ${utcDay(-1)}`));
  assert.equal(traces(w).snapshot, false);
});

test('a vault already swept through yesterday exits 0 saying so, and the model is not called', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(-1) } }));
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /already up to date/);
  assert.equal(traces(w).model, false);
});

test('an empty window advances vacuously and exits 0 without the model', () => {
  const w = makeCurateWorld();
  rmSync(w.transcript);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /nothing to curate/);
  assert.equal(traces(w).model, false);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
});

test('a required source that is misconfigured exits 1 naming the setting, and no mark moves', () => {
  const w = makeCurateWorld({ config: (c) => { c.sources.transcripts.include_projects = []; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(r.stderr, /sources\.transcripts\.include_projects/);
  assert.equal(w.watermark(), null);
  assert.equal(traces(w).model, false);

  const w2 = makeCurateWorld({ machine: {} });
  w2.setMachine({ transcripts_dir: join(w2.base, 'no-such-projects') });
  const r2 = w2.curate();
  assert.equal(r2.status, EXIT.FAILURE, r2.stderr);
  assert.match(r2.stderr, /machine\.json transcripts_dir/);
  assert.equal(w2.watermark(), null);
});

test('a listed project that is missing while another exists is a warning in the log and last-run, and the round runs', () => {
  const w = makeCurateWorld({ config: (c) => { c.sources.transcripts.include_projects = [PROJECT, '-home-ana-gone']; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(w.lastRun().warnings.some((line) => line.includes('project_missing (-home-ana-gone)')));
  assert.match(w.logText(), /source_warning/);
});

test('a CLI stub exits 1 before the model', () => {
  const w = makeCurateWorld();
  const stub = join(w.base, 'claude-stub');
  writeFileSync(stub, '#!/bin/sh\n', { mode: 0o755 });
  w.setMachine({ claude_bin: stub });
  assert.ok(stub.startsWith(w.base), 'the stub is this test\'s own file, never a real claude');
  const r = spawnSync(process.execPath, [BIN, 'curate'], { cwd: w.vault, env: w.env, encoding: 'utf8' });
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'cli_stub');
  assert.equal(traces(w).snapshot, true);
  assert.equal(traces(w).model, false);
});

test('a required source id this version cannot read exits 1 naming curate.sources.required', () => {
  const w = makeCurateWorld({ config: (c) => { c.curate.sources.required = ['transcripts', 'calendar']; c.curate.sources.best_effort = []; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(r.stderr, /curate\.sources\.required names calendar/);
});

test('a curate.prompt outside the vault is refused with exit 2 (ruling M5)', () => {
  const w = makeCurateWorld({ config: (c) => { c.curate.prompt = '../outside.md'; } });
  writeFileSync(join(w.base, 'outside.md'), '{{signature}}\nDo something else.\n');
  const r = w.curate();
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'prompt_outside');
  assert.equal(traces(w).model, false);
});

test('no machine.json is exit 2, and nothing runs', () => {
  const w = makeCurateWorld();
  rmSync(w.machineFile);
  const r = spawnSync(process.execPath, [BIN, 'curate'], { cwd: w.vault, env: w.env, encoding: 'utf8' });
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.deepEqual(traces(w), NONE);
  assert.deepEqual(w.roundFiles(), []);
});

test('no network after waiting is exit 69, and nothing is fetched', async () => {
  const w = makeCurateWorld();
  w.setMachine({ network_check: [process.execPath, '-e', 'process.exit(1)'] });
  const r = await curateInProcess(w, [], { networkTimeoutMs: 100 });
  assert.equal(r.status, EXIT.UNAVAILABLE, r.stderr);
  assert.equal(traces(w).fetched, false);
  assert.equal(w.lastRun().network.ok, false);
});

test('a model that outlives the round timeout is killed and never exits 0', async () => {
  const w = makeCurateWorld();
  w.scenario({ delayMs: 60000 });
  const r = await curateInProcess(w, [], { roundTimeoutMs: 1500, killGraceMs: 500 });
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'timed_out');
  assert.equal(w.watermark(), null);
  assert.deepEqual(w.roundFiles(), []);
});

test('the order: a failing step leaves no trace of any step after it', async () => {
  // 4. network fails: the check ran, nothing after it.
  let w = makeCurateWorld();
  w.setMachine({ network_check: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(w.networkMarker)}, ''); process.exit(1)`] });
  let r = await curateInProcess(w, [], { networkTimeoutMs: 100 });
  assert.equal(r.status, EXIT.UNAVAILABLE);
  assert.deepEqual(traces(w), { ...NONE, network: true });

  // 5. sync fails: network ran, no snapshot, no CLI, no model.
  w = makeCurateWorld();
  git(w.vault, ['remote', 'set-url', 'origin', join(w.base, 'no-such-remote.git')]);
  r = await curateInProcess(w);
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.deepEqual(traces(w), { ...NONE, network: true });

  // 6. the synced config refuses its prompt: fetched, nothing after.
  w = makeCurateWorld({ config: (c) => { c.curate.prompt = '/etc/hostname'; } });
  r = await curateInProcess(w);
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.deepEqual(traces(w), { ...NONE, network: true, fetched: true });

  // 8. dirty after sync (made dirty as the window step starts): no snapshot.
  w = makeCurateWorld();
  r = await curateInProcess(w, [], { onStep: (step) => { if (step === 'window') writeFileSync(join(w.vault, 'late.md'), 'late\n'); } });
  assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
  assert.match(r.stderr, /late\.md \(\d{4}-/);
  assert.deepEqual(traces(w), { ...NONE, network: true, fetched: true });

  // 11. sources misconfigured: the CLI was checked, the model never ran.
  w = makeCurateWorld({ config: (c) => { c.sources.transcripts.include_projects = []; } });
  r = await curateInProcess(w);
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.deepEqual(traces(w), { network: true, fetched: true, snapshot: true, cli: true, model: false });
  assert.deepEqual(JSON.parse(readFileSync(w.files.argvFile, 'utf8')), ['--version']);

  // The steps as observed on a full round, in order.
  w = makeCurateWorld();
  const steps = [];
  r = await curateInProcess(w, [], { onStep: (step) => steps.push(step) });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(steps, ['machine', 'lock', 'network', 'sync', 'config', 'window', 'dirty', 'snapshot', 'cli', 'sources', 'model', 'evidence', 'cleanup', 'watermark']);
});

test('--dry takes no lock, writes no state, runs no check and prints the window and the command line', () => {
  const w = makeCurateWorld();
  const before = readdirSync(w.state).sort();
  const r = w.curate(['--dry']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /Dry run/);
  assert.match(r.stdout, new RegExp(`Days: ${utcDay(-1).split('-').reverse().join('/')}`));
  assert.match(r.stdout, /Source transcripts: 1 file/);
  assert.match(r.stdout, /--max-turns/);
  assert.deepEqual(readdirSync(w.state).sort(), before);
  assert.deepEqual(traces(w), NONE);
  assert.deepEqual(w.roundFiles(), []);
});

test('--check runs the steps up to the model and stops: no model, no last-run, no mark', () => {
  const w = makeCurateWorld();
  const r = w.curate(['--check']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /Prompt: \d+ characters/);
  assert.equal(traces(w).model, false);
  assert.deepEqual(JSON.parse(readFileSync(w.files.argvFile, 'utf8')), ['--version']);
  assert.equal(w.lastRun(), null);
  assert.equal(w.watermark(), null);
  assert.deepEqual(w.roundFiles(), []);
});

test('the log never holds a tool result: a sentinel planted in the fixture\'s tool result stays out of the log and last-run', () => {
  const w = makeCurateWorld();
  const sentinel = 'SENTINEL-TOOL-RESULT-zq9x';
  w.scenario({ rewrite: { replace: [['token seen by child: 0123456789abcdef0123456789abcdef', sentinel]] } });
  const r = w.curate(['--keep-stream']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.logText().includes(sentinel), false);
  assert.equal(JSON.stringify(w.lastRun()).includes(sentinel), false);
  const kept = readdirSync(join(w.state, 'logs')).filter((n) => n.endsWith('.stream.jsonl'));
  assert.equal(kept.length, 1, '--keep-stream keeps the raw stream');
  assert.ok(readFileSync(join(w.state, 'logs', kept[0]), 'utf8').includes(sentinel), 'the raw stream is where the tool result lives');
});

test('the model runs in the vault with the round token, path_extra first on PATH, the limits from the config and the machine\'s model', () => {
  const w = makeCurateWorld({ config: (c) => { c.curate.max_turns = 7; c.curate.budget_usd = 1.5; } });
  const extra = join(w.base, 'extra-bin');
  w.setMachine({ path_extra: [extra], model: 'claude-opus-5-5' });
  const envFile = join(w.base, 'model-env.json');
  w.scenario({ actions: [{ run: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ cwd: process.cwd(), path: process.env.PATH, token: process.env.BRAIN_KIT_ROUND_TOKEN }))`] }] });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const seen = JSON.parse(readFileSync(envFile, 'utf8'));
  assert.equal(seen.cwd, w.vault);
  assert.equal(seen.path.split(':')[0], extra);
  assert.match(seen.token, /^[0-9a-f]{32}$/);
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.deepEqual(argv.slice(argv.indexOf('--max-turns'), argv.indexOf('--max-turns') + 2), ['--max-turns', '7']);
  assert.deepEqual(argv.slice(argv.indexOf('--max-budget-usd'), argv.indexOf('--max-budget-usd') + 2), ['--max-budget-usd', '1.5']);
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
  assert.equal(argv.at(-1), '--');
});

test('the prompt carries the parameters block: the day as DD/MM/YYYY, the window, the transcript, the caps and the kit, and no signature line of its own', () => {
  const w = makeCurateWorld();
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  const [y, m, d] = utcDay(-1).split('-');
  assert.match(prompt, new RegExp(`Days to curate: ${d}/${m}/${y} \\(time zone UTC\\)`));
  assert.match(prompt, /Window: from \d{4}-\d{2}-\d{2}T00:00:00\.000Z/);
  assert.ok(prompt.includes(w.transcript));
  assert.match(prompt, /Limits: transcripts=20/);
  assert.ok(prompt.includes('The kit command: "'));
  const signature = w.config.curate.signature;
  assert.equal(prompt.split('\n')[0], signature);
  assert.equal(prompt.split(signature).length - 1, 1, 'the signature appears once, as the first line');
});

test('the parameters block renders in the vault\'s language', () => {
  const w = makeCurateWorld({ config: (c) => { c.lang = 'pt-BR'; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.match(prompt, /Dias a curar: /);
  assert.doesNotMatch(prompt, /\{[a-z_]+\}/);
});

test('a SIGTERM to curate while the model runs kills the model\'s whole process group before the lock is released, and exits 1', async () => {
  const { spawn } = await import('node:child_process');
  const w = makeCurateWorld();
  const pidFile = join(w.base, 'fake-claude.pid');
  // The fake writes its own pid (the parent of this action), then sleeps.
  w.scenario({ actions: [{ run: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.ppid))`] }], delayMs: 60000 });
  assert.equal(w.machine.claude_bin, FAKE);
  const child = spawn(process.execPath, [BIN, 'curate'], { cwd: w.vault, env: w.env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const until = Date.now() + 30000;
  while (!existsSync(w.files.stdinFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  while (!existsSync(pidFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  const fakePid = Number(readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  const code = await exited;
  assert.equal(code, EXIT.FAILURE);
  let alive = true;
  try { process.kill(fakePid, 0); } catch { alive = false; }
  if (alive) process.kill(fakePid, 'SIGKILL');
  assert.equal(alive, false, 'the model died with the round');
  assert.equal(w.lastRun().reasonCode, 'interrupted');
  assert.deepEqual(w.roundFiles(), [], 'the lock is released');
  assert.equal(w.watermark(), null);
});

test('a path proposed twice is compared with the latest proposal that named it', () => {
  const w = makeCurateWorld();
  w.scenario({
    actions: [
      { write: { path: 'notes/a.md', content: note('A') } },
      w.proposeAction('notes/a.md'),
      { write: { path: 'notes/a.md', content: note('A, second version') } },
      w.proposeAction('notes/a.md'),
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.lastRun().proposed.proposals.length, 2);
  assert.equal(w.status(), '');
});

test('a proposed deletion is left alone when the file came back after the push', () => {
  const w = makeCurateWorld();
  w.write('notes/old.md', note('Old'));
  git(w.vault, ['add', '-A']);
  git(w.vault, ['commit', '-q', '-m', 'old note']);
  git(w.vault, ['push', '-q', 'origin', 'main']);
  const unlink = "require('node:fs').unlinkSync('notes/old.md')";
  w.scenario({
    actions: [
      { run: [process.execPath, '-e', unlink] },
      w.proposeAction('notes/old.md'),
      { write: { path: 'notes/old.md', content: note('Old, written again') } },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(r.stderr, /changed after the push, left as they are: notes\/old\.md/);
  assert.match(readFileSync(join(w.vault, 'notes/old.md'), 'utf8'), /written again/);

  // Not written again: the deletion as pushed is brought back from HEAD.
  const w2 = makeCurateWorld();
  w2.write('notes/old.md', note('Old'));
  git(w2.vault, ['add', '-A']);
  git(w2.vault, ['commit', '-q', '-m', 'old note']);
  git(w2.vault, ['push', '-q', 'origin', 'main']);
  w2.scenario({ actions: [{ run: [process.execPath, '-e', unlink] }, w2.proposeAction('notes/old.md')] });
  const r2 = w2.curate();
  assert.equal(r2.status, EXIT.OK, r2.stderr);
  assert.match(readFileSync(join(w2.vault, 'notes/old.md'), 'utf8'), /# Old/);
  assert.equal(w2.status(), '');
});

test('more open days than a round reads: it curates the oldest, advances only through the last day it read, and says how many remain; the next round continues', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(-11) } }));
  // A session ten days old, the only one inside the first round's window.
  const old = join(w.projects, PROJECT, 'bbbbbbbb-1111-4222-8333-444444444444.jsonl');
  writeFileSync(old, `${JSON.stringify({ type: 'user', timestamp: `${utcDay(-10)}T12:00:00.000Z`, message: { role: 'user', content: 'An older session' } })}\n`);
  w.scenario({ rewrite: { toolUses: [{ name: 'Read', input: { file_path: old, offset: 1 } }] } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const last = w.lastRun();
  assert.deepEqual(last.window.days, [-10, -9, -8, -7, -6, -5, -4].map(utcDay));
  assert.equal(last.remainingDays, 3);
  assert.equal('skippedDays' in last, false);
  assert.match(r.stderr, /3 more day\(s\) remain/);
  assert.match(w.logText(), /days_remaining/);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-4) }, 'the mark stops at the last day read');
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.match(prompt, /3 newer open day\(s\) are left for the next round/);
  assert.ok(prompt.includes(old));
  assert.equal(prompt.includes(w.transcript), false, 'yesterday\'s session is outside this round\'s window');

  w.scenario();
  const next = w.curate();
  assert.equal(next.status, EXIT.OK, next.stderr);
  assert.deepEqual(w.lastRun().window.days, [-3, -2, -1].map(utcDay));
  assert.equal(w.lastRun().remainingDays, 0);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
});

test('a day whose only transcript cannot be opened is not an empty day: the round exits 4 and the mark stays', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, () => {
  const w = makeCurateWorld();
  chmodSync(w.transcript, 0o000);
  try {
    w.scenario({ rewrite: { toolUses: [], finalText: 'BRAIN_KIT_SOURCES: transcripts=failed' } });
    const r = w.curate();
    assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
    assert.match(w.lastRun().reason, /transcripts \(0\/1\)/);
    assert.equal(w.watermark(), null);
    assert.equal(w.notifications().length, 1);
  } finally {
    chmodSync(w.transcript, 0o600);
  }
});
