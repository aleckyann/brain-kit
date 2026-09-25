// The briefing's facts (src/briefing/facts.mjs) and `brain-kit preflight`
// (src/commands/preflight.mjs). Every fact the briefing states is computed
// here, and every one that cannot be known says so: gh absent or failing
// gives no list, never an empty one; a last-run record that cannot be read
// is not "no round yet"; git that cannot answer leaves its numbers null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { main } from '../src/cli.mjs';
import { acquireLock } from '../src/guards/lock.mjs';
import { briefingFacts, humanInstant, PR_LIST_ARGS, staleVerdict } from '../src/briefing/facts.mjs';
import { PREFLIGHT_JSON_VERSION, renderPreflight, runPreflight } from '../src/commands/preflight.mjs';
import { CLEAN_ENV, git, makeRepo } from './helpers/git-repo.mjs';
import { makeWorld } from './helpers/sync-world.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const UTC3 = 'America/Argentina/Buenos_Aires';
// 09:00 of Friday 25/09/2026 at UTC-3.
const NOW = new Date('2026-09-25T12:00:00Z');
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: CLEAN_ENV }).stdout.trim();

const FACT_KEYS = ['today', 'todayHuman', 'weekday', 'tz', 'lastRun', 'connectorStates', 'openPullRequests', 'stale', 'pending', 'git', 'lock', 'questions'];

// A fake gh that answers only the call the preflight makes: `gh api
// --paginate ... --jq <filter>`, over pages of the GitHub API's own shape
// (FAKE_GH_OUTPUT holds an array of pages). With --paginate it prints every
// page, without it only the first, as gh does; the filter is applied as gh
// would (one JSON line per pull request) only when it is the preflight's
// own. Any other call is refused, so a changed argv is a failing test.
const FAKE_GH = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), prompt: process.env.GH_PROMPT_DISABLED ?? null, gitDir: process.env.GIT_DIR ?? null }) + '\\n');
const expected = ${JSON.stringify(PR_LIST_ARGS)};
const paginate = args.includes('--paginate');
const rest = args.filter((arg) => arg !== '--paginate');
if (JSON.stringify(rest) !== JSON.stringify(expected.filter((arg) => arg !== '--paginate'))) { process.stderr.write('fake gh: unexpected call\\n'); process.exit(2); }
const mode = process.env.FAKE_GH_MODE || 'ok';
if (mode === 'fail') { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4); }
if (mode === 'garbage') { process.stdout.write('not json at all\\n'); process.exit(0); }
if (mode === 'shape') { process.stdout.write(JSON.stringify({ number: '7', title: 'x' }) + '\\n'); process.exit(0); }
const pages = JSON.parse(fs.readFileSync(process.env.FAKE_GH_OUTPUT, 'utf8'));
const line = (pr) => JSON.stringify({ number: pr.number, title: pr.title, url: pr.html_url, createdAt: pr.created_at });
for (const [index, page] of (paginate ? pages : pages.slice(0, 1)).entries()) {
  if (mode === 'failpage2' && index === 1) { process.stderr.write('HTTP 502: Bad Gateway (page 2)\\n'); process.exit(1); }
  for (const pr of page) process.stdout.write(line(pr) + '\\n');
}
`;

function baseConfig(overrides = {}) {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.vault.timezone = UTC3;
  return merge(config, overrides);
}

function merge(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object' ? merge(base[key], value) : value;
  }
  return out;
}

const FOLLOWUPS = `---
type: pending
title: Follow-ups
description: Things to do.
generated:
  by: human:ana
  at: 2026-09-22T00:00:00+00:00
---

# Follow-ups

## Open

| Logged | What | With whom / where | Deadline | Next step |
|---|---|---|---|---|
| 20/09/2026 | Send the report | Ana | 24/09/2026 | write |
| 20/09/2026 | Call the bank | bank | 25/09/2026 | call |
| 20/09/2026 | Plan Q4 | team | 31/02/2026 | draft |
| 20/09/2026 | Think it over | self | someday | - |
`;

const PROMISES = `---
type: pending
title: Promises
description: Promised.
generated:
  by: human:ana
  at: 2026-09-22T00:00:00+00:00
---

## Active

| Made on | To whom | What I promised | Condition / deadline | Status |
|---|---|---|---|---|
| 20/09/2026 | Ana | Send the deck | 2026-09-29 | open |
`;

function staleNote(staleAfter) {
  return `---\ntype: note\ntitle: Old\ndescription: An old note.\ngenerated:\n  by: human:ana\n  at: 2026-01-01T00:00:00+00:00\nstale_after: ${staleAfter}\n---\n\n# Old\n`;
}

// A committed vault (git repository), a state directory, HOME and a bin
// directory with a fake gh, all in scratch.
function makeFactsWorld({ config = {}, files = {}, gh = true } = {}) {
  const root = makeRepo({
    'brain-kit.config.json': `${JSON.stringify(baseConfig(config), null, 2)}\n`,
    'index.md': '# Index\n',
    'pending/follow-ups.md': FOLLOWUPS,
    'pending/promises.md': PROMISES,
    ...files,
  }, 'brain-kit-preflight-');
  const base = makeTempDir('brain-kit-preflight-world-');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_GIT, join(bin, 'git'));
  if (gh) {
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
  }
  const home = join(base, 'home');
  mkdirSync(home);
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const output = join(base, 'gh-output.json');
  writeFileSync(output, '[[]]\n');
  const log = join(base, 'gh-calls.jsonl');
  const env = { ...CLEAN_ENV, HOME: home, PATH: bin, BRAIN_KIT_STATE_DIR: stateDir, FAKE_GH_OUTPUT: output, FAKE_GH_LOG: log, FAKE_GH_MODE: 'ok' };
  return {
    root, stateDir, env, bin, log, output,
    config: () => JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8')),
    facts(options = {}) {
      return briefingFacts({ root, config: this.config(), machine: null, stateDir, now: options.now ?? NOW, env: { ...env, ...(options.env ?? {}) } });
    },
    // The pull requests, in the API's shape, 30 to a page as GitHub serves them.
    prs(list) {
      const raw = list.map((pr) => ({ number: pr.number, title: pr.title, html_url: pr.url, created_at: pr.createdAt, state: 'open', user: { login: 'ana' } }));
      const pages = [];
      for (let i = 0; i < raw.length; i += 30) pages.push(raw.slice(i, i + 30));
      writeFileSync(output, `${JSON.stringify(pages.length === 0 ? [[]] : pages)}\n`);
    },
    lastRun(value) {
      writeFileSync(join(stateDir, 'last-run.json'), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    },
    calls() {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

function capture() {
  let out = '';
  let err = '';
  return {
    io: { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } },
    out: () => out,
    err: () => err,
  };
}

async function preflight(world, argv, { env = {}, now = NOW, cwd } = {}) {
  const c = capture();
  const code = await runPreflight(argv, c.io, createTranslator('en'), { env: { ...world.env, ...env }, now, cwd: cwd ?? world.root });
  return { code, out: c.out(), err: c.err() };
}

// ------------------------------------------------------------ today

test('briefingFacts: today, its human form and its weekday are the vault zone\'s', () => {
  const world = makeFactsWorld();
  const facts = world.facts();
  assert.deepEqual(Object.keys(facts), FACT_KEYS);
  assert.deepEqual([facts.today, facts.todayHuman, facts.weekday, facts.tz], ['2026-09-25', '25/09/2026', 'friday', UTC3]);
  // 23:30 of Sunday 27/09 at UTC-3 is already Monday in UTC.
  const late = world.facts({ now: new Date('2026-09-28T02:30:00Z') });
  assert.deepEqual([late.today, late.todayHuman, late.weekday], ['2026-09-27', '27/09/2026', 'sunday']);
  const monday = world.facts({ now: new Date('2026-09-28T03:05:00Z') });
  assert.deepEqual([monday.today, monday.weekday], ['2026-09-28', 'monday']);
  assert.equal(facts.questions, null, 'the queue is wired in by task 3');
});

test('briefingFacts: the pending buckets are computed for the vault\'s today', () => {
  const world = makeFactsWorld();
  const facts = world.facts();
  assert.deepEqual(facts.pending.overdue.map((i) => i.what), ['Send the report']);
  assert.deepEqual(facts.pending.today.map((i) => i.what), ['Call the bank']);
  assert.deepEqual(facts.pending.upcoming.map((i) => i.what), ['Send the deck']);
  assert.deepEqual(facts.pending.undated.map((i) => i.what), ['Plan Q4', 'Think it over']);
  assert.deepEqual(facts.pending.problems.map((p) => p.code), ['invalid_date']);
  // Just after midnight of 26/09 at UTC-3, "Call the bank" is overdue.
  const next = world.facts({ now: new Date('2026-09-26T03:01:00Z') });
  assert.deepEqual(next.pending.overdue.map((i) => i.what), ['Send the report', 'Call the bank']);
});

// ------------------------------------------------------------ last run

test('briefingFacts: no last run is null, with no carried connector state', () => {
  const facts = makeFactsWorld().facts();
  assert.equal(facts.lastRun, null);
  assert.deepEqual(facts.connectorStates, {});
});

test('briefingFacts: a last run is read as the curator wrote it, with its time in the vault\'s zone', () => {
  const world = makeFactsWorld();
  world.lastRun({
    at: '2026-09-25T12:30:00.000Z', durationMs: 1000, exit: 0, reasonCode: null,
    sources: { transcripts: { kept: 2, read: 2, advanced: true }, calendar: { state: 'connected', advanced: false }, meeting_notes: { state: 'needs_auth' } },
    connectorStates: { calendar: { state: 'connected', at: '2026-09-25T12:30:00.000Z' }, meeting_notes: { state: 'needs_auth', at: '2026-09-24T12:30:00.000Z' }, broken: { state: 3 } },
  });
  const facts = world.facts();
  assert.deepEqual(facts.lastRun, {
    at: '2026-09-25T12:30:00.000Z', atHuman: '25/09/2026 09:30', exit: 0, reasonCode: null,
    sources: { transcripts: { state: null, advanced: true }, calendar: { state: 'connected', advanced: false }, meeting_notes: { state: 'needs_auth', advanced: null } },
    problem: null,
  });
  assert.deepEqual(facts.connectorStates, {
    calendar: { state: 'connected', at: '2026-09-25T12:30:00.000Z', atHuman: '25/09/2026 09:30' },
    meeting_notes: { state: 'needs_auth', at: '2026-09-24T12:30:00.000Z', atHuman: '24/09/2026 09:30' },
  }, 'an entry that is not a carried state is left out, as the curator itself reads them');
});

test('briefingFacts and the text: a last run of each exit is stated with what the exit means', async () => {
  const meanings = {
    0: 'completed', 1: 'failed', 2: 'usage error or not inside a vault', 3: 'degraded, a human step is needed',
    4: 'a required source was not read', 69: 'network or connector unavailable', 75: 'postponed, to be retried', 5: 'an exit code this version does not know',
  };
  const world = makeFactsWorld();
  for (const [exit, meaning] of Object.entries(meanings)) {
    world.lastRun({ at: '2026-09-25T12:30:00.000Z', exit: Number(exit), reasonCode: 'lock_held', sources: {} });
    assert.equal(world.facts().lastRun.exit, Number(exit));
    const { code, out } = await preflight(world, []);
    assert.equal(code, EXIT.OK);
    assert.ok(out.includes(`Last curator round: 25/09/2026 09:30, exit ${exit} (${meaning}), reason lock_held.`), out);
  }
  world.lastRun({ at: '2026-09-25T12:30:00.000Z', reasonCode: 'machine_invalid' });
  assert.equal(world.facts().lastRun.exit, null);
  assert.ok((await preflight(world, [])).out.includes('exit - (no exit recorded), reason machine_invalid.'));
});

test('briefingFacts: a last-run record that cannot be read is said, never taken for no round', async () => {
  const world = makeFactsWorld();
  world.lastRun('{ half a record');
  const facts = world.facts();
  assert.notEqual(facts.lastRun, null);
  assert.equal(facts.lastRun.exit, null);
  assert.match(facts.lastRun.problem, /JSON|Expected|Unexpected/);
  world.lastRun('[1, 2]');
  assert.match(world.facts().lastRun.problem, /not an object/);
  const { out } = await preflight(world, []);
  assert.match(out, /Last curator round: its record cannot be read \(not an object: \[1,2\]\); nothing is known about it\./);
  assert.doesNotMatch(out, /none recorded on this machine/);
});

test('the text lists each source of the last run and the carried connector states', async () => {
  const world = makeFactsWorld();
  world.lastRun({
    at: '2026-09-25T12:30:00.000Z', exit: 4, reasonCode: 'source_unread',
    sources: { transcripts: { advanced: true }, calendar: { state: 'failed', advanced: false } },
    connectorStates: { calendar: { state: 'failed', at: '2026-09-25T12:30:00.000Z' } },
  });
  const { out } = await preflight(world, []);
  assert.ok(out.includes('  transcripts: state -, mark advanced: yes'), out);
  assert.ok(out.includes('  calendar: state failed, mark advanced: no'), out);
  assert.ok(out.includes('Connector states carried by the rounds:\n  calendar: failed, as seen by the round of 25/09/2026 09:30'), out);
});

// ------------------------------------------------------------ pull requests

test('briefingFacts: open pull requests come from gh api, every page, run in the vault with the argv given', () => {
  const world = makeFactsWorld();
  world.prs([
    { number: 12, title: 'curate: 24/09', url: 'https://example.invalid/ana/brain/pull/12', createdAt: '2026-09-25T01:00:00Z' },
    { number: 9, title: 'curate: 23/09', url: 'https://example.invalid/ana/brain/pull/9', createdAt: '2026-09-23T15:00:00Z' },
  ]);
  const facts = world.facts();
  assert.deepEqual(facts.openPullRequests, {
    ok: true, reason: null, detail: null,
    items: [
      { number: 9, title: 'curate: 23/09', url: 'https://example.invalid/ana/brain/pull/9', createdHuman: '23/09/2026' },
      { number: 12, title: 'curate: 24/09', url: 'https://example.invalid/ana/brain/pull/12', createdHuman: '24/09/2026' },
    ],
  }, '01:00 UTC of 25/09 is 22:00 of 24/09 at UTC-3');
  const [call] = world.calls();
  assert.deepEqual(call.args, ['api', '--paginate', '--method', 'GET', 'repos/{owner}/{repo}/pulls?state=open', '--jq', '.[] | {number, title, url: .html_url, createdAt: .created_at} | tojson']);
  assert.equal(call.args.some((arg) => /limit|per_page|\b\d+\b/.test(arg)), false, 'no number anywhere in the call: no cap');
  assert.deepEqual([...PR_LIST_ARGS], call.args);
  assert.equal(call.cwd, world.root);
  assert.equal(call.prompt, '1', 'gh never prompts');
  assert.equal(call.gitDir, null);
});

test('briefingFacts: gh absent is ok false with reason absent and no list', () => {
  const world = makeFactsWorld({ gh: false });
  const facts = world.facts();
  assert.deepEqual(facts.openPullRequests, { ok: false, reason: 'absent', detail: null, items: null });
  assert.deepEqual(world.calls(), []);
});

test('briefingFacts: gh failing is ok false with its first line, never an empty list', () => {
  const world = makeFactsWorld();
  const facts = world.facts({ env: { FAKE_GH_MODE: 'fail' } });
  assert.deepEqual(facts.openPullRequests, { ok: false, reason: 'failed', detail: 'To get started with GitHub CLI, please run:  gh auth login', items: null });
});

test('briefingFacts: gh printing something other than the list is unreadable, never a guess', () => {
  const world = makeFactsWorld();
  const garbage = world.facts({ env: { FAKE_GH_MODE: 'garbage' } }).openPullRequests;
  assert.deepEqual([garbage.ok, garbage.reason, garbage.items], [false, 'unreadable', null]);
  const shape = world.facts({ env: { FAKE_GH_MODE: 'shape' } }).openPullRequests;
  assert.deepEqual([shape.ok, shape.reason, shape.items], [false, 'unreadable', null]);
});

test('briefingFacts: more than 30 open pull requests across two pages are all listed, with no cap', async () => {
  const world = makeFactsWorld();
  const list = Array.from({ length: 47 }, (_, i) => ({ number: 47 - i, title: `pr ${47 - i}`, url: `https://example.invalid/pull/${47 - i}`, createdAt: '2026-09-20T12:00:00Z' }));
  world.prs(list);
  assert.equal(JSON.parse(readFileSync(world.output, 'utf8')).length, 2, 'the fake serves two pages, as GitHub would');
  const prs = world.facts().openPullRequests;
  assert.deepEqual(Object.keys(prs), ['ok', 'reason', 'detail', 'items']);
  assert.equal(prs.ok, true);
  assert.deepEqual(prs.items.map((pr) => pr.number), Array.from({ length: 47 }, (_, i) => i + 1), 'every one, in number order');
  const { out } = await preflight(world, []);
  assert.ok(out.includes('Open pull requests awaiting merge (47):\n  #1 pr 1, opened 20/09/2026, https://example.invalid/pull/1\n'), out);
  assert.ok(out.includes('  #47 pr 47, opened 20/09/2026, https://example.invalid/pull/47'));
  assert.doesNotMatch(out, /at most|may be more/);
});

test('briefingFacts: a page that fails midway is a failure, never the pages before it', () => {
  const world = makeFactsWorld();
  world.prs(Array.from({ length: 47 }, (_, i) => ({ number: i + 1, title: `pr ${i + 1}`, url: `https://example.invalid/pull/${i + 1}`, createdAt: '2026-09-20T12:00:00Z' })));
  assert.deepEqual(world.facts({ env: { FAKE_GH_MODE: 'failpage2' } }).openPullRequests, { ok: false, reason: 'failed', detail: 'HTTP 502: Bad Gateway (page 2)', items: null });
});

test('the text states each pull request fact, and each way of not knowing it', async () => {
  const world = makeFactsWorld();
  assert.ok((await preflight(world, [])).out.includes('Open pull requests awaiting merge: none.'));
  world.prs([{ number: 7, title: 'curate: 24/09', url: 'https://example.invalid/pull/7', createdAt: '2026-09-24T12:00:00Z' }]);
  assert.ok((await preflight(world, [])).out.includes('Open pull requests awaiting merge (1):\n  #7 curate: 24/09, opened 24/09/2026, https://example.invalid/pull/7'));
  assert.ok((await preflight(world, [], { env: { FAKE_GH_MODE: 'fail' } })).out.includes('Open pull requests: not known, gh failed (To get started with GitHub CLI, please run:  gh auth login).'));
  assert.ok((await preflight(world, [], { env: { FAKE_GH_MODE: 'garbage' } })).out.includes('Open pull requests: not known, gh printed something other than the expected list'));
  const absent = makeFactsWorld({ gh: false });
  assert.ok((await preflight(absent, [])).out.includes('Open pull requests: not known, gh is not installed or not on PATH.'));
});

// ------------------------------------------------------------ stale notes

test('briefingFacts: the notes past their stale_after, with the day in the vault\'s zone', () => {
  const world = makeFactsWorld({ files: {
    'notes/old.md': staleNote('2026-09-01T02:00:00+00:00'),
    'notes/fresh.md': staleNote('2026-12-01T00:00:00+00:00'),
    'notes/exact.md': staleNote('2026-09-25T12:00:00+00:00'),
  } });
  const facts = world.facts();
  assert.deepEqual(facts.stale, {
    ok: true, reason: null, count: 2,
    notes: [
      { path: 'notes/exact.md', staleAfter: '2026-09-25T12:00:00+00:00', staleAfterHuman: '25/09/2026' },
      { path: 'notes/old.md', staleAfter: '2026-09-01T02:00:00+00:00', staleAfterHuman: '31/08/2026' },
    ],
  }, '02:00 UTC of 01/09 is 23:00 of 31/08 at UTC-3');
});

test('briefingFacts: a plain-date stale_after is a civil date of the vault\'s zone, shown as written; a datetime is an instant', async () => {
  const world = makeFactsWorld({ files: {
    'notes/plain.md': staleNote('2026-09-20'),
    'notes/offset.md': staleNote('2026-09-20T00:00:00-03:00'),
  } });
  // 23:59 of 19/09 at UTC-3, already 20/09 in UTC: neither has come.
  assert.deepEqual(world.facts({ now: new Date('2026-09-20T02:59:00Z') }).stale, { ok: true, reason: null, count: 0, notes: [] });
  // 00:01 of 20/09 at UTC-3: both have.
  const after = world.facts({ now: new Date('2026-09-20T03:01:00Z') }).stale;
  assert.deepEqual(after.notes, [
    { path: 'notes/offset.md', staleAfter: '2026-09-20T00:00:00-03:00', staleAfterHuman: '20/09/2026' },
    { path: 'notes/plain.md', staleAfter: '2026-09-20', staleAfterHuman: '20/09/2026' },
  ], 'the plain date is never shown as 19/09');
  // The datetime's instant decides it to the minute; the plain date, the whole day.
  const edge = world.facts({ now: new Date('2026-09-20T03:00:00Z') }).stale;
  assert.deepEqual(edge.notes.map((n) => n.path), ['notes/offset.md', 'notes/plain.md']);
  const { out } = await preflight(world, [], { now: new Date('2026-09-20T03:01:00Z') });
  assert.ok(out.includes('Notes past their stale_after (2):\n  notes/offset.md, stale since 20/09/2026\n  notes/plain.md, stale since 20/09/2026'), out);
});

test('staleVerdict: a plain date by the day, a datetime with offset by the instant, anything else not judged', () => {
  const at = { today: '2026-09-20', now: new Date('2026-09-20T03:00:00Z'), tz: UTC3 };
  assert.deepEqual(staleVerdict('2026-09-20', at), { stale: true, human: '20/09/2026' });
  assert.deepEqual(staleVerdict('2026-09-21', at), { stale: false, human: '21/09/2026' });
  assert.deepEqual(staleVerdict('2026-09-20T00:00:00-03:00', at), { stale: true, human: '20/09/2026' });
  assert.deepEqual(staleVerdict('2026-09-20T00:00:01-03:00', at), { stale: false, human: '20/09/2026' });
  assert.deepEqual(staleVerdict('2026-09-20T02:00:00Z', at), { stale: true, human: '19/09/2026' }, 'an instant is shown as the vault\'s day');
  for (const value of ['2026-09-20T10:00', '2026-02-30', 'soon', '', null, 20260920]) assert.equal(staleVerdict(value, at), null, String(value));
});

test('preflight: a machine.json that cannot be read is said on stderr, and the facts still print', async () => {
  const world = makeFactsWorld();
  writeFileSync(join(world.stateDir, 'machine.json'), '{ broken');
  const { code, out, err } = await preflight(world, []);
  assert.equal(code, EXIT.OK);
  assert.match(err, /^brain-kit preflight: this machine's machine\.json cannot be read, and nothing below comes from it: Cannot parse /);
  assert.match(out, /^Facts for the briefing/);
  const json = await preflight(world, ['--json']);
  assert.doesNotThrow(() => JSON.parse(json.out), 'stdout stays JSON');
});

test('briefingFacts: when git cannot list the vault the stale count is not known', () => {
  const world = makeFactsWorld();
  const facts = briefingFacts({ root: world.root, config: world.config(), stateDir: world.stateDir, now: NOW, env: world.env, deps: { listPublishable: () => ({ failure: { status: 128 } }) } });
  assert.deepEqual(facts.stale, { ok: false, reason: 'listing_failed', count: null, notes: null });
});

// ------------------------------------------------------------ git and lock

test('briefingFacts: git states the branch, the changed paths, and the default branch against its remote as last fetched', () => {
  const world = makeWorld({ prefix: 'brain-kit-preflight-git-' });
  const config = baseConfig();
  writeFileSync(join(world.vault, 'brain-kit.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  git(world.vault, ['add', '-A']);
  git(world.vault, ['commit', '-q', '-m', 'config']);
  // git on PATH, and no gh at all: nothing here may reach a real one.
  const bin = join(world.base, 'gitonly');
  mkdirSync(bin);
  symlinkSync(REAL_GIT, join(bin, 'git'));
  const facts = () => briefingFacts({ root: world.vault, config, stateDir: join(world.base, 'state'), now: NOW, env: { ...world.env, PATH: bin } });
  assert.deepEqual(facts().git, { branch: 'main', defaultBranch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, dirty: 0, reason: null });
  world.publish(2);
  assert.equal(facts().git.behind, 0, 'not fetched yet: the preflight never fetches');
  git(world.vault, ['fetch', '-q', 'origin']);
  assert.deepEqual([facts().git.ahead, facts().git.behind], [1, 2]);
  writeFileSync(join(world.vault, 'scratch.md'), '# scratch\n');
  assert.equal(facts().git.dirty, 1);
  git(world.vault, ['checkout', '-q', '-b', 'feature']);
  assert.deepEqual([facts().git.branch, facts().git.defaultBranch], ['feature', 'main']);
});

test('briefingFacts: git and the lock outside a repository are not known, with the reason', () => {
  const dir = makeTempDir('brain-kit-preflight-norepo-');
  writeFileSync(join(dir, 'brain-kit.config.json'), `${JSON.stringify(baseConfig(), null, 2)}\n`);
  writeFileSync(join(dir, 'index.md'), '# Index\n');
  const facts = briefingFacts({ root: dir, config: baseConfig(), stateDir: join(dir, '.state'), now: NOW, env: { ...CLEAN_ENV, PATH: '/nonexistent' } });
  assert.deepEqual(facts.git, { branch: null, defaultBranch: null, upstream: null, ahead: null, behind: null, dirty: null, reason: 'not_a_repository' });
  assert.equal(facts.lock.held, null);
  assert.equal(typeof facts.lock.reason, 'string');
  assert.equal(facts.stale.ok, true, 'outside a repository the folder is the set, as validate reads it');
});

test('briefingFacts: a repository with no remote says so', () => {
  const world = makeFactsWorld();
  const facts = world.facts();
  assert.deepEqual(facts.git, { branch: 'main', defaultBranch: 'main', upstream: null, ahead: null, behind: null, dirty: 0, reason: 'no_remote' });
  // A remote configured but never fetched.
  git(world.root, ['remote', 'add', 'origin', join(world.root, 'nowhere.git')]);
  assert.deepEqual(world.facts().git, { branch: 'main', defaultBranch: 'main', upstream: 'origin/main', ahead: null, behind: null, dirty: 0, reason: 'no_remote_ref' });
});

test('briefingFacts: the lock, free and held', () => {
  const world = makeFactsWorld();
  assert.deepEqual(world.facts().lock, { held: false, command: null, reason: null });
  const lock = acquireLock(world.root, { command: 'curate', env: world.env });
  try {
    assert.deepEqual(world.facts().lock, { held: true, command: 'curate', reason: null });
  } finally {
    lock.release();
  }
});

// ------------------------------------------------------------ the command

test('preflight: the text in English, every section present', async () => {
  const world = makeFactsWorld();
  const { code, out, err } = await preflight(world, []);
  assert.equal(code, EXIT.OK, err);
  assert.equal(err, '');
  const expected = [
    `Facts for the briefing, computed by brain-kit for ${world.root} (days in ${UTC3}):`,
    'Today: Friday, 25/09/2026.',
    'Last curator round: none recorded on this machine.',
    'Connector states carried by the rounds: none recorded.',
    'Open pull requests awaiting merge: none.',
    'Notes past their stale_after: none.',
    'Pending, overdue (1):',
    '  Send the report, deadline 24/09/2026 (pending/follow-ups.md:16)',
    'Pending, due today (1):',
    '  Call the bank, deadline 25/09/2026 (pending/follow-ups.md:17)',
    'Pending, due in the next 7 day(s) (1):',
    '  Send the deck, deadline 29/09/2026 (pending/promises.md:14)',
    'Pending, with no date (2):',
    '  Plan Q4, deadline cell "31/02/2026" (pending/follow-ups.md:18)',
    '  Think it over, deadline cell "someday" (pending/follow-ups.md:19)',
    'Pending, due more than 7 day(s) from today: 0.',
    'Problems reading the pending tables (1):',
    '  pending/follow-ups.md:18: "31/02/2026" is not a real date; the item is counted by the cell\'s first real date, or with no date.',
    'Git: on main, 0 changed path(s) in the working tree.',
    'Git: how main stands against its remote is not known (the repository has no remote to compare it with).',
    'Vault lock: free.',
  ].join('\n');
  assert.equal(out, `${expected}\n`);
});

// The English column names of this world's tables, for a pt-BR vault: the
// pack's Portuguese defaults would name columns these tables do not have.
const ENGLISH_PENDING = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'en', 'config.defaults.json'), 'utf8')).briefing.pending;

test('preflight: the text in Portuguese for a pt-BR vault, whatever the caller\'s language', async () => {
  const world = makeFactsWorld({ config: { lang: 'pt-BR', briefing: { pending: ENGLISH_PENDING } } });
  const { code, out } = await preflight(world, []);
  assert.equal(code, EXIT.OK);
  assert.ok(out.startsWith(`Fatos para o briefing, calculados pelo brain-kit para ${world.root} (dias no fuso ${UTC3}):\nHoje: sexta-feira, 25/09/2026.\n`), out);
  for (const line of [
    'Última rodada da curadoria: nenhuma registrada nesta máquina.',
    'Pull requests abertos esperando merge: nenhum.',
    'Pendências atrasadas (1):',
    '  Send the report, prazo 24/09/2026 (pending/follow-ups.md:16)',
    'Pendências que vencem hoje (1):',
    'Pendências que vencem nos próximos 7 dia(s) (1):',
    'Pendências sem data (2):',
    'Trava do vault: livre.',
  ]) assert.ok(out.includes(line), `${line}\n---\n${out}`);
  world.lastRun({ at: '2026-09-25T12:30:00.000Z', exit: 75, reasonCode: 'lock_held', sources: {} });
  assert.ok((await preflight(world, [])).out.includes('Última rodada da curadoria: 25/09/2026 09:30, saída 75 (adiada, será tentada de novo), motivo lock_held.'));
  const absent = makeFactsWorld({ gh: false, config: { lang: 'pt-BR' } });
  assert.ok((await preflight(absent, [])).out.includes('Pull requests abertos: não se sabe, o gh não está instalado ou não está no PATH.'));
});

test('preflight --json: version, then exactly the facts\' keys in their order, and the facts themselves', async () => {
  const world = makeFactsWorld();
  const { code, out } = await preflight(world, ['--json']);
  assert.equal(code, EXIT.OK);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed), ['version', ...FACT_KEYS]);
  assert.equal(parsed.version, PREFLIGHT_JSON_VERSION);
  const { version, ...facts } = parsed;
  assert.deepEqual(facts, JSON.parse(JSON.stringify(world.facts())));
  assert.deepEqual(Object.keys(parsed.pending), ['overdue', 'today', 'upcoming', 'undated', 'later', 'upcomingDays', 'problems']);
  assert.deepEqual(Object.keys(parsed.pending.overdue[0]), ['file', 'line', 'what', 'deadline', 'raw']);
  assert.deepEqual(Object.keys(parsed.openPullRequests), ['ok', 'reason', 'detail', 'items']);
  assert.deepEqual(Object.keys(parsed.stale), ['ok', 'reason', 'count', 'notes']);
  assert.deepEqual(Object.keys(parsed.git), ['branch', 'defaultBranch', 'upstream', 'ahead', 'behind', 'dirty', 'reason']);
  assert.deepEqual(Object.keys(parsed.lock), ['held', 'command', 'reason']);
  world.lastRun({ at: '2026-09-25T12:30:00.000Z', exit: 0, reasonCode: null, sources: { calendar: { state: 'connected', advanced: true } } });
  const withRun = JSON.parse((await preflight(world, ['--json'])).out);
  assert.deepEqual(Object.keys(withRun.lastRun), ['at', 'atHuman', 'exit', 'reasonCode', 'sources', 'problem']);
});

test('preflight: the dir argument, a subdirectory, and exit 2 outside a vault or with bad arguments', async () => {
  const world = makeFactsWorld();
  const outside = makeTempDir('brain-kit-preflight-outside-');
  assert.equal((await preflight(world, [world.root], { cwd: outside })).code, EXIT.OK);
  assert.equal((await preflight(world, ['pending'])).code, EXIT.OK, 'a directory inside the vault finds it');
  const none = await preflight(world, [], { cwd: outside });
  assert.equal(none.code, EXIT.USAGE);
  assert.match(none.err, /no brain-kit vault found/);
  assert.equal(none.out, '');
  const missing = await preflight(world, [join(outside, 'nope')]);
  assert.equal(missing.code, EXIT.USAGE);
  assert.match(missing.err, /does not exist/);
  const file = await preflight(world, [join(world.root, 'index.md')]);
  assert.equal(file.code, EXIT.USAGE);
  assert.match(file.err, /is not a directory/);
  const bad = await preflight(world, ['--nope']);
  assert.equal(bad.code, EXIT.USAGE);
  assert.match(bad.err, /unrecognized argument "--nope"[\s\S]*Usage: brain-kit preflight/);
  const two = await preflight(world, ['a', 'b']);
  assert.equal(two.code, EXIT.USAGE);
  const help = await preflight(world, ['--help']);
  assert.deepEqual([help.code, help.out], [EXIT.OK, 'Usage: brain-kit preflight [dir] [--json]\n']);
});

test('preflight: a time zone this system does not know is exit 2, never a guessed today', async () => {
  const world = makeFactsWorld({ config: { vault: { timezone: '<vault-timezone>' } } });
  const { code, out, err } = await preflight(world, []);
  assert.equal(code, EXIT.USAGE);
  assert.equal(out, '');
  assert.match(err, /vault\.timezone in brain-kit\.config\.json is "<vault-timezone>"/);
});

test('the CLI dispatches preflight, and the usage lists it in both languages', async () => {
  const world = makeFactsWorld();
  // A process of its own, with the world's PATH (the fake gh and git) and
  // state directory: the real gh is never reachable.
  const result = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'brain-kit.mjs'), 'preflight', world.root, '--json'], {
    encoding: 'utf8', env: { ...world.env, BRAIN_KIT_LANG: 'en' }, cwd: world.root,
  });
  assert.equal(result.status, EXIT.OK, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, PREFLIGHT_JSON_VERSION);
  assert.equal(world.calls().length, 1, 'the fake gh answered');
  const c = capture();
  assert.equal(await main(['preflight', '--help'], c.io), EXIT.OK);
  assert.equal(c.out(), 'Usage: brain-kit preflight [dir] [--json]\n'.replace('Usage', c.out().startsWith('Uso') ? 'Uso' : 'Usage'));
  for (const lang of ['en', 'pt-BR']) {
    assert.match(createTranslator(lang)('cli.usage', { version: 'x' }), /\n {2}preflight \[dir\] \[--json\] +\S/);
  }
});

test('renderPreflight: an item with no what reads as a dash, a detached HEAD is named', () => {
  const t = createTranslator('en');
  const facts = {
    today: '2026-09-25', todayHuman: '25/09/2026', weekday: 'friday', tz: 'UTC', lastRun: null, connectorStates: {},
    openPullRequests: { ok: true, reason: null, detail: null, items: [] },
    stale: { ok: false, reason: 'listing_failed', count: null, notes: null },
    pending: { overdue: [], today: [], upcoming: [], undated: [{ file: 'a.md', line: 3, what: '', deadline: null, raw: '' }], later: 2, upcomingDays: 3, problems: [] },
    git: { branch: null, defaultBranch: 'main', upstream: 'origin/main', ahead: 0, behind: 4, dirty: 2, reason: null },
    lock: { held: null, command: null, reason: 'boom' },
    questions: null,
  };
  const text = renderPreflight(facts, t, { vault: '/v' });
  for (const line of [
    'Notes past their stale_after: not known, git could not list the vault\'s files.',
    'Pending, overdue (0):\n  none',
    'Pending, with no date (1):\n  -, deadline cell "" (a.md:3)',
    'Pending, due in the next 3 day(s) (0):',
    'Pending, due more than 3 day(s) from today: 2.',
    'Git: on (detached HEAD), 2 changed path(s) in the working tree.',
    'Git: main is 4 commit(s) behind and 0 ahead of origin/main, as of the last fetch.',
    'Vault lock: not known (boom).',
  ]) assert.ok(text.includes(line), `${line}\n---\n${text}`);
});

test('the text names every weekday, and every pending problem, in both languages', async () => {
  const days = {
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    'pt-BR': ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'],
  };
  for (const lang of ['en', 'pt-BR']) {
    const world = makeFactsWorld({ config: { lang } });
    for (let i = 0; i < 7; i += 1) {
      // 12:00 UTC of Sunday 27/09/2026 plus i days: 09:00 at UTC-3.
      const now = new Date(Date.UTC(2026, 8, 27 + i, 12));
      const { out } = await preflight(world, [], { now });
      const date = `${String(27 + i > 30 ? 27 + i - 30 : 27 + i).padStart(2, '0')}/${27 + i > 30 ? '10' : '09'}/2026`;
      const label = lang === 'en' ? 'Today' : 'Hoje';
      assert.ok(out.includes(`\n${label}: ${days[lang][i]}, ${date}.\n`), `${lang} ${i}: ${out.split('\n')[1]}`);
    }
  }
  const t = { en: createTranslator('en'), 'pt-BR': createTranslator('pt-BR') };
  const problems = [
    { code: 'not_configured', detail: { file: 'followups' } },
    { code: 'heading_not_configured', detail: { file: 'followups', heading: 'x_heading' } },
    { code: 'duplicate_entry', detail: { path: 'a.md', heading: '## Open' } },
    { code: 'never_read', detail: { path: 'a.md' } },
    { code: 'file_missing', detail: { path: 'a.md' } },
    { code: 'unreadable', detail: { path: 'a.md', detail: 'EACCES' } },
    { code: 'heading_missing', detail: { path: 'a.md', heading: '## Open' } },
    { code: 'heading_repeated', detail: { path: 'a.md', heading: '## Open' } },
    { code: 'table_missing', detail: { path: 'a.md', heading: '## Open' } },
    { code: 'tables_ignored', detail: { path: 'a.md', heading: '## Open', count: 2 } },
    { code: 'column_missing', detail: { path: 'a.md', heading: '## Open', column: 'Deadline', line: 12 } },
    { code: 'invalid_date', detail: { path: 'a.md', line: 13, value: '31/02/2026' } },
    { code: 'date_without_year', detail: { path: 'a.md', line: 14, value: '05/10' } },
    { code: 'from_the_future', detail: { path: 'a.md' } },
    { code: 'ambiguous_deadline', detail: { path: 'a.md', line: 15, deadline: '2026-10-12', others: ['05/10', '31/02/2026'] } },
  ];
  for (const lang of ['en', 'pt-BR']) {
    const facts = makeFactsWorld().facts();
    facts.pending.problems = problems;
    const lines = renderPreflight(facts, t[lang], { vault: '/v' }).split('\n');
    const at = lines.findIndex((line) => /\((15)\):$/.test(line));
    assert.notEqual(at, -1, lang);
    const rendered = lines.slice(at + 1, at + 1 + problems.length);
    assert.equal(new Set(rendered).size, problems.length, `${lang}: each problem has its own sentence`);
    for (const line of rendered) assert.doesNotMatch(line, /\{\w+\}/, `${lang}: ${line}`);
    assert.ok(rendered[9].includes('2'), rendered[9]);
    assert.ok(rendered[10].includes('a.md:12') && rendered[10].includes('Deadline'), rendered[10]);
    assert.ok(rendered[11].includes('a.md:13') && rendered[11].includes('31/02/2026'), rendered[11]);
    assert.ok(rendered[12].includes('a.md:14') && rendered[12].includes('05/10'), rendered[12]);
    assert.ok(rendered[13].includes('from_the_future') && rendered[13].includes('a.md'), 'an unknown code is named, never taken for another');
    assert.ok(rendered[14].includes('a.md:15') && rendered[14].includes('12/10/2026') && rendered[14].includes('"05/10", "31/02/2026"'), rendered[14]);
  }
});

test('humanInstant: DD/MM/YYYY HH:MM in the zone given, null for what is not an instant', () => {
  assert.equal(humanInstant('2026-09-25T02:59:00Z', UTC3), '24/09/2026 23:59');
  assert.equal(humanInstant('2026-09-25T03:00:00Z', UTC3), '25/09/2026 00:00');
  assert.equal(humanInstant('yesterday', UTC3), null);
  assert.equal(humanInstant(null, UTC3), null);
});
