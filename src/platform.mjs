// What differs on Windows, in one place (the report of 05/10/2026, the first
// run of the kit on Windows 10: docs/incidents.md). Each function takes the
// operating system as `platform`, defaulting to the one running, so the
// tests reach the Windows branch on any machine; production passes nothing.
//
// Four differences matter to the kit:
//   - A program on PATH has an extension (node.exe, gh.exe, brain-kit.cmd)
//     that a shell adds from PATHEXT; a name looked up as it is spelt is
//     never found. findProgram looks the way a shell does.
//   - A path is spelt with backslashes and a drive letter. Claude Code
//     reads a path in a permission rule in POSIX form (C:\Users\ana is
//     /c/Users/ana, "Permissions", code.claude.com, read on 06/10/2026),
//     and Git Bash, which runs every Bash command the model and the hooks
//     run, takes C:/Users/ana as it is. ruleFormOf and slashed give those
//     two spellings.
//   - Node reports 0666 for every directory and file whatever who may open
//     it: the mode says nothing, and chmod sets only the read-only flag.
//     Who may open a file is its ACL, read and set here by security
//     identifier (SID), never by account name, which Windows translates
//     ("BUILTIN\Administradores" on a Portuguese Windows).
//   - A batch file (.cmd, .bat) cannot be started without cmd.exe, and
//     Node refuses to start one without a shell since 18.20.2 and 20.12.2
//     (CVE-2024-27980). The kit never runs a shell (src/exec.mjs), so a
//     batch launcher is named as such, and where the kit needs what it
//     starts, the npm launcher's own target is read (npmShimTarget).
import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, win32 } from 'node:path';
import { run } from './exec.mjs';

export const WINDOWS = 'win32';

export function isWindows(platform = process.platform) {
  return platform === WINDOWS;
}

// PATHEXT when the environment does not set it: the default of Windows 10.
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
// The extensions a process can be started from without a shell.
const DIRECT_EXTENSIONS = Object.freeze(['.exe', '.com']);
const BATCH_EXTENSIONS = Object.freeze(['.cmd', '.bat']);

// A variable of `env` by name. Windows reads its environment without regard
// to case, and its PATH is usually spelt `Path`: process.env answers either
// spelling, but a copy of it ({ ...process.env }) keeps the one it had, and
// `env.PATH` of a copy is undefined there. So on Windows the name is matched
// in any case, PATH spelt as it is first.
export function envValue(env, name, platform = process.platform) {
  if (env === null || typeof env !== 'object') return undefined;
  if (env[name] !== undefined || !isWindows(platform)) return env[name];
  const key = Object.keys(env).find((each) => each.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// The directories of the environment's PATH, split at the platform's own
// separator (; on Windows, : elsewhere).
export function pathEntries(env, platform = process.platform) {
  return String(envValue(env, 'PATH', platform) ?? '').split(isWindows(platform) ? ';' : ':');
}

// `env` with `dirs` in front of its PATH, joined at the platform's
// separator, and every other spelling of the name dropped (a copy of a
// Windows environment holds `Path`; left beside a new `PATH`, which of the
// two a child reads would be Node's choice, not the kit's).
export function withPathPrefix(env, dirs, platform = process.platform) {
  const current = envValue(env, 'PATH', platform) ?? '';
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (isWindows(platform) && key.toUpperCase() === 'PATH') continue;
    if (key === 'PATH') continue;
    out[key] = value;
  }
  out.PATH = [...dirs, current].filter((part) => part !== '').join(isWindows(platform) ? ';' : ':');
  return out;
}

function pathExtensions(env) {
  const configured = envValue(env, 'PATHEXT', WINDOWS);
  const text = typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_PATHEXT;
  return text.split(';').map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith('.'));
}

// The file names a shell tries for `name`, in its order: on Windows the name
// with each PATHEXT extension, or the name alone when it already ends in
// one; elsewhere the name alone.
export function programNames(name, { platform = process.platform, env = process.env } = {}) {
  if (!isWindows(platform)) return [name];
  const extensions = pathExtensions(env);
  if (extensions.includes(extname(name).toLowerCase())) return [name];
  return extensions.map((ext) => `${name}${ext}`);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The first regular file `name` names in `dirs`, as a shell finds it, or
// null. Only absolute directories are searched (see doctor's
// findExecutable). `executable` is the test a candidate must pass besides
// being a file: on POSIX, the caller's execute-permission test; on Windows
// every file counts, as it does for the shell.
export function findProgram(name, dirs, { platform = process.platform, env = process.env, executable = isFile } = {}) {
  const names = programNames(name, { platform, env });
  for (const entry of dirs) {
    // A PATH entry of Windows may be quoted ("C:\Program Files\x"); the
    // shell drops the quotes.
    const dir = isWindows(platform) && typeof entry === 'string' ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (typeof dir !== 'string' || !(isWindows(platform) ? win32.isAbsolute(dir) : isAbsolute(dir))) continue;
    for (const each of names) {
      const candidate = join(dir, each);
      if (isWindows(platform) ? isFile(candidate) : executable(candidate)) return candidate;
    }
  }
  return null;
}

// Whether the kit can start the program at `path` without a shell: on
// Windows, an .exe or a .com; elsewhere anything.
export function startsWithoutShell(path, platform = process.platform) {
  if (!isWindows(platform)) return true;
  return DIRECT_EXTENSIONS.includes(extname(path).toLowerCase());
}

// Whether `path` is a batch launcher, which only cmd.exe starts.
export function isBatchFile(path, platform = process.platform) {
  return isWindows(platform) && BATCH_EXTENSIONS.includes(extname(path).toLowerCase());
}

const DRIVE_PATH = /^([A-Za-z]):[\\/]/;

// Whether `path` is a Windows path from a drive letter (C:\ or C:/).
export function isDrivePath(path) {
  return typeof path === 'string' && DRIVE_PATH.test(path);
}

// The path with its backslashes turned into slashes, on Windows: the form
// Git Bash and Node both take, and one a double-quoted bash word carries as
// it is. Unchanged elsewhere, where a backslash is a character of a name.
export function slashed(path, platform = process.platform) {
  return isWindows(platform) ? String(path).replace(/\\/g, '/') : path;
}

// The path as Claude Code reads it in a permission rule: on Windows, a
// drive path in POSIX form, the drive in lower case (C:\Users\ana is
// /c/Users/ana); every other path as it is. A rule then names it
// `//c/Users/ana`, the same `//` and absolute path as on POSIX.
export function ruleFormOf(path, platform = process.platform) {
  if (!isWindows(platform) || typeof path !== 'string') return path;
  const match = DRIVE_PATH.exec(path);
  if (match === null) return path;
  return `/${match[1].toLowerCase()}/${path.slice(3).replace(/\\/g, '/')}`;
}

// Whether a path in rule form is the root of a whole disk: / everywhere,
// and on Windows a drive (/c). A read rule under it would grant every file.
export function isDiskRoot(ruleForm, platform = process.platform) {
  const trimmed = String(ruleForm).replace(/\/+$/, '');
  if (trimmed === '') return true;
  return isWindows(platform) && /^\/[a-z]$/i.test(trimmed);
}

// --- npm launchers -----------------------------------------------------------

// The script an npm launcher starts. `npm install -g` writes three for each
// command on Windows: `<name>` (sh, for Git Bash), `<name>.cmd` and
// `<name>.ps1`, and each names its script relative to its own directory,
// as "$basedir/node_modules/<package>/<script>" in the sh one and
// "%dp0%\node_modules\<package>\<script>" in the cmd one. The absolute path
// of that script, or null when the file is not such a launcher. Read, never
// run: the sh one needs a shell the kit does not start, the cmd one cmd.exe.
const SHIM_MAX_BYTES = 8192;
const SH_TARGET = /"\$basedir\/(node_modules\/[^"$`\\]+)"/;
const CMD_TARGET = /"%dp0%\\(node_modules\\[^"%]+)"/;

export function npmShimTarget(file) {
  let text;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > SHIM_MAX_BYTES) return null;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = SH_TARGET.exec(text) ?? CMD_TARGET.exec(text);
  if (match === null) return null;
  const relative = match[1].split(/[\\/]/);
  if (relative.includes('..')) return null;
  return join(file, '..', ...relative);
}

// --- who may open a file, on Windows -----------------------------------------

// The identities a private file may grant access to, besides the person:
// the operating system itself and the machine's administrators, who can
// read every file anyway. Everyone else is someone the file was not meant
// for (a second account on the machine above all).
export const SYSTEM_SID = 'S-1-5-18';
export const ADMINISTRATORS_SID = 'S-1-5-32-544';
const SID = /^S-1-\d+(-\d+)+$/;
const ACL_TIMEOUT_MS = 30000;

// The security identifier of the account running this process, read from
// `whoami /user`, whose CSV row ends in it; null when it cannot be read.
// `deps.run` is the seam the tests use.
// The account does not change while a process runs, so the answer of the
// real `whoami` is kept; a seam's answer never is.
let ownSid = null;

export function currentUserSid({ env = process.env, run: runner } = {}) {
  if (runner === undefined && ownSid !== null) return ownSid;
  const r = (runner ?? run)('whoami', ['/user', '/fo', 'csv', '/nh'], { env, timeout: ACL_TIMEOUT_MS });
  if (r.status !== 0) return null;
  const fields = [...String(r.stdout).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const sid = fields.at(-1);
  if (typeof sid !== 'string' || !SID.test(sid)) return null;
  if (runner === undefined) ownSid = sid;
  return sid;
}

// Every access control entry of `path`, read by PowerShell's Get-Acl, as
// { sid, type: 'Allow' | 'Deny', rights } with `rights` the numeric
// FileSystemRights mask. The path travels in the environment, never inside
// the script, so no character of it can be read as code.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$acl = Get-Acl -LiteralPath $env:BRAIN_KIT_ACL_PATH',
  "foreach ($ace in $acl.Access) { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; '{0}|{1}|{2}' -f $sid, $ace.AccessControlType, [int64]$ace.FileSystemRights }",
].join('; ');

export function readAcl(path, { env = process.env, run: runner = run } = {}) {
  const r = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ACL_SCRIPT], {
    env: { ...env, BRAIN_KIT_ACL_PATH: path },
    timeout: ACL_TIMEOUT_MS,
  });
  if (r.status !== 0) return { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || `status ${r.status}` };
  const entries = [];
  for (const line of String(r.stdout).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const [sid, type, rights] = line.trim().split('|');
    if (!SID.test(sid ?? '') || (type !== 'Allow' && type !== 'Deny') || !/^-?\d+$/.test(rights ?? '')) {
      return { ok: false, error: `unreadable line: ${line.trim().slice(0, 120)}` };
    }
    entries.push({ sid, type, rights: Number(rights) });
  }
  return { ok: true, entries };
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
}

// Whether `path` is open to nobody but the person (and the system and the
// administrators): { state: 'private' }, { state: 'open', sids } naming the
// other identities an Allow entry grants anything to, or
// { state: 'unverified', error } when the ACL or the person's identity
// cannot be read. A Deny entry only takes access away, and never opens a
// file.
export function aclVerdict(path, deps = {}) {
  const user = currentUserSid(deps);
  if (user === null) return { state: 'unverified', error: 'whoami /user' };
  const read = readAcl(path, deps);
  if (!read.ok) return { state: 'unverified', error: read.error };
  const allowed = new Set([user, SYSTEM_SID, ADMINISTRATORS_SID]);
  const others = [...new Set(read.entries.filter((e) => e.type === 'Allow' && !allowed.has(e.sid)).map((e) => e.sid))];
  if (others.length > 0) return { state: 'open', sids: others };
  return { state: 'private' };
}

// Makes `path` open to the person, the system and the administrators only:
// what it inherited is dropped and each of the three is granted full
// control, the grant inherited by everything created under a directory.
// SIDs in icacls's `*S-1-...` form, so the account names Windows translates
// play no part. { ok } or { ok: false, error }; never throws.
export function restrictToOwner(path, { directory = true, ...deps } = {}) {
  const runner = deps.run ?? run;
  const user = currentUserSid(deps);
  if (user === null) return { ok: false, error: 'whoami /user' };
  const inherit = directory ? '(OI)(CI)' : '';
  const grants = [user, SYSTEM_SID, ADMINISTRATORS_SID].flatMap((sid) => ['/grant:r', `*${sid}:${inherit}F`]);
  const r = runner('icacls', [path, '/inheritance:r', ...grants], { env: deps.env ?? process.env, timeout: ACL_TIMEOUT_MS });
  if (r.status !== 0) return { ok: false, error: firstLine(r.stderr) || firstLine(r.stdout) || `status ${r.status}` };
  // Any explicit entry for another identity survives /inheritance:r; one
  // read afterwards says whether the file is really private now.
  const after = aclVerdict(path, deps);
  if (after.state === 'open') {
    const removals = after.sids.flatMap((sid) => ['/remove:g', `*${sid}`]);
    const again = runner('icacls', [path, ...removals], { env: deps.env ?? process.env, timeout: ACL_TIMEOUT_MS });
    if (again.status !== 0) return { ok: false, error: firstLine(again.stderr) || firstLine(again.stdout) || `status ${again.status}` };
  }
  return { ok: true };
}
