// The vault's own Claude Code project, written once for every machine.
//
// Version 0.0.8 made `init` list the vault's own project by the name Claude
// Code gives it, which is the vault's absolute path with every character that
// is not a letter or a digit turned into a dash. That name goes into
// brain-kit.config.json, which is versioned and travels to every machine that
// clones the vault, and it depends on the path of the clone: on a second
// machine whose clone lives elsewhere the listed project does not exist, and
// the doctor failed (the second stranger's F1/D2, 01/10/2026). `{vault}` is
// the one entry of include_projects that means "the project Claude Code names
// for THIS vault's folder ON THIS MACHINE"; resolveIncludeProjects is the one
// place that turns it into a name. This file is that function, the plan the
// transcripts source makes from it, and what the configuration accepts. The
// doctor, the round and `init` have their own files beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { createTranslator } from '../src/lang.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import * as source from '../src/sources/transcripts-claude-code.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import {
  FROM, INSIDE, NOW, OTHER_PROJECT, PROJECT, TIMEZONE, TO, assistant, makeWorld, paths, user,
} from './helpers/transcripts-world.mjs';

const base = realpathSync(makeTempDir('bk-vproj-'));
let counter = 0;

// A folder that exists, standing for a clone of the vault at a path of the
// test's choosing; its real path.
function folder(...parts) {
  counter += 1;
  const dir = join(base, `machine-${counter}`, ...parts);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

const nameOf = (path) => source.claudeProjectName(path);

// --- the entry, and the one function that resolves it --------------------------

test('the entry for the vault\'s own project is the string {vault}, which no Claude Code project directory is called', () => {
  assert.equal(source.VAULT_PROJECT, '{vault}');
  // A project directory is made of letters, digits and dashes, whatever the path (claudeProjectName),
  // so no folder of the transcripts directory can ever be taken for the entry.
  for (const path of ['/home/ana/{vault}', '/Users/ana/My Notes/{vault}/x', '/{vault}']) assert.match(nameOf(path), /^[A-Za-z0-9-]+$/);
  assert.doesNotMatch(source.VAULT_PROJECT, /^[A-Za-z0-9-]+$/);
});

test('resolveIncludeProjects turns {vault} into the project Claude Code names for the vault\'s folder on THIS machine, whatever the path of the clone', () => {
  const here = folder('home', 'ana', 'my-brain');
  const there = folder('Users', 'ana', 'my-brain');
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], here), [nameOf(here)]);
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], there), [nameOf(there)]);
  assert.notEqual(nameOf(here), nameOf(there), 'two clones of one vault are two projects');
  assert.match(source.resolveIncludeProjects(['{vault}'], there)[0], /-machine-\d+-Users-ana-my-brain$/);
  assert.match(source.resolveIncludeProjects(['{vault}'], here)[0], /-machine-\d+-home-ana-my-brain$/);
});

test('it resolves against the folder it is given, not the one the process runs in', () => {
  const vault = folder('home', 'ana', 'brain');
  const resolved = source.resolveIncludeProjects(['{vault}'], vault)[0];
  assert.notEqual(resolved, nameOf(realpathSync(process.cwd())), 'the test runs somewhere else than the vault');
  assert.equal(resolved, nameOf(vault));
});

test('the vault is followed through a link, a trailing slash and a dot-dot to its real path, the folder Claude Code names', () => {
  const real = folder('data', 'vaults', 'brain');
  const link = join(base, `link-${counter}`);
  symlinkSync(real, link);
  const expected = [nameOf(real)];
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], link), expected);
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], `${real}/`), expected);
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], `${link}/`), expected);
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], join(real, '..', 'brain')), expected);
  assert.notEqual(expected[0], nameOf(link), 'the name of the link is not the project');
});

test('every other entry stays as written, in order, and a name listed twice is listed once', () => {
  const vault = folder('home', 'ana', 'brain');
  const own = nameOf(vault);
  const list = Object.freeze(['-home-ana-code', '{vault}', '', '-home-ana-code', own, '{vault}', '-b']);
  assert.deepEqual(source.resolveIncludeProjects(list, vault), ['-home-ana-code', own, '', '-b']);
  assert.deepEqual([...list], ['-home-ana-code', '{vault}', '', '-home-ana-code', own, '{vault}', '-b'], 'the list is not changed');
});

test('any other string between braces is a project name like any other: no second token exists', () => {
  const vault = folder('home', 'ana', 'brain');
  const list = ['{other}', '{VAULT}', ' {vault}', '{vault} ', '{}', '{vault', 'vault'];
  assert.deepEqual(source.resolveIncludeProjects(list, vault), list);
});

test('a vault whose project cannot be named drops the entry and never guesses another project', () => {
  const long = folder('v'.repeat(210));
  assert.equal(nameOf(long), null, 'the premise: a path whose name Claude Code shortens');
  assert.deepEqual(source.resolveIncludeProjects(['{vault}', '-home-ana-code'], long), ['-home-ana-code']);
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], long), []);
  for (const root of [undefined, null, '', join(base, 'nowhere'), 'no/such/relative/folder', 42]) {
    assert.deepEqual(source.resolveIncludeProjects(['{vault}'], root), [], String(root));
  }
});

test('what is not a list resolves to no project: "all" is the caller\'s to handle, and a bare {vault} string is not a list', () => {
  const vault = folder('home', 'ana', 'brain');
  for (const value of ['all', '{vault}', undefined, null, 7, {}]) assert.deepEqual(source.resolveIncludeProjects(value, vault), [], String(value));
});

test('vaultProjectName is the project of the vault\'s real path, or null; the project that may be waiting for its first session is that same name, so the two cannot disagree', () => {
  const real = folder('data', 'brain');
  const link = join(base, `link-${counter}`);
  symlinkSync(real, link);
  assert.equal(source.vaultProjectName(link), nameOf(real));
  assert.equal(source.vaultProjectName(join(base, 'nowhere')), null);
  assert.equal(source.vaultProjectName(undefined), null);
  assert.equal(source.vaultProjectName(folder('v'.repeat(210))), null);
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], link), [source.waitingProjectName({ vaultRoot: link, machine: {}, env: {} })]);
  // Where Claude Code keeps its projects elsewhere nothing is waiting, but the entry still means the vault's project.
  assert.equal(source.waitingProjectName({ vaultRoot: link, machine: {}, env: { CLAUDE_CONFIG_DIR: '/elsewhere' } }), null);
  assert.deepEqual(source.resolveIncludeProjects(['{vault}'], link), [nameOf(real)]);
});

// --- the plan the transcripts source makes -----------------------------------

function planOf(world, { vault, waiting = null, machine = world.machine, home } = {}) {
  return source.transcriptsSource.collect({
    window: { from: FROM, to: TO, timezone: TIMEZONE }, config: world.config, machine, now: NOW, digestDir: world.digestDir, vaultRoot: vault, waiting, ...(home === undefined ? {} : { home }),
  });
}

const en = createTranslator('en');

test('the plan reads the sessions of the project {vault} stands for, and of no other', () => {
  const world = makeWorld({ include: ['{vault}'] });
  const vault = folder('home', 'ana', 'brain');
  const own = nameOf(vault);
  const mine = world.write(own, 'a.jsonl', [user('Ana decides to cite the survey', INSIDE), assistant('Noted.', INSIDE)]);
  world.write(OTHER_PROJECT, 'b.jsonl', [user('Ana writes code', INSIDE)]);
  world.write(PROJECT, 'c.jsonl', [user('Ana writes more code', INSIDE)]);
  const plan = planOf(world, { vault, waiting: own });
  assert.deepEqual(paths(plan), [mine]);
  assert.equal(plan.files[0].project, own);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.waiting, []);
  assert.equal(plan.misconfigured, false);
});

test('two clones at different paths, one configuration (the entry only): each plan reads its own path\'s project, neither is misconfigured, and a folder made for B alone leaves A with no sessions yet', () => {
  const world = makeWorld({ include: ['{vault}'] });
  const a = folder('home', 'ana', 'my-brain');
  const b = folder('Users', 'ana', 'my-brain');
  const [ownA, ownB] = [nameOf(a), nameOf(b)];
  const fileB = world.write(ownB, 's.jsonl', [user('Ana decides in B', INSIDE)]);

  const planA = planOf(world, { vault: a, waiting: ownA });
  assert.deepEqual(planA.files, []);
  assert.deepEqual(planA.waiting, [ownA]);
  assert.deepEqual(planA.problems, []);
  assert.equal(planA.misconfigured, false);
  assert.ok(planA.promptBlock.includes(en('sources.transcripts.no_sessions_yet', { project: ownA, root: world.root })), planA.promptBlock);

  const planB = planOf(world, { vault: b, waiting: ownB });
  assert.deepEqual(paths(planB), [fileB]);
  assert.deepEqual(planB.waiting, []);
  assert.equal(planB.misconfigured, false);

  // Then A gets a session of its own: it reads that one, and never B's.
  const fileA = world.write(ownA, 's.jsonl', [user('Ana decides in A', INSIDE)]);
  assert.deepEqual(paths(planOf(world, { vault: a, waiting: ownA })), [fileA]);
  assert.deepEqual(paths(planOf(world, { vault: b, waiting: ownB })), [fileB]);
});

test('{vault} beside a name: both are read; the vault\'s own project with no sessions yet waits beside the name that has some, and a name that is not there is warned about as ever', () => {
  const world = makeWorld({ include: ['{vault}', OTHER_PROJECT] });
  const vault = folder('home', 'ana', 'brain');
  const own = nameOf(vault);
  const other = world.write(OTHER_PROJECT, 'b.jsonl', [user('Ana writes code', INSIDE)]);
  let plan = planOf(world, { vault, waiting: own });
  assert.deepEqual(paths(plan), [other]);
  assert.deepEqual(plan.waiting, [own]);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.misconfigured, false);
  const mine = world.write(own, 'a.jsonl', [user('Ana decides', INSIDE)]);
  plan = planOf(world, { vault, waiting: own });
  assert.deepEqual(paths(plan).sort(), [mine, other].sort());
  assert.deepEqual(plan.waiting, []);

  const lost = makeWorld({ include: ['{vault}', '-home-ana-gone'] });
  const kept = lost.write(own, 'a.jsonl', [user('Ana decides', INSIDE)]);
  plan = planOf(lost, { vault, waiting: own });
  assert.deepEqual(paths(plan), [kept]);
  assert.deepEqual(plan.problems, [{ code: 'project_missing', detail: '-home-ana-gone' }]);
  assert.equal(plan.misconfigured, false);
});

test('the guards of a new vault hold for the entry as they did for its name: a named projects folder that is not there, a moved one, a broken link and a file all refuse', () => {
  const vault = folder('home', 'ana', 'brain');
  const own = nameOf(vault);
  const defaultRoot = (world) => join(world.tmp, '.claude', 'projects');
  const unnamedMachine = {};

  // The positive case: the default folder was never made, and the vault's own project is all that is listed.
  let world = makeWorld({ include: ['{vault}'], missingRoot: true });
  let plan = planOf(world, { vault, waiting: own, machine: unnamedMachine, home: world.tmp });
  assert.deepEqual(plan.waiting, [own]);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.misconfigured, false);

  // A folder named on purpose that is not there.
  world = makeWorld({ include: ['{vault}'], missingRoot: true });
  plan = planOf(world, { vault, waiting: own });
  assert.deepEqual(plan.problems, [{ code: 'root_missing', detail: world.root }]);
  assert.equal(plan.misconfigured, true);
  assert.deepEqual(plan.waiting, []);

  // Claude Code keeps its projects somewhere this kit was not told about (CLAUDE_CONFIG_DIR): nothing waits.
  world = makeWorld({ include: ['{vault}'], missingRoot: true });
  plan = planOf(world, { vault, waiting: null, machine: unnamedMachine, home: world.tmp });
  assert.deepEqual(plan.problems, [{ code: 'root_missing', detail: defaultRoot(world) }]);
  assert.equal(plan.misconfigured, true);

  // A broken link where the default folder should be, and a file.
  world = makeWorld({ include: ['{vault}'], missingRoot: true });
  mkdirSync(join(world.tmp, '.claude'));
  symlinkSync(join(world.tmp, 'unmounted', 'volume'), defaultRoot(world));
  plan = planOf(world, { vault, waiting: own, machine: unnamedMachine, home: world.tmp });
  assert.deepEqual(plan.problems, [{ code: 'root_missing', detail: defaultRoot(world) }]);
  assert.equal(plan.misconfigured, true);
  world = makeWorld({ include: ['{vault}'], missingRoot: true });
  mkdirSync(join(world.tmp, '.claude'));
  writeFileSync(defaultRoot(world), 'not a folder');
  plan = planOf(world, { vault, waiting: own, machine: unnamedMachine, home: world.tmp });
  assert.deepEqual(plan.problems, [{ code: 'root_missing', detail: defaultRoot(world) }]);
  assert.equal(plan.misconfigured, true);

  // A name that is not the vault's own beside it, with nothing found.
  world = makeWorld({ include: ['{vault}', '-home-ana-typo'] });
  plan = planOf(world, { vault, waiting: own });
  assert.deepEqual(plan.problems, [{ code: 'project_missing', detail: '-home-ana-typo' }]);
  assert.deepEqual(plan.waiting, [own]);
  assert.equal(plan.misconfigured, true);
});

test('the vault\'s own project, missing where nothing may wait for it, is its own problem when the entry stands for it, and the old project_missing when its name is written out', () => {
  const vault = folder('home', 'ana', 'brain');
  const own = nameOf(vault);
  const entry = makeWorld({ include: ['{vault}'] });
  let plan = planOf(entry, { vault, waiting: null });
  assert.deepEqual(plan.problems, [{ code: 'own_project_missing', detail: own }]);
  assert.equal(plan.misconfigured, true);
  assert.deepEqual(plan.waiting, []);
  // A name written out in a configuration of 0.0.8 behaves exactly as it did.
  const written = makeWorld({ include: [own] });
  plan = planOf(written, { vault, waiting: null });
  assert.deepEqual(plan.problems, [{ code: 'project_missing', detail: own }]);
  assert.equal(plan.misconfigured, true);
  plan = planOf(written, { vault, waiting: own });
  assert.deepEqual(plan.waiting, [own]);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.misconfigured, false);
  // Beside a project that is there the round goes on: it reads that one and warns. The doctor's check is a warning too, not a failure.
  const beside = makeWorld({ include: ['{vault}', OTHER_PROJECT] });
  const other = beside.write(OTHER_PROJECT, 'b.jsonl', [user('Ana writes code', INSIDE)]);
  plan = planOf(beside, { vault, waiting: null });
  assert.deepEqual(plan.problems, [{ code: 'own_project_missing', detail: own }]);
  assert.equal(plan.misconfigured, false);
  assert.deepEqual(paths(plan), [other]);
});

test('"all" keeps its meaning: every project directory of the transcripts directory, the vault\'s own absent or not', () => {
  const world = makeWorld({ include: 'all' });
  const vault = folder('home', 'ana', 'brain');
  const a = world.write(PROJECT, 'a.jsonl', [user('Ana asks about the plan', INSIDE)]);
  const b = world.write(OTHER_PROJECT, 'b.jsonl', [user('Ana writes code', INSIDE)]);
  const plan = planOf(world, { vault, waiting: nameOf(vault) });
  assert.deepEqual(paths(plan).sort(), [a, b].sort());
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.waiting, []);
  // A list that holds "all" names a directory called all; {vault} beside it still means the vault.
  const listed = makeWorld({ include: ['all', '{vault}'] });
  listed.write(nameOf(vault), 's.jsonl', [user('Ana decides', INSIDE)]);
  const named = planOf(listed, { vault, waiting: nameOf(vault) });
  assert.deepEqual(named.problems, [{ code: 'project_missing', detail: 'all' }]);
  assert.equal(named.files.length, 1);
});

test('a vault whose project cannot be named: the entry stands for nothing, the plan says so, and alone it refuses instead of saying that no project is listed', () => {
  const long = folder('v'.repeat(210));
  for (const vault of [long, undefined]) {
    const world = makeWorld({ include: ['{vault}'] });
    const plan = planOf(world, { vault });
    assert.deepEqual(plan.problems.map((p) => p.code), ['vault_unnamed'], String(vault));
    assert.equal(plan.misconfigured, true);
    assert.deepEqual(plan.files, []);
    assert.doesNotMatch(plan.promptBlock, /No project is listed/);
    assert.match(plan.promptBlock, /\{vault\}/);
  }
  const alone = makeWorld({ include: ['{vault}'] });
  assert.equal(planOf(alone, { vault: long }).problems[0].detail, long, 'the path the entry could not be told from');
  // Beside a project that is there, that one is read and the problem is a warning.
  const beside = makeWorld({ include: ['{vault}', OTHER_PROJECT] });
  const other = beside.write(OTHER_PROJECT, 'b.jsonl', [user('Ana writes code', INSIDE)]);
  const plan = planOf(beside, { vault: long });
  assert.deepEqual(paths(plan), [other]);
  assert.deepEqual(plan.problems.map((p) => p.code), ['vault_unnamed']);
  assert.equal(plan.misconfigured, false);
  // An empty list on such a vault has no entry to offer, and says what is so; on any other it is the old problem, which offers the entry.
  assert.deepEqual(planOf(makeWorld({ include: [] }), { vault: long }).problems.map((p) => p.code), ['vault_unnamed']);
  const vault = folder('home', 'ana', 'brain');
  for (const root of [vault, undefined]) {
    const empty = planOf(makeWorld({ include: [] }), { vault: root });
    assert.deepEqual(empty.problems.map((p) => p.code), ['no_projects'], String(root));
    assert.equal(empty.misconfigured, true);
    assert.match(empty.promptBlock, /List \{vault\}, the project of this vault on whatever machine it is opened, or the project directories to read/);
  }
});

test('the new problems are said in words in both languages, with the entry spelt out and no placeholder left', () => {
  const vault = folder('home', 'ana', 'brain');
  const long = folder('v'.repeat(210));
  for (const lang of ['en', 'pt-BR']) {
    const unnamed = makeWorld({ include: ['{vault}'], lang });
    const missing = makeWorld({ include: ['{vault}'], lang });
    const lines = [
      ...planOf(unnamed, { vault: long }).problemLines,
      ...planOf(missing, { vault, waiting: null }).problemLines,
    ];
    assert.equal(lines.length, 2, lang);
    for (const line of lines) {
      assert.ok(line.includes('{vault}'), `${lang}: ${line}`);
      assert.doesNotMatch(line.replaceAll('{vault}', ''), /\{\w+\}/, `${lang}: ${line}`);
    }
    assert.ok(lines[0].includes(long), lines[0]);
    assert.ok(lines[1].includes(nameOf(vault)) && lines[1].includes('CLAUDE_CONFIG_DIR') && lines[1].includes('transcripts_dir'), lines[1]);
    assert.doesNotMatch(lines[1], /Fix the names|Corrija os nomes/);
  }
});

// --- what the configuration accepts ------------------------------------------

test('the schema takes {vault} in the list, alone or beside names, and refuses what it refused: any other string in place of the list, and anything that is not a string', () => {
  for (const name of ['config/valid.json', 'config/valid-pt-BR.json']) {
    const withValue = (value) => {
      const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', name), 'utf8'));
      config.sources.transcripts.include_projects = value;
      return validateConfig(config);
    };
    for (const value of [['{vault}'], ['{vault}', '-home-ana-code'], ['-home-ana-code', '{vault}'], ['{vault}', '{vault}'], ['{other}']]) {
      assert.deepEqual(withValue(value), [], `${name}: ${JSON.stringify(value)}`);
    }
    // The entry is an entry of the list: the bare string is refused like any string but "all".
    for (const value of ['{vault}', '', 'ALL', '{other}']) {
      assert.deepEqual(withValue(value), ['$.sources.transcripts.include_projects: does not match /^all$/'], `${name}: ${JSON.stringify(value)}`);
    }
    for (const value of [null, true, 1, { vault: true }, [1], [null], [['{vault}']], [{ vault: true }]]) {
      const errors = withValue(value);
      assert.ok(errors.length > 0 && errors.every((e) => e.startsWith('$.sources.transcripts.include_projects')), `${name}: ${JSON.stringify(value)}: ${errors.join('\n')}`);
    }
  }
});
