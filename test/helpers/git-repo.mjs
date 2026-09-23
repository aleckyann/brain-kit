// Throwaway git repositories for the guard tests. Every call carries a local
// identity and runs with the caller's git environment removed, so nothing
// here depends on the machine's git configuration or on a GIT_DIR the test
// runner happens to carry. Paths may be strings or Buffers (a file name
// that is not valid UTF-8 can only be a Buffer).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withoutLocalGitVars } from '../../src/git-env.mjs';
import { makeTempDir } from './tmp.mjs';

export const CLEAN_ENV = withoutLocalGitVars(process.env);

export function git(cwd, args, { input } = {}) {
  const result = spawnSync('git', ['-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', '-c', 'protocol.file.allow=always', ...args], {
    cwd, encoding: 'utf8', env: CLEAN_ENV, input,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// A path under `root`: `relPath` is a string, or a Buffer of raw bytes.
export function pathUnder(root, relPath) {
  return typeof relPath === 'string' ? join(root, relPath) : Buffer.concat([Buffer.from(`${root}/`), relPath]);
}

export function write(root, relPath, content) {
  const full = pathUnder(root, relPath);
  if (typeof relPath === 'string') mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// A repository at `<tmp>/vault`, its real path returned, with `files`
// committed when there are any.
export function makeRepo(files = {}, prefix = 'brain-kit-guard-') {
  const root = join(realpathSync(makeTempDir(prefix)), 'vault');
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  const entries = Object.entries(files);
  for (const [relPath, content] of entries) write(root, relPath, content);
  if (entries.length > 0) {
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'initial']);
  }
  return root;
}
