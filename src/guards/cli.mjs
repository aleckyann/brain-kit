// Is the Claude Code CLI a usable program, before a round spends anything
// on it? docs/incidents.md, 14/09/2026: a reinstall skipped its post install
// step and left a launcher of about 500 bytes where the native binary
// (hundreds of megabytes) should be; for two days every round died on it,
// and `--version` printed error text instead of a number. PATH finding the
// file proves nothing.
//
// Problems: `missing` (no such file on the path given or on PATH), `batch`
// (a Windows batch launcher, which only cmd.exe starts), `stub`
// (a file under 2 KB), `version` (`--version` fails, times out, or prints
// something that does not start with a dotted version number).
// Every result carries `realPath`, the file behind any symlink (npm's
// claude is a link to the package's bin/claude.exe), or null when there is
// none to resolve; checkCli itself never changes anything.
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { findProgram, isBatchFile, pathEntries } from '../platform.mjs';
import { spawnSync } from 'node:child_process';

export const STUB_MAX_BYTES = 2048;
const VERSION_RE = /^\d+\.\d+\.\d+/;
const VERSION_TIMEOUT_MS = 30000;

// A bare name is looked up on PATH, the way a shell would find it (on
// Windows with PATHEXT's extensions: the native install is claude.exe).
export function resolveCliPath(claudeBin, env = process.env, platform = process.platform) {
  if (typeof claudeBin !== 'string' || claudeBin === '') return null;
  if (isAbsolute(claudeBin) || claudeBin.includes('/') || claudeBin.includes('\\')) return resolve(claudeBin);
  const executable = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  return findProgram(claudeBin, pathEntries(env, platform), { platform, env, executable });
}

export function checkCli(claudeBin, { env = process.env, timeoutMs = VERSION_TIMEOUT_MS, platform = process.platform } = {}) {
  const bin = String(claudeBin);
  const path = resolveCliPath(claudeBin, env, platform);
  let size = null;
  let realPath = null;
  if (path !== null) {
    try {
      const st = statSync(path);
      if (st.isFile()) size = st.size;
      realPath = realpathSync(path);
    } catch {
      size = null;
    }
  }
  if (size === null) {
    return { ok: false, problem: 'missing', version: null, messageKey: 'harness.cli.missing', params: { bin }, realPath };
  }
  // A batch launcher (npm's claude.cmd on Windows) is started by cmd.exe
  // only, and the kit never runs a shell (src/exec.mjs): the round could not
  // start it, whatever its size.
  if (isBatchFile(path, platform)) {
    return { ok: false, problem: 'batch', version: null, messageKey: 'harness.cli.batch', params: { bin: path }, realPath };
  }
  if (size < STUB_MAX_BYTES) {
    const bytes = size;
    return { ok: false, problem: 'stub', version: null, messageKey: 'harness.cli.stub', params: { bin, bytes }, realPath };
  }
  const r = spawnSync(path, ['--version'], { env, encoding: 'utf8', timeout: timeoutMs });
  const printed = `${r.stdout ?? ''}`.trim();
  const match = r.error || r.status !== 0 ? null : VERSION_RE.exec(printed);
  if (!match) {
    const output = (printed || `${r.stderr ?? ''}`.trim() || (r.error ? r.error.code ?? String(r.error) : '')).split('\n')[0].slice(0, 200);
    return { ok: false, problem: 'version', version: null, messageKey: 'harness.cli.version', params: { bin, output }, realPath };
  }
  return { ok: true, problem: null, version: match[0], messageKey: null, params: null, realPath };
}
