// The bridge to a legacy lock (src/guards/legacy-lock.mjs): machine.json
// `paths.legacy_lock` makes every writer also hold an exclusive flock(2) on
// that file, taken without waiting, and makes the Stop hook stand down while
// another process holds it. The holder in these tests is a real second
// process, bash doing what a legacy scheduled job does (`exec 9>>file; flock
// -n 9`), started for one test and stopped in that test's finally block.
//
// Every test in which someone else holds the legacy lock runs the process
// that asks for it as a child, watched through /proc/locks
// (test/helpers/legacy-lock-world.mjs): a writer that waited instead of
// refusing would be seen waiting and fail the test, never hang it. A test
// that asks for the lock in this very process only ever does so while
// nobody else holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock, describeLock, joinOrAcquire } from '../src/guards/lock.mjs';
import { FLOCK_HELD_STATUS, legacyLockSetting, probeLegacyLock } from '../src/guards/legacy-lock.mjs';
import { GUARD_FILES, GuardError } from '../src/guards/location.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { runDoctor } from '../src/commands/doctor.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { CLEAN_ENV, makeRepo } from './helpers/git-repo.mjs';
import { BIN, hookEnv, makeHookVault, runHookProcess } from './helpers/hook-world.mjs';
import { makeCurateWorld, note } from './helpers/curate-world.mjs';
import { flockProbe, flockAvailable, runWatched, startHolder } from './helpers/legacy-lock-world.mjs';

const HAS_FLOCK = flockAvailable();
const NEEDS_FLOCK = { skip: !HAS_FLOCK && 'needs Linux and util-linux flock' };
const ON_LINUX = { skip: process.platform !== 'linux' && 'the unusable causes past "not Linux" are Linux ones' };
const T = { en: createTranslator('en'), 'pt-BR': createTranslator('pt-BR') };
const LOCK_URL = pathToFileURL(join(KIT_ROOT, 'src', 'guards', 'lock.mjs')).href;
const WRITE = ['watermark', 'assume-covered', 'transcripts'];

// machine.json's paths.legacy_lock set to `value` (undefined removes it),
// written as `machine set` writes it.
function setLegacy(fx, value) {
  const file = join(fx.stateDir, 'machine.json');
  const machine = JSON.parse(readFileSync(file, 'utf8'));
  if (value === undefined) delete machine.paths.legacy_lock;
  else machine.paths.legacy_lock = value;
  writeFileSync(file, `${JSON.stringify(machine, null, 2)}\n`);
}

// A registered vault from `init --yes`, committed clean, whose bridge names
// `<base>/locks/legacy.lock` (not created), unless `legacy` says otherwise.
function bridgedVault({ lang = 'en', legacy } = {}) {
  const fx = makeHookVault({ lang });
  mkdirSync(join(fx.base, 'locks'));
  const file = join(fx.base, 'locks', 'legacy.lock');
  setLegacy(fx, legacy === undefined ? file : legacy);
  return { ...fx, file };
}

// The kit's CLI as a scheduler runs it, watched (see the header).
function kit(fx, args, { env = fx.env, file = fx.file } = {}) {
  return runWatched(process.execPath, [BIN, ...args], { file, env, cwd: fx.root });
}

function kitSync(fx, args, { env = fx.env } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: fx.root, env, encoding: 'utf8' });
}

function markMoved(fx) {
  return existsSync(join(fx.stateDir, 'watermark.json'));
}

function vaultLockLeft(fx) {
  return existsSync(join(fx.root, '.git', GUARD_FILES.LOCK));
}

// A PATH holding git and nothing else: no flock anywhere on it.
function gitOnlyPath(base) {
  const dir = join(base, 'git-only');
  mkdirSync(dir);
  symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), join(dir, 'git'));
  return dir;
}

// A PATH holding git and flock and nothing else: no gh, so the briefing's
// facts never ask a real one.
function gitAndFlockPath(base) {
  const dir = join(base, 'git-and-flock');
  mkdirSync(dir);
  for (const name of ['git', 'flock']) {
    symlinkSync(spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' }).stdout.trim(), join(dir, name));
  }
  return dir;
}

function thrown(fn) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof GuardError, `expected a GuardError, got ${caught && caught.stack}`);
  return caught;
}

function rendersIn(error, needle) {
  for (const [lang, t] of Object.entries(T)) {
    const text = t(error.messageKey, error.params);
    assert.ok(text.includes(String(needle)), `${lang}: ${JSON.stringify(text)} does not name ${needle}`);
    assert.doesNotMatch(text, /\{\w+\}/, `${lang}: a placeholder left in ${JSON.stringify(text)}`);
  }
}

function beginSession(fx) {
  const r = runHookProcess('session-start', { session_id: 's1', source: 'startup', cwd: fx.root }, { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0, r.stderr);
}

const STOP_PAYLOAD = (fx) => JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd: fx.root });

// --- writers --------------------------------------------------------------------

test('a writer finding the legacy lock held refuses at once, exit 75, with the held-lock line naming the file, in both languages, and changes nothing', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    for (const lang of ['en', 'pt-BR']) {
      const r = await kit(fx, WRITE, { env: { ...fx.env, BRAIN_KIT_LANG: lang } });
      assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
      assert.equal(r.stderr, `${T[lang]('lock.legacy_held', { lock: fx.file })}\n`);
      assert.equal(r.stdout, '');
    }
    assert.equal(markMoved(fx), false, 'the mark never moved');
    assert.equal(vaultLockLeft(fx), false, 'the vault lock the writer had just taken was let go');
    assert.equal(flockProbe(fx.file), 1, 'the holder still holds it: the writer came back without waiting for it');
  } finally {
    await holder.stop();
  }
});

test('with the holder gone the writer proceeds, and leaves the legacy file where it was, as it was: never written, truncated or removed', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  // Some legacy jobs write into their lock file; whatever is there stays.
  const content = 'pid 4242, written by the legacy job\n';
  writeFileSync(fx.file, content);
  const holder = startHolder(fx.file);
  let before;
  try {
    await holder.ready;
    before = statSync(fx.file);
    assert.equal((await kit(fx, WRITE)).status, EXIT.TEMPFAIL);
  } finally {
    await holder.stop();
  }
  const r = await kit(fx, WRITE);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(markMoved(fx), true);
  const after = statSync(fx.file);
  assert.equal(after.ino, before.ino, 'the same file, never removed or replaced');
  assert.equal(readFileSync(fx.file, 'utf8'), content, 'never written or truncated');
  assert.equal(flockProbe(fx.file), 0, 'let go when the writer ended');
  assert.equal(vaultLockLeft(fx), false);
});

test('a legacy file not there yet is created by opening it, as flock itself creates it, and left there, empty', NEEDS_FLOCK, () => {
  const fx = bridgedVault();
  assert.equal(existsSync(fx.file), false);
  const r = kitSync(fx, WRITE);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(statSync(fx.file).isFile());
  assert.equal(statSync(fx.file).size, 0);
});

test('a writer holds the legacy lock exactly while it holds the vault lock: taken with it, let go with it', NEEDS_FLOCK, () => {
  const fx = bridgedVault();
  const lock = acquireLock(fx.root, { command: 'sync', env: fx.env });
  let released;
  try {
    assert.equal(flockProbe(fx.file), 1, 'held while the vault lock is');
    assert.deepEqual(Object.keys(lock).sort(), ['holder', 'lockPath', 'release', 'token'], 'the same lock object as ever');
  } finally {
    released = lock.release();
  }
  assert.equal(released, true, 'release answers as the vault lock\'s own release');
  assert.equal(flockProbe(fx.file), 0);
  assert.equal(describeLock(fx.root, { env: fx.env }), null);
  assert.equal(lock.release(), false, 'a second release is harmless');
  assert.equal(flockProbe(fx.file), 0);
});

test('a writer killed while it holds the legacy lock loses it at once: the kernel lets go, not the writer', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  // The child holds the lock until it is killed, or until its standard input
  // (a pipe from this process) ends: a test process that dies before its
  // finally leaves no writer behind.
  const program = `const { acquireLock } = await import(${JSON.stringify(LOCK_URL)}); acquireLock(process.argv[1], { command: 'curate' }); process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); process.stdout.write('held\\n');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, fx.root], { env: fx.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.includes('held\n')) resolve();
      });
      child.on('exit', () => reject(new Error(`the writer exited before it held the lock: ${err}`)));
    });
    assert.equal(flockProbe(fx.file), 1);
    child.kill('SIGKILL');
    assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    assert.equal(flockProbe(fx.file), 0, 'free the moment the writer died, with no release');
    // The vault lock it left names a dead process: the next writer replaces
    // it and takes both.
    const next = acquireLock(fx.root, { command: 'curate', env: fx.env });
    try {
      assert.equal(flockProbe(fx.file), 1);
    } finally {
      next.release();
    }
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});

// --- every writer, one by one --------------------------------------------------

// Everything a writer could change: HEAD, the tree's status, every ref, the
// marks and the question queue (machine.json's paths name both inside the
// state directory).
function snapshot(fx) {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: fx.root, encoding: 'utf8', env: CLEAN_ENV });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  return {
    head: git(['rev-parse', 'HEAD']),
    status: git(['status', '--porcelain=v1', '--untracked-files=all']),
    refs: git(['for-each-ref', '--format=%(refname) %(objectname)']),
    marks: read(join(fx.stateDir, 'watermark.json')),
    queue: read(join(fx.stateDir, 'questions.log')),
  };
}

test('every writer refuses at once while the legacy lock is held, exit 75 with the held-lock line, and changes nothing: propose outside a round, sync, verify, every watermark and questions write', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  const legacyMark = join(fx.base, 'legacy-watermark');
  writeFileSync(legacyMark, '2026-09-20\n');
  writeFileSync(join(fx.root, 'draft.md'), note('Draft'));
  // One question in the queue, so answer and archive have one to change.
  const added = kitSync(fx, ['questions', 'add', 'Asked before the legacy job started?']);
  assert.equal(added.status, EXIT.OK, added.stderr);
  const id = /q-[0-9a-f]{8}/.exec(added.stdout)[0];
  const writers = [
    ['propose', 'Legacy lock held', '--only', 'draft.md'],
    ['sync'],
    ['verify', '--files', 'index.md'],
    ['watermark', 'set', 'transcripts', '2026-09-01'],
    ['watermark', 'reopen', 'transcripts', '2026-09-01'],
    ['watermark', 'assume-covered', 'transcripts'],
    ['watermark', 'import', '--from', legacyMark],
    ['questions', 'add', 'Asked while the legacy job ran?'],
    ['questions', 'answer', id],
    ['questions', 'archive', id],
    ['questions', 'sweep'],
  ];
  const before = snapshot(fx);
  assert.notEqual(before.queue, null, 'the queue holds the seeded question');
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    for (const argv of writers) {
      const label = argv.join(' ');
      const r = await kit(fx, argv);
      assert.equal(r.status, EXIT.TEMPFAIL, `${label}: ${r.stderr}`);
      assert.equal(r.stderr, `${T.en('lock.legacy_held', { lock: fx.file })}\n`, label);
      assert.equal(r.stdout, '', label);
      assert.deepEqual(snapshot(fx), before, `${label} changed nothing`);
      assert.equal(vaultLockLeft(fx), false, `${label} let the vault lock go`);
    }
    assert.equal(flockProbe(fx.file), 1, 'the holder held it throughout');
  } finally {
    await holder.stop();
  }
});

test('the bridge is read from the state directory the vault itself derives, whatever directory the writer starts in', NEEDS_FLOCK, async () => {
  const base = realpathSync(makeTempDir('brain-kit-legacy-derived-'));
  for (const dir of ['home', 'elsewhere', 'locks']) mkdirSync(join(base, dir));
  const env = { ...hookEnv(base), XDG_STATE_HOME: join(base, 'xdg') };
  delete env.BRAIN_KIT_STATE_DIR;
  const root = join(base, 'vault');
  const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });
  let r = run(['init', root, '--yes', '--lang', 'en'], base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const file = join(base, 'locks', 'legacy.lock');
  r = run(['machine', 'set', 'paths.legacy_lock', file], root);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(r.stdout.includes(join(base, 'xdg', 'brain-kit')), `machine.json lives in the derived state directory: ${r.stdout}`);
  const holder = startHolder(file);
  try {
    await holder.ready;
    for (const argv of [['watermark', 'assume-covered', 'transcripts', root], ['questions', 'add', 'From elsewhere?', root]]) {
      const refused = await runWatched(process.execPath, [BIN, ...argv], { file, env, cwd: join(base, 'elsewhere') });
      assert.equal(refused.status, EXIT.TEMPFAIL, `${argv.join(' ')}: ${refused.stderr}`);
      assert.equal(refused.stderr, `${T.en('lock.legacy_held', { lock: file })}\n`);
    }
  } finally {
    await holder.stop();
  }
});

// --- once, never waiting, never by a joined command ---------------------------

// A `flock` first on PATH that records its arguments, one line per run, and
// then runs the real one with the same descriptors.
function flockShim(base) {
  const bin = join(base, 'shim');
  mkdirSync(bin);
  writeFileSync(join(bin, 'flock'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SHIM_FLOCK_LOG"\nexec "$SHIM_FLOCK_REAL" "$@"\n');
  chmodSync(join(bin, 'flock'), 0o755);
  const log = join(base, 'flock-calls.log');
  const real = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).stdout.trim();
  return {
    env: (env) => ({ ...env, PATH: `${bin}${delimiter}${env.PATH}`, SHIM_FLOCK_LOG: log, SHIM_FLOCK_REAL: real }),
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

test('the legacy lock is asked for once per writer, never waiting, and never by a command joined to the round, nor with the bridge off', NEEDS_FLOCK, () => {
  const fx = bridgedVault();
  const shim = flockShim(fx.base);
  const env = shim.env(fx.env);
  let r = kitSync(fx, WRITE, { env });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(shim.calls(), [`-n -x -E ${FLOCK_HELD_STATUS} 3`], 'one exclusive lock, never waiting (-n), on the descriptor handed over as fd 3');
  const round = acquireLock(fx.root, { command: 'curate', env });
  try {
    assert.equal(shim.calls().length, 2, 'the round asks once');
    r = kitSync(fx, ['questions', 'add', 'Asked by the round?'], { env: { ...env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(r.status, EXIT.OK, r.stderr);
    assert.equal(shim.calls().length, 2, 'the command joined to the round never asked');
  } finally {
    round.release();
  }
  setLegacy(fx, null);
  r = kitSync(fx, ['questions', 'add', 'Bridge off?'], { env });
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(shim.calls().length, 2, 'with the bridge off nothing asks');
});

test('a command joined to the round never takes the legacy lock, in this process or another; one that does not join is refused by the vault lock, named by its holder', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  const round = acquireLock(fx.root, { command: 'curate', env: fx.env });
  try {
    // A second flock from a new descriptor would be refused by the round's
    // own, even in the process that holds it.
    const joined = joinOrAcquire(fx.root, { command: 'propose', env: { ...fx.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(joined.joined, true);
    joined.release();
    assert.equal(flockProbe(fx.file), 1, 'the round still holds it');
    const r = await kit(fx, ['questions', 'add', 'Asked inside the round?'], { env: { ...fx.env, BRAIN_KIT_ROUND_TOKEN: round.token } });
    assert.equal(r.status, EXIT.OK, r.stderr);
    const refused = await kit(fx, ['questions', 'add', 'Asked outside the round?']);
    assert.equal(refused.status, EXIT.TEMPFAIL, refused.stderr);
    const { pid, host, command, startedAt } = round.holder;
    assert.equal(refused.stderr, `${T.en('lock.held', { pid, host, command, startedAt })}\n`, 'the vault lock is asked first, so its holder is named');
  } finally {
    round.release();
  }
  assert.equal(flockProbe(fx.file), 0);
});

// --- the round -----------------------------------------------------------------

test('a round holds the legacy lock for the whole round, and the propose its model runs joins the round without taking it again', NEEDS_FLOCK, () => {
  const w = makeCurateWorld();
  const file = join(w.base, 'legacy.lock');
  w.setMachine({ paths: { ...w.machine.paths, legacy_lock: file } });
  w.scenario({
    actions: [
      { write: { path: 'notes/meeting.md', content: note('Meeting') } },
      { run: ['flock', '-n', file, 'true'] },
      w.proposeAction('notes/meeting.md'),
    ],
  });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const runs = readFileSync(w.files.recordFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(runs[0].status, 1, 'inside the round the legacy lock is held, by the round');
  const propose = runs.find((run) => run.argv.includes('propose'));
  assert.equal(propose.status, EXIT.OK, propose.stderr);
  assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 1, 'the pull request was opened');
  assert.equal(w.lastRun().exit, EXIT.OK);
  assert.equal(flockProbe(file), 0, 'the round let go when it ended');
  assert.ok(statSync(file).isFile(), 'and left the file in place');
  assert.deepEqual(w.roundFiles(), []);
});

test('a round finding the legacy lock held postpones: exit 75, lock_held naming the file, no model launched, no lock left, the owner notified', NEEDS_FLOCK, async () => {
  const w = makeCurateWorld();
  const file = join(w.base, 'legacy.lock');
  w.setMachine({ paths: { ...w.machine.paths, legacy_lock: file } });
  const holder = startHolder(file);
  try {
    await holder.ready;
    const r = await runWatched(process.execPath, [BIN, 'curate'], { file, env: w.env, cwd: w.vault });
    assert.equal(r.status, EXIT.TEMPFAIL, r.stderr);
    const last = w.lastRun();
    assert.equal(last.exit, EXIT.TEMPFAIL);
    assert.equal(last.reasonCode, 'lock_held');
    assert.equal(last.reason, T.en('lock.legacy_held', { lock: file }));
    assert.deepEqual(w.launches(), [], 'no model was launched');
    assert.deepEqual(w.roundFiles(), [], 'the vault lock was let go');
    assert.equal(w.watermark(), null);
    assert.equal(w.notifications().at(-1).at(-1), last.reason);
  } finally {
    await holder.stop();
  }
});

test('a round whose legacy lock cannot be used stops with exit 1 as lock_unusable, never lock_held: the refusal is its reason and its notification, no model launched', NEEDS_FLOCK, () => {
  const w = makeCurateWorld();
  const gone = join(w.base, 'gone');
  const file = join(gone, 'legacy.lock');
  w.setMachine({ paths: { ...w.machine.paths, legacy_lock: file } });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE, r.stderr);
  const refusal = T.en('lock.legacy_dir_missing', { lock: file, dir: gone });
  const last = w.lastRun();
  assert.equal(last.exit, EXIT.FAILURE);
  assert.equal(last.reasonCode, 'lock_unusable');
  assert.equal(last.reason, refusal);
  assert.equal(w.notifications().at(-1).at(-1), refusal);
  assert.deepEqual(w.launches(), [], 'no model was launched');
  assert.deepEqual(w.roundFiles(), [], 'the vault lock was let go');
  assert.equal(existsSync(gone), false, 'nothing was created');
});

// --- the Stop hook ---------------------------------------------------------------

test('the Stop hook stands down while the legacy lock is held, naming it, even with session work to propose; once it is free it blocks again', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  beginSession(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    const r = await runWatched(process.execPath, [BIN, 'hook', 'stop'], { file: fx.file, env: fx.env, cwd: join(fx.base, 'elsewhere'), input: STOP_PAYLOAD(fx) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'released');
    assert.equal(r.stderr, `${T.en('hook.stop.release_legacy_held', { lock: fx.file })}\n`);
  } finally {
    await holder.stop();
  }
  const r = runHookProcess('stop', STOP_PAYLOAD(fx), { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /mine\.md/);
  assert.equal(statSync(fx.file).size, 0, 'the probe never writes it');
});

test('a legacy lock that cannot be used proves no writer: the Stop hook goes on to block, and says why propose would refuse', NEEDS_FLOCK, () => {
  const fx = bridgedVault();
  const gone = join(fx.base, 'gone');
  setLegacy(fx, join(gone, 'legacy.lock'));
  beginSession(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  const r = runHookProcess('stop', STOP_PAYLOAD(fx), { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /mine\.md/);
  assert.ok(out.reason.endsWith(`\n${T.en('lock.legacy_dir_missing', { lock: join(gone, 'legacy.lock'), dir: gone })}`), out.reason);
  assert.equal(existsSync(gone), false, 'nothing was created');
});

test('the Stop hook with the bridge on and the file not there yet: free, and the probe does not create it', NEEDS_FLOCK, () => {
  const fx = bridgedVault();
  beginSession(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  const r = runHookProcess('stop', STOP_PAYLOAD(fx), { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(JSON.parse(r.stdout).decision, 'block');
  assert.equal(existsSync(fx.file), false);
});

// --- the facts: preflight, the briefing, SessionStart ---------------------------------

test('preflight and the briefing say the legacy lock is held while another process holds it, never free; free once it is not; unusable with the writers\' refusal; nothing with the bridge off', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  const env = { ...fx.env, PATH: gitAndFlockPath(fx.base) };
  const held = T.en('preflight.legacy_lock_held', { lock: fx.file });
  const free = T.en('preflight.legacy_lock_free', { lock: fx.file });
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    const text = await kit(fx, ['preflight'], { env });
    assert.equal(text.status, EXIT.OK, text.stderr);
    assert.ok(text.stdout.includes(`${T.en('preflight.lock_free')}\n${held}\n`), text.stdout);
    assert.equal(text.stdout.includes(free), false, 'never free while held');
    const json = await kit(fx, ['preflight', '--json'], { env });
    assert.deepEqual(JSON.parse(json.stdout).lock, { held: false, command: null, reason: null, legacy: { file: fx.file, state: 'held', reason: null } });
    const briefing = await runWatched(process.execPath, [BIN, 'prompt', 'briefing', '--vault', fx.root], { file: fx.file, env, cwd: fx.base });
    assert.equal(briefing.status, EXIT.OK, briefing.stderr);
    assert.ok(briefing.stdout.includes(held), `the briefing's sources block says it is held:\n${briefing.stdout}`);
    assert.equal(briefing.stdout.includes(free), false);
  } finally {
    await holder.stop();
  }
  let r = kitSync(fx, ['preflight'], { env });
  assert.ok(r.stdout.includes(free) && !r.stdout.includes(held), r.stdout);
  const gone = join(fx.base, 'gone');
  setLegacy(fx, join(gone, 'legacy.lock'));
  r = kitSync(fx, ['preflight'], { env });
  const refusal = T.en('lock.legacy_dir_missing', { lock: join(gone, 'legacy.lock'), dir: gone });
  assert.ok(r.stdout.includes(T.en('preflight.legacy_lock_unusable', { refusal })), r.stdout);
  setLegacy(fx, null);
  r = kitSync(fx, ['preflight'], { env });
  assert.equal(r.stdout.includes(T.en('preflight.lock_free')), true);
  assert.doesNotMatch(r.stdout, /Legacy lock/, 'with the bridge off, no line');
});

test('the SessionStart line says the legacy lock is held, or that it cannot be used, and nothing while it is free', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  const payload = JSON.stringify({ session_id: 's1', source: 'startup', cwd: fx.root });
  const contextOf = (r) => {
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  };
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    const r = await runWatched(process.execPath, [BIN, 'hook', 'session-start'], { file: fx.file, env: fx.env, cwd: join(fx.base, 'elsewhere'), input: payload });
    const context = contextOf(r);
    assert.ok(context.includes(T.en('hook.session_start.legacy_lock_held', { lock: fx.file })), context);
    assert.doesNotMatch(context, /\n/, 'still one line');
  } finally {
    await holder.stop();
  }
  const freeContext = contextOf(runHookProcess('session-start', payload, { env: fx.env, cwd: join(fx.base, 'elsewhere') }));
  assert.doesNotMatch(freeContext, /legacy lock/i);
  const gone = join(fx.base, 'gone');
  setLegacy(fx, join(gone, 'legacy.lock'));
  const refusal = T.en('lock.legacy_dir_missing', { lock: join(gone, 'legacy.lock'), dir: gone });
  const unusableContext = contextOf(runHookProcess('session-start', payload, { env: fx.env, cwd: join(fx.base, 'elsewhere') }));
  assert.ok(unusableContext.includes(T.en('hook.session_start.legacy_lock_unusable', { refusal })), unusableContext);
});

test('a Stop hook that releases a clean session still names a legacy lock bridge that cannot be used', NEEDS_FLOCK, () => {
  const fx = bridgedVault();
  const gone = join(fx.base, 'gone');
  setLegacy(fx, join(gone, 'legacy.lock'));
  beginSession(fx);
  const r = runHookProcess('stop', STOP_PAYLOAD(fx), { env: fx.env, cwd: join(fx.base, 'elsewhere') });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'released: nothing to propose');
  const refusal = T.en('lock.legacy_dir_missing', { lock: join(gone, 'legacy.lock'), dir: gone });
  assert.equal(r.stderr, `${T.en('hook.stop.release_clean', { count: 0 })} ${refusal}\n`);
});

// --- the bridge off ------------------------------------------------------------------

test('the bridge off changes nothing: no setting, null, or no machine.json at all, whatever the platform and PATH', () => {
  const fx = makeHookVault();
  const env = { ...fx.env, PATH: gitOnlyPath(fx.base) };
  for (const [label, value] of [['no setting', undefined], ['null', null]]) {
    setLegacy(fx, value);
    const lock = acquireLock(fx.root, { command: 'sync', env }, { platform: 'darwin' });
    assert.deepEqual(Object.keys(lock).sort(), ['holder', 'lockPath', 'release', 'token'], label);
    assert.equal(lock.release(), true, label);
  }
  const repo = makeRepo();
  const lock = acquireLock(repo, { command: 'sync', env: { ...CLEAN_ENV, BRAIN_KIT_STATE_DIR: makeTempDir('brain-kit-legacy-none-') } }, { platform: 'darwin' });
  assert.equal(lock.release(), true, 'no machine.json: no bridge');
});

test('with the bridge off a writer never looks at a file the legacy job holds', NEEDS_FLOCK, async () => {
  const fx = bridgedVault({ legacy: null });
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    const r = await kit(fx, WRITE);
    assert.equal(r.status, EXIT.OK, r.stderr);
    assert.equal(markMoved(fx), true);
  } finally {
    await holder.stop();
  }
});

// --- a bridge that cannot be used ------------------------------------------------------

// The refusal: exit 1 (retrying cannot fix it), the message key and its
// parameters, both packs naming `needle`, and the vault lock let go.
function refusedWith(fx, key, params, needle, { env = fx.env, deps = {} } = {}) {
  const error = thrown(() => acquireLock(fx.root, { command: 'sync', env }, deps));
  assert.equal(error.code, 'LEGACY_LOCK_UNUSABLE');
  assert.equal(error.exitCode, EXIT.FAILURE);
  assert.equal(error.messageKey, key);
  assert.deepEqual(error.params, params);
  rendersIn(error, needle);
  assert.equal(describeLock(fx.root, { env }), null, 'the vault lock was let go');
  return error;
}

test('a bridge on a machine that is not Linux refuses every writer, exit 1, and creates nothing', () => {
  const fx = bridgedVault();
  refusedWith(fx, 'lock.legacy_not_linux', { lock: fx.file, platform: 'darwin' }, fx.file, { deps: { platform: 'darwin' } });
  assert.equal(existsSync(fx.file), false);
});

test('a bridge with no flock on PATH refuses every writer, exit 1, and creates nothing', ON_LINUX, () => {
  const fx = bridgedVault();
  refusedWith(fx, 'lock.legacy_no_flock', { lock: fx.file }, fx.file, { env: { ...fx.env, PATH: gitOnlyPath(fx.base) } });
  assert.equal(existsSync(fx.file), false);
});

test('a bridge whose directory is gone, or that names a directory or a FIFO, refuses every writer, exit 1', NEEDS_FLOCK, () => {
  const fx = bridgedVault();
  const gone = join(fx.base, 'gone');
  setLegacy(fx, join(gone, 'legacy.lock'));
  refusedWith(fx, 'lock.legacy_dir_missing', { lock: join(gone, 'legacy.lock'), dir: gone }, gone);
  assert.equal(existsSync(gone), false, 'nothing was created');

  const dir = join(fx.base, 'a-directory');
  mkdirSync(dir);
  setLegacy(fx, dir);
  refusedWith(fx, 'lock.legacy_not_a_file', { lock: dir }, dir);

  const fifo = join(fx.base, 'a-fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  setLegacy(fx, fifo);
  refusedWith(fx, 'lock.legacy_not_a_file', { lock: fifo }, fifo);
  assert.deepEqual(probeLegacyLock(fifo, { env: fx.env }), { state: 'unusable', messageKey: 'lock.legacy_not_a_file', params: { lock: fifo } }, 'the probe opens it without blocking too');
});

test('a legacy file this user may not open refuses, exit 1; one it may only read is still locked', { skip: (!HAS_FLOCK && 'needs flock') || (process.getuid?.() === 0 && 'root opens anything') }, () => {
  const fx = bridgedVault();
  writeFileSync(fx.file, '');
  chmodSync(fx.file, 0o000);
  refusedWith(fx, 'lock.legacy_open_failed', { lock: fx.file, code: 'EACCES' }, fx.file);
  chmodSync(fx.file, 0o444);
  const lock = acquireLock(fx.root, { command: 'sync', env: fx.env });
  try {
    assert.equal(flockProbe(fx.file), 1, 'held through a read-only descriptor');
  } finally {
    lock.release();
  }
  assert.equal(flockProbe(fx.file), 0);
});

test('a machine.json that cannot say whether the bridge is on refuses every writer, exit 1, and names the command that shows where it breaks; a relative setting written by hand too', () => {
  const fx = bridgedVault();
  const machineFile = join(fx.stateDir, 'machine.json');
  setLegacy(fx, 'relative/legacy.lock');
  refusedWith(fx, 'lock.legacy_setting_invalid', { file: machineFile, value: '"relative/legacy.lock"' }, machineFile);
  writeFileSync(machineFile, '{ not json');
  const error = refusedWith(fx, 'lock.legacy_machine_unreadable', { file: machineFile, detail: legacyLockSetting(fx.stateDir).params.detail }, machineFile);
  assert.match(error.params.detail, /JSON/);
  // Neither machine set nor machine register can rewrite a file they cannot
  // read, so the sentence sends the person to the check that shows the same
  // place, in both languages.
  rendersIn(error, 'brain-kit doctor --only machine-valid');
  const shown = kitSync(fx, ['doctor', '--only', 'machine-valid']);
  assert.equal(shown.status, EXIT.FAILURE);
  assert.ok(shown.stdout.includes(error.params.detail), `doctor --only machine-valid shows the same place: ${shown.stdout}`);
  for (const argv of [['machine', 'set', 'paths.legacy_lock', 'null'], ['machine', 'register']]) {
    const r = kitSync(fx, argv);
    assert.equal(r.status, EXIT.FAILURE, `${argv.join(' ')} cannot repair it: ${r.stderr}`);
  }
  assert.equal(readFileSync(machineFile, 'utf8'), '{ not json', 'and nothing rewrote it');
});

// --- machine set ---------------------------------------------------------------------

test('machine set takes paths.legacy_lock as an absolute path, refuses a relative one or one under ~/, and null turns the bridge off', () => {
  const fx = makeHookVault();
  const machineFile = join(fx.stateDir, 'machine.json');
  const file = join(fx.base, 'legacy.lock');
  let r = kitSync(fx, ['machine', 'set', 'paths.legacy_lock', file]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).paths.legacy_lock, file);
  assert.deepEqual(legacyLockSetting(fx.stateDir), { state: 'on', file });
  assert.match(kitSync(fx, ['machine', 'show']).stdout, /"legacy_lock"/);
  for (const bad of ['relative/legacy.lock', '~/legacy.lock', '']) {
    const before = readFileSync(machineFile, 'utf8');
    r = kitSync(fx, ['machine', 'set', 'paths.legacy_lock', bad]);
    assert.equal(r.status, EXIT.FAILURE, `${JSON.stringify(bad)}: ${r.stderr}`);
    assert.match(r.stderr, /paths\.legacy_lock/);
    assert.equal(readFileSync(machineFile, 'utf8'), before, `${JSON.stringify(bad)} left the file as it was`);
  }
  r = kitSync(fx, ['machine', 'set', 'paths.legacy_lock', 'null']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.equal(JSON.parse(readFileSync(machineFile, 'utf8')).paths.legacy_lock, null);
  assert.deepEqual(legacyLockSetting(fx.stateDir), { state: 'off' });
});

test('machine set changes or turns off a bridge that cannot be used, and one that is held, without waiting', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  setLegacy(fx, join(fx.base, 'gone', 'legacy.lock'));
  assert.equal(kitSync(fx, WRITE).status, EXIT.FAILURE, 'every writer refuses');
  let r = kitSync(fx, ['machine', 'set', 'paths.legacy_lock', fx.file]);
  assert.equal(r.status, EXIT.OK, r.stderr);
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    r = await kit(fx, ['machine', 'set', 'paths.legacy_lock', 'null']);
    assert.equal(r.status, EXIT.OK, r.stderr);
  } finally {
    await holder.stop();
  }
  assert.deepEqual(legacyLockSetting(fx.stateDir), { state: 'off' });
});

// --- doctor ----------------------------------------------------------------------------

async function doctorLegacy(fx, env = fx.env) {
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  const code = await runDoctor(['--json', '--only', 'legacy-lock', fx.root], io, T.en, { env, cwd: fx.root });
  const [check] = JSON.parse(out).checks;
  return { code, check };
}

test('doctor: the bridge off is ok and says so, whether or not machine.json names the key', async () => {
  const fx = makeHookVault();
  let { code, check } = await doctorLegacy(fx);
  assert.deepEqual([code, check.status, check.messageKey], [EXIT.OK, 'ok', 'doctor.legacy_lock.off']);
  setLegacy(fx, null);
  ({ code, check } = await doctorLegacy(fx));
  assert.deepEqual([code, check.status, check.messageKey], [EXIT.OK, 'ok', 'doctor.legacy_lock.off']);
});

test('doctor: the bridge on and working is ok, free or held right now, and the probe neither waits nor creates the file', NEEDS_FLOCK, async () => {
  const fx = bridgedVault();
  let { code, check } = await doctorLegacy(fx);
  assert.deepEqual([code, check.status, check.messageKey, check.params], [EXIT.OK, 'ok', 'doctor.legacy_lock.on', { lock: fx.file }]);
  assert.equal(existsSync(fx.file), false, 'the probe did not create it');
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    const r = await kit(fx, ['doctor', '--json', '--only', 'legacy-lock']);
    assert.equal(r.status, EXIT.OK, r.stderr);
    [check] = JSON.parse(r.stdout).checks;
    assert.deepEqual([check.status, check.messageKey, check.params], ['ok', 'doctor.legacy_lock.on_held', { lock: fx.file }]);
  } finally {
    await holder.stop();
  }
});

test('doctor: the bridge on but unusable fails with the refusal every writer gives', ON_LINUX, async () => {
  const fx = bridgedVault();
  let { code, check } = await doctorLegacy(fx, { ...fx.env, PATH: gitOnlyPath(fx.base) });
  assert.deepEqual([code, check.status, check.messageKey, check.params], [EXIT.FAILURE, 'fail', 'lock.legacy_no_flock', { lock: fx.file }]);
  const gone = join(fx.base, 'gone');
  setLegacy(fx, join(gone, 'legacy.lock'));
  if (HAS_FLOCK) {
    ({ code, check } = await doctorLegacy(fx));
    assert.deepEqual([code, check.status, check.messageKey, check.params], [EXIT.FAILURE, 'fail', 'lock.legacy_dir_missing', { lock: join(gone, 'legacy.lock'), dir: gone }]);
  }
  setLegacy(fx, 'relative/legacy.lock');
  ({ code, check } = await doctorLegacy(fx));
  assert.deepEqual([code, check.status, check.messageKey], [EXIT.FAILURE, 'fail', 'lock.legacy_setting_invalid']);
});
