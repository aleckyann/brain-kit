// How the kit asks `gh` whether it can open a pull request: is it there, and
// is it logged in. `propose --dry` asks it before saying it would propose,
// and `doctor` (check `gh-auth`) asks it before saying the machine is ready,
// so both read the same answer from the same function.
//
// `gh auth status` exits 0 when gh holds a login and non-zero when it does
// not. It is the cheapest question gh has, but it is not guaranteed to stay
// off the network (newer gh versions check the token against the forge), so a
// non-zero answer is reported with gh's own words, never as a diagnosis of
// its own: the person reads what gh said.

export const AUTH_STATUS_ARGS = Object.freeze(['auth', 'status']);

// The command that fixes a logged-out gh, as a person would type it.
export function loginCommand(program) {
  return `${program} auth login`;
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

// The verdict on the result of running `<program> auth status` (through
// src/exec.mjs, which never throws): { state: 'logged_in' }, { state:
// 'absent' } (the program is not there), or { state: 'logged_out', status,
// detail } (it ran and said no).
export function authVerdict(result) {
  if (result.status === 0) return { state: 'logged_in' };
  if (result.errorCode === 'ENOENT') return { state: 'absent' };
  return { state: 'logged_out', status: result.status, detail: detailOf(result) };
}
