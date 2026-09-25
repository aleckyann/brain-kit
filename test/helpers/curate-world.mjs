// A throwaway world for `brain-kit curate`: the propose world (a vault
// cloned from a bare remote on this machine, a fake `gh` first on PATH),
// plus a machine.json whose claude_bin is test/helpers/fake-claude.mjs, a
// network check that leaves a marker file, a notify command that records
// its arguments, a fake transcripts tree with one session inside
// yesterday (UTC, the fixture configuration's zone), and a scenario file
// for the fake claude. Nothing here reaches a network or a real claude.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Phase 3: the connector sources as a round in connector mode sees them.
export const CALENDAR_PREFIX = 'mcp__claude_ai_Google_Calendar__';
export const DRIVE_PREFIX = 'mcp__claude_ai_Google_Drive__';
export const PINNED_TOOLS = Object.freeze(['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'ToolSearch']);
export const CALENDAR_TOOLS = Object.freeze(['list_events', 'get_event', 'list_calendars'].map((s) => CALENDAR_PREFIX + s));
export const DRIVE_TOOLS = Object.freeze(['search_files', 'read_file_content', 'get_file_metadata'].map((s) => DRIVE_PREFIX + s));
export const CONNECTOR_TOOLS = Object.freeze([...PINNED_TOOLS, ...CALENDAR_TOOLS, ...DRIVE_TOOLS]);
// A title with an accent, as a person copies it from one of their own documents.
export const NOTES_TITLE = 'Notas de reunião';

// The init event's server list: each connector's status, null leaving it
// out (a connector disabled for Claude Code, or never connected).
export function connectorServers({ calendar = 'connected', drive = 'connected' } = {}) {
  const list = [{ name: 'plugin:example:tasks', status: 'connected', source: 'plugin' }];
  if (calendar !== null) list.push({ name: 'claude.ai Google Calendar', status: calendar, source: 'claudeai' });
  if (drive !== null) list.push({ name: 'claude.ai Google Drive', status: drive, source: 'claudeai' });
  return list;
}

// The configuration edit that turns the connector sources on, as a person
// does: the calendar with the owner's main calendar, the meeting notes with
// the title they confirmed.
export function withConnectors({ calendar = true, meetingNotes = true } = {}) {
  return (c) => {
    if (calendar) {
      c.sources.calendar.enabled = true;
      c.sources.calendar.calendars = ['primary'];
      c.sources.calendar.tool_suffixes = ['list_events', 'get_event', 'list_calendars'];
    }
    if (meetingNotes) {
      c.sources.meeting_notes.enabled = true;
      c.sources.meeting_notes.tool_suffixes = ['search_files', 'read_file_content', 'get_file_metadata'];
      c.sources.meeting_notes.search_title_contains = NOTES_TITLE;
    }
  };
}

// The first instant of a UTC day (the fixture configuration's zone).
export function dayStart(day) {
  return `${day}T00:00:00.000Z`;
}

// A listing of the owner's main calendar over [from, to), exactly as the
// calendar block asks for it, answered with `content` (JSON text).
export function listEvents(from, to, { calendarId = 'primary', content = '{"events":[]}', input = {}, ...rest } = {}) {
  return { name: `${CALENDAR_PREFIX}list_events`, input: { calendarId, startTime: from, endTime: to, eventType: ['DEFAULT'], pageSize: 250, timeZone: 'UTC', ...input }, content, ...rest };
}

// The meeting-notes search of a source whose first day is `firstDay`: the
// literal title and the bound 12 hours before that day (the fixture's
// window_hours_before_day).
export function searchNotes(firstDay, { content = '{"files":[]}', ...rest } = {}) {
  const since = new Date(Date.parse(dayStart(firstDay)) - 12 * 60 * 60 * 1000).toISOString().replace('.000Z', 'Z');
  return { name: `${DRIVE_PREFIX}search_files`, input: { query: `title contains '${NOTES_TITLE}' and modifiedTime > '${since}'` }, content, ...rest };
}

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
    launchLog: join(markers, 'claude-launches.jsonl'),
    launchCountFile: join(markers, 'claude-launch-count'),
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
  // The Claude Code user settings a round in connector mode reads: a
  // scratch directory of this world's own, never the person's ~/.claude.
  const claudeConfig = join(world.base, 'claude-config');
  mkdirSync(claudeConfig);
  writeFileSync(join(claudeConfig, 'settings.json'), '{}\n');
  const env = {
    ...world.env,
    FAKE_CLAUDE_SCENARIO: scenarioFile,
    BRAIN_KIT_LANG: 'en',
    BRAIN_KIT_LEAK_PATTERNS: patterns,
    CLAUDE_CONFIG_DIR: claudeConfig,
  };

  // The scenario of a round that reads the transcript and reports it. A
  // new scenario starts the launch count again.
  function scenario(fields = {}) {
    const { rewrite = {}, ...rest } = fields;
    rmSync(files.launchCountFile, { force: true });
    rmSync(files.launchLog, { force: true });
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
    claudeConfig,
    // The fake user settings.json a connector-mode round reads.
    userSettings(value) {
      writeFileSync(join(claudeConfig, 'settings.json'), `${JSON.stringify(value)}\n`);
    },
    // One entry per model launch of the last scenario: { launch, argv, stdin }.
    launches() {
      return existsSync(files.launchLog) ? readFileSync(files.launchLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
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
