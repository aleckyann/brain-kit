// Throwaway vaults for the hook tests: a real `brain-kit init --yes` in a
// temporary directory, the state directory pinned there, the result
// committed so the tree starts clean, and the real hook spawned with JSON on
// standard input. The environment is built from nothing but what the kit
// needs, so a CLAUDE_PROJECT_DIR or a GIT_DIR the test runner carries can
// never point a hook at some other directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './git-repo.mjs';
import { makeTempDir } from './tmp.mjs';

export const BIN = fileURLToPath(new URL('../../bin/brain-kit.mjs', import.meta.url));

export function hookEnv(base, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: join(base, 'home'),
    USER: 'ana',
    LOGNAME: 'ana',
    TZ: 'UTC',
    BRAIN_KIT_LANG: 'en',
    BRAIN_KIT_STATE_DIR: join(base, 'state'),
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

// `{ base, root, env, stateDir }`: a vault at `<base>/<name>` made by init,
// committed, with machine.json in the pinned state directory.
export function makeHookVault({ lang = 'en', name = 'vault', commit = true } = {}) {
  const base = realpathSync(makeTempDir('brain-kit-hook-'));
  mkdirSync(join(base, 'home'));
  mkdirSync(join(base, 'elsewhere'));
  const env = hookEnv(base);
  const r = spawnSync(process.execPath, [BIN, 'init', join(base, name), '--yes', '--lang', lang], {
    cwd: base, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const root = join(base, name);
  if (commit) {
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'vault']);
  }
  return { base, root, env, stateDir: env.BRAIN_KIT_STATE_DIR };
}

// The real hook, run from a directory that is not the vault, so the vault
// can only be found through the payload.
export function runHookProcess(event, payload, { env, cwd }) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [BIN, 'hook', event], { input, env, cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
