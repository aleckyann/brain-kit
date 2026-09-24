// Is the Claude Code CLI a usable program, before a round spends anything
// on it? docs/incidents.md, 14/09/2026: a reinstall skipped its post install
// step and left a launcher of about 500 bytes where the native binary
// (hundreds of megabytes) should be; for two days every round died on it,
// and `--version` printed error text instead of a number. PATH finding the
// file proves nothing.
//
// Problems: `missing` (no such file on the path given or on PATH), `stub`
// (a file under 2 KB), `version` (`--version` fails, times out, or prints
// something that does not start with a dotted version number).
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const STUB_MAX_BYTES = 2048;
const VERSION_RE = /^\d+\.\d+\.\d+/;
const VERSION_TIMEOUT_MS = 30000;

// A bare name is looked up on PATH, the way spawn would find it.
export function resolveCliPath(claudeBin, env = process.env) {
  if (typeof claudeBin !== 'string' || claudeBin === '') return null;
  if (isAbsolute(claudeBin) || claudeBin.includes('/') || claudeBin.includes('\\')) return resolve(claudeBin);
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, claudeBin);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export function checkCli(claudeBin, { env = process.env, timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  const bin = String(claudeBin);
  const path = resolveCliPath(claudeBin, env);
  let size = null;
  if (path !== null) {
    try {
      const st = statSync(path);
      if (st.isFile()) size = st.size;
    } catch {
      size = null;
    }
  }
  if (size === null) {
    return { ok: false, problem: 'missing', version: null, messageKey: 'harness.cli.missing', params: { bin } };
  }
  if (size < STUB_MAX_BYTES) {
    const bytes = size;
    return { ok: false, problem: 'stub', version: null, messageKey: 'harness.cli.stub', params: { bin, bytes } };
  }
  const r = spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: timeoutMs });
  const printed = `${r.stdout ?? ''}`.trim();
  const match = r.error || r.status !== 0 ? null : VERSION_RE.exec(printed);
  if (!match) {
    const output = (printed || `${r.stderr ?? ''}`.trim() || (r.error ? r.error.code ?? String(r.error) : '')).split('\n')[0].slice(0, 200);
    return { ok: false, problem: 'version', version: null, messageKey: 'harness.cli.version', params: { bin, output } };
  }
  return { ok: true, problem: null, version: match[0], messageKey: null, params: null };
}
