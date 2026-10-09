// 14/09/2026, third time over (22/09, 30/09 and 03/10 too): an npm install of
// Claude Code skipped its post install step and left a launcher stub of about
// 500 bytes where the native binary should be, and every round died at the
// CLI check until a person ran the package's own install.cjs by hand. The
// rule: a round repairs that stub itself, and only when it is sure what it
// is touching and that no install is running: not Windows, the real path is
// <pkg>/bin/<file> of the Claude Code package with install.cjs a regular file,
// and the stub is more than 10 minutes old. The installer runs with the
// person's environment (never the round's, which carries its token), and
// `checkCli`, which doctor uses too, stays free of side effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { checkCli, STUB_MAX_BYTES } from '../../src/guards/cli.mjs';
import { repairStub } from '../../src/guards/cli-repair.mjs';
import { makeCurateWorld, FAKE } from '../helpers/curate-world.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const SKIP = process.platform === 'win32' ? 'the stand-in launcher is a shell script' : false;
const MINUTE = 60 * 1000;
const STUB = `#!/bin/sh\n# launcher\n${'#'.repeat(500 - 22)}\n`;
// What the package's own install step leaves: a launcher past 2 KB that runs
// the fake claude, standing in for the native binary.
const NATIVE = `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n${'#'.repeat(STUB_MAX_BYTES)}\n`;
const FIXING_INSTALLER = (marker) => `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ token: process.env.BRAIN_KIT_ROUND_TOKEN ?? 'absent', mark: process.env.ANA_MARK ?? 'unset' }));
fs.writeFileSync(path.join(__dirname, 'bin', 'claude.exe'), ${JSON.stringify(NATIVE)});
`;
const FAILING_INSTALLER = 'process.stderr.write("boom: no native package\\nFallback: node /home/ana/x.cjs\\n"); process.exit(1);\n';

// <dir>/pkg is the npm package, <dir>/bin/claude the link npm puts on PATH.
// `installer` is the body of install.cjs; the stub is `minutes` old. `env`
// is the person's, with the scenario the fake claude answers --version from.
function fakePackage(dir, { installer = FIXING_INSTALLER(join(dir, 'marker.json')), name = '@anthropic-ai/claude-code', minutes = 20, binDir = 'bin', installLink = false } = {}) {
  const pkg = join(dir, 'pkg');
  mkdirSync(join(pkg, binDir), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name }));
  const stub = join(pkg, binDir, 'claude.exe');
  writeFileSync(stub, STUB, { mode: 0o755 });
  const then = new Date(Date.now() - minutes * MINUTE);
  utimesSync(stub, then, then);
  const install = join(pkg, 'install.cjs');
  if (installLink) {
    writeFileSync(join(pkg, 'real-install.cjs'), installer);
    symlinkSync(join(pkg, 'real-install.cjs'), install);
  } else {
    writeFileSync(install, installer);
  }
  const link = join(dir, 'bin', 'claude');
  symlinkSync(stub, link);
  const scenario = join(dir, 'scenario.json');
  writeFileSync(scenario, '{}');
  return { pkg, stub, link, marker: join(dir, 'marker.json'), env: { PATH: process.env.PATH, ANA_MARK: 'given', FAKE_CLAUDE_SCENARIO: scenario } };
}

const repair = ({ link, env }, options = {}) => repairStub(checkCli(link, { env }), { env, ...options });

test('the 14/09/2026 stub, found through the symlink npm puts on PATH, is reinstalled and the CLI then answers', { skip: SKIP }, () => {
  const { stub, link, marker, env } = fakePackage(makeTempDir('brain-kit-incident-0914-repair-'));
  const before = checkCli(link, { env });
  assert.equal(before.problem, 'stub');
  assert.equal(before.realPath, realpathSync(stub), 'the stub is named by its real path, not by the link');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(repairStub(before, { env }), { tried: true, fixed: true, skipped: null, said: null });
  const after = checkCli(link, { env });
  assert.deepEqual([after.ok, after.version], [true, '2.1.281']);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { token: 'absent', mark: 'given' }, 'the installer ran with the environment it was given');
});

test('checkCli has no side effect: a stub it reports stays the stub, byte for byte', { skip: SKIP }, () => {
  const { stub, link, env } = fakePackage(makeTempDir('brain-kit-incident-0914-repair-'));
  checkCli(link, { env });
  checkCli(link, { env });
  assert.equal(readFileSync(stub, 'utf8'), STUB);
});

// Each refusal leaves the stub as it was; the nearest positive case is the
// test above, the same package with one condition broken.
const REFUSALS = [
  ['Windows (npm puts a batch file there, never a stub to reinstall)', {}, { platform: 'win32' }, 'windows'],
  ['a package that is not Claude Code', { name: 'other' }, {}, 'layout'],
  ['a stub that is not under <pkg>/bin', { binDir: 'dist' }, {}, 'layout'],
  ['an install.cjs that is a symlink', { installLink: true }, {}, 'layout'],
  ['a stub 5 minutes old (an install may be running, the CLI updating itself included)', { minutes: 5 }, {}, 'young'],
];
for (const [name, packageOptions, repairOptions, skipped] of REFUSALS) {
  test(`no repair for ${name}`, { skip: SKIP }, () => {
    const p = fakePackage(makeTempDir('brain-kit-incident-0914-repair-'), packageOptions);
    const { stub, marker } = p;
    const r = repair(p, repairOptions);
    assert.deepEqual(r, { tried: false, fixed: false, skipped, said: null });
    assert.equal(readFileSync(stub, 'utf8'), STUB);
    assert.throws(() => readFileSync(marker), { code: 'ENOENT' }, 'the installer never ran');
  });
}

test('no repair when the CLI is not a stub (its --version fails)', { skip: SKIP }, () => {
  const dir = makeTempDir('brain-kit-incident-0914-repair-');
  const { link, marker, env } = fakePackage(dir);
  writeFileSync(join(dir, 'pkg', 'bin', 'claude.exe'), `#!/bin/sh\necho "Error: no native binary"\n${'#'.repeat(STUB_MAX_BYTES)}\n`, { mode: 0o755 });
  const cli = checkCli(link, { env });
  assert.equal(cli.problem, 'version');
  assert.deepEqual(repairStub(cli, { env }), { tried: false, fixed: false, skipped: 'not_stub', said: null });
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
});

test('an installer that fails is tried, not fixed, and quoted by its first line only', { skip: SKIP }, () => {
  const p = fakePackage(makeTempDir('brain-kit-incident-0914-repair-'), { installer: FAILING_INSTALLER });
  const r = repair(p);
  assert.deepEqual(r, { tried: true, fixed: false, skipped: null, said: 'boom: no native package' });
  assert.equal(readFileSync(p.stub, 'utf8'), STUB);
});

test('an installer that outlives its timeout is tried, not fixed, and named by the error', { skip: SKIP }, () => {
  const p = fakePackage(makeTempDir('brain-kit-incident-0914-repair-'), { installer: 'setTimeout(() => {}, 60000);\n' });
  const r = repair(p, { timeoutMs: 300 });
  assert.deepEqual([r.tried, r.fixed, r.skipped, r.said], [true, false, null, 'ETIMEDOUT']);
});

// The round: the package lives in the world's own directory, the link in
// the machine's claude_bin.
function stubbedWorld(packageOptions = {}) {
  const w = makeCurateWorld();
  const dir = join(w.base, 'npm');
  const pkg = fakePackage(dir, packageOptions);
  w.setMachine({ claude_bin: pkg.link });
  return { w, ...pkg };
}

test('a round that meets the 14/09/2026 stub reinstalls it, records the repair and reaches the model', { skip: SKIP }, () => {
  const { w, marker } = stubbedWorld();
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.ok(w.launches().length >= 1, 'the model was launched');
  assert.deepEqual(w.lastRun().repairs, [{ kind: 'cli_reinstalled', version: '2.1.281' }]);
  assert.match(w.logText(), /cli_repair \{"tried":true,"fixed":true/);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')).token, 'absent', 'the round token never reaches the installer');
});

test('a round whose installer fails exits 1 as cli_stub, quotes the first line it said and no home path', { skip: SKIP }, () => {
  const { w, stub } = stubbedWorld({ installer: FAILING_INSTALLER });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'cli_stub');
  assert.match(last.reason, /launcher stub/);
  assert.match(last.reason, /tried to reinstall it and the installer said: boom: no native package$/);
  assert.doesNotMatch(`${last.reason}${r.stdout}${r.stderr}`, /\/home\/ana/);
  assert.deepEqual(last.repairs, []);
  assert.equal(w.launches().length, 0, 'no model was launched');
  assert.equal(readFileSync(stub, 'utf8'), STUB);
  assert.match(w.logText(), /cli_repair \{"tried":true,"fixed":false/);
});

test('the nearest positive case of the round: a stub 5 minutes old is not touched, fails as before and is logged as skipped', { skip: SKIP }, () => {
  const { w, marker } = stubbedWorld({ minutes: 5 });
  const r = w.curate();
  assert.equal(r.status, EXIT.FAILURE);
  const last = w.lastRun();
  assert.equal(last.reasonCode, 'cli_stub');
  assert.doesNotMatch(last.reason, /reinstall/);
  assert.deepEqual(last.repairs, []);
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  assert.match(w.logText(), /cli_repair \{"tried":false,"fixed":false,"skipped":"young"/);
});

test('a round with a good CLI logs nothing about a repair', () => {
  const w = makeCurateWorld();
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  assert.deepEqual(w.lastRun().repairs, []);
  assert.doesNotMatch(w.logText(), /cli_repair/);
});
