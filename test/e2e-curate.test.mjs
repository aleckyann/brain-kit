// The one test that runs a real round: the real `claude`, a real model, a
// real (small) cost. Opt-in only, with BRAIN_KIT_E2E=1, and never in CI:
//
//   BRAIN_KIT_E2E=1 node --test test/e2e-curate.test.mjs
//
// Everything else is built in a scratch directory that is NOT removed when
// the test ends, so the round can be read afterwards (the path is printed):
// a vault made by `brain-kit init --yes`, a bare remote it pushes to, a fake
// `gh` first on PATH that records the pull request instead of opening one,
// a Claude Code transcripts tree with one session inside yesterday, and a
// state directory. machine.json points claude_bin at the real claude found
// on PATH and the model at sonnet; the configuration caps the round at 1
// USD. HOME stays the person's own, because the real claude's login lives
// there: the round's isolation (--setting-sources '' and the rest) is what
// keeps the person's settings, hooks and MCP servers out, and this test is
// where that is proven against the real CLI.
//
// What a passing run proves (the acceptance criterion of phase 2): exit 0;
// the vault's log holds the session's fact on a branch the round pushed;
// the fake gh saw `pr create` against the default branch; last-run.json
// records a cost; the watermark advanced for transcripts; and the stream's
// own init event reported dontAsk, no MCP server and no hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../src/version.mjs';
import { withoutLocalGitVars } from '../src/git-env.mjs';
import { user, assistant } from './helpers/transcripts-world.mjs';

const ENABLED = process.env.BRAIN_KIT_E2E === '1';
const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const FAKE_CLAUDE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const PROJECT = '-home-ana-reading';
const FACT = 'Ana decided to move the reading group to Thursdays';
const BUDGET_USD = 1;
const MODEL = 'sonnet';
const ROUND_TIMEOUT_MS = 30 * 60 * 1000;

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// Records every call as one JSON line; `pr create` succeeds and `pr view`
// answers only for a head a `pr create` named, as the real gh would.
function fakeGh(log) {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(log, JSON.stringify({ args }) + '\\n');
const url = 'https://example.invalid/ana/reading/pull/1';
if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('Creating pull request\\n' + url + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const created = before.filter((e) => e.args[0] === 'pr' && e.args[1] === 'create' && e.args[e.args.indexOf('--head') + 1] === args[2]).at(-1);
  if (!created) { process.stderr.write('no pull requests found for branch "' + args[2] + '"\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ baseRefName: created.args[created.args.indexOf('--base') + 1], headRefName: args[2], url }) + '\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unexpected call\\n');
process.exit(2);
`;
}

function run(program, args, { cwd, env, timeout = 120000 } = {}) {
  const r = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout });
  return r;
}

function must(r, what) {
  assert.equal(r.status, 0, `${what} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

test('a real round against a throwaway vault opens a pull request from inside the round and records its cost', {
  skip: ENABLED ? false : 'set BRAIN_KIT_E2E=1 to run a real round (real claude, real cost)',
  timeout: ROUND_TIMEOUT_MS + 5 * 60 * 1000,
}, (t) => {
  const claude = findOnPath('claude');
  assert.ok(claude, 'BRAIN_KIT_E2E=1 needs the real claude on PATH');
  assert.notEqual(claude, FAKE_CLAUDE, 'this test runs the real claude, never the fake');

  const base = mkdtempSync(join(tmpdir(), 'brain-kit-e2e-'));
  t.diagnostic(`scratch: ${base}`);
  const vault = join(base, 'vault');
  const remote = join(base, 'remote.git');
  const state = join(base, 'state');
  const projects = join(base, 'projects');
  const fakebin = join(base, 'fakebin');
  const ghLog = join(base, 'gh-calls.jsonl');
  const gitconfig = join(base, 'gitconfig');
  mkdirSync(fakebin);
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(fakebin, 'gh'), fakeGh(ghLog));
  chmodSync(join(fakebin, 'gh'), 0o755);
  // The vault's push gate runs `brain-kit` from PATH: this checkout's own.
  symlinkSync(BIN, join(fakebin, 'brain-kit'));
  writeFileSync(gitconfig, '[user]\n\tname = Ana\n\temail = ana@example.invalid\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');

  const env = {
    ...withoutLocalGitVars(process.env),
    PATH: `${fakebin}${delimiter}${process.env.PATH ?? ''}`,
    BRAIN_KIT_STATE_DIR: state,
    BRAIN_KIT_LANG: 'en',
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const kit = (args, options = {}) => run(process.execPath, [BIN, ...args], { cwd: base, env, ...options });
  const git = (cwd, args) => must(run('git', args, { cwd, env }), `git ${args.join(' ')}`);

  // The vault, its configuration, and its first commit on a bare remote.
  must(kit(['init', vault, '--yes', '--lang', 'en']), 'brain-kit init --yes');
  const configFile = join(vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.vault.timezone = 'UTC';
  config.sources.transcripts.include_projects = [PROJECT];
  config.curate.budget_usd = BUDGET_USD;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(vault, ['add', '-A']);
  git(vault, ['commit', '-q', '-m', 'A new vault']);
  git(vault, ['remote', 'add', 'origin', remote]);
  git(vault, ['push', '-q', '-u', 'origin', 'main']);
  git(vault, ['remote', 'set-head', 'origin', '--auto']);

  // One session inside yesterday (UTC, the vault's zone).
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const at = `${yesterday}T12:00:00.000Z`;
  mkdirSync(join(projects, PROJECT), { recursive: true });
  const transcript = join(projects, PROJECT, 'e2e00000-1111-4222-8333-444444444444.jsonl');
  writeFileSync(transcript, `${[
    user(`Note for the vault: ${FACT}, starting next week.`, at),
    assistant(`Understood: ${FACT}.`, at),
  ].map((line) => JSON.stringify(line)).join('\n')}\n`);

  // machine.json: the transcripts tree, the real claude, sonnet, and a
  // notify command that records any call (a green round makes none).
  const notified = join(base, 'notified.jsonl');
  must(kit(['machine', 'set', 'transcripts_dir', projects, vault]), 'machine set transcripts_dir');
  must(kit(['machine', 'set', 'claude_bin', claude, vault]), 'machine set claude_bin');
  must(kit(['machine', 'set', 'model', MODEL, vault]), 'machine set model');
  must(kit(['machine', 'set', 'notify_command', JSON.stringify([process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(notified)}, JSON.stringify(process.argv.slice(1)) + '\\n')`]), vault]), 'machine set notify_command');
  const machine = JSON.parse(readFileSync(join(state, 'machine.json'), 'utf8'));
  assert.equal(machine.claude_bin, claude, 'the round must run the real claude found on PATH');

  // The round, as a scheduler runs it.
  const round = run(process.execPath, [BIN, 'curate', vault, '--keep-stream'], { cwd: vault, env, timeout: ROUND_TIMEOUT_MS });
  const lastRun = JSON.parse(readFileSync(join(state, 'last-run.json'), 'utf8'));
  const logs = join(state, 'logs');
  const logFile = readdirSync(logs).filter((name) => name.endsWith('.log')).map((name) => join(logs, name))[0];
  t.diagnostic(`exit ${round.status}, cost ${lastRun.costUsd} USD, ${lastRun.numTurns} turn(s), log ${logFile}`);
  console.log(`e2e curate: exit ${round.status}, cost ${lastRun.costUsd} USD, turns ${lastRun.numTurns}, log ${logFile}`);
  assert.equal(round.status, 0, `curate exited ${round.status}\n${round.stdout}\n${round.stderr}\n${JSON.stringify(lastRun, null, 2)}`);

  // last-run.json: a cost, the isolation proven, a pull request opened.
  assert.equal(typeof lastRun.costUsd, 'number', JSON.stringify(lastRun));
  assert.ok(lastRun.costUsd > 0 && lastRun.costUsd <= BUDGET_USD * 1.5, `cost ${lastRun.costUsd}`);
  assert.deepEqual(lastRun.isolation, { ok: true, problems: [] });
  assert.equal(lastRun.proposed?.opened, true, JSON.stringify(lastRun.proposed));

  // The stream's own init event: dontAsk, no MCP server, and no hook event.
  const streamFile = readdirSync(logs).filter((name) => name.endsWith('.stream.jsonl')).map((name) => join(logs, name))[0];
  assert.ok(streamFile, 'the round kept its stream (--keep-stream)');
  const events = readFileSync(streamFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  assert.ok(init, 'the stream carries an init event');
  assert.equal(init.permissionMode, 'dontAsk');
  assert.deepEqual(init.mcp_servers ?? [], []);
  assert.equal(events.filter((e) => e.type === 'system' && String(e.subtype).startsWith('hook_')).length, 0);

  // The log entry is on the branch the round pushed.
  const branch = lastRun.proposed.branch;
  const logPath = config.taxonomy?.log ?? 'memory/log.md';
  const pushedLog = must(run('git', ['show', `${branch}:${logPath}`], { cwd: remote, env }), `git show ${branch}:${logPath}`);
  assert.match(pushedLog, /reading group/i, pushedLog);
  assert.match(pushedLog, /thursday/i, pushedLog);

  // The fake gh saw pr create against the default branch.
  const calls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const create = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(create, JSON.stringify(calls));
  assert.equal(create.args[create.args.indexOf('--base') + 1], 'main');
  assert.equal(create.args[create.args.indexOf('--head') + 1], branch);

  // The watermark advanced for transcripts, to yesterday.
  const mark = JSON.parse(readFileSync(join(state, 'watermark.json'), 'utf8'));
  assert.equal(mark.sources.transcripts, yesterday);

  // A green round notifies nobody.
  assert.equal(existsSync(notified), false);
});
