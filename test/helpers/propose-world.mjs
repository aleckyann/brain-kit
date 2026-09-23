// A throwaway vault, its bare remote and a fake `gh`, for the tests of
// `brain-kit propose`. Built on ./sync-world.mjs (a real clone of a bare
// remote on this machine, no network), plus:
//
//   - a directory first on PATH holding a fake `gh` that records every call
//     (its arguments, and for `pr create` the body file's text, read while
//     it still exists) as one JSON line, and a link to the real git. The
//     fake's behaviour is chosen per run through FAKE_GH_MODE: `ok`;
//     `fail` (`pr create` exits 1); `unauth` (`pr create` exits 4 with the
//     message an unauthenticated gh prints); `otherbase` (`pr view`
//     reports a base other than the one requested); `otherhead` (`pr view`
//     reports another head branch); `viewfail` (`pr view` exits 1). `absentPath()` is a PATH with the real git and no gh at
//     all, so a gh installed on this machine can never answer a test.
//   - `fingerprint(dir)`: HEAD, the local branches and tags, the index's
//     bytes and every working-tree file's bytes, mode and modification
//     time, in one comparable value: what propose must never move.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git-repo.mjs';
import { gitProbe, makeWorld } from './sync-world.mjs';

export const NOW = new Date('2026-09-23T12:00:00.000Z');
export const BRANCH = 'bot/2026-09-23-12-00-00';
export const PR_URL = 'https://example.invalid/ana/vault/pull/7';

const FAKE_GH = (log) => `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.FAKE_GH_MODE || 'ok';
const log = ${JSON.stringify(log)};
const entry = { args };
const isCreate = args[0] === 'pr' && args[1] === 'create';
const isView = args[0] === 'pr' && args[1] === 'view';
if (isCreate) {
  const at = args.indexOf('--body-file');
  entry.body = at === -1 ? null : fs.readFileSync(args[at + 1], 'utf8');
}
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
fs.appendFileSync(log, JSON.stringify(entry) + '\\n');
if (isCreate) {
  if (mode === 'fail') { process.stderr.write('HTTP 422: Validation Failed (createPullRequest)\\n'); process.exit(1); }
  if (mode === 'unauth') { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4); }
  process.stdout.write('Creating pull request\\n${PR_URL}\\n');
  process.exit(0);
}
if (isView) {
  if (mode === 'viewfail') { process.stderr.write('no pull requests found for branch "' + args[2] + '"\\n'); process.exit(1); }
  const created = before.filter((e) => e.args[0] === 'pr' && e.args[1] === 'create').at(-1);
  const requested = created ? created.args[created.args.indexOf('--base') + 1] : null;
  const base = mode === 'otherbase' ? 'bot/2026-09-22-10-00-00' : requested;
  const head = mode === 'otherhead' ? 'someone-else/branch' : args[2];
  process.stdout.write(JSON.stringify({ baseRefName: base, headRefName: head, url: '${PR_URL}' }) + '\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unexpected call\\n');
process.exit(2);
`;

export function note(title, extra = '') {
  return `---\ntype: note\ntitle: ${title}\ndescription: A note about ${title}.\ngenerated:\n  by: brain-kit-curator/claude-opus-5-5\n  at: 2026-09-22T00:00:00+00:00\n${extra}---\n\n# ${title}\n`;
}

export function makeProposeWorld(options = {}) {
  const world = makeWorld({ prefix: 'brain-kit-propose-', ...options });
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: world.env }).stdout.trim();
  const bin = join(world.base, 'fakebin');
  mkdirSync(bin);
  const log = join(world.base, 'gh-calls.jsonl');
  writeFileSync(join(bin, 'gh'), FAKE_GH(log));
  chmodSync(join(bin, 'gh'), 0o755);
  const gitOnly = join(world.base, 'gitonly');
  mkdirSync(gitOnly);
  symlinkSync(realGit, join(gitOnly, 'git'));
  const env = { ...world.env, PATH: `${bin}:${world.env.PATH}`, FAKE_GH_MODE: 'ok' };
  // The temporary directory propose is handed, so a test can see exactly
  // what it leaves behind.
  const tmp = join(world.base, 'tmp');
  mkdirSync(tmp);
  return {
    ...world,
    env,
    tmp,
    ghLog: log,
    // A PATH holding the real git and nothing else: no gh anywhere.
    absentPath: () => gitOnly,
    ghCalls() {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
    write(rel, content) {
      const full = join(world.vault, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    },
    remoteRefs() {
      return git(world.remote, ['for-each-ref', '--format=%(refname) %(objectname)']);
    },
    remoteSha(ref) {
      const result = gitProbe(world.remote, ['rev-parse', '-q', '--verify', ref]);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    // What the pushed commit changes against its parent, as "STATUS\tpath" lines.
    changedIn(commit) {
      return git(world.remote, ['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-status', `${commit}^`, commit]).trim().split('\n').filter(Boolean);
    },
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function files(root, rel = '', out = {}) {
  for (const entry of readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (path === '.git') continue;
    const full = join(root, path);
    const st = lstatSync(full);
    if (entry.isDirectory()) {
      out[`${path}/`] = { mode: st.mode, mtime: st.mtimeMs };
      files(root, path, out);
    } else {
      out[path] = { mode: st.mode, mtime: st.mtimeMs, sha: entry.isSymbolicLink() ? null : sha256(readFileSync(full)) };
    }
  }
  return out;
}

export function fingerprint(dir) {
  const head = gitProbe(dir, ['symbolic-ref', '-q', 'HEAD']);
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    headSha: gitProbe(dir, ['rev-parse', '-q', '--verify', 'HEAD']).stdout.trim(),
    refs: git(dir, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']),
    index: sha256(readFileSync(join(dir, '.git', 'index'))),
    files: files(dir),
  };
}
