// Wait for the network inside the round, before anything that needs it.
//
// docs/incidents.md, 11/08/2026: a round fired in the second the machine
// woke up, five seconds before the network came up, and its remote sources
// vanished without an error. So the wait lives in the engine, not in the
// scheduler. And 29/08/2026: for three nights the guard called a check that
// waited for the network manager to start, not for a connection; it came
// back in 0.02 seconds with exit 0 and protected nothing. So a check that
// succeeds on its FIRST try in under `minWaitMs` is accepted but reported
// `did_not_wait`, for the log and for `doctor` to show: it may be answering
// about something other than the connection.
//
//   waitForNetwork(check, { timeoutMs, minWaitMs = 100, intervalMs = 1000 }, deps)
//     -> Promise<{ ok, waitedMs, attempts, warning: 'did_not_wait' | null }>
//
// `check` is `machine.network_check`, an argument vector run without a
// shell (exit 0 is success), or, when unset, a TCP connection to
// api.anthropic.com:443, the endpoint the round actually needs. A function
// returning a boolean (or a promise of one) is accepted too, for callers
// that already hold a check. Retried every `intervalMs` until `timeoutMs`
// has passed: then `ok: false`, and `curate` exits 69.
//
// Every attempt is bounded by what is left of the timeout, and an argument
// vector still running at its bound is killed: an unattended round must not
// leave a child behind.
//
// `deps` carries `now`, `sleep`, `connect(host, port, timeoutMs)` and
// `runArgv(argv, timeoutMs)` for the tests, which never touch the network.
// Production passes nothing.
import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';

export const DEFAULT_HOST = 'api.anthropic.com';
export const DEFAULT_PORT = 443;
export const DEFAULT_TIMEOUT_MS = 120000;
export const DEFAULT_MIN_WAIT_MS = 100;
export const DEFAULT_INTERVAL_MS = 1000;
const ATTEMPT_CAP_MS = 10000;

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const socket = netConnect({ host, port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function runArgvCheck(argv, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let child;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(ok);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', shell: false });
    } catch {
      finish(false);
      return;
    }
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function attemptFor(check, deps) {
  if (typeof check === 'function') return async () => (await check()) === true;
  if (Array.isArray(check) && check.length > 0) {
    if (!check.every((part) => typeof part === 'string') || check[0] === '') {
      throw new TypeError('network_check must be an argument vector of strings');
    }
    return (limitMs) => deps.runArgv(check, limitMs);
  }
  if (check === null || check === undefined || (Array.isArray(check) && check.length === 0)) {
    return (limitMs) => deps.connect(DEFAULT_HOST, DEFAULT_PORT, limitMs);
  }
  throw new TypeError('network_check must be an argument vector, a function, or unset');
}

export async function waitForNetwork(check, {
  timeoutMs = DEFAULT_TIMEOUT_MS, minWaitMs = DEFAULT_MIN_WAIT_MS, intervalMs = DEFAULT_INTERVAL_MS,
} = {}, deps = {}) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const attempt = attemptFor(check, { connect: deps.connect ?? tcpConnect, runArgv: deps.runArgv ?? runArgvCheck });
  const start = now();
  let attempts = 0;
  for (;;) {
    const left = timeoutMs - (now() - start);
    attempts += 1;
    let ok = false;
    try {
      ok = (await attempt(Math.max(1, Math.min(left, ATTEMPT_CAP_MS)))) === true;
    } catch {
      ok = false;
    }
    const waitedMs = now() - start;
    if (ok) {
      const warning = attempts === 1 && waitedMs < minWaitMs ? 'did_not_wait' : null;
      return { ok: true, waitedMs, attempts, warning };
    }
    if (waitedMs + intervalMs > timeoutMs) return { ok: false, waitedMs, attempts, warning: null };
    await sleep(intervalMs);
  }
}
