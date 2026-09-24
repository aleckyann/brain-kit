// A throwaway world for `brain-kit curate`: the propose world (a vault
// cloned from a bare remote on this machine, a fake `gh` first on PATH),
// plus a machine.json whose claude_bin is test/helpers/fake-claude.mjs, a
// network check that leaves a marker file, a notify command that records
// its arguments, a fake transcripts tree with one session inside
// yesterday (UTC, the fixture configuration's zone), and a scenario file
// for the fake claude. Nothing here reaches a network or a real claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../../src/version.mjs';
import { git } from './git-repo.mjs';
import { makeProposeWorld, note } from './propose-world.mjs';
import { user, assistant } from './transcripts-world.mjs';

export const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
export const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
export const STREAMS = join(KIT_ROOT, 'test', 'fixtures', 'stream');
export const PROJECT = '-home-ana-brain';
export { note };

const DAY_MS = 24 * 60 * 60 * 1000;

// Yesterday and today, as UTC calendar days, from the real clock (a CLI run
// cannot be handed a clock).
export function utcDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

export function makeCurateWorld({ machine: machineExtra = {}, config: editConfig = null } = {}) {
  const world = makeProposeWorld();
  const state = world.env.BRAIN_KIT_STATE_DIR;
  mkdirSync(state, { recursive: true, mode: 0o700 });

  // The vault's configuration, committed and pushed so sync finds it level.
  const configFile = join(world.vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (editConfig) editConfig(config);
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  git(world.vault, ['add', '-A']);
  git(world.vault, ['commit', '-q', '--allow-empty', '-m', 'curate world config']);
  git(world.vault, ['push', '-q', 'origin', 'main']);

  // One transcript with a message inside yesterday.
  const projects = join(world.base, 'projects');
  const projectDir = join(projects, PROJECT);
  mkdirSync(projectDir, { recursive: true });
  const yesterdayNoon = `${utcDay(-1)}T12:00:00.000Z`;
  const transcript = join(projectDir, 'aaaaaaaa-1111-4222-8333-444444444444.jsonl');
  writeFileSync(transcript, `${[user('Ana decided to cite the newer survey', yesterdayNoon), assistant('Noted.', yesterdayNoon)].map((l) => JSON.stringify(l)).join('\n')}\n`);

  const markers = join(world.base, 'markers');
  mkdirSync(markers);
  const networkMarker = join(markers, 'network');
  const notifyLog = join(markers, 'notify.jsonl');
  const scenarioFile = join(world.base, 'scenario.json');
  const files = {
    argvFile: join(markers, 'claude-argv.json'),
    stdinFile: join(markers, 'claude-stdin.txt'),
    recordFile: join(markers, 'claude-runs.jsonl'),
  };
  const machine = {
    vault_id: 'vault-00000000',
    canonical_path: world.vault,
    claude_bin: FAKE,
    model: null,
    network_check: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(networkMarker)}, '')`],
    notify_command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(notifyLog)}, JSON.stringify(process.argv.slice(1)) + '\\n')`],
    transcripts_dir: projects,
    paths: { watermark: join(state, 'watermark.json'), last_run: join(state, 'last-run.json'), log_dir: join(state, 'logs') },
    ...machineExtra,
  };
  const machineFile = join(state, 'machine.json');
  writeFileSync(machineFile, `${JSON.stringify(machine, null, 2)}\n`, { mode: 0o600 });

  const patterns = join(world.base, 'leak-patterns.txt');
  writeFileSync(patterns, 'zz-no-such-leak-zz\n');
  const env = {
    ...world.env,
    FAKE_CLAUDE_SCENARIO: scenarioFile,
    BRAIN_KIT_LANG: 'en',
    BRAIN_KIT_LEAK_PATTERNS: patterns,
  };

  // The scenario of a round that reads the transcript and reports it.
  function scenario(fields = {}) {
    const { rewrite = {}, ...rest } = fields;
    const value = {
      ...files,
      stream: join(STREAMS, 'isolated-run.jsonl'),
      rewrite: {
        toolUses: [{ name: 'Read', input: { file_path: transcript, offset: 1 } }],
        finalText: 'Round done.\nBRAIN_KIT_SOURCES: transcripts=ok',
        ...rewrite,
      },
      ...rest,
    };
    writeFileSync(scenarioFile, JSON.stringify(value));
    return value;
  }
  scenario();

  // The fake's action that runs the real propose, as the model would.
  const proposeAction = (...paths) => ({ run: [process.execPath, BIN, 'propose', 'Round notes', '--only', ...paths] });

  return {
    ...world,
    env,
    state,
    config,
    machine,
    machineFile,
    transcript,
    projects,
    networkMarker,
    notifyLog,
    files,
    scenario,
    proposeAction,
    setMachine(fields) {
      Object.assign(machine, fields);
      writeFileSync(machineFile, `${JSON.stringify(machine, null, 2)}\n`, { mode: 0o600 });
    },
    // `brain-kit curate` as a scheduler runs it, a process of its own.
    curate(args = [], extraEnv = {}) {
      assert.equal(machine.claude_bin, FAKE, 'this test must run the fake claude, never the real one');
      return spawnSync(process.execPath, [BIN, 'curate', ...args], { cwd: world.vault, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 120000 });
    },
    lastRun() {
      const file = join(state, 'last-run.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    },
    logText() {
      const dir = join(state, 'logs');
      if (!existsSync(dir)) return '';
      return readdirSync(dir).filter((n) => n.endsWith('.log')).map((n) => readFileSync(join(dir, n), 'utf8')).join('');
    },
    watermark() {
      const file = join(state, 'watermark.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).sources : null;
    },
    notifications() {
      return existsSync(notifyLog) ? readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    roundFiles() {
      return readdirSync(join(world.vault, '.git')).filter((n) => n.startsWith('brain-kit-round-') || n === 'brain-kit.lock');
    },
    status() {
      return git(world.vault, ['status', '--porcelain=v1', '--untracked-files=all']);
    },
  };
}
