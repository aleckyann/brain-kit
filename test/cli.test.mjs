import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { main } from '../src/cli.mjs';
import { ConfigError } from '../src/config.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { readQueue } from '../src/briefing/questions.mjs';
import { makeHookVault } from './helpers/hook-world.mjs';
import { makeProposeWorld, note } from './helpers/propose-world.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (s) => { stdout += s; } },
      stderr: { write: (s) => { stderr += s; } },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function run(args, input = '') {
  return spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' });
}

test('--version prints the package.json version', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkg.version}\n`);
});

test('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain-kit/);
  assert.match(r.stdout, /hook/);
});

test('no arguments prints usage and exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain-kit/);
});

test('unknown command exits 2 with the command named on stderr', () => {
  const r = run(['definitely-not-a-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /definitely-not-a-command/);
  assert.equal(r.stdout, '');
});

test('BRAIN_KIT_LANG=en switches CLI messages', () => {
  const r = spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
  assert.match(r.stderr, /unknown command/);
});

test('hook stop is a silent no-op in phase 0', () => {
  const r = run(['hook', 'stop'], JSON.stringify({ stop_hook_active: false, cwd: KIT_ROOT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook session-start is a silent no-op in phase 0', () => {
  const r = run(['hook', 'session-start'], JSON.stringify({ cwd: KIT_ROOT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook with an unknown event exits 2', () => {
  const r = run(['hook', 'nope'], '{}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
});

test('a ConfigError thrown by a command maps to exit 2 with the message on stderr and no stack', async () => {
  const { io, stderr, stdout } = fakeIo();
  const commands = new Map([['boom', async () => { throw new ConfigError('Not a brain-kit vault'); }]]);
  const code = await main(['boom'], io, { commands });
  assert.equal(code, EXIT.USAGE);
  assert.equal(stderr(), 'Not a brain-kit vault\n');
  assert.equal(stdout(), '');
});

test('any other error thrown by a command maps to exit 1, prefixed, without a stack unless BRAIN_KIT_DEBUG is set', async () => {
  const prevDebug = process.env.BRAIN_KIT_DEBUG;
  delete process.env.BRAIN_KIT_DEBUG;
  try {
    const { io, stderr, stdout } = fakeIo();
    const commands = new Map([['boom', async () => { throw new Error('boom'); }]]);
    const code = await main(['boom'], io, { commands });
    assert.equal(code, EXIT.FAILURE);
    assert.equal(stderr(), 'brain-kit: boom\n');
    assert.equal(stdout(), '');
  } finally {
    if (prevDebug === undefined) delete process.env.BRAIN_KIT_DEBUG;
    else process.env.BRAIN_KIT_DEBUG = prevDebug;
  }
});

// --- -C <dir> (final review of phase 4, C2) ----------------------------------------

const tEn = createTranslator('en');
const kitIn = (args, { cwd, env }) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...env, BRAIN_KIT_LANG: 'en' }, encoding: 'utf8' });

test('-C <vault> from a directory outside it runs validate, lint and questions exactly as from inside the vault', () => {
  const fx = makeHookVault();
  const outside = join(fx.base, 'elsewhere');
  for (const args of [['validate'], ['lint', '--base', 'worktree'], ['questions', 'list']]) {
    const inside = kitIn(args, { cwd: fx.root, env: fx.env });
    const viaC = kitIn(['-C', fx.root, ...args], { cwd: outside, env: fx.env });
    const without = kitIn(args, { cwd: outside, env: fx.env });
    assert.equal(inside.status, 0, `${args.join(' ')}: ${inside.stdout}${inside.stderr}`);
    assert.deepEqual([viaC.status, viaC.stdout, viaC.stderr], [inside.status, inside.stdout, inside.stderr], args.join(' '));
    assert.equal(without.status, EXIT.USAGE, `${args.join(' ')} from outside without -C finds no vault`);
  }
  const added = kitIn(['-C', fx.root, 'questions', 'add', 'Is the room booked?'], { cwd: outside, env: fx.env });
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(readQueue(fx.stateDir).map((q) => q.text), ['Is the room booked?']);
});

test('-C is relative to the working directory, several apply in order, and each must be a directory', () => {
  const fx = makeHookVault();
  const relative = kitIn(['-C', '..', '-C', 'vault', 'validate'], { cwd: join(fx.base, 'elsewhere'), env: fx.env });
  assert.equal(relative.status, 0, relative.stdout + relative.stderr);
  const missing = kitIn(['-C'], { cwd: fx.base, env: fx.env });
  assert.equal(missing.status, EXIT.USAGE);
  assert.ok(missing.stderr.startsWith(`${tEn('cli.dir_missing')}\n`), missing.stderr);
  const empty = kitIn(['-C', '', 'validate'], { cwd: fx.base, env: fx.env });
  assert.equal(empty.status, EXIT.USAGE);
  assert.ok(empty.stderr.startsWith(`${tEn('cli.dir_missing')}\n`), empty.stderr);
  const absent = kitIn(['-C', 'nowhere', 'validate'], { cwd: fx.base, env: fx.env });
  assert.deepEqual([absent.status, absent.stderr], [EXIT.USAGE, `${tEn('cli.dir_not_found', { dir: join(fx.base, 'nowhere') })}\n`]);
  writeFileSync(join(fx.base, 'a-file'), 'x\n');
  const file = kitIn(['-C', 'a-file', 'validate'], { cwd: fx.base, env: fx.env });
  assert.deepEqual([file.status, file.stderr], [EXIT.USAGE, `${tEn('cli.dir_not_a_directory', { dir: join(fx.base, 'a-file') })}\n`]);
});

test('-C in process: the command runs in the directory, and the working directory is given back after it, even when the command throws', async () => {
  const fx = makeHookVault();
  const before = process.cwd();
  let seen = null;
  const commands = new Map([
    ['where', async () => { seen = process.cwd(); return EXIT.OK; }],
    ['boom', async () => { throw new Error('boom'); }],
  ]);
  const f = fakeIo();
  assert.equal(await main(['-C', fx.root, 'where'], f.io, { commands }), EXIT.OK);
  assert.equal(seen, realpathSync(fx.root));
  assert.equal(process.cwd(), before);
  assert.equal(await main(['-C', fx.root, 'boom'], fakeIo().io, { commands }), EXIT.FAILURE);
  assert.equal(process.cwd(), before);
});

test('-C <vault> propose from a directory outside it reads --only paths from the vault and opens the pull request there', () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const outside = join(world.base, 'outside');
  mkdirSync(outside);
  const r = kitIn(['-C', world.vault, 'propose', 'Add A', '--only', 'notes/a.md'], { cwd: outside, env: world.env });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  const create = world.ghCalls().find((call) => call.args[1] === 'create');
  const branch = create.args[create.args.indexOf('--head') + 1];
  assert.deepEqual(world.changedIn(world.remoteSha(`refs/heads/${branch}`)), ['A\tnotes/a.md']);
  const refused = kitIn(['propose', 'Add A', '--only', 'notes/a.md'], { cwd: outside, env: world.env });
  assert.equal(refused.status, EXIT.USAGE, 'without -C the same command finds no vault');
});
