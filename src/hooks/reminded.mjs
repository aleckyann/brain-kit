// What the Stop hook has already asked a session to propose (the report of
// 05/10/2026: Claude Code fires Stop at the end of every reply, not only
// when a session ends, so an interview of ten captures was stopped ten
// times, each asking for a `propose` of the same log). The hook asks once
// for each path a session changed, and remembers which; a later reply that
// changed only paths it already asked about is released, with a line on
// stderr. The next session to start in this working tree reads the record
// and tells its model which of those paths were left unproposed
// (src/hooks/session-start.mjs).
//
// One record per working tree, in its git directory (never the working
// tree, which the hooks only read): `{ "format": 1, "session": "<id>",
// "paths": ["<decoded path>", ...] }`, written whole to a private temporary
// file renamed into place. A record of another session is the previous
// session's: the Stop hook of a new session starts its own. A record that
// cannot be read or written is no record: the hook then asks as it did
// before, every reply, the safe direction.
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locateRepository } from '../guards/location.mjs';

export const REMINDED_NAME = 'brain-kit-stop-reminded.json';
const FORMAT = 1;

export function remindedPath(root, env = process.env) {
  return join(locateRepository(root, env).gitDir, REMINDED_NAME);
}

// { session, paths } or null (absent, unreadable, or of another shape).
export function readReminded(root, env = process.env) {
  let value;
  try {
    value = JSON.parse(readFileSync(remindedPath(root, env), 'utf8'));
  } catch {
    return null;
  }
  const ok = value !== null && typeof value === 'object' && value.format === FORMAT
    && typeof value.session === 'string' && value.session !== ''
    && Array.isArray(value.paths) && value.paths.every((path) => typeof path === 'string' && path !== '');
  return ok ? { session: value.session, paths: value.paths } : null;
}

// True when the record now holds `session` and `paths`.
export function writeReminded(root, env, { session, paths }) {
  let file;
  try {
    file = remindedPath(root, env);
  } catch {
    return false;
  }
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ format: FORMAT, session, paths: [...paths].sort() })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}
