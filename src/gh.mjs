// How the kit asks `gh` whether it can open a pull request: is it there, and
// does it answer for the host the vault uses. `propose --dry` asks it before
// saying it would propose, and `doctor` (check `gh-auth`) asks it before
// saying the machine is ready, so both read the same answer from the same
// functions.
//
// THE QUESTION IS ASKED ABOUT ONE HOST. `gh auth status` with no host tests
// every account on every host gh knows, over the network, and exits 1 if any
// one of them has a problem, so a stale second account (or a second host with
// an old token) fails a vault whose own host works. It is asked about the
// host the vault's `origin` names, github.com while there is no origin yet,
// with `--hostname`. Even so, the answer is taken for what it is: exit 0 is
// the host's login confirmed; a non-zero exit is gh reporting a problem, said
// in gh's own words and never as a finding of the kit's; a run that did not
// finish (a timeout, a program that cannot be started) is a question not
// answered, which is neither of the two.

export const DEFAULT_HOST = 'github.com';

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

// The argument list that asks gh about one host.
export function authArgs(host) {
  return ['auth', 'status', '--hostname', host];
}

// The command that starts a login, for the host when there is one.
export function loginCommand(program, host = null) {
  return host === null ? `${program} auth login` : `${program} auth login --hostname ${host}`;
}

// The host a remote url names, lower case, or null for one that names none (a
// local path, a file url, anything that is not a url). Every form a clone
// has: https://[user[:password]@]host[:port]/path, ssh://[user@]host[:port]/
// path, git://host/path, and the scp-like [user@]host:path.
export function hostOfUrl(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  if (text === '' || /\s/.test(text)) return null;
  let host;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (scheme !== null) {
    if (scheme[1].toLowerCase() === 'file') return null;
    const authority = scheme[2].split('/')[0];
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
  } else {
    // A path ("/x", "./x", "../x") is no host, nor is a drive letter ("C:\x").
    if (/^[/.]/.test(text)) return null;
    const scp = /^(?:[^@/:]+@)?([^/:@]+):/.exec(text);
    if (scp === null || scp[1].length === 1) return null;
    host = scp[1];
  }
  return HOST.test(host) ? host.toLowerCase() : null;
}

// The host to ask gh about for a repository: the one `remote` names, else
// DEFAULT_HOST (no such remote yet, or a url that names no host).
// `askGit(args)` runs git in the repository, as the caller runs it, and
// returns run()'s result.
export function hostOfRemote(askGit, remote) {
  const got = askGit(['remote', 'get-url', remote]);
  return (got.status === 0 ? hostOfUrl(got.stdout) : null) ?? DEFAULT_HOST;
}

const MAX_DETAIL_CHARS = 300;

// The line of gh's output that says why, for a message: the first line with
// a sentence in it (gh prints the host name alone on a line before the
// reason), else the first line at all, else the exit status.
function detailOf(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, ' ')).filter((line) => line !== '');
  const line = lines.find((entry) => entry.includes(' ')) ?? lines[0] ?? `exit status ${result.status}`;
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS)}...` : line;
}

// The verdict on the result of running `<program> auth status --hostname
// <host>` (through src/exec.mjs, which never throws): { state: 'logged_in' }
// (exit 0), { state: 'absent' } (the program is not there), { state:
// 'unverified', error } (it did not finish: a timeout, or a program that
// cannot be started, `error` its code) or { state: 'problem', status, detail }
// (it ran and exited non-zero; `detail` is gh's own sentence).
export function authVerdict(result) {
  if (result.status === 0) return { state: 'logged_in' };
  if (result.errorCode === 'ENOENT') return { state: 'absent' };
  if (typeof result.errorCode === 'string') return { state: 'unverified', error: result.errorCode };
  return { state: 'problem', status: result.status, detail: detailOf(result) };
}
