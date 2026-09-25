// The one test that runs a real round through the person's real claude.ai
// connectors: the real `claude`, a real model, a real (small) cost, and the
// calendar and document store of whoever runs it. Opt-in only, with
// BRAIN_KIT_E2E_CONNECTORS=1, and never in CI:
//
//   BRAIN_KIT_E2E_CONNECTORS=1 node --test test/e2e-connectors.test.mjs
//
// BRAIN_KIT_E2E_CALENDAR names the calendar the round lists (`primary`, the
// owner's main calendar, by default), and BRAIN_KIT_E2E_LANG the vault's
// language pack (`en` by default), whose literal meeting-notes title the
// round searches for, as `init` writes it.
//
// Everything is built in a scratch directory that is NOT removed when the
// test ends, so the round can be read afterwards (the path is printed): a
// vault made by `brain-kit init --yes` with the calendar and the meeting
// notes turned on, a bare remote it pushes to, a fake `gh` first on PATH
// that records the pull request instead of opening one, an empty but
// configured Claude Code transcripts tree, and a state directory.
// machine.json points claude_bin at the real claude found on PATH and the
// model at sonnet; the configuration caps the round at 1.5 USD. HOME stays
// the person's own and CLAUDE_CONFIG_DIR is left as it is, because the
// login and the connectors live there: connector mode loads the person's
// user settings on purpose, and what it switches off (hooks, skills, the
// built-in tools beyond the pinned set, every user allow rule mirrored as a
// deny) is what this test proves against the real CLI.
//
// Nothing the connectors return is asserted on or printed: only states,
// counts, the tool names the model called, the cost and the paths.
//
// What a passing run proves (the phase 3 criterion, against real
// connectors): exit 0; the round ran in connector mode, or the recorded
// states say why not; each connector source was either read, by its
// mechanical evidence, with its mark advanced, or has its state recorded
// with its mark unmoved; no write tool of either connector was called, and
// every connector-mode launch denied them all; a pull request was opened
// against the default branch, or last-run.json says nothing was proposed;
// and a state that is not connected was announced to the notify command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../src/version.mjs';
import { withoutLocalGitVars } from '../src/git-env.mjs';
import { addDays, localDay } from '../src/guards/watermark.mjs';

const ENABLED = process.env.BRAIN_KIT_E2E_CONNECTORS === '1';
const CALENDAR = process.env.BRAIN_KIT_E2E_CALENDAR || 'primary';
const LANG = process.env.BRAIN_KIT_E2E_LANG || 'en';
const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const FAKE_CLAUDE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const PROJECT = '-home-ana-reading';
const BUDGET_USD = 1.5;
const MODEL = 'sonnet';
const ROUND_TIMEOUT_MS = 30 * 60 * 1000;
const CONNECTOR_SOURCES = Object.freeze(['calendar', 'meeting_notes']);
// Each connector's write tools (src/sources/calendar-google.mjs and
// src/sources/meeting-notes-google-drive.mjs), which no round may reach.
const WRITE_SUFFIXES = Object.freeze({
  calendar: ['create_event', 'update_event', 'delete_event', 'respond_to_event'],
  meeting_notes: ['create_file', 'update_file', 'copy_file', 'share_file', 'trash_file', 'download_file_content'],
});

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
  return spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout });
}

function must(r, what) {
  assert.equal(r.status, 0, `${what} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function jsonLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// The values after a flag in an argument vector, up to the next option.
function valuesAfter(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1) return [];
  const out = [];
  for (let i = at + 1; i < argv.length && !argv[i].startsWith('--'); i++) out.push(argv[i]);
  return out;
}

test('a real round through the person\'s own connectors reads each source or records why not, never writes through them, and ends in a pull request or nothing proposed', {
  skip: ENABLED ? false : 'set BRAIN_KIT_E2E_CONNECTORS=1 to run a real round through your own connectors (real claude, real cost)',
  timeout: ROUND_TIMEOUT_MS + 5 * 60 * 1000,
}, (t) => {
  const claude = findOnPath('claude');
  assert.ok(claude, 'BRAIN_KIT_E2E_CONNECTORS=1 needs the real claude on PATH');
  assert.notEqual(claude, FAKE_CLAUDE, 'this test runs the real claude, never the fake');
  assert.ok(['en', 'pt-BR'].includes(LANG), `BRAIN_KIT_E2E_LANG must be en or pt-BR, not ${LANG}`);

  const base = mkdtempSync(join(tmpdir(), 'brain-kit-e2e-connectors-'));
  t.diagnostic(`scratch: ${base}`);
  console.log(`e2e connectors: scratch ${base}`);
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

  // HOME and CLAUDE_CONFIG_DIR are the person's own: the login and the
  // connectors live there.
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

  // The vault: both connector sources on, the pack's own meeting-notes
  // literal as init wrote it, an empty but configured transcripts project.
  must(kit(['init', vault, '--yes', '--lang', LANG]), 'brain-kit init --yes');
  const configFile = join(vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.sources.transcripts.include_projects = [PROJECT];
  config.sources.calendar.enabled = true;
  config.sources.calendar.calendars = [CALENDAR];
  config.sources.meeting_notes.enabled = true;
  config.curate.budget_usd = BUDGET_USD;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const literal = config.sources.meeting_notes.search_title_contains;
  assert.ok(typeof literal === 'string' && literal !== '', 'init wrote the pack\'s meeting-notes literal');
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(vault, ['add', '-A']);
  git(vault, ['commit', '-q', '-m', 'A new vault']);
  git(vault, ['remote', 'add', 'origin', remote]);
  git(vault, ['push', '-q', '-u', 'origin', 'main']);
  git(vault, ['remote', 'set-head', 'origin', '--auto']);
  mkdirSync(join(projects, PROJECT), { recursive: true });

  // machine.json: the transcripts tree, the real claude, sonnet, and a
  // notify command that records every call.
  const notified = join(base, 'notified.jsonl');
  must(kit(['machine', 'set', 'transcripts_dir', projects, vault]), 'machine set transcripts_dir');
  must(kit(['machine', 'set', 'claude_bin', claude, vault]), 'machine set claude_bin');
  must(kit(['machine', 'set', 'model', MODEL, vault]), 'machine set model');
  must(kit(['machine', 'set', 'notify_command', JSON.stringify([process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(notified)}, JSON.stringify(process.argv.slice(1)) + '\\n')`]), vault]), 'machine set notify_command');
  const machine = JSON.parse(readFileSync(join(state, 'machine.json'), 'utf8'));
  assert.equal(machine.claude_bin, claude, 'the round must run the real claude found on PATH');

  // The round, as a scheduler runs it, keeping its stream to read the tool
  // names the model called.
  const round = run(process.execPath, [BIN, 'curate', vault, '--keep-stream'], { cwd: vault, env, timeout: ROUND_TIMEOUT_MS });
  const lastRun = JSON.parse(readFileSync(join(state, 'last-run.json'), 'utf8'));
  const logs = join(state, 'logs');
  const logFile = readdirSync(logs).filter((name) => name.endsWith('.log')).map((name) => join(logs, name))[0];
  const states = Object.fromEntries(CONNECTOR_SOURCES.map((id) => [id, lastRun.sources?.[id]?.state ?? null]));
  const summary = `exit ${round.status}, cost ${lastRun.costUsd} USD, ${lastRun.numTurns} turn(s), mode ${lastRun.mode}, relaunched ${lastRun.relaunched}, `
    + `states ${CONNECTOR_SOURCES.map((id) => `${id}=${states[id]}`).join(' ')}, documents ${JSON.stringify(lastRun.sources?.meeting_notes?.documents ?? null)}, log ${logFile}`;
  t.diagnostic(summary);
  console.log(`e2e connectors: ${summary}`);
  assert.equal(round.status, 0, `curate exited ${round.status}\n${round.stdout}\n${round.stderr}\n${JSON.stringify(lastRun, null, 2)}`);
  if (typeof lastRun.costUsd === 'number') assert.ok(lastRun.costUsd <= BUDGET_USD * 1.5, `cost ${lastRun.costUsd}`);

  // Connector mode, or the states say why not.
  if (lastRun.mode !== 'connectors') {
    for (const id of CONNECTOR_SOURCES) {
      assert.ok(typeof states[id] === 'string' && states[id] !== 'connected', `mode ${lastRun.mode}, but ${id} records the state ${states[id]}`);
    }
  }

  // Each connector source: read by its evidence and its mark advanced to
  // yesterday, or its state recorded and its mark unmoved (it was unset).
  const yesterday = addDays(localDay(new Date(lastRun.at), config.vault.timezone), -1);
  const markFile = join(state, 'watermark.json');
  const mark = existsSync(markFile) ? JSON.parse(readFileSync(markFile, 'utf8')).sources ?? {} : {};
  for (const id of CONNECTOR_SOURCES) {
    const entry = lastRun.sources?.[id];
    assert.ok(entry, `last-run.json has no entry for ${id}: ${JSON.stringify(lastRun.sources)}`);
    if (entry.advanced === true) {
      assert.ok(entry.expected > 0 && entry.read === entry.expected, `${id} advanced without its evidence: ${JSON.stringify(entry)}`);
      assert.equal(mark[id], yesterday, `${id}'s mark`);
    } else {
      assert.equal(typeof entry.state, 'string', `${id} was not read and records no state: ${JSON.stringify(entry)}`);
      assert.equal(mark[id], undefined, `${id}'s mark moved without a reading`);
    }
  }

  // No write tool of either connector was called, and every launch in
  // connector mode denied them all.
  const prefixes = { calendar: config.sources.calendar.tool_prefix, meeting_notes: config.sources.meeting_notes.tool_prefix };
  const writes = CONNECTOR_SOURCES.flatMap((id) => WRITE_SUFFIXES[id].map((suffix) => prefixes[id] + suffix));
  const streamFile = readdirSync(logs).filter((name) => name.endsWith('.stream.jsonl')).map((name) => join(logs, name))[0];
  const called = streamFile === undefined ? [] : jsonLines(streamFile)
    .filter((event) => event.type === 'assistant' && Array.isArray(event.message?.content))
    .flatMap((event) => event.message.content.filter((block) => block.type === 'tool_use').map((block) => block.name));
  console.log(`e2e connectors: connector tools called ${JSON.stringify(called.filter((name) => Object.values(prefixes).some((prefix) => name.startsWith(prefix))))}`);
  for (const name of called) assert.ok(!writes.includes(name), `the model called the write tool ${name}`);
  const starts = readFileSync(logFile, 'utf8').split('\n')
    .map((line) => /^\S+ model_start (.*)$/.exec(line)).filter(Boolean).map((m) => JSON.parse(m[1]));
  for (const start of starts.filter((entry) => entry.mode === 'connectors')) {
    const denied = valuesAfter(start.argv, '--disallowedTools');
    for (const tool of writes) assert.ok(denied.includes(tool), `launch ${start.launch} did not deny ${tool}`);
  }

  // A pull request against the default branch, or nothing proposed.
  if (lastRun.proposed === null) {
    assert.ok(['nothing_proposed', 'nothing_available'].includes(lastRun.reasonCode), `no proposal, reason ${lastRun.reasonCode}`);
  } else {
    assert.equal(lastRun.proposed.opened, true, JSON.stringify(lastRun.proposed));
    const calls = jsonLines(ghLog);
    const create = calls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    assert.ok(create, JSON.stringify(calls));
    assert.equal(create.args[create.args.indexOf('--base') + 1], 'main');
    assert.equal(create.args[create.args.indexOf('--head') + 1], lastRun.proposed.branch);
  }

  // A best-effort state other than connected (or pending, which says
  // nothing yet) is announced once, naming the connectors guide; a round
  // whose connectors were all there announces nothing.
  const changed = CONNECTOR_SOURCES.filter((id) => typeof states[id] === 'string' && !['connected', 'pending'].includes(states[id]));
  const notices = existsSync(notified) ? jsonLines(notified) : [];
  if (changed.length === 0) assert.deepEqual(notices, []);
  else assert.ok(notices.some((argv) => argv.join(' ').includes('docs/connectors.md')), JSON.stringify(notices));
});
