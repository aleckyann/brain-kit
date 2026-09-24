// A fake Claude Code transcripts tree, built in a temporary directory, for
// the tests of src/sources/transcripts-claude-code.mjs. No test reads a
// real ~/.claude/projects: every line here is built from the structure of
// Claude Code 2.1.281 transcripts (one JSON object per line; user,
// assistant, system and attachment lines carry an ISO `timestamp`;
// last-prompt, custom-title and mode lines carry none), with neutral
// content.
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { makeTempDir } from './tmp.mjs';
import { transcriptsSource } from '../../src/sources/transcripts-claude-code.mjs';

// The window of the tests: the day 23/09/2026 in a UTC-3 time zone.
export const FROM = new Date('2026-09-23T03:00:00.000Z');
export const TO = new Date('2026-09-24T03:00:00.000Z');
export const NOW = new Date('2026-09-24T12:30:00.000Z');
export const INSIDE = '2026-09-23T14:00:00.000Z';
export const WEEKS_AGO = '2026-08-31T15:00:00.000Z';
export const SIGNATURE = 'Second brain curator';
export const PROJECT = '-home-ana-vault';
export const OTHER_PROJECT = '-home-ana-code';

let counter = 0;
function uuid() {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

const SESSION = '11111111-2222-4333-8444-555555555555';

function base(type, timestamp) {
  return {
    type,
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/ana/vault',
    sessionId: SESSION,
    version: '2.1.281',
    gitBranch: 'main',
    entrypoint: 'cli',
    uuid: uuid(),
    timestamp,
  };
}

export function user(text, timestamp, extra = {}) {
  return { ...base('user', timestamp), message: { role: 'user', content: text }, permissionMode: 'default', promptId: uuid(), ...extra };
}

export function userBlocks(blocks, timestamp, extra = {}) {
  return { ...base('user', timestamp), message: { role: 'user', content: blocks }, ...extra };
}

export function toolResult(timestamp) {
  return userBlocks([{ type: 'tool_result', tool_use_id: 'toolu_fake_1', content: 'ok' }], timestamp);
}

export function meta(text, timestamp) {
  return user(text, timestamp, { isMeta: true });
}

export function assistant(text, timestamp) {
  return { ...base('assistant', timestamp), message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

export function system(timestamp) {
  return { ...base('system', timestamp), subtype: 'informational', content: 'note' };
}

export function customTitle() {
  return { type: 'custom-title', customTitle: 'A session of Ana', sessionId: SESSION };
}

export function lastPrompt() {
  return { type: 'last-prompt', lastPrompt: 'what did we decide', sessionId: SESSION };
}

export function mode() {
  return { type: 'mode', mode: 'default', sessionId: SESSION };
}

export function defaultConfig(lang = 'en') {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

// makeWorld({ include, exclude, cap, extraSignatures, lang, missingRoot })
export function makeWorld({
  include = [PROJECT],
  exclude = [],
  cap = 20,
  extraSignatures = [],
  lang = 'en',
  missingRoot = false,
} = {}) {
  const tmp = makeTempDir('bk-transcripts-');
  const root = join(tmp, 'projects');
  if (!missingRoot) mkdirSync(root);
  const config = defaultConfig(lang);
  config.lang = lang;
  config.curate.signature = SIGNATURE;
  config.curate.extra_signatures = extraSignatures;
  config.curate.caps = { ...config.curate.caps, transcripts: cap };
  config.sources.transcripts.include_projects = include;
  config.sources.transcripts.exclude_path_patterns = exclude;
  const machine = { transcripts_dir: root };

  // write(project, name, lines, { mtime }): lines are objects (one JSON
  // line each) or raw strings (written as they are, for malformed lines).
  function write(project, name, lines, { mtime = NOW } = {}) {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    const body = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
    writeFileSync(file, `${body}\n`);
    const when = mtime instanceof Date ? mtime : new Date(mtime);
    utimesSync(file, when, when);
    return file;
  }

  function collect(window = { from: FROM, to: TO }) {
    return transcriptsSource.collect({ window, config, machine, now: NOW });
  }

  return { tmp, root, config, machine, write, collect };
}

export function paths(plan) {
  return plan.files.map((file) => file.path);
}
