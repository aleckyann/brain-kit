// Repair the launcher stub an npm install of Claude Code leaves behind.
// Incident 14/09/2026 (again on 22/09, 30/09 and 03/10): the install step
// was skipped, bin/claude.exe stayed a stub of about 500 bytes, and every
// round died at the CLI check until a person ran the package's own
// install.cjs by hand. That script needs no network and writes only that
// one file, so a round may run it, but only when it is sure of what it
// touches and that nothing else is installing:
//
//   repairStub(cli, { env, now, platform, minAgeMs, timeoutMs, run })
//     -> { tried, fixed, skipped, said }
//
// `cli` is checkCli's result (it carries the stub's real path). Not tried,
// with `skipped`: 'not_stub' (the problem is another one), 'windows' (npm's
// shim there is a batch file), 'layout' (the real path is not
// <pkg>/bin/<file> of the @anthropic-ai/claude-code package with install.cjs
// a regular file, never a link) or 'young' (the stub is no more than
// `minAgeMs` old, so an install may be running, the CLI's own update
// included). Tried: `fixed` is the installer's own exit status, so the
// caller checks the CLI again; `said` is the first line the installer wrote
// to stderr (its last line is a fallback command with an absolute home
// path). The installer gets `env` and no shell: pass the person's, never the
// round's, which carries the round token.
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const CLI_PACKAGE = '@anthropic-ai/claude-code';
export const STUB_MIN_AGE_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 120000;
const SAID_CHARS = 200;

function installerOf(realPath) {
  if (typeof realPath !== 'string' || basename(dirname(realPath)) !== 'bin') return null;
  const pkg = dirname(dirname(realPath));
  const install = join(pkg, 'install.cjs');
  try {
    if (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).name !== CLI_PACKAGE) return null;
    return lstatSync(install).isFile() ? install : null;
  } catch {
    return null;
  }
}

export function repairStub(cli, { env = process.env, now = new Date(), platform = process.platform, minAgeMs = STUB_MIN_AGE_MS, timeoutMs = INSTALL_TIMEOUT_MS, run = spawnSync } = {}) {
  const skip = (skipped) => ({ tried: false, fixed: false, skipped, said: null });
  if (cli.problem !== 'stub') return skip('not_stub');
  if (platform === 'win32') return skip('windows');
  const install = installerOf(cli.realPath);
  if (install === null) return skip('layout');
  if (now.getTime() - statSync(cli.realPath).mtimeMs <= minAgeMs) return skip('young');
  const r = run(process.execPath, [install], { env, timeout: timeoutMs, encoding: 'utf8' });
  const fixed = !r.error && r.status === 0;
  const line = `${r.stderr ?? ''}`.split('\n').map((l) => l.trim()).find((l) => l !== '');
  const said = line ?? (r.error ? r.error.code ?? r.error.message : fixed ? null : `exit ${r.status}`);
  return { tried: true, fixed, skipped: null, said: said?.slice(0, SAID_CHARS) ?? null };
}
