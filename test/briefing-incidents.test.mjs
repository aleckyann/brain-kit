// The briefing shows what went wrong and what mended itself (spec R7, docs/
// superpowers/specs/2026-10-09-round-repairs-and-incidents-design.md): the
// open incidents of incidents.jsonl grouped by reason code, the repairs of
// the last 24 hours, a network check that did not wait, and each source more
// than one day behind. The facts come from a seeded state directory (no
// curate run), and the lines are the ones `renderLastRun` gives the
// briefing's `sources` block and `brain-kit preflight` alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { STATE_FILES } from '../src/state.mjs';
import { briefingFacts, withoutPaths } from '../src/briefing/facts.mjs';
import { briefingBlocks, renderBlocks } from '../src/briefing/blocks.mjs';
import { renderLastRun, runPreflight } from '../src/commands/preflight.mjs';
import { CLEAN_ENV, makeRepo } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const UTC3 = 'America/Argentina/Buenos_Aires';
// 09:00 of Friday 09/10/2026 at UTC-3: yesterday is 2026-10-08.
const NOW = new Date('2026-10-09T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function world() {
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  config.vault.timezone = UTC3;
  const root = makeRepo({ 'brain-kit.config.json': `${JSON.stringify(config, null, 2)}\n`, 'index.md': '# Index\n' }, 'brain-kit-briefing-incidents-');
  const stateDir = join(makeTempDir('brain-kit-briefing-incidents-state-'), 'state');
  mkdirSync(stateDir);
  const env = { ...CLEAN_ENV, HOME: makeTempDir('brain-kit-briefing-incidents-home-'), BRAIN_KIT_STATE_DIR: stateDir };
  const w = {
    root, stateDir, env, config,
    facts: () => briefingFacts({ root, config, machine: null, stateDir, now: NOW, env, deps: { findExecutable: () => null } }),
    lastRun: (value) => writeFileSync(join(stateDir, STATE_FILES.LAST_RUN), `${JSON.stringify(value)}\n`),
    incidents: (lines) => writeFileSync(join(stateDir, STATE_FILES.INCIDENTS), lines.map((line) => `${JSON.stringify(line)}\n`).join('')),
    mark: (sources) => writeFileSync(join(stateDir, STATE_FILES.WATERMARK), `${JSON.stringify({ sources })}\n`),
    lines: (lang = 'en') => renderLastRun(w.facts(), createTranslator(lang)),
  };
  return w;
}

const iso = (ms) => new Date(ms).toISOString();
const incident = (at, fields = {}) => ({ at, exit: EXIT.UNAVAILABLE, reasonCode: 'sync_offline', known: true, reason: 'No network.', repairs: [], closes: false, ...fields });
const RUN = { at: '2026-10-08T12:30:00.000Z', exit: 69, reasonCode: 'sync_offline', sources: { transcripts: { advanced: true }, calendar: { state: 'failed', advanced: false } }, connectorStates: { calendar: { state: 'failed', at: '2026-10-08T12:30:00.000Z' } } };

// ------------------------------------------------------------ nothing to add

test('nothing open, repaired, warned or behind: the lines are exactly the ones a round without this feature gave', () => {
  const w = world();
  assert.deepEqual(w.lines(), ['Last curator round: none recorded on this machine.', 'Connector states carried by the rounds: none recorded.']);
  assert.deepEqual(w.lines('pt-BR'), ['Última rodada da curadoria: nenhuma registrada nesta máquina.', 'Estados dos conectores guardados pelas rodadas: nenhum registrado.']);
  w.lastRun(RUN);
  // A closed history, a repair a day and a half old and a mark one day behind are not news.
  w.incidents([
    incident(iso(NOW.getTime() - 50 * HOUR)),
    incident(iso(NOW.getTime() - 40 * HOUR), { exit: 0, reasonCode: 'proposed', closes: true, repairs: [{ kind: 'cli_reinstalled', version: '2.1.300' }] }),
  ]);
  w.mark({ transcripts: '2026-10-07' });
  assert.deepEqual(w.lines(), [
    'Last curator round: 08/10/2026 09:30, exit 69 (network or connector unavailable), reason sync_offline.',
    '  transcripts: state -, mark advanced: yes',
    '  calendar: state failed, mark advanced: no',
    'Connector states carried by the rounds:',
    '  calendar: failed, as seen by the round of 08/10/2026 09:30',
  ]);
  assert.deepEqual(w.lines('pt-BR'), [
    'Última rodada da curadoria: 08/10/2026 09:30, saída 69 (rede ou conector indisponível), motivo sync_offline.',
    '  transcripts: estado -, marca avançou: sim',
    '  calendar: estado failed, marca avançou: não',
    'Estados dos conectores guardados pelas rodadas:',
    '  calendar: failed, como visto pela rodada de 08/10/2026 09:30',
  ]);
  const facts = w.facts();
  assert.deepEqual(facts.incidents, { open: [], repairs: [], corrupt: 0, problem: null });
  assert.deepEqual(facts.marks, { sources: { transcripts: { day: '2026-10-07', behind: 1 } }, problem: null });
});

// ------------------------------------------------------------ open incidents

test('open incidents are the non-zero lines after the newest closing one, grouped by reason code', () => {
  const w = world();
  w.incidents([
    incident('2026-10-05T12:00:00.000Z', { reasonCode: 'cli_missing' }),
    incident('2026-10-06T12:00:00.000Z', { exit: 0, reasonCode: 'proposed', closes: true }),
    incident('2026-10-07T12:00:00.000Z', { exit: EXIT.TEMPFAIL, reasonCode: 'dirty_tree', reason: 'The working tree is not clean.' }),
    incident('2026-10-08T12:00:00.000Z', { reasonCode: 'sync_offline', known: false, reason: 'Name resolution failed.' }),
    incident('2026-10-09T10:00:00.000Z', { exit: EXIT.TEMPFAIL, reasonCode: 'dirty_tree', reason: 'Three files are changed.\nnotes/a.md, notes/b.md, notes/c.md' }),
  ]);
  const { open, repairs, corrupt, problem } = w.facts().incidents;
  assert.deepEqual(open.map((g) => g.reasonCode), ['dirty_tree', 'sync_offline'], 'cli_missing was closed by the round of 06/10');
  assert.deepEqual(open[0], { reasonCode: 'dirty_tree', count: 2, firstHuman: '07/10 09:00', lastHuman: '09/10 07:00', known: true, reason: 'Three files are changed.' });
  assert.deepEqual(open[1], { reasonCode: 'sync_offline', count: 1, firstHuman: '08/10 09:00', lastHuman: '08/10 09:00', known: false, reason: 'Name resolution failed.' });
  assert.deepEqual([repairs, corrupt, problem], [[], 0, null]);
});

test('the newest reason of a group is cut to one line of 200 characters', () => {
  const w = world();
  w.incidents([incident('2026-10-08T12:00:00.000Z', { reason: `${'x'.repeat(300)}\nsecond line` })]);
  assert.equal(w.facts().incidents.open[0].reason, 'x'.repeat(200));
});

test('an open incident is a line of the text with its code, count, times, knowledge and newest reason', () => {
  const w = world();
  w.incidents([
    incident('2026-10-07T12:00:00.000Z', { exit: EXIT.TEMPFAIL, reasonCode: 'dirty_tree', reason: 'Old reason.' }),
    incident('2026-10-09T10:00:00.000Z', { exit: EXIT.TEMPFAIL, reasonCode: 'dirty_tree', reason: 'Three files are changed.' }),
    incident('2026-10-08T12:00:00.000Z', { reasonCode: 'sync_offline', known: false, reason: 'Name resolution failed.' }),
  ]);
  assert.deepEqual(w.lines().slice(-2), [
    'Open incident: dirty_tree, 2 time(s) from 07/10 09:00 to 09/10 07:00 (known cause). Latest reason: Three files are changed.',
    'Open incident: sync_offline, 1 time(s) from 08/10 09:00 to 08/10 09:00 (unknown cause). Latest reason: Name resolution failed.',
  ]);
  assert.deepEqual(w.lines('pt-BR').slice(-2), [
    'Incidente aberto: dirty_tree, 2 vez(es) de 07/10 09:00 a 09/10 07:00 (causa conhecida). Último motivo: Three files are changed.',
    'Incidente aberto: sync_offline, 1 vez(es) de 08/10 09:00 a 08/10 09:00 (causa desconhecida). Último motivo: Name resolution failed.',
  ]);
});

// ------------------------------------------------------------ repairs

test('the repairs of the last 24 hours are listed, in the vault zone, and an older one is not', () => {
  const w = world();
  w.incidents([
    incident(iso(NOW.getTime() - 30 * HOUR), { exit: 0, reasonCode: 'nothing_to_curate', repairs: [{ kind: 'cli_reinstalled', version: '2.1.280' }] }),
    incident(iso(NOW.getTime() - 3 * HOUR), { exit: 0, reasonCode: 'nothing_to_curate', repairs: [{ kind: 'index_lock_moved', to: '/x/.git/index.lock.stale-20261009T060000', ageMinutes: 20 }, { kind: 'cli_reinstalled', version: '2.1.301' }] }),
  ]);
  const { open, repairs } = w.facts().incidents;
  assert.deepEqual(open, [], 'an exit-0 repair is a record, not an open incident');
  assert.deepEqual(repairs, [
    { atHuman: '09/10 06:00', kind: 'index_lock_moved', detail: 'index.lock.stale-20261009T060000' },
    { atHuman: '09/10 06:00', kind: 'cli_reinstalled', detail: '2.1.301' },
  ]);
  assert.deepEqual(w.lines().slice(-2), [
    'Repaired on its own at 09/10 06:00: index_lock_moved index.lock.stale-20261009T060000',
    'Repaired on its own at 09/10 06:00: cli_reinstalled 2.1.301',
  ]);
  assert.equal(w.lines('pt-BR').at(-1), 'Corrigido sozinho em 09/10 06:00: cli_reinstalled 2.1.301');
});

test('a repair in a round that went wrong is listed too, and its time is the vault zone\'s, not UTC', () => {
  const w = world();
  // 01:30 UTC on 09/10 is 22:30 of 08/10 at UTC-3.
  w.incidents([incident('2026-10-09T01:30:00.000Z', { reasonCode: 'sync_offline', repairs: [{ kind: 'index_lock_moved', to: '/x/.git/index.lock.stale-1', ageMinutes: 9 }] })]);
  const { open, repairs } = w.facts().incidents;
  assert.equal(open[0].firstHuman, '08/10 22:30');
  assert.deepEqual(repairs, [{ atHuman: '08/10 22:30', kind: 'index_lock_moved', detail: 'index.lock.stale-1' }]);
});

// ------------------------------------------------------------ the network check

test('a network check that did not wait is a line, with what it answered in', () => {
  const w = world();
  w.lastRun({ ...RUN, network: { ok: true, waitedMs: 16, attempts: 1, warning: 'did_not_wait' } });
  const facts = w.facts();
  assert.deepEqual([facts.lastRun.networkWarning, facts.lastRun.networkWaitedMs], ['did_not_wait', 16]);
  assert.equal(w.lines().at(-1), 'The network check answered in 16 ms on its first try: it may not wait for a connection. Check network_check in machine.json.');
  assert.equal(w.lines('pt-BR').at(-1), 'A checagem de rede respondeu em 16 ms na primeira tentativa: talvez não espere a conexão. Confira network_check no machine.json.');
});

test('a network check that waited, or a record without one, says nothing and carries null', () => {
  const w = world();
  w.lastRun({ ...RUN, network: { ok: true, waitedMs: 4000, attempts: 3, warning: null } });
  const waited = w.facts();
  assert.deepEqual([waited.lastRun.networkWarning, waited.lastRun.networkWaitedMs], [null, 4000]);
  assert.ok(!w.lines().some((line) => line.includes('network check')));
  w.lastRun(RUN);
  const absent = w.facts();
  assert.deepEqual([absent.lastRun.networkWarning, absent.lastRun.networkWaitedMs], [null, null]);
  w.lastRun({ ...RUN, network: 'down' });
  const odd = w.facts();
  assert.deepEqual([odd.lastRun.networkWarning, odd.lastRun.networkWaitedMs], [null, null]);
});

// ------------------------------------------------------------ days behind

test('a source more than one day behind yesterday is a line with its days; one day behind is nothing', () => {
  const w = world();
  w.mark({ transcripts: '2026-10-05', calendar: '2026-10-07', meeting_notes: '2026-10-08', slides: '2026-10-06' });
  assert.deepEqual(w.facts().marks, {
    sources: {
      transcripts: { day: '2026-10-05', behind: 3 },
      calendar: { day: '2026-10-07', behind: 1 },
      meeting_notes: { day: '2026-10-08', behind: 0 },
      slides: { day: '2026-10-06', behind: 2 },
    },
    problem: null,
  });
  assert.deepEqual(w.lines().slice(2), [
    'Source transcripts: 3 days not curated; the next round reads them.',
    'Source slides: 2 days not curated; the next round reads them.',
  ]);
  assert.equal(w.lines('pt-BR').at(-2), 'Fonte transcripts: 3 dias sem curadoria; a próxima rodada lê esses dias.');
});

test('a source marked after yesterday is not behind', () => {
  const w = world();
  w.mark({ transcripts: '2026-10-09' });
  assert.deepEqual(w.facts().marks.sources.transcripts, { day: '2026-10-09', behind: -1 });
  assert.equal(w.lines().length, 2);
});

// ------------------------------------------------------------ files that cannot be read

test('a directory where incidents.jsonl should be is one unreadable line, never a throw', () => {
  const w = world();
  mkdirSync(join(w.stateDir, STATE_FILES.INCIDENTS));
  assert.deepEqual(w.facts().incidents, { open: [], repairs: [], corrupt: 0, problem: 'EISDIR' });
  assert.deepEqual(w.lines().slice(2), ['Could not read incidents.jsonl: EISDIR']);
  assert.deepEqual(w.lines('pt-BR').slice(2), ['Não foi possível ler incidents.jsonl: EISDIR']);
});

test('a watermark.json that is not JSON is one unreadable line, never a throw', () => {
  const w = world();
  writeFileSync(join(w.stateDir, STATE_FILES.WATERMARK), '{ half a mark');
  const facts = w.facts();
  assert.deepEqual(facts.marks.sources, {});
  assert.match(facts.marks.problem, /JSON|Expected|Unexpected/);
  const lines = w.lines().slice(2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Could not read watermark\.json: .*(JSON|Expected|Unexpected)/);
});

test('a line that is not a record is counted, said in a line after the open incidents, and the rest is read', () => {
  const w = world();
  const good = JSON.stringify(incident('2026-10-08T12:00:00.000Z', { reasonCode: 'dirty_tree', exit: EXIT.TEMPFAIL, reason: 'Three files are changed.' }));
  writeFileSync(join(w.stateDir, STATE_FILES.INCIDENTS), `${good}\n`);
  const clean = w.facts().incidents;
  assert.equal(clean.corrupt, 0);
  assert.ok(!w.lines().some((line) => line.includes('could not be read')), 'a clean file says nothing about corrupt lines');
  writeFileSync(join(w.stateDir, STATE_FILES.INCIDENTS), `not json\n${good}\n{"half\n`);
  const { open, corrupt } = w.facts().incidents;
  assert.equal(corrupt, 2);
  assert.deepEqual(open.map((g) => g.reasonCode), ['dirty_tree']);
  assert.deepEqual(w.lines().slice(2), [
    'Open incident: dirty_tree, 1 time(s) from 08/10 09:00 to 08/10 09:00 (known cause). Latest reason: Three files are changed.',
    '2 line(s) of incidents.jsonl could not be read and may hide an open incident.',
  ]);
  assert.equal(w.lines('pt-BR').at(-1), '2 linha(s) de incidents.jsonl não puderam ser lidas e podem esconder um incidente aberto.');
});

// ------------------------------------------------------------ no absolute path reaches the text

test('withoutPaths: an absolute path token becomes its last segment', () => {
  assert.equal(withoutPaths('/home/ana/x/node_modules/pkg/bin/claude.exe is 500 bytes'), 'claude.exe is 500 bytes');
  assert.equal(withoutPaths("open '/home/ana/.local/state/brain-kit/v/watermark.json'"), "open 'watermark.json'");
  assert.equal(withoutPaths('C:\\Users\\ana\\x\\claude.exe is 500 bytes'), 'claude.exe is 500 bytes');
  assert.equal(withoutPaths('moved to ~/.cache/brain-kit/lock (stale)'), 'moved to lock (stale)');
  assert.equal(withoutPaths('read (/var/state/brain-kit/last-run.json) and "/var/state/brain-kit/incidents.jsonl"'), 'read (last-run.json) and "incidents.jsonl"');
  assert.equal(withoutPaths('/a/b and /c/d/e'), 'b and e', 'every token of the text, not the first only');
});

test('withoutPaths: a URL, a relative path, a one-separator path and plain words are untouched', () => {
  for (const text of ['see https://example.com/a/b', 'see docs/guide.md', 'and/or the 09/10/2026 round', 'at /tmp now', 'at ~/x now', 'C:\\x now', 'no path here', '']) {
    assert.equal(withoutPaths(text), text);
  }
});

test('an open incident whose reason starts with a path shows the file name, not the path, and keeps its 200 characters for the words', () => {
  const w = world();
  w.incidents([
    incident('2026-10-08T12:00:00.000Z', { reasonCode: 'cli_stub', exit: EXIT.FAILURE, reason: `/home/ana/x/node_modules/pkg/bin/claude.exe is 500 bytes, ${'y'.repeat(300)}` }),
  ]);
  const group = w.facts().incidents.open[0];
  assert.equal(group.reason.length, 200);
  assert.ok(group.reason.startsWith('claude.exe is 500 bytes, yyy'), group.reason);
  const line = w.lines().at(-1);
  assert.match(line, /^Open incident: cli_stub, 1 time\(s\) .* Latest reason: claude\.exe is 500 bytes/);
  assert.ok(!line.includes('/home/'), line);
});

test('a file that cannot be opened is named by its file name, never its path, in the unreadable line', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, () => {
  const w = world();
  const file = join(w.stateDir, STATE_FILES.WATERMARK);
  writeFileSync(file, '{"sources":{}}\n');
  chmodSync(file, 0o000);
  const { problem } = w.facts().marks;
  assert.equal(problem, "EACCES: permission denied, open 'watermark.json'");
  const line = w.lines().at(-1);
  assert.equal(line, "Could not read watermark.json: EACCES: permission denied, open 'watermark.json'");
  assert.ok(!line.includes(w.stateDir), line);
});

// ------------------------------------------------------------ the two places the lines appear

test('the briefing\'s sources block carries the same lines', () => {
  const w = world();
  w.lastRun({ ...RUN, network: { ok: true, waitedMs: 16, attempts: 1, warning: 'did_not_wait' } });
  w.incidents([incident('2026-10-08T12:00:00.000Z', { reasonCode: 'dirty_tree', exit: EXIT.TEMPFAIL, reason: 'Three files are changed.' })]);
  w.mark({ transcripts: '2026-10-05' });
  const config = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'en', 'config.defaults.json'), 'utf8'));
  config.lang = 'en';
  config.vault.timezone = UTC3;
  config.briefing.blocks = ['sources'];
  const { blocks, problems } = briefingBlocks(config, w.root);
  const text = renderBlocks({ blocks, problems, facts: w.facts(), config, root: w.root, t: createTranslator('en'), kit: '"/opt/brain-kit/bin/brain-kit.mjs"', log: config.taxonomy.log, selection: null, mark: null });
  assert.match(text, /Open incident: dirty_tree, 1 time\(s\) from 08\/10 09:00 to 08\/10 09:00 \(known cause\)\. Latest reason: Three files are changed\./);
  assert.match(text, /The network check answered in 16 ms on its first try/);
  assert.match(text, /Source transcripts: 3 days not curated; the next round reads them\./);
});

test('brain-kit preflight prints them, and its JSON carries incidents and marks', async () => {
  const w = world();
  w.incidents([incident('2026-10-08T12:00:00.000Z', { reasonCode: 'dirty_tree', exit: EXIT.TEMPFAIL, reason: 'Three files are changed.' })]);
  w.mark({ transcripts: '2026-10-05' });
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  const deps = { env: w.env, now: NOW, cwd: w.root, facts: { findExecutable: () => null } };
  assert.equal(await runPreflight(['--json'], io, createTranslator('en'), deps), EXIT.OK);
  const parsed = JSON.parse(out);
  assert.equal(parsed.incidents.open[0].reasonCode, 'dirty_tree');
  assert.equal(parsed.marks.sources.transcripts.behind, 3);
  out = '';
  assert.equal(await runPreflight([], io, createTranslator('en'), deps), EXIT.OK);
  assert.match(out, /Open incident: dirty_tree, 1 time\(s\)/);
  assert.match(out, /Source transcripts: 3 days not curated/);
});
