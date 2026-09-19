import { test } from 'node:test';
import { makeTempDir } from './helpers/tmp.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { stateDirFor, ensureStateDir, STATE_FILES } from '../src/state.mjs';

function tmpVaultPath(name = 'my-vault') {
  const parent = makeTempDir('brain-kit-vaultparent-');
  return join(parent, name);
}

test('stateDirFor honours BRAIN_KIT_STATE_DIR when set, ignoring the vault path', () => {
  const override = join(tmpdir(), 'wherever-the-override-points');
  const env = { BRAIN_KIT_STATE_DIR: override };
  assert.equal(stateDirFor('/some/vault', env), override);
  assert.equal(stateDirFor('/a/completely/different/vault', env), override);
});

test('without an override, stateDirFor derives a directory under XDG_STATE_HOME', () => {
  const stateHome = makeTempDir('brain-kit-statehome-');
  const vault = tmpVaultPath('alpha-vault');
  const dir = stateDirFor(vault, { XDG_STATE_HOME: stateHome });
  assert.ok(dir.startsWith(stateHome), `${dir} should live under ${stateHome}`);
});

test('the derived directory is readable by a human: it carries the vault directory name', () => {
  const stateHome = makeTempDir('brain-kit-statehome-');
  const vault = tmpVaultPath('my-readable-vault-name');
  const dir = stateDirFor(vault, { XDG_STATE_HOME: stateHome });
  assert.ok(basename(dir).startsWith('my-readable-vault-name'), basename(dir));
});

test('two different vault paths never collide', () => {
  const stateHome = makeTempDir('brain-kit-statehome-');
  const env = { XDG_STATE_HOME: stateHome };
  const a = stateDirFor(tmpVaultPath('same-name'), env);
  const b = stateDirFor(tmpVaultPath('same-name'), env);
  assert.notEqual(a, b, 'two distinct absolute paths, even with the same basename, must map to distinct directories');
});

test('the same vault path always yields the same directory', () => {
  const stateHome = makeTempDir('brain-kit-statehome-');
  const vault = tmpVaultPath('stable-vault');
  const env = { XDG_STATE_HOME: stateHome };
  assert.equal(stateDirFor(vault, env), stateDirFor(vault, env));
});

test('without XDG_STATE_HOME, stateDirFor falls back under ~/.local/state', () => {
  const vault = tmpVaultPath('fallback-vault');
  const dir = stateDirFor(vault, {});
  assert.ok(dir.startsWith(join(homedir(), '.local', 'state')), dir);
});

test('ensureStateDir creates the directory with mode 0700, and creates parents', () => {
  const root = makeTempDir('brain-kit-ensure-');
  const nested = join(root, 'does', 'not', 'exist', 'yet');
  ensureStateDir(nested);
  const info = statSync(nested);
  assert.ok(info.isDirectory());
  assert.equal(info.mode & 0o777, 0o700);
});

test('calling ensureStateDir twice is harmless', () => {
  const root = makeTempDir('brain-kit-ensure-twice-');
  const dir = join(root, 'state');
  ensureStateDir(dir);
  assert.doesNotThrow(() => ensureStateDir(dir));
  const info = statSync(dir);
  assert.ok(info.isDirectory());
  assert.equal(info.mode & 0o777, 0o700);
});

test('STATE_FILES names every file the later slices will write, and nothing collides', () => {
  const expectedKeys = ['LOCK', 'WATERMARK', 'LAST_RUN', 'SNAPSHOT', 'LOG_DIR', 'QUESTIONS_LOG'];
  for (const key of expectedKeys) {
    assert.equal(typeof STATE_FILES[key], 'string', `STATE_FILES.${key} must be a string`);
    assert.ok(STATE_FILES[key].length > 0, `STATE_FILES.${key} must not be empty`);
  }
  const names = Object.values(STATE_FILES);
  assert.equal(names.length, new Set(names).size, 'no two STATE_FILES entries may share a name');
});

test('STATE_FILES is frozen so no other module can invent or rename an entry', () => {
  assert.ok(Object.isFrozen(STATE_FILES));
});
