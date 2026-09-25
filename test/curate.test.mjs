// `brain-kit curate`: the round, run against a throwaway vault with a bare
// remote, a fake `gh` and the fake claude (test/helpers/curate-world.mjs).
// Every run that could reach a claude asserts first that machine.json names
// the fake; the stub case names a 12-byte file of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants as osConstants } from 'node:os';
import { runCurate } from '../src/commands/curate.mjs';
import { acquireLock } from '../src/guards/lock.mjs';
import { createTranslator } from '../src/lang.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { git } from './helpers/git-repo.mjs';
import {
  BIN, CALENDAR_PREFIX, CALENDAR_TOOLS, CONNECTOR_TOOLS, connectorServers, dayStart, DRIVE_PREFIX, DRIVE_TOOLS, FAKE, listEvents, makeCurateWorld, note,
  PROJECT, searchNotes, STREAMS, utcDay, withConnectors,
} from './helpers/curate-world.mjs';

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

// The network check's timing, injected (re-review N6): the real check runs
// to its end, and the fake clock never moves, so the wait always ends under
// the minimum wait and `did_not_wait` is noted however slow the machine is.
function instantNetwork() {
  return {
    networkDeps: {
      now: () => 0,
      sleep: async () => { throw new Error('a second attempt was never meant to run'); },
      runArgv: (argv) => spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' }).status === 0,
    },
  };
}

test('a full round: the fake writes a note and runs the real propose with the round\'s environment; the pull request targets the default branch, the record is read and removed, the tree is clean, the mark advances, last-run names the branch and paths', async () => {
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
  const r = await curateInProcess(w, [], instantNetwork());
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
  assert.deepEqual(last.sources.transcripts, { kept: 1, read: 1, advanced: true, noTimestamp: 0 });
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
  // The reason says what to run, with the branch: propose's own message
  // went to the model, which nobody reads (final review I1).
  const { branch } = w.lastRun().proposed;
  const reason = w.lastRun().reason;
  assert.ok(reason.includes(`gh pr create --head ${branch}`), reason);
  assert.doesNotMatch(reason, /the command propose printed/);
  assert.equal(w.notifications().at(-1).at(-1), reason, 'the notification carries it too');
});

test('a round record that is a symlink is never followed: it counts as broken, even pointing at a valid record, and the round exits 1 (final review M7)', () => {
  const w = makeCurateWorld();
  const target = join(w.base, 'elsewhere.json');
  writeFileSync(target, JSON.stringify({ format: 1, proposals: [] }));
  const link = `require('node:fs').symlinkSync(${JSON.stringify(target)}, '.git/brain-kit-round-' + process.env.BRAIN_KIT_ROUND_TOKEN + '.json')`;
  w.scenario({ actions: [{ run: [process.execPath, '-e', link] }] });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'record_invalid');
  assert.equal(w.watermark(), null);
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

test('a hook event after the init event kills the model at once, exit 1, and the reason does not claim the model did no work (final review I3)', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { hookAfterInit: true }, delayMs: 30000 });
  const started = Date.now();
  const r = w.curate();
  assert.ok(Date.now() - started < 15000, 'killed at the hook, not waited for');
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'isolation');
  assert.deepEqual(last.isolation.problems, ['hooks']);
  assert.match(last.reason, /after the model had started/);
  assert.doesNotMatch(last.reason, /before the model did any work/);
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

  for (const marker of ['Error 401 from the service', 'failed authentication']) {
    w.scenario({ stream: undefined, stderr: `${marker}\n`, exitCode: 1 });
    assert.equal(w.curate().status, EXIT.UNAVAILABLE, marker);
    assert.doesNotMatch(w.lastRun().reason, /from the service|failed auth/, 'only the marker is reported, never the CLI\'s text');
  }

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

test('a model run that otherwise succeeded but leaves a required source open is exit 4, notified, naming the source (review I1)', () => {
  const w = makeCurateWorld();
  w.scenario({ rewrite: { finalText: 'Round done.' } });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  assert.equal(w.watermark(), null);
  const last = w.lastRun();
  assert.equal(last.sources.transcripts.advanced, false);
  assert.equal(last.reasonCode, 'source_not_advanced');
  assert.match(last.reason, /transcripts \(no_sources_line\)/);
  assert.match(r.stderr, /did not move \(no_sources_line\)/);
  assert.equal(w.notifications().at(-1).at(-1), last.reason);

  w.scenario({ rewrite: { finalText: 'Round done.\nBRAIN_KIT_SOURCES: transcripts=failed' } });
  const r2 = w.curate();
  assert.equal(r2.status, EXIT.SOURCE_UNREAD, r2.stderr);
  assert.match(w.lastRun().reason, /transcripts \(reported_failed\)/);
  assert.equal(w.watermark(), null);
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
  assert.equal(w.lastRun().reasonCode, 'dirty_tree');
  assert.match(w.lastRun().reason, /draft\.md \(\d{4}-/, 'the round\'s own reason names the file');
  assert.equal(traces(w).fetched, false);
  assert.equal(traces(w).model, false);
});

// Final review of phase 4, C1: a proposal made outside a round (a person's
// session, the morning briefing) leaves its files dirty by design. The
// round's sync brings them back to HEAD from the proposed-paths ledger
// instead of postponing on them every day, and a file edited after its
// push still postpones.
test('a round after a proposal made outside a round runs instead of postponing: its sync restores the proposed file', () => {
  const w = makeCurateWorld();
  w.write('notes/briefing.md', note('Briefing'));
  const proposed = spawnSync(process.execPath, [BIN, 'propose', 'Briefing', '--only', 'notes/briefing.md'], { cwd: w.vault, env: w.env, encoding: 'utf8' });
  assert.equal(proposed.status, EXIT.OK, proposed.stderr);
  assert.equal(w.status(), '?? notes/briefing.md\n');
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /Brought back to HEAD 1 path\(s\)/);
  assert.equal(w.status(), '');
  assert.equal(traces(w).model, true);
});

test('a file edited after its proposal outside a round still postpones the round with 75, naming it', () => {
  const w = makeCurateWorld();
  w.write('notes/briefing.md', note('Briefing'));
  const proposed = spawnSync(process.execPath, [BIN, 'propose', 'Briefing', '--only', 'notes/briefing.md'], { cwd: w.vault, env: w.env, encoding: 'utf8' });
  assert.equal(proposed.status, EXIT.OK, proposed.stderr);
  w.write('notes/briefing.md', `${note('Briefing')}more\n`);
  const r = w.curate();
  assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'dirty_tree');
  assert.match(w.lastRun().reason, /notes\/briefing\.md/);
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

test('a mark equal to today is in the future: exit 1 naming watermark reopen; a mark at yesterday is up to date (review I4)', () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(0) } }));
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'watermark_future');
  assert.match(r.stderr, new RegExp(`brain-kit watermark reopen transcripts ${utcDay(-1)}`));
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(-1) } }));
  const r2 = w.curate();
  assert.equal(r2.status, EXIT.OK, r2.stderr);
  assert.equal(w.lastRun().reasonCode, 'up_to_date');
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
  const w = makeCurateWorld({ config: (c) => { c.curate.sources.required = ['transcripts', 'journal']; c.curate.sources.best_effort = []; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(r.stderr, /curate\.sources\.required names journal/);
});

test('a required connector source that is off exits 1 before the model, naming its problems and its settings; no mark moves', () => {
  const w = makeCurateWorld({ config: (c) => { c.curate.sources.required = ['transcripts', 'calendar']; c.curate.sources.best_effort = []; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'source_misconfigured');
  assert.match(r.stderr, /the required source calendar is not set up \(not_enabled \(1\)\); fix brain-kit\.config\.json sources\.calendar/);
  assert.equal(traces(w).model, false);
  assert.equal(w.watermark(), null);
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

// The network wait's timing, injected (final review of phase 4, I4): the
// real check runs to its end however slow the machine is, never killed by
// a wall-clock limit, and each attempt spends the whole (fake) wait, so the
// loop ends after exactly one attempt without sleeping.
function oneAttemptNetwork() {
  const clock = { at: 0 };
  return {
    networkTimeoutMs: 1000,
    networkDeps: {
      now: () => clock.at,
      sleep: async () => { throw new Error('a second attempt was never meant to run'); },
      runArgv: (argv) => {
        const done = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' });
        clock.at += 1000;
        return done.status === 0;
      },
    },
  };
}

test('no network after waiting is exit 69, and nothing is fetched', async () => {
  const w = makeCurateWorld();
  w.setMachine({ network_check: [process.execPath, '-e', 'process.exit(1)'] });
  const r = await curateInProcess(w, [], oneAttemptNetwork());
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
  let r = await curateInProcess(w, [], oneAttemptNetwork());
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

// Phase 3, task 1: every round runs with the exact built-in tools, no
// skills, and reads scoped to the vault and the plan's own transcripts.
const PINNED_TOOLS = 'Read,Glob,Grep,Edit,Write,Bash,ToolSearch';
const DAY_MS = 24 * 60 * 60 * 1000;

test('the round\'s argv pins the built-in tools, disables skills, and allows reading only the vault and the plan\'s transcripts, a space and an accent kept', () => {
  const w = makeCurateWorld();
  // The transcripts tree, under a directory with a space and an accent.
  const root = join(w.base, 'Sessões de estudo');
  const projectDir = join(root, PROJECT);
  mkdirSync(projectDir, { recursive: true });
  const kept = join(projectDir, 'aaaaaaaa-1111-4222-8333-444444444444.jsonl');
  writeFileSync(kept, readFileSync(w.transcript));
  // A session of the same project that the plan leaves out: written ten days ago.
  const old = join(projectDir, 'bbbbbbbb-1111-4222-8333-444444444444.jsonl');
  writeFileSync(old, `${JSON.stringify({ type: 'user', timestamp: `${utcDay(-10)}T12:00:00.000Z`, message: { role: 'user', content: 'An older session' } })}\n`);
  const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
  utimesSync(old, tenDaysAgo, tenDaysAgo);
  w.setMachine({ transcripts_dir: root });
  w.scenario({ rewrite: { toolUses: [{ name: 'Read', input: { file_path: kept, offset: 1 } }] } });
  // --dry prints the argument vector the round would pass, read rule included.
  const dry = w.curate(['--dry']);
  assert.equal(dry.status, EXIT.OK, dry.stderr);
  assert.ok(dry.stdout.includes(JSON.stringify(`Read(//${kept.slice(1)})`)), dry.stdout);
  assert.ok(dry.stdout.includes(JSON.stringify(PINNED_TOOLS)), dry.stdout);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.lastRun().sources.transcripts, { kept: 1, read: 1, advanced: true, noTimestamp: 0 });
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(argv.filter((a) => a === '--disable-slash-commands').length, 1);
  assert.equal(argv[argv.indexOf('--tools') + 1], PINNED_TOOLS);
  const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
  const reads = allowed.filter((rule) => /^(Read|Glob|Grep)\b/.test(rule));
  assert.deepEqual(reads, ['Read(./**)', 'Glob(./**)', 'Grep(./**)', `Read(//${kept.slice(1)})`]);
  assert.ok(allowed.includes('ToolSearch'));
  assert.equal(JSON.stringify(argv).includes('bbbbbbbb-1111'), false, 'a session the plan left out is not readable');
  assert.equal(JSON.stringify(argv).includes(`${projectDir}/**`), false, 'the project directory is not readable as a whole');
});

test('a stream whose init lists a built-in tool beyond the pinned set, or lacks one, is killed at once and exits 1, the day open', () => {
  const w = makeCurateWorld();
  const cases = [
    [['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'ToolSearch', 'Task'], /extra: Task; missing: -/],
    [['Bash', 'Glob', 'Grep', 'Edit', 'Write', 'ToolSearch'], /extra: -; missing: Read\b/],
  ];
  for (const [tools, detail] of cases) {
    w.scenario({ rewrite: { tools }, delayMs: 60000 });
    const started = Date.now();
    const r = w.curate();
    assert.ok(Date.now() - started < 30000, 'killed, not waited for');
    assert.equal(r.status, EXIT.FAILURE, r.stderr);
    const last = w.lastRun();
    assert.equal(last.reasonCode, 'isolation');
    assert.deepEqual(last.isolation.problems, ['builtin_tools']);
    assert.match(last.reason, detail);
    assert.equal(w.watermark(), null);
  }
  assert.equal(w.notifications().length, cases.length);
});

test('a built-in tool the vault denies by bare name is expected absent from the init and the round runs (ruling R-B4); absent with no such deny, the round stops', () => {
  const noGlob = ['Bash', 'Read', 'Grep', 'Edit', 'Write', 'ToolSearch'];
  const w = makeCurateWorld({ config: (c) => { c.curate.disallowed_tools_extra = ['Glob']; } });
  w.scenario({ rewrite: { tools: noGlob } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.lastRun().isolation.ok, true);
  assert.equal(JSON.parse(readFileSync(w.files.argvFile, 'utf8')).at(-2), 'Glob');

  const control = makeCurateWorld();
  control.scenario({ rewrite: { tools: noGlob } });
  const c = control.curate();
  assert.equal(c.status, EXIT.FAILURE, c.stderr);
  assert.deepEqual(control.lastRun().isolation.problems, ['builtin_tools']);
  assert.equal(control.watermark(), null);
});

test('a vault whose allow list grants a scoped tool with no scope is a configuration error: exit 2 naming the setting and the rule, in the vault\'s language, before the model; --dry says the same', () => {
  for (const extra of [['Read'], ['Edit()'], ['Bash(*)'], ['Write(./**),Grep']]) {
    const w = makeCurateWorld({ config: (c) => { c.curate.allowed_tools_extra = extra; } });
    const r = w.curate();
    assert.equal(r.status, EXIT.USAGE, r.stderr);
    assert.equal(traces(w).model, false, 'the model was never started');
    const last = w.lastRun();
    assert.equal(last.reasonCode, 'config_invalid');
    assert.ok(last.reason.includes('brain-kit.config.json curate.allowed_tools_extra'), last.reason);
    assert.ok(last.reason.includes(extra.length === 1 && !extra[0].includes(',') ? extra[0] : 'Grep'), last.reason);
    assert.doesNotMatch(last.reason, /unexpected error/);
    assert.equal(w.watermark(), null);
    const dry = w.curate(['--dry']);
    assert.equal(dry.status, EXIT.USAGE, dry.stderr);
    assert.ok(dry.stderr.includes('curate.allowed_tools_extra'), dry.stderr);
  }
  const pt = makeCurateWorld({ config: (c) => { c.lang = 'pt-BR'; c.curate.allowed_tools_extra = ['Read']; } });
  const r = pt.curate();
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.match(pt.lastRun().reason, /concede Read sem escopo/);
  // A scope, however wide, is a deliberate grant: the round runs.
  const wide = makeCurateWorld({ config: (c) => { c.curate.allowed_tools_extra = ['Read(//**)']; } });
  assert.equal(wide.curate().status, EXIT.OK);
});

test('a transcript in the window whose path no read rule can name stops the round before the model: exit 4 naming it and the characters, the day open', () => {
  const w = makeCurateWorld();
  const copy = join(w.projects, PROJECT, '(a) Read (b).jsonl');
  writeFileSync(copy, readFileSync(w.transcript));
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  assert.equal(traces(w).model, false, 'the model was never started');
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'source_unreadable');
  assert.ok(last.reason.includes(copy), last.reason);
  assert.match(last.reason, /hold \( \) in their path, which no read permission can name exactly/);
  assert.equal(w.watermark(), null);
  assert.equal(w.notifications().length, 1);
});

test('a transcripts_dir holding such a character is refused with the machine file, before anything runs', () => {
  const w = makeCurateWorld();
  w.setMachine({ transcripts_dir: join(w.base, 'Sessões (cópia)') });
  const r = w.curate();
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'machine_invalid');
  assert.match(w.lastRun().reason, /transcripts_dir: must not hold \( \)/);
  assert.equal(traces(w).model, false);
});

test('one element of the vault\'s deny list that the CLI splits into several tools expects all of them absent (review M3)', () => {
  const w = makeCurateWorld({ config: (c) => { c.curate.disallowed_tools_extra = ['Glob,Grep']; } });
  w.scenario({ rewrite: { tools: ['Bash', 'Read', 'Edit', 'Write', 'ToolSearch'] } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.lastRun().isolation.ok, true);
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

// The four usual ones, then the rarer catchable signals whose default
// action ends a process (SIGPWR only where the platform has it).
const RARER = ['SIGUSR2', 'SIGALRM', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGPWR'].filter((name) => Object.hasOwn(osConstants.signals, name));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', ...RARER]) {
  test(`a ${signal} to curate while the model runs kills the model's whole process group before the lock is released, writes last-run, notifies and exits 1`, async () => {
    const { spawn } = await import('node:child_process');
    const w = makeCurateWorld();
    const pidFile = join(w.base, 'fake-claude.pid');
    // The fake writes its own pid (the parent of this action), then sleeps.
    w.scenario({ actions: [{ run: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.ppid))`] }], delayMs: 60000 });
    assert.equal(w.machine.claude_bin, FAKE);
    const child = spawn(process.execPath, [BIN, 'curate'], { cwd: w.vault, env: w.env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
    const until = Date.now() + 30000;
    while (!existsSync(w.files.stdinFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    while (!existsSync(pidFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const fakePid = Number(readFileSync(pidFile, 'utf8'));
    child.kill(signal);
    const { code, sig } = await exited;
    assert.deepEqual({ code, sig }, { code: EXIT.FAILURE, sig: null });
    let alive = true;
    try { process.kill(fakePid, 0); } catch { alive = false; }
    if (alive) process.kill(fakePid, 'SIGKILL');
    assert.equal(alive, false, 'the model died with the round');
    const last = w.lastRun();
    assert.equal(last.reasonCode, 'interrupted');
    assert.ok(last.reason.includes(signal), 'the reason names the signal');
    assert.deepEqual(w.roundFiles(), [], 'the lock is released');
    assert.equal(w.watermark(), null);
    assert.equal(w.notifications().length, 1);
  });
}

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

test('a day whose only transcript cannot be opened is not an empty day: the round exits 4 before the model, naming the file, and the mark stays (final review I2)', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, () => {
  const w = makeCurateWorld();
  chmodSync(w.transcript, 0o000);
  try {
    w.scenario({ rewrite: { toolUses: [], finalText: 'BRAIN_KIT_SOURCES: transcripts=failed' } });
    const r = w.curate();
    assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
    const last = w.lastRun();
    assert.equal(last.reasonCode, 'source_unreadable');
    assert.ok(last.reason.includes(w.transcript), 'the reason names the file');
    assert.match(last.reason, /exclude_path_patterns/);
    assert.match(last.reason, /brain-kit watermark assume-covered transcripts/);
    assert.equal(traces(w).model, false, 'the model was never started');
    assert.equal(w.watermark(), null);
    assert.equal(w.notifications().length, 1);
  } finally {
    chmodSync(w.transcript, 0o600);
  }
});

test('a CLI killed by a signal after printing a successful stream is a failed round, and the mark does not move (review I5)', () => {
  const w = makeCurateWorld();
  w.scenario({ killSelf: 'SIGKILL' });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.lastRun().reasonCode, 'model_failed');
  assert.match(w.lastRun().reason, /SIGKILL/);
  assert.equal(w.watermark(), null);
});

test('a result whose subtype is not success is a failed round even when is_error is false (review M1)', () => {
  const w = makeCurateWorld();
  w.scenario({ stream: join(STREAMS, 'max-turns.jsonl'), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript } }], finalText: 'x\nBRAIN_KIT_SOURCES: transcripts=ok', replace: [['"is_error":true', '"is_error":false']] }, exitCode: 0 });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.match(w.lastRun().reason, /error_max_turns/);
  assert.equal(w.watermark(), null);
});

// Review I6: the model edits the tracked pre-push hook, runs propose (whose
// push would run the hook, outside every allowlist) and writes the hook
// back byte for byte. Now propose, joined to the round, refuses while a
// protected path differs from HEAD, so the hook never runs.
function hookWorld() {
  const w = makeCurateWorld();
  w.write('.githooks/pre-push', '#!/bin/sh\nexit 0\n');
  chmodSync(join(w.vault, '.githooks/pre-push'), 0o755);
  git(w.vault, ['add', '-A']);
  git(w.vault, ['commit', '-q', '-m', 'hook']);
  git(w.vault, ['push', '-q', 'origin', 'main']);
  git(w.vault, ['config', 'core.hooksPath', '.githooks']);
  return w;
}

test('a round whose model edits the pre-push hook and proposes: propose refuses, the hook never runs, and the round exits non-zero', () => {
  const w = hookWorld();
  const hook = join(w.vault, '.githooks/pre-push');
  const saved = join(w.base, 'pre-push.orig');
  const marker = join(w.base, 'ran-outside-the-allowlist');
  w.scenario({
    actions: [
      { run: ['sh', '-c', `cp "${hook}" "${saved}" && sed -i '2i touch "${marker}"' "${hook}"`] },
      { write: { path: 'notes/m.md', content: note('Meeting') } },
      w.proposeAction('notes/m.md'),
      { run: ['sh', '-c', `cat "${saved}" > "${hook}"`] },
    ],
  });
  const r = w.curate();
  assert.notEqual(r.status, EXIT.OK, r.stderr);
  assert.equal(existsSync(marker), false, 'the edited hook never ran');
  const runs = readFileSync(w.files.recordFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const propose = runs.find((run) => run.argv.includes('propose'));
  assert.equal(propose.status, EXIT.USAGE);
  assert.match(propose.stderr, /\.githooks\/pre-push/);
  assert.deepEqual(w.ghCalls(), [], 'nothing was pushed or opened');
  assert.equal(w.watermark(), null);

  // Without the revert, the hook itself is what the round reports as left.
  const w2 = hookWorld();
  const hook2 = join(w2.vault, '.githooks/pre-push');
  w2.scenario({
    actions: [
      { run: ['sh', '-c', `sed -i '2i echo changed' "${hook2}"`] },
      { write: { path: 'notes/m.md', content: note('Meeting') } },
      w2.proposeAction('notes/m.md'),
    ],
  });
  const r2 = w2.curate();
  assert.equal(r2.status, EXIT.FAILURE, r2.stderr);
  assert.ok(w2.lastRun().leftovers.includes('.githooks/pre-push'));
  assert.match(w2.lastRun().reason, /\.githooks\/pre-push/);
});

test('curate.enabled false: exit 0 saying so, nothing run or advanced, last-run reason disabled', () => {
  const w = makeCurateWorld({ config: (c) => { c.curate.enabled = false; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /disabled/);
  assert.equal(w.lastRun().reasonCode, 'disabled');
  assert.equal(traces(w).cli, false);
  assert.equal(traces(w).model, false);
  assert.equal(w.watermark(), null);
  assert.deepEqual(w.notifications(), []);
});

test('every round removes its own log files older than machine.log_retention_days, and nothing else', () => {
  const w = makeCurateWorld();
  w.setMachine({ log_retention_days: 5 });
  const logs = join(w.state, 'logs');
  mkdirSync(logs, { recursive: true });
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const files = {
    'curate-2026-01-01.log': old,
    'curate-2026-01-01T00-00-00-000Z.stream.jsonl': old,
    'curate-2026-09-01.log': recent,
    'notes-of-mine.txt': old,
    'other-2026-01-01.log': old,
  };
  for (const [name, when] of Object.entries(files)) {
    writeFileSync(join(logs, name), 'x\n');
    utimesSync(join(logs, name), when, when);
  }
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(-1) } }));
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const left = readdirSync(logs);
  assert.equal(left.includes('curate-2026-01-01.log'), false);
  assert.equal(left.includes('curate-2026-01-01T00-00-00-000Z.stream.jsonl'), false);
  for (const kept of ['curate-2026-09-01.log', 'notes-of-mine.txt', 'other-2026-01-01.log']) assert.ok(left.includes(kept), kept);
});

// ------------------------------------------------ final review of phase 2

// Sessions of Ana on `day` (UTC, the world's zone), noon plus a minute
// each, with an mtime inside the window.
function daySessions(w, day, count, tag) {
  const paths = [];
  const mtime = new Date('2026-09-28T23:00:00.000Z');
  for (let i = 0; i < count; i += 1) {
    const path = join(w.projects, PROJECT, `${tag}${String(i).padStart(7, '0')}-1111-4222-8333-444444444444.jsonl`);
    const at = new Date(Date.parse(`${day}T12:00:00.000Z`) + i * 60_000).toISOString();
    writeFileSync(path, `${JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: `Ana, ${tag} ${i}` } })}\n`);
    utimesSync(path, mtime, mtime);
    paths.push(path);
  }
  return paths;
}

const AFTER_28 = new Date('2026-09-29T12:00:00.000Z');

test('the reviewer\'s C1 reproduction: 5 + 10 + 10 sessions and a cap of 20 cover 26/09 and 27/09, the mark stops at 27/09, 28/09 is deferred and said; the next round covers 28/09', async () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-25' } }));
  const first = daySessions(w, '2026-09-26', 5, 'a');
  const second = daySessions(w, '2026-09-27', 10, 'b');
  const third = daySessions(w, '2026-09-28', 10, 'c');
  const all = [...first, ...second, ...third];
  // A model that reads every file the plan could list.
  w.scenario({ rewrite: { toolUses: all.map((path) => ({ name: 'Read', input: { file_path: path, offset: 1 } })) } });
  const r = await curateInProcess(w, [], { now: AFTER_28 });
  assert.equal(r.status, EXIT.OK, r.stderr);
  const last = w.lastRun();
  assert.deepEqual(last.window.days, ['2026-09-26', '2026-09-27']);
  assert.equal(last.window.to, '2026-09-28T00:00:00.000Z');
  assert.deepEqual(last.deferredDays, ['2026-09-28']);
  assert.deepEqual(last.sources.transcripts, { kept: 15, read: 15, advanced: true, noTimestamp: 0 });
  assert.ok(last.warnings.some((line) => /reads through 27\/09\/2026 and leaves 1 day\(s\) \(28\/09\/2026\) for the next round/.test(line)), last.warnings.join('\n'));
  assert.match(r.stderr, /leaves 1 day\(s\) \(28\/09\/2026\) for the next round/);
  assert.match(r.stderr, /curate\.caps\.transcripts \(20\)/);
  assert.match(w.logText(), /days_deferred/);
  assert.deepEqual(w.watermark(), { transcripts: '2026-09-27' }, 'the mark stops at the last covered day');
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  for (const path of [...first, ...second]) assert.ok(prompt.includes(path), path);
  for (const path of third) assert.equal(prompt.includes(path), false, 'a deferred day\'s session is not offered');
  assert.match(prompt, /1 more open day\(s\) \(28\/09\/2026\) are left for the next round/);

  const next = await curateInProcess(w, [], { now: AFTER_28 });
  assert.equal(next.status, EXIT.OK, next.stderr);
  assert.deepEqual(w.lastRun().window.days, ['2026-09-28']);
  assert.deepEqual(w.lastRun().deferredDays, []);
  assert.equal(w.lastRun().sources.transcripts.kept, 10);
  assert.deepEqual(w.watermark(), { transcripts: '2026-09-28' });
});

test('a first open day holding more transcripts than the cap exits 4 before the model, naming curate.caps.transcripts, the day and the counts; notified; the mark stays', async () => {
  const w = makeCurateWorld();
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-25' } }));
  const paths = daySessions(w, '2026-09-26', 21, 'a');
  w.scenario({ rewrite: { toolUses: paths.map((path) => ({ name: 'Read', input: { file_path: path } })) } });
  const r = await curateInProcess(w, [], { now: AFTER_28 });
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'cap_exceeded');
  assert.match(last.reason, /26\/09\/2026 alone holds 21 transcripts, more than brain-kit\.config\.json curate\.caps\.transcripts \(20\)/);
  assert.equal(traces(w).model, false, 'the model was never started');
  assert.deepEqual(w.watermark(), { transcripts: '2026-09-25' });
  assert.equal(w.notifications().length, 1);
  assert.equal(w.notifications()[0].at(-1), last.reason);
});

test('the reviewer\'s I2 reproduction, a metadata-only session beside a normal one: one round proposes once and closes the day; the retry is a no-op, never a second pull request', () => {
  const w = makeCurateWorld();
  const meta = join(w.projects, PROJECT, 'ffffffff-1111-4222-8333-444444444444.jsonl');
  writeFileSync(meta, `${JSON.stringify({ type: 'summary', summary: 'Ana and the reading group', leafUuid: '00000000-0000-4000-8000-000000000001' })}\n`);
  w.scenario({ actions: [{ write: { path: 'notes/meeting.md', content: note('Meeting') } }, w.proposeAction('notes/meeting.md')] });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.lastRun().sources.transcripts.noTimestamp, 1);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  const again = w.curate();
  assert.equal(again.status, EXIT.OK, again.stderr);
  assert.equal(w.lastRun().reasonCode, 'up_to_date');
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 1, 'one pull request, not one per retry');
});

test('the reviewer\'s I2 reproduction with a session that cannot be decoded: every retry exits 4 without starting the model, so no pull request is ever opened for a day that cannot close', () => {
  const w = makeCurateWorld();
  const broken = join(w.projects, PROJECT, 'ffffffff-1111-4222-8333-444444444444.jsonl');
  writeFileSync(broken, 'not json at all\n');
  w.scenario({ actions: [{ write: { path: 'notes/meeting.md', content: note('Meeting') } }, w.proposeAction('notes/meeting.md')] });
  for (let i = 0; i < 2; i += 1) {
    const r = w.curate();
    assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
    assert.equal(w.lastRun().reasonCode, 'source_unreadable');
    assert.ok(w.lastRun().reason.includes(broken));
  }
  assert.equal(traces(w).model, false, 'the model never ran');
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 0);
  assert.equal(w.watermark(), null);
});

test('a scheduled round speaks the vault\'s language, whatever the environment says', () => {
  const w = makeCurateWorld({ config: (c) => { c.lang = 'pt-BR'; } });
  rmSync(w.transcript);
  const r = w.curate([], { BRAIN_KIT_LANG: 'en' });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(w.lastRun().reason, /nada a curar/);
  assert.match(r.stdout, /nada a curar/);
});

test('curate.network_min_wait_ms reaches the network wait: at 0 a check that answers at once is no longer noted as did_not_wait', () => {
  const w = makeCurateWorld({ config: (c) => { c.curate.network_min_wait_ms = 0; } });
  rmSync(w.transcript);
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.lastRun().network.warning, null);
  assert.doesNotMatch(w.logText(), /network_did_not_wait/);
});

test('the re-review\'s N1 reproduction: two sessions whose messages carry `ts` instead of `timestamp` exit 4 before the model, notified, and the mark stays', () => {
  const w = makeCurateWorld();
  rmSync(w.transcript);
  const at = `${utcDay(-1)}T12:00:00.000Z`;
  const drifted = [];
  for (const id of ['dddddddd', 'eeeeeeee']) {
    const path = join(w.projects, PROJECT, `${id}-1111-4222-8333-444444444444.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: 'user', ts: at, message: { role: 'user', content: 'Ana decided to move the reading group' } })}\n${JSON.stringify({ type: 'assistant', ts: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Noted.' }] } })}\n`);
    drifted.push(path);
  }
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'source_unreadable');
  for (const path of drifted) assert.ok(last.reason.includes(path), path);
  assert.equal(traces(w).model, false);
  assert.equal(w.watermark(), null, 'no day closed as empty');
  assert.equal(w.notifications().length, 1);
});

test('--dry previews an over-cap first day as what a round would do, in the vault\'s language, never as if a round ran', async () => {
  const w = makeCurateWorld({ config: (c) => { c.lang = 'pt-BR'; } });
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-25' } }));
  daySessions(w, '2026-09-26', 21, 'a');
  const r = await curateInProcess(w, ['--dry'], { now: AFTER_28 });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /Uma rodada agora pararia antes do modelo: só o dia 26\/09\/2026 tem 21 transcrições/);
  assert.doesNotMatch(r.stdout, /não foi iniciado|was not started|nenhuma marca andou/);

  const d = makeCurateWorld();
  writeFileSync(join(d.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-25' } }));
  daySessions(d, '2026-09-26', 5, 'a');
  daySessions(d, '2026-09-27', 16, 'b');
  const deferred = await curateInProcess(d, ['--dry'], { now: AFTER_28 });
  assert.match(deferred.stdout, /A round now would read through 26\/09\/2026 and leave 2 day\(s\) \(27\/09\/2026, 28\/09\/2026\) for the next round/);
});

// ---------------------------------------------------------------- phase 3, task 5
//
// The round with connector sources: each source over its own days, connector
// mode for the ones the person's rules allow, and one relaunch without what
// the first init event shows unavailable. Every round here runs the fake
// claude with CLAUDE_CONFIG_DIR pointing at the world's own scratch user
// settings (test/helpers/curate-world.mjs), never the person's.

const BUILTINS = CONNECTOR_TOOLS.filter((name) => !name.startsWith('mcp__'));
const PROPOSE_NOTE = (w) => [{ write: { path: 'notes/reading.md', content: note('Reading') } }, w.proposeAction('notes/reading.md')];

// The fake's stream in connector mode: the isolated fixture with the init
// event a connector-mode round sees (the servers and their tools), the
// transcript read unless `read` is false, and the given tool uses.
function connectorRewrite(w, { servers = connectorServers(), tools = CONNECTOR_TOOLS, uses = [], read = true, finalText } = {}) {
  const readTranscript = read ? [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }] : [];
  return { mcpServers: servers, tools, toolUses: [...readTranscript, ...uses], finalText };
}

// The allow and deny lists of an argument vector.
function argvLists(argv) {
  const allowedAt = argv.indexOf('--allowedTools');
  const deniedAt = argv.indexOf('--disallowedTools');
  return { allowed: argv.slice(allowedAt + 1, deniedAt), denied: argv.slice(deniedAt + 1, argv.lastIndexOf('--')) };
}

function settingSources(argv) {
  return argv[argv.indexOf('--setting-sources') + 1];
}

const shownDay = (day) => day.split('-').reverse().join('/');

test('phase 3 criterion: with the three sources configured and every evidence in the stream, three marks advance; the round ran in connector mode with each source\'s read tools and none of their write tools', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  w.scenario({
    actions: PROPOSE_NOTE(w),
    rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(utcDay(0))), searchNotes(y)], finalText: 'Round done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty meeting_notes=empty' }),
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y, meeting_notes: y });
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 1);
  const last = w.lastRun();
  assert.equal(last.mode, 'connectors');
  assert.equal(last.relaunched, false);
  assert.deepEqual(last.sources.transcripts, { kept: 1, read: 1, advanced: true, noTimestamp: 0 });
  assert.deepEqual(last.sources.calendar, { state: 'connected', observedPrefix: CALENDAR_PREFIX, read: 1, expected: 1, listed: 0, advanced: true, reported: 'empty' });
  assert.deepEqual(last.sources.meeting_notes, { state: 'connected', observedPrefix: DRIVE_PREFIX, read: 1, expected: 1, listed: 0, advanced: true, reported: 'empty', documents: { read: 0, failed: 0 } });
  assert.deepEqual(last.userRules, { mirrored: [], widenedReads: [], blocking: [] });
  assert.deepEqual(last.notConfigured, []);
  assert.deepEqual(last.connectorStates, { calendar: { state: 'connected', at: last.at }, meeting_notes: { state: 'connected', at: last.at } });
  assert.deepEqual(last.window.sources, { transcripts: [y], calendar: [y], meeting_notes: [y] });
  assert.deepEqual(w.notifications(), [], 'a connected source is never announced on its first round');
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(settingSources(argv), 'user');
  assert.equal(argv.includes('--strict-mcp-config'), false);
  assert.equal(argv[argv.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  const { allowed, denied } = argvLists(argv);
  for (const tool of [...CALENDAR_TOOLS, ...DRIVE_TOOLS]) assert.ok(allowed.includes(tool), tool);
  const writes = [...['create_event', 'update_event', 'delete_event', 'respond_to_event'].map((s) => CALENDAR_PREFIX + s), ...['create_file', 'update_file', 'copy_file', 'share_file', 'trash_file', 'download_file_content'].map((s) => DRIVE_PREFIX + s)];
  for (const tool of writes) {
    assert.ok(denied.includes(tool), tool);
    assert.equal(allowed.includes(tool), false, tool);
  }
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.ok(prompt.includes('`BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed> calendar=<ok|empty|failed|unavailable> meeting_notes=<ok|empty|partial|failed|unavailable>`'), 'the last line names every source offered');
  assert.match(prompt, /Source calendar:\nRead through the connector claude\.ai Google Calendar\./);
  assert.match(prompt, /Open at most 3 document\(s\) found by the title search \(curate\.caps\.search_docs_opened\) and at most 6 document\(s\) attached/);
  assert.match(prompt, /write meeting_notes=partial in the last line/);
});

test('phase 3 criterion: the calendar needs authentication at init; the model is killed there, the round launches once more without it, isolated, curates and proposes the transcripts, exit 0; the calendar mark stays, last-run names the state, notify runs once, and not on the next identical round', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const y = utcDay(-1);
  const needsAuth = { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: null }) }, delayMs: 60000 };
  w.scenario({
    launches: [
      needsAuth,
      { actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Round done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' } },
    ],
  });
  const started = Date.now();
  const r = w.curate();
  assert.ok(Date.now() - started < 30000, 'killed at init, not waited for');
  assert.equal(r.status, EXIT.OK, r.stderr);
  const launches = w.launches();
  assert.equal(launches.length, 2, 'one relaunch');
  assert.equal(settingSources(launches[0].argv), 'user');
  assert.ok(argvLists(launches[0].argv).allowed.includes(`${CALENDAR_PREFIX}list_events`));
  assert.equal(settingSources(launches[1].argv), '', 'the relaunch is isolated: no connector source is left');
  assert.ok(launches[1].argv.includes('--strict-mcp-config'));
  assert.equal(argvLists(launches[1].argv).allowed.some((rule) => rule.startsWith('mcp__')), false);
  assert.match(launches[1].stdin, /Source calendar:\nUnavailable this round \(state needs_auth\)\. Write calendar=unavailable in the last line, and do not try to reach it any other way/);
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 1, 'the pull request is born');
  assert.equal(w.status(), '', 'the tree is clean');
  assert.deepEqual(w.watermark(), { transcripts: y }, 'the calendar mark stays');
  const last = w.lastRun();
  assert.equal(last.relaunched, true);
  assert.equal(last.mode, 'isolated');
  assert.equal(last.sources.calendar.state, 'needs_auth');
  assert.equal(last.sources.calendar.advanced, false);
  assert.equal(last.sources.calendar.reported, 'unavailable');
  assert.equal(last.sources.transcripts.advanced, true);
  assert.equal(last.isolation.ok, true);
  assert.deepEqual(last.connectorStates, { calendar: { state: 'needs_auth', at: last.at } });
  assert.match(r.stderr, /the source calendar is unavailable this round \(needs_auth\): claude\.ai Google Calendar needs authentication/);
  assert.match(r.stdout, /launching once more, without calendar/);
  assert.match(w.logText(), / relaunch \{"without":\["calendar"\]/);
  const notes = w.notifications();
  assert.equal(notes.length, 1);
  assert.match(notes[0].at(-1), /the source calendar is needs_auth\. claude\.ai Google Calendar needs authentication/);
  assert.doesNotMatch(notes[0].at(-1), /it was connected/, 'a connector never seen before is not said to have been connected (review M1)');
  assert.match(notes[0].at(-1), /docs\/connectors\.md/);

  // The next identical round: the transcripts are up to date, the calendar's
  // day is still open, the model is killed at init again, and there is
  // nothing else to read: exit 0, and no second notification.
  w.scenario({ launches: [needsAuth] });
  const again = w.curate();
  assert.equal(again.status, EXIT.OK, again.stderr);
  assert.equal(w.launches().length, 1, 'nothing left to relaunch with');
  assert.equal(w.lastRun().reasonCode, 'nothing_available');
  assert.match(w.lastRun().reason, /calendar \(needs_auth\)/);
  assert.deepEqual(w.watermark(), { transcripts: y });
  assert.equal(w.notifications().length, 1, 'the same state is not announced again');
});

for (const [label, servers, state] of [
  ['absent from the init event (disabled for Claude Code, or never connected)', connectorServers({ calendar: null, drive: null }), 'absent'],
  ['listed as connected with its tools missing from the session', connectorServers({ calendar: 'connected', drive: null }), 'tools_missing'],
  ['failed', connectorServers({ calendar: 'failed', drive: null }), 'failed'],
  ['reporting a status this version does not know', connectorServers({ calendar: 'disabled', drive: null }), 'unknown'],
]) {
  test(`the calendar ${label}: killed at init, relaunched once without it, the transcripts curated, exit 0, its mark unmoved and its state named`, () => {
    const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
    w.scenario({
      launches: [
        { rewrite: { mcpServers: servers, tools: BUILTINS }, delayMs: 60000 },
        { actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' } },
      ],
    });
    const started = Date.now();
    const r = w.curate();
    assert.ok(Date.now() - started < 30000, 'killed at init, not waited for');
    assert.equal(r.status, EXIT.OK, r.stderr);
    assert.equal(w.launches().length, 2);
    assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
    assert.equal(w.lastRun().sources.calendar.state, state);
    assert.match(w.launches()[1].stdin, new RegExp(`Unavailable this round \\(state ${state}\\)`));
    assert.equal(w.notifications().length, 1);
  });
}

test('a bare Bash in the person\'s allow rules refuses connector mode: the calendar is blocked_by_user_rules naming the rule, the round runs isolated on the transcripts, exit 0, and the calendar mark stays', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w.userSettings({ permissions: { allow: ['Bash'] } });
  w.scenario({ actions: PROPOSE_NOTE(w), rewrite: { finalText: 'Round done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const launches = w.launches();
  assert.equal(launches.length, 1);
  assert.equal(settingSources(launches[0].argv), '');
  assert.equal(argvLists(launches[0].argv).allowed.some((rule) => rule.startsWith('mcp__')), false);
  assert.match(launches[0].stdin, /Source calendar:\nUnavailable this round \(state blocked_by_user_rules\)/);
  const last = w.lastRun();
  assert.equal(last.mode, 'isolated');
  assert.equal(last.relaunched, false);
  assert.equal(last.sources.calendar.state, 'blocked_by_user_rules');
  assert.deepEqual(last.sources.calendar.rules, ['Bash']);
  assert.deepEqual(last.userRules.blocking.map((b) => [b.rule, b.reason, b.file]), [['Bash', 'covers_kit', join(w.claudeConfig, 'settings.json')]]);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  assert.match(r.stderr, /the source calendar is not read this round: The rule Bash in the allow list of .*settings\.json lets the model run every command/);
  assert.equal(w.notifications().length, 1, 'a state change, announced once');
});

test('a user allow rule the round would inherit is mirrored into the deny list of the connector-mode argv; a read rule disjoint from the round\'s reads is mirrored too (ruling R-F2), one over the vault is recorded as widening reads', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w.userSettings({ permissions: { allow: ['Bash(rtk curl *)', 'Read(//etc/**)', 'Read(//**)'] } });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(utcDay(0)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(settingSources(argv), 'user');
  const { allowed, denied } = argvLists(argv);
  assert.ok(denied.includes('Bash(rtk curl *)'));
  assert.ok(denied.includes('Read(//etc/**)'));
  assert.equal(denied.includes('Read(//**)'), false, 'mirrored, it would deny the round its own reads');
  assert.equal(allowed.includes('Bash(rtk curl *)'), false);
  assert.deepEqual(w.lastRun().userRules, { mirrored: ['Bash(rtk curl *)', 'Read(//etc/**)'], widenedReads: ['Read(//**)'], blocking: [] });
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y });
});

for (const rule of [`${CALENDAR_PREFIX}*`, 'mcp__claude_ai_Google_Calendar']) {
  test(`a user rule for the whole calendar server (${rule}), mirrored as a deny, would deny the calendar its own reads: it is blocked_by_user_rules naming the rule, and the meeting notes, which need it, wait for it with no model work (final review I2)`, () => {
    const w = makeCurateWorld({ config: withConnectors() });
    w.userSettings({ permissions: { allow: [rule] } });
    const y = utcDay(-1);
    w.scenario({ actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable meeting_notes=unavailable' } });
    const r = w.curate();
    assert.equal(r.status, EXIT.OK, r.stderr);
    const launches = w.launches();
    assert.equal(launches.length, 1);
    assert.equal(settingSources(launches[0].argv), '', 'no connector source is left: the round runs isolated');
    const { allowed } = argvLists(launches[0].argv);
    assert.equal(allowed.some((item) => item.startsWith('mcp__')), false, 'neither source\'s tools');
    const last = w.lastRun();
    assert.equal(last.mode, 'isolated');
    assert.equal(last.sources.calendar.state, 'blocked_by_user_rules');
    assert.deepEqual(last.sources.calendar.rules, [rule]);
    assert.deepEqual(last.sources.meeting_notes.waitingFor, { source: 'calendar', state: 'blocked_by_user_rules' });
    assert.equal(last.sources.meeting_notes.read, 0);
    assert.deepEqual(w.watermark(), { transcripts: y });
    assert.match(w.logText(), /"source":"meeting_notes".*"reason":"waiting_for_calendar"/);
    assert.match(w.logText(), / source_waiting \{"source":"meeting_notes","through":"calendar","state":"blocked_by_user_rules"\}/);
    assert.match(r.stderr, /covers the tools of claude\.ai Google Calendar/);
    assert.match(r.stderr, /the source meeting_notes is not read this round: it closes a day only with calendar read over it/);
    assert.match(launches[0].stdin, /Source calendar:\nUnavailable this round \(state blocked_by_user_rules\)/);
    assert.match(launches[0].stdin, /Source meeting_notes:\nUnavailable this round \(state waiting_for_calendar\)/);
  });
}

test('a user rule allowing one of a source\'s own read tools is not mirrored while the source runs, and is mirrored once the source leaves the round, so it grants nothing then', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const own = `${DRIVE_PREFIX}search_files`;
  const y = utcDay(-1);
  w.userSettings({ permissions: { allow: [own] } });
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'connected', drive: 'needs-auth' }), tools: [...BUILTINS, ...CALENDAR_TOOLS] }, delayMs: 60000 },
      { rewrite: connectorRewrite(w, { servers: connectorServers({ calendar: 'connected', drive: 'needs-auth' }), tools: [...BUILTINS, ...CALENDAR_TOOLS], uses: [listEvents(dayStart(y), dayStart(utcDay(0)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty meeting_notes=unavailable' }) },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const [first, second] = w.launches().map((launch) => argvLists(launch.argv));
  assert.ok(first.allowed.includes(own));
  assert.equal(first.denied.includes(own), false);
  assert.equal(second.allowed.includes(own), false);
  assert.ok(second.denied.includes(own), 'without the calendar in the round, the person\'s rule for its tool is denied');
  assert.deepEqual(w.lastRun().userRules.mirrored, [own]);
});

test('per-source windows (decision D5): a calendar mark two days behind the transcripts mark reads only its own days, the transcripts only theirs, and each advances only through what it read', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const [d4, d3, d2, y, today] = [utcDay(-4), utcDay(-3), utcDay(-2), utcDay(-1), utcDay(0)];
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: d2, calendar: d4 } }));
  // A session on a day the transcripts already covered.
  const old = join(w.projects, PROJECT, 'cccccccc-1111-4222-8333-444444444444.jsonl');
  writeFileSync(old, `${JSON.stringify({ type: 'user', timestamp: `${d3}T12:00:00.000Z`, message: { role: 'user', content: 'An older session' } })}\n`);
  // A listing over the transcripts' day only: the calendar's own days are not read.
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(today))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty' }) });
  let r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: d4 }, 'a listing of another source\'s days does not close the calendar\'s');
  let last = w.lastRun();
  assert.deepEqual(last.window.days, [d3, d2, y]);
  assert.deepEqual(last.window.sources, { transcripts: [y], calendar: [d3, d2, y] });
  let prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.equal(prompt.includes(old), false, 'the transcripts are not offered a day they already covered');
  assert.ok(prompt.includes(w.transcript));
  assert.ok(prompt.includes(`"startTime":"${dayStart(d3)}"`), 'the calendar is listed from its own first day');
  assert.ok(prompt.includes(`Days for this source: ${shownDay(y)}; its window runs from ${dayStart(y)}`), 'the transcripts are told their own days');

  // The listing of the calendar's own days: it advances through its own last day.
  w.scenario({ rewrite: connectorRewrite(w, { read: false, uses: [listEvents(dayStart(d3), dayStart(today))], finalText: 'Done.\nBRAIN_KIT_SOURCES: calendar=ok' }) });
  r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y });
  last = w.lastRun();
  assert.deepEqual(last.window.sources, { transcripts: [], calendar: [d3, d2, y] });
  assert.equal('transcripts' in last.sources, false, 'a source with no day of its own is not collected');
  prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.ok(prompt.includes('`BRAIN_KIT_SOURCES: calendar=<ok|empty|failed|unavailable>`'), 'nor offered');
  assert.equal(prompt.includes(w.transcript), false);
});

test('per-source windows, the other way round: the transcripts two days behind the calendar; --check shows the calendar listed from its own first day only', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const [d4, d2, y, today] = [utcDay(-4), utcDay(-2), utcDay(-1), utcDay(0)];
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: d4, calendar: d2 } }));
  const r = w.curate(['--check']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, new RegExp(`Source calendar: read through claude\\.ai Google Calendar, days ${shownDay(y)}\\n`));
  assert.ok(r.stdout.includes(`"startTime":"${dayStart(y)}","endTime":"${dayStart(today)}"`), r.stdout);
  assert.equal(r.stdout.includes(`"startTime":"${dayStart(utcDay(-3))}"`), false);
});

test('a listed source that is off on purpose is only recorded in last-run, with no warning and no notification; one that is half configured is said, never dropped in silence (ruling R-E1)', () => {
  // The fixture lists both connector sources: the meeting notes are off,
  // and the calendar names a calendar with no enabled key (a vault made
  // before phase 3).
  const w = makeCurateWorld();
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const last = w.lastRun();
  assert.deepEqual(last.notConfigured.map((entry) => entry.source), ['calendar', 'meeting_notes']);
  assert.deepEqual(last.notConfigured[0].problems, ['not_enabled (1)']);
  assert.ok(last.notConfigured[1].problems.includes('disabled'));
  assert.equal(r.stderr.includes('meeting_notes'), false, 'off on purpose: silent');
  assert.match(r.stderr, /the source calendar is listed but off for this round \(not_enabled \(1\)\); see brain-kit\.config\.json sources\.calendar/);
  assert.ok(last.warnings.some((line) => line.includes('the source calendar is listed but off')));
  assert.match(w.logText(), /source_off \{"source":"calendar"/);
  assert.deepEqual(Object.keys(last.sources), ['transcripts']);
  assert.equal(last.mode, 'isolated');
  assert.equal(last.userRules, null, 'with no connector source to read, the person\'s settings are not read at all');
  assert.deepEqual(w.notifications(), []);

  const quiet = makeCurateWorld({ config: (c) => { c.sources.calendar.enabled = false; } });
  const q = quiet.curate();
  assert.equal(q.status, EXIT.OK, q.stderr);
  assert.equal(q.stderr.includes('calendar'), false, q.stderr);
  assert.deepEqual(quiet.lastRun().notConfigured.map((entry) => entry.source), ['calendar', 'meeting_notes']);
});

test('a half-configured connector source (enabled, with a tool prefix that is no server\'s) is off, said with its problem, and the round runs isolated without it', () => {
  const w = makeCurateWorld({ config: (c) => { withConnectors({ meetingNotes: false })(c); c.sources.calendar.tool_prefix = 'mcp__x__, Bash'; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stderr, /the source calendar is listed but off for this round \(bad_tool_prefix/);
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(settingSources(argv), '');
  assert.equal(JSON.stringify(argv).includes('mcp__x__'), false, 'no rule is built from it');
});

test('empty: the calendar reported empty with its listing made advances; the transcripts reported empty with a file kept do not, and that is exit 4; without the listing, the calendar\'s empty is only a word and changes no exit', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(utcDay(0)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=empty calendar=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  assert.deepEqual(w.watermark(), { calendar: y });
  assert.match(w.lastRun().reason, /transcripts \(empty_with_files\)/);

  const w2 = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w2.scenario({ rewrite: connectorRewrite(w2, { finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty' }) });
  const r2 = w2.curate();
  assert.equal(r2.status, EXIT.OK, r2.stderr);
  assert.deepEqual(w2.watermark(), { transcripts: y });
  assert.match(r2.stderr, /watermark of calendar did not move \(no_evidence\)/);
});

test('meeting notes reported partial (a limit reached, ruling R-D1) keep their day open whatever the evidence; the round is exit 0', () => {
  const w = makeCurateWorld({ config: withConnectors({ calendar: false }) });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [searchNotes(y)], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok meeting_notes=partial' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y });
  const last = w.lastRun();
  assert.equal(last.sources.meeting_notes.read, 1);
  assert.equal(last.sources.meeting_notes.reported, 'partial');
  assert.equal(last.sources.meeting_notes.advanced, false);
});

test('a connector still connecting at init (pending, ruling R-B1) does not relaunch: the source stays, its evidence decides, and pending is reported but never carried nor announced', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { servers: connectorServers({ calendar: 'pending', drive: null }), tools: BUILTINS, uses: [listEvents(dayStart(y), dayStart(utcDay(0)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=ok' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.launches().length, 1);
  const last = w.lastRun();
  assert.equal(last.relaunched, false);
  assert.equal(last.sources.calendar.state, 'pending');
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y });
  assert.deepEqual(last.connectorStates, {});
  assert.deepEqual(w.notifications(), []);
});

test('one relaunch per round: the drive needs authentication at the first init and the calendar fails at the second; no third launch, the calendar stays unread, the transcripts are curated, exit 0', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'connected', drive: 'needs-auth' }), tools: [...BUILTINS, ...CALENDAR_TOOLS] }, delayMs: 60000 },
      { actions: PROPOSE_NOTE(w), rewrite: connectorRewrite(w, { servers: connectorServers({ calendar: 'failed', drive: 'needs-auth' }), tools: BUILTINS, finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable meeting_notes=unavailable' }) },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const launches = w.launches();
  assert.equal(launches.length, 2, 'never a third launch');
  assert.equal(settingSources(launches[1].argv), 'user', 'the second launch is still in connector mode, for the calendar');
  const second = argvLists(launches[1].argv);
  assert.equal(second.allowed.some((rule) => rule.startsWith(DRIVE_PREFIX)), false);
  assert.ok(second.allowed.includes(`${CALENDAR_PREFIX}list_events`));
  assert.ok(second.denied.includes(`${DRIVE_PREFIX}trash_file`), 'a source left out keeps its write tools denied');
  assert.match(launches[1].stdin, /Source meeting_notes:\nUnavailable this round \(state needs_auth\)/);
  assert.deepEqual(w.watermark(), { transcripts: y });
  const last = w.lastRun();
  assert.equal(last.sources.calendar.state, 'failed');
  assert.equal(last.sources.meeting_notes.state, 'needs_auth');
  assert.match(r.stderr, /the source calendar is failed in the relaunch too/);
  assert.equal(w.notifications().length, 2, 'each changed state once');
});

test('final review I2: the calendar needs authentication at the first init: the relaunch goes without it and without the meeting notes, which wait for it, isolated when nothing else needs a connector; no search runs, the notes day stays open (waiting_for_calendar), exit 0', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: 'connected' }), tools: [...BUILTINS, ...DRIVE_TOOLS] }, delayMs: 60000 },
      { actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable meeting_notes=unavailable' } },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const launches = w.launches();
  assert.equal(launches.length, 2);
  assert.equal(settingSources(launches[1].argv), '', 'the relaunch has no connector source left');
  assert.equal(argvLists(launches[1].argv).allowed.some((rule) => rule.startsWith('mcp__')), false);
  assert.match(launches[1].stdin, /Source meeting_notes:\nUnavailable this round \(state waiting_for_calendar\)/);
  assert.deepEqual(w.watermark(), { transcripts: y });
  const last = w.lastRun();
  assert.equal(last.mode, 'isolated');
  assert.equal(last.relaunched, true);
  assert.equal(last.sources.meeting_notes.state, 'connected', 'its own connector was there');
  assert.deepEqual(last.sources.meeting_notes.waitingFor, { source: 'calendar', state: 'needs_auth' });
  assert.match(w.logText(), / relaunch \{"without":\["calendar","meeting_notes"\],"states":\{"calendar":"needs_auth","meeting_notes":"waiting_for_calendar"\}\}/);
  assert.match(w.logText(), /"source":"meeting_notes","day":null,"reported":"unavailable","advanced":false,"reason":"waiting_for_calendar"/);
  assert.match(r.stderr, /watermark of meeting_notes did not move \(waiting_for_calendar\)/);
  assert.equal(w.notifications().length, 1, 'the calendar\'s state change, once');
});

test('--dry and --check print the launch mode, the mirror\'s counts and any rule that refuses connector mode, and write nothing', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w.userSettings({ permissions: { allow: ['Bash(rtk curl *)', 'Read(//etc/**)', 'Read(//**)'] } });
  for (const args of [['--dry'], ['--check']]) {
    const r = w.curate(args);
    assert.equal(r.status, EXIT.OK, r.stderr);
    assert.match(r.stdout, /Mode: connectors \(.*\): 2 user allow rule\(s\) mirrored as denies, 1 widening reads/, args[0]);
    assert.match(r.stdout, /Source calendar: read through claude\.ai Google Calendar, days /, args[0]);
    assert.ok(r.stdout.includes('"--setting-sources","user"'), args[0]);
  }
  w.userSettings({ permissions: { allow: ['Bash'] } });
  for (const args of [['--dry'], ['--check']]) {
    const r = w.curate(args);
    assert.equal(r.status, EXIT.OK, r.stderr);
    assert.match(r.stdout, /Mode: isolated; connector mode is refused by your Claude Code user settings/, args[0]);
    assert.match(r.stdout, /The rule Bash in the allow list of .*settings\.json lets the model run every command/, args[0]);
    assert.match(r.stdout, /Source calendar: not read this round \(blocked_by_user_rules\)/, args[0]);
    assert.ok(r.stdout.includes('"--setting-sources",""'), args[0]);
  }
  assert.equal(w.lastRun(), null, 'neither writes last-run');
  assert.equal(w.watermark(), null);
  assert.deepEqual(w.notifications(), []);
});

test('the state-change notification: once when a best-effort connector source goes from connected to needs_auth, never again while it stays, once when it comes back, never for pending', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const round = (status) => {
    if (status === 'needs-auth') w.scenario({ launches: [{ rewrite: { mcpServers: connectorServers({ calendar: status, drive: null }) }, delayMs: 60000 }] });
    else w.scenario({ rewrite: connectorRewrite(w, { servers: connectorServers({ calendar: status, drive: null }), tools: status === 'connected' ? [...BUILTINS, ...CALENDAR_TOOLS] : BUILTINS, finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=failed' }) });
    const r = w.curate();
    assert.equal(r.status, EXIT.OK, `${status}: ${r.stderr}`);
    return w.notifications().map((call) => call.at(-1));
  };
  assert.deepEqual(round('connected'), []);
  let sent = round('needs-auth');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /calendar is now needs_auth \(it was connected\)/);
  assert.equal(round('needs-auth').length, 1, 'the same state again: nothing new');
  sent = round('connected');
  assert.equal(sent.length, 2);
  assert.match(sent[1], /calendar is connected again \(it was needs_auth\); see docs\/connectors\.md/);
  assert.equal(round('pending').length, 2, 'pending says nothing about the connector yet');
  assert.equal(w.lastRun().connectorStates.calendar.state, 'connected');
});

test('a required connector source that is unavailable leaves the round exit 4 after the relaunch, the transcripts still curated', () => {
  const w = makeCurateWorld({ config: (c) => { withConnectors({ meetingNotes: false })(c); c.curate.sources.required = ['transcripts', 'calendar']; c.curate.sources.best_effort = ['meeting_notes']; } });
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: null }) }, delayMs: 60000 },
      { actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' } },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  assert.match(w.lastRun().reason, /calendar \(0\/1\)/);
  assert.equal(w.watermark(), null, 'no mark moves on exit 4');
  assert.equal(w.notifications().length, 1, 'the exit is announced; a required source\'s state change is not announced on its own');
});

test('when what is left after the connectors is a transcripts plan with nothing in it, no model runs again: the transcripts advance as an empty window does, the calendar\'s day stays open, exit 0', () => {
  // Relaunch case: the calendar needs authentication, and there is no session yesterday.
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  rmSync(w.transcript);
  w.scenario({ launches: [{ rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: null }) }, delayMs: 60000 }] });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.launches().length, 1, 'killed at init, and not launched again for nothing');
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'nothing_available');
  assert.match(last.reason, /unavailable: calendar \(needs_auth\)/);
  assert.equal(last.sources.transcripts.advanced, true);
  assert.deepEqual(last.sources.calendar, { state: 'needs_auth', observedPrefix: null, read: 0, expected: 1, listed: null, advanced: false, reported: null });

  // Mode-choice case: the calendar is blocked by a rule, and no model starts at all.
  const b = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  rmSync(b.transcript);
  b.userSettings({ permissions: { allow: ['Bash'] } });
  const rb = b.curate();
  assert.equal(rb.status, EXIT.OK, rb.stderr);
  assert.equal(b.launches().length, 0);
  assert.equal(traces(b).model, false);
  assert.deepEqual(b.watermark(), { transcripts: utcDay(-1) });
  assert.equal(b.lastRun().mode, 'isolated');
  assert.equal(b.lastRun().sources.calendar.state, 'blocked_by_user_rules');
});

test('a calendar blocked by a rule for its whole server takes its own tools out of the round, so the person\'s rule for one of them is mirrored too, in the same choice', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const own = `${DRIVE_PREFIX}search_files`;
  w.userSettings({ permissions: { allow: [`${DRIVE_PREFIX}*`, own] } });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(utcDay(0)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty meeting_notes=unavailable' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const { allowed, denied } = argvLists(w.launches()[0].argv);
  assert.equal(allowed.includes(own), false);
  assert.ok(denied.includes(own), 'no user rule for a document-store tool survives in a round without the meeting notes');
  assert.deepEqual(w.lastRun().userRules.mirrored, [`${DRIVE_PREFIX}*`, own]);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y }, 'the calendar does not wait for the meeting notes');
  assert.match(r.stderr, /watermark of meeting_notes did not move \(no_evidence\)/, 'blocked on its own account, not a second door left unread');
});

test('a user Bash rule covering the kit\'s `node <kit>` forms is mirrored, and the round keeps only the direct kit forms in connector mode', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w.userSettings({ permissions: { allow: ['Bash(node:*)'] } });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(utcDay(0)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const argv = JSON.parse(readFileSync(w.files.argvFile, 'utf8'));
  assert.equal(settingSources(argv), 'user');
  const { allowed, denied } = argvLists(argv);
  assert.ok(denied.includes('Bash(node:*)'));
  assert.equal(allowed.some((rule) => rule.startsWith('Bash(node ')), false, 'no node form is left to collide with the mirrored deny');
  for (const sub of ['validate', 'lint', 'propose']) assert.ok(allowed.some((rule) => rule.startsWith('Bash("') && rule.endsWith(` ${sub}:*)`)), sub);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y });
});

test('a hook in the stream of a launch stopped for a relaunch, after the init event, is an isolation failure: no relaunch, exit 1, no mark moves', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: null }), hookAfterInit: true } },
      { actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' } },
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.launches().length, 1, 'no relaunch after a breach');
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'isolation');
  assert.deepEqual(last.isolation.problems, ['hooks']);
  assert.equal(w.watermark(), null);
});

test('an unset calendar mark reads yesterday only, even when the transcripts are catching up from further back', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const [d4, y, today] = [utcDay(-4), utcDay(-1), utcDay(0)];
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: d4 } }));
  const r = w.curate(['--check']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, new RegExp(`Source calendar: read through claude\\.ai Google Calendar, days ${shownDay(y)}\\n`));
  assert.ok(r.stdout.includes(`"startTime":"${dayStart(y)}","endTime":"${dayStart(today)}"`), r.stdout);
});

test('days past the transcripts\' cap are left for the transcripts\' next round only: the calendar reads and advances through its own days (ruling C1)', async () => {
  const w = makeCurateWorld({ config: (c) => { withConnectors({ meetingNotes: false })(c); c.curate.caps.transcripts = 1; } });
  const now = new Date('2026-09-29T12:00:00.000Z');
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-25', calendar: '2026-09-25' } }));
  const sessions = ['2026-09-26', '2026-09-27'].flatMap((day, i) => daySessions(w, day, 1, String(i + 1)));
  w.scenario({ rewrite: connectorRewrite(w, { read: false, uses: [{ name: 'Read', input: { file_path: sessions[0], offset: 1 } }, listEvents(dayStart('2026-09-26'), dayStart('2026-09-29'))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty' }) });
  const r = await curateInProcess(w, [], { now });
  assert.equal(r.status, EXIT.OK, r.stderr);
  const last = w.lastRun();
  assert.deepEqual(last.window.sources, { transcripts: ['2026-09-26'], calendar: ['2026-09-26', '2026-09-27', '2026-09-28'] });
  assert.deepEqual(last.deferredDays, ['2026-09-27', '2026-09-28']);
  assert.deepEqual(w.watermark(), { transcripts: '2026-09-26', calendar: '2026-09-28' });
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.equal(prompt.includes(sessions[1]), false, 'a deferred transcripts day is not offered');
  assert.ok(prompt.includes(`"startTime":"${dayStart('2026-09-26')}","endTime":"${dayStart('2026-09-29')}"`), 'the calendar is offered its own days');
});

test('each launch is checked in its own mode: an isolated relaunch whose init event lists a server is stopped at once, exit 1', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: null }) }, delayMs: 60000 },
      { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: null }), toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' }, delayMs: 60000 },
    ],
  });
  const started = Date.now();
  const r = w.curate();
  assert.ok(Date.now() - started < 30000, 'both launches stopped at their init');
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  assert.equal(w.launches().length, 2);
  assert.equal(settingSources(w.launches()[1].argv), '');
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'isolation');
  assert.deepEqual(last.isolation.problems, ['mcp']);
  assert.equal(last.mode, 'isolated');
  assert.equal(w.watermark(), null);
});

test('every kind of rule that refuses connector mode refuses it, in the settings file or its local sibling: a file that cannot be read, a rule that cannot be mirrored, a write rule over the vault, a Bash rule over every command', () => {
  const cases = [
    ['settings.json', '{ "permissions": { "allow": ["Bash(rtk curl *)"], } }\n', 'unreadable', /The Claude Code user settings file .*settings\.json cannot be read/],
    ['settings.json', `${JSON.stringify({ permissions: { allow: ['Bash(echo $(date) ok)'] } })}\n`, 'unreadable', /The rule Bash\(echo \$\(date\) ok\) in the allow list of .* has no meaning the kit can mirror/],
    ['settings.json', `${JSON.stringify({ permissions: { allow: ['Edit(//**)'] } })}\n`, 'covers_vault', /The rule Edit\(\/\/\*\*\) in the allow list of .* lets the model write in the vault/],
    ['settings.local.json', `${JSON.stringify({ permissions: { allow: ['Bash(*)'] } })}\n`, 'covers_kit', /The rule Bash\(\*\) in the allow list of .*settings\.local\.json lets the model run every command/],
  ];
  for (const [name, text, reason, message] of cases) {
    const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
    writeFileSync(join(w.claudeConfig, name), text);
    const dry = w.curate(['--dry']);
    assert.equal(dry.status, EXIT.OK, dry.stderr);
    assert.match(dry.stdout, /Mode: isolated; connector mode is refused/, `${reason}: ${name}`);
    assert.match(dry.stdout, message, `${reason}: ${name}`);
    assert.ok(dry.stdout.includes('"--setting-sources",""'), `${reason}: ${name}`);
  }
  // A round with a settings file the kit cannot read: isolated, the calendar blocked, the file named.
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  writeFileSync(join(w.claudeConfig, 'settings.json'), '{ "permissions": { "allow": ["Bash(rtk curl *)"], } }\n');
  w.scenario({ rewrite: { finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(settingSources(w.launches()[0].argv), '');
  const last = w.lastRun();
  assert.equal(last.sources.calendar.state, 'blocked_by_user_rules');
  assert.deepEqual(last.sources.calendar.rules, [join(w.claudeConfig, 'settings.json')]);
  assert.deepEqual(last.userRules.blocking.map((b) => b.reason), ['unreadable']);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
});

// ---------------------------------------------------------------- task 5, fix round 1

test('review C1: a calendar stuck since 16/09 never takes the transcripts\' days: on 25/09 the transcripts read 24/09 and propose, the calendar gets its own oldest seven days, exit 0', async () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const now = new Date('2026-09-25T12:00:00.000Z');
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-23', calendar: '2026-09-16' } }));
  const [session] = daySessions(w, '2026-09-24', 1, 'd');
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: null }) }, delayMs: 60000 },
      { actions: PROPOSE_NOTE(w), rewrite: { toolUses: [session, w.transcript].map((file_path) => ({ name: 'Read', input: { file_path, offset: 1 } })), finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable' } },
    ],
  });
  const r = await curateInProcess(w, [], { now });
  assert.equal(r.status, EXIT.OK, r.stderr);
  const last = w.lastRun();
  assert.deepEqual(last.window.sources, { transcripts: ['2026-09-24'], calendar: ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'] });
  assert.equal(last.remainingDays, 1, 'the calendar leaves 24/09 for its next round');
  assert.match(r.stderr, /calendar reads through 23\/09\/2026 this round; 1 more day\(s\) remain for it/);
  assert.equal(r.stderr.includes('transcripts reads through'), false, 'nothing remains for the transcripts');
  assert.deepEqual(w.watermark(), { transcripts: '2026-09-24', calendar: '2026-09-16' });
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 1, 'the pull request is born');
  assert.ok(w.launches()[1].stdin.includes(session));
});

test('review C1: each source is clipped to its own oldest seven days, and a source ahead reads its own days whatever the one behind', async () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const now = new Date('2026-09-25T12:00:00.000Z');
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-10', calendar: '2026-09-20' } }));
  const r = await curateInProcess(w, ['--check'], { now });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /Source calendar: read through claude\.ai Google Calendar, days 21\/09\/2026, 22\/09\/2026, 23\/09\/2026, 24\/09\/2026\n/);
  assert.ok(r.stdout.includes(`"startTime":"${dayStart('2026-09-21')}","endTime":"${dayStart('2026-09-25')}"`));
  assert.match(r.stderr, /transcripts reads through 17\/09\/2026 this round; 7 more day\(s\) remain for it/);
  assert.match(r.stdout, /Days: 11\/09\/2026, .*17\/09\/2026, 21\/09\/2026, .*24\/09\/2026 /, 'the round\'s days are the union');
});

test('review I1: a last line whose states are not states (an e-mail, a title) is recorded as invalid, in last-run and the log, never as written, and advances nothing', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  const email = 'ana.private@example.com';
  const title = 'Minutes_of_the_budget_cut';
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(utcDay(0))), searchNotes(y)], finalText: `Done.\nBRAIN_KIT_SOURCES: transcripts=${title} calendar=${email} meeting_notes=ok` }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  const last = w.lastRun();
  assert.equal(last.sources.calendar.reported, 'invalid');
  assert.match(w.logText(), /"source":"calendar","day":"[0-9-]+","reported":"invalid"/);
  assert.match(w.logText(), /"source":"transcripts","day":"[0-9-]+","reported":"invalid"/);
  for (const text of [JSON.stringify(last), w.logText()]) {
    assert.equal(text.includes(email), false);
    assert.equal(text.includes(title), false);
  }
  assert.deepEqual(w.watermark(), { meeting_notes: y }, 'only a real state advances; nothing moves on exit 4 but the round\'s own rule');
});

test('review I2: with the calendar configured, the meeting notes close a day only when the calendar was read over it in the same round; the morning round without the calendar leaves it open, with no model work on the notes (final review I2), the retry closes both', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  // Morning: the calendar needs authentication; the meeting notes wait for it, and no search runs.
  w.scenario({
    launches: [
      { rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: 'connected' }), tools: [...BUILTINS, ...DRIVE_TOOLS] }, delayMs: 60000 },
      { actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable meeting_notes=unavailable' } },
    ],
  });
  let r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y });
  assert.equal(w.lastRun().sources.meeting_notes.read, 0, 'no search was offered');
  assert.match(r.stderr, /watermark of meeting_notes did not move \(waiting_for_calendar\)/);
  // The retry, the calendar reconnected: both doors, both close.
  w.scenario({ rewrite: connectorRewrite(w, { read: false, uses: [listEvents(dayStart(y), dayStart(utcDay(0))), searchNotes(y)], finalText: 'Done.\nBRAIN_KIT_SOURCES: calendar=empty meeting_notes=empty' }) });
  r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y, meeting_notes: y });
});

test('review I2: a day the calendar already closed is listed again for the meeting notes\' attachments, said so in the parameters, and then the meeting notes close it', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: y, calendar: y } }));
  w.scenario({ rewrite: connectorRewrite(w, { read: false, uses: [listEvents(dayStart(y), dayStart(utcDay(0))), searchNotes(y)], finalText: 'Done.\nBRAIN_KIT_SOURCES: calendar=empty meeting_notes=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  assert.ok(prompt.includes(`Days ${shownDay(y)} were already curated for this source: they are listed again only so the meeting_notes can reach the documents attached to their events`));
  assert.deepEqual(w.lastRun().window.sources.calendar, [y]);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y, meeting_notes: y });
});

test('review I2: with the calendar not configured, the title search alone closes a meeting-notes day', () => {
  const w = makeCurateWorld({ config: withConnectors({ calendar: false }) });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [searchNotes(y)], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok meeting_notes=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y, meeting_notes: y });
});

test('review M2: an invalid machine.json keeps the connector states the last round knew', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const states = { calendar: { state: 'needs_auth', at: '2026-09-24T09:30:00.000Z' } };
  writeFileSync(join(w.state, 'last-run.json'), JSON.stringify({ at: '2026-09-24T09:30:00.000Z', connectorStates: states }));
  writeFileSync(w.machineFile, '{ not json');
  const r = w.curate();
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.deepEqual(w.lastRun().connectorStates, states);
});

test('review M3: the write tools of a configured connector source with no day of its own are still denied in connector mode', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { meeting_notes: y } }));
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(y), dayStart(utcDay(0)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.lastRun().window.sources.meeting_notes, []);
  const { denied } = argvLists(JSON.parse(readFileSync(w.files.argvFile, 'utf8')));
  for (const s of ['create_file', 'update_file', 'copy_file', 'share_file', 'trash_file', 'download_file_content']) assert.ok(denied.includes(DRIVE_PREFIX + s), s);
});

test('review I2: the calendar in the round is not enough: without its listing over the day, the meeting notes keep the day open', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [searchNotes(y)], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty meeting_notes=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y });
  assert.match(r.stderr, /watermark of meeting_notes did not move \(second_door_unread\)/);
});

// ---------------------------------------------------------------- final review fix (25/09/2026)

test('final review I2: --dry says the meeting notes wait for a calendar blocked by the person\'s rules, and shows the round isolated', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  w.userSettings({ permissions: { allow: [`${CALENDAR_PREFIX}*`] } });
  const r = w.curate(['--dry']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /the source meeting_notes is not read this round: it closes a day only with calendar read over it, and that source is not read this round \(blocked_by_user_rules\)/);
  assert.match(r.stdout, /Source meeting_notes: not read this round \(waiting_for_calendar\)/);
  assert.ok(r.stdout.includes('"--setting-sources",""'), 'no connector source is left to read');
  assert.equal(w.lastRun(), null);
});

test('final review I2: with the calendar turned off, the meeting notes do not wait for it: the title search alone closes their day', () => {
  const w = makeCurateWorld({ config: (c) => { withConnectors()(c); c.sources.calendar.enabled = false; } });
  const y = utcDay(-1);
  w.scenario({ rewrite: connectorRewrite(w, { uses: [searchNotes(y)], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok meeting_notes=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y, meeting_notes: y });
  assert.equal(Object.hasOwn(w.lastRun().sources.meeting_notes, 'waitingFor'), false);
});

test('ruling R-F1: a connector source reported empty whose reads listed something does not advance (inconsistent_empty), and last-run counts what was listed; the same listing reported ok advances', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const y = utcDay(-1);
  const events = JSON.stringify({ events: [{ id: 'evt-0001', summary: 'Reading group' }, { id: 'evt-0002', summary: 'Reading group' }] });
  const files = JSON.stringify({ files: [{ id: 'file-0001', title: 'Notes by Example - Reading group' }] });
  const uses = [listEvents(dayStart(y), dayStart(utcDay(0)), { content: events }), searchNotes(y, { content: files })];
  w.scenario({ rewrite: connectorRewrite(w, { uses, finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty meeting_notes=empty' }) });
  let r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y });
  assert.match(r.stderr, /watermark of calendar did not move \(inconsistent_empty\)/);
  assert.match(r.stderr, /watermark of meeting_notes did not move \(inconsistent_empty\)/);
  const last = w.lastRun();
  assert.equal(last.sources.calendar.listed, 2);
  assert.equal(last.sources.meeting_notes.listed, 1);
  assert.match(w.logText(), /"source":"calendar","day":"[0-9-]+","reported":"empty","advanced":false,"reason":"inconsistent_empty"/);
  for (const text of [JSON.stringify(last), w.logText()]) assert.equal(text.includes('Reading group'), false, 'counts only, never what was listed');
  w.scenario({ rewrite: connectorRewrite(w, { read: false, uses, finalText: 'Done.\nBRAIN_KIT_SOURCES: calendar=ok meeting_notes=ok' }) });
  r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.watermark(), { transcripts: y, calendar: y, meeting_notes: y });
});

test('final review M1: a source whose days end before the round\'s is told the window of its own days, never the round\'s end', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  const today = utcDay(0);
  // The calendar eleven days behind reads its oldest seven, the transcripts read yesterday.
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: utcDay(-2), calendar: utcDay(-11) } }));
  w.scenario({ rewrite: connectorRewrite(w, { uses: [listEvents(dayStart(utcDay(-10)), dayStart(utcDay(-3)))], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=empty' }) });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const prompt = readFileSync(w.files.stdinFile, 'utf8');
  const own = [-10, -9, -8, -7, -6, -5, -4].map((n) => shownDay(utcDay(n))).join(', ');
  assert.ok(prompt.includes(`Days for this source: ${own}; its window runs from ${dayStart(utcDay(-10))} (included) to ${dayStart(utcDay(-3))} (not included).`), prompt);
  assert.ok(prompt.includes(`Days for this source: ${shownDay(utcDay(-1))}; its window runs from ${dayStart(utcDay(-1))} (included) to ${dayStart(today)} (not included).`), 'the transcripts\' own day');
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1), calendar: utcDay(-4) });
});

test('final review M2: the calendar listed for the meeting notes keeps its own seven-day cap; the notes days past the listing wait, and each source says what remains', async () => {
  const w = makeCurateWorld({ config: withConnectors() });
  const now = new Date('2026-09-25T12:00:00.000Z');
  // The calendar twelve days back (after `watermark reopen`), the notes two.
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-24', calendar: '2026-09-12', meeting_notes: '2026-09-22' } }));
  let r = await curateInProcess(w, ['--check'], { now });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.match(r.stdout, /Source calendar: read through claude\.ai Google Calendar, days 13\/09\/2026, 14\/09\/2026, 15\/09\/2026, 16\/09\/2026, 17\/09\/2026, 18\/09\/2026, 19\/09\/2026\n/);
  assert.match(r.stdout, /Source meeting_notes: no open day of its own in this round/);
  assert.match(r.stderr, /calendar reads through 19\/09\/2026 this round; 5 more day\(s\) remain for it/);
  assert.match(r.stderr, /meeting_notes reads no day this round: its 2 open day\(s\) wait until calendar has listed the days before them/);
  // Closer: the listing spans both, within seven days, and the notes keep their days.
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-24', calendar: '2026-09-18', meeting_notes: '2026-09-22' } }));
  r = await curateInProcess(w, ['--check'], { now });
  assert.match(r.stdout, /Source calendar: read through claude\.ai Google Calendar, days 19\/09\/2026, 20\/09\/2026, 21\/09\/2026, 22\/09\/2026, 23\/09\/2026, 24\/09\/2026\n/);
  assert.match(r.stdout, /Source meeting_notes: read through claude\.ai Google Drive, days 23\/09\/2026, 24\/09\/2026\n/);
  assert.equal(r.stderr.includes('more day(s) remain'), false);
  // The notes behind the calendar by more than seven days: the listing covers the notes' oldest seven, the calendar's own days wait.
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-24', calendar: '2026-09-23', meeting_notes: '2026-09-12' } }));
  r = await curateInProcess(w, ['--check'], { now });
  assert.match(r.stdout, /Source calendar: read through claude\.ai Google Calendar, days 13\/09\/2026, .*19\/09\/2026\n/);
  assert.match(r.stderr, /calendar reads through 19\/09\/2026 this round; 1 more day\(s\) remain for it/);
  assert.match(r.stderr, /meeting_notes reads through 19\/09\/2026 this round; 5 more day\(s\) remain for it/);
  // A calendar with no mark yet reads only yesterday on its own: the listing that stops before it leaves that day for later.
  writeFileSync(join(w.state, 'watermark.json'), JSON.stringify({ sources: { transcripts: '2026-09-24', meeting_notes: '2026-09-12' } }));
  r = await curateInProcess(w, ['--check'], { now });
  assert.match(r.stderr, /calendar reads through 19\/09\/2026 this round; 1 more day\(s\) remain for it/);
});

test('final review I3: a user write rule anchored at the settings folder (`/x`) is mirrored in its resolved absolute form, never as written, so the deny names the same place the allow did', () => {
  const w = makeCurateWorld({ config: withConnectors({ meetingNotes: false }) });
  w.userSettings({ permissions: { allow: ['Edit(/notes/**)', 'Write(/**)', 'Edit(~/elsewhere/**)'] } });
  const r = w.curate(['--dry']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const argv = JSON.parse(/Command: \S+ (\[.*\])\n/.exec(r.stdout)?.[1] ?? r.stdout.slice(r.stdout.indexOf('['), r.stdout.lastIndexOf(']') + 1));
  const { denied } = argvLists(argv);
  assert.ok(denied.includes(`Edit(/${w.claudeConfig}/notes/**)`), denied.join(' '));
  assert.ok(denied.includes(`Write(/${w.claudeConfig}/**)`));
  assert.ok(denied.includes(`Edit(/${w.env.HOME}/elsewhere/**)`));
  for (const rule of ['Edit(/notes/**)', 'Write(/**)', 'Edit(~/elsewhere/**)']) assert.equal(denied.includes(rule), false, rule);
});

test('final review I2: meeting notes unavailable on their own account keep their own reason: a bare Bash blocks both sources, and the notes are blocked, not waiting, their mark held by their own evidence', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  w.userSettings({ permissions: { allow: ['Bash'] } });
  w.scenario({ actions: PROPOSE_NOTE(w), rewrite: { toolUses: [{ name: 'Read', input: { file_path: w.transcript, offset: 1 } }], finalText: 'Done.\nBRAIN_KIT_SOURCES: transcripts=ok calendar=unavailable meeting_notes=unavailable' } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const last = w.lastRun();
  assert.equal(last.sources.meeting_notes.state, 'blocked_by_user_rules');
  assert.equal(Object.hasOwn(last.sources.meeting_notes, 'waitingFor'), false);
  assert.equal(r.stderr.includes('waiting_for_calendar'), false);
  assert.match(r.stderr, /watermark of meeting_notes did not move \(no_evidence\)/);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
});

test('final review I2: when nothing is left for a model once the calendar is gone, the waiting meeting notes are still logged with their reason', () => {
  const w = makeCurateWorld({ config: withConnectors() });
  rmSync(w.transcript);
  w.scenario({ launches: [{ rewrite: { mcpServers: connectorServers({ calendar: 'needs-auth', drive: 'connected' }), tools: [...BUILTINS, ...DRIVE_TOOLS] }, delayMs: 60000 }] });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(w.launches().length, 1, 'no second launch for nothing');
  assert.equal(w.lastRun().reasonCode, 'nothing_available');
  assert.match(w.logText(), / watermark \{"source":"meeting_notes","day":null,"advanced":false,"reason":"waiting_for_calendar"\}/);
  assert.match(r.stderr, /watermark of meeting_notes did not move \(waiting_for_calendar\)/);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
});
