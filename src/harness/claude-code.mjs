// Runs Claude Code headless for one round: builds the argument vector,
// feeds the prompt on standard input and reads the stream-json output into
// a round record (src/harness/stream.mjs).
//
// ISOLATION. Measured on 24/09/2026 with Claude Code 2.1.281: a default
// `claude -p` inherits the person's own permission mode (`auto` on the
// maintainer's machine), user hooks, user allow rules and every MCP server,
// and under that a command in --disallowedTools and a command outside the
// allowlist both ran, exit 0, no denial reported. `--permission-mode
// dontAsk` alone was not enough either: a user hook that rewrote `curl` into
// another command, plus a user allow rule for the rewritten form, let a
// disallowed command run. What held is the set below, with the argument
// after --setting-sources being the empty string (no user, project or local
// settings file is read, so no hook and no rule of the person's), plus
// --strict-mcp-config (no MCP server but the ones passed). `--setting-sources
// project` is NOT enough: a project SessionStart hook ran in a workspace
// never trusted, and every vault's own .claude/settings.json enables the
// brain-kit plugin, whose hooks would then run inside the round. The login
// is not a settings source and keeps working. src/guards/isolation.mjs
// checks, from the stream's own init event, that the flags took effect.
//
// `--verbose` is required: `-p --output-format stream-json` without it
// exits 1 ("When using --print, --output-format=stream-json requires
// --verbose"). The prompt never goes on the argument vector: `--` closes it
// and the prompt is written to standard input.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createStreamParser } from './stream.mjs';

export const ISOLATION_ARGS = Object.freeze([
  '-p',
  '--verbose',
  '--output-format', 'stream-json',
  '--permission-mode', 'dontAsk',
  '--permission-prompts', 'none',
  '--setting-sources', '',
  '--strict-mcp-config',
  '--no-session-persistence',
]);

function checkRules(label, rules) {
  if (!Array.isArray(rules)) throw new TypeError(`${label} must be an array of rules`);
  for (const rule of rules) {
    // A rule that starts with a dash would be read as the next option, and
    // an empty one as nothing at all.
    if (typeof rule !== 'string' || rule === '' || rule.startsWith('-')) {
      throw new TypeError(`${label}: not a permission rule: ${JSON.stringify(rule)}`);
    }
  }
}

export function buildArgv({ model, maxTurns, budgetUsd, allowed = [], disallowed = [] } = {}) {
  checkRules('allowed', allowed);
  checkRules('disallowed', disallowed);
  const argv = [...ISOLATION_ARGS];
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || model === '' || model.startsWith('-')) throw new TypeError(`not a model name: ${JSON.stringify(model)}`);
    argv.push('--model', model);
  }
  if (maxTurns !== undefined && maxTurns !== null) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new TypeError(`maxTurns must be a positive integer, got ${JSON.stringify(maxTurns)}`);
    argv.push('--max-turns', String(maxTurns));
  }
  if (budgetUsd !== undefined && budgetUsd !== null) {
    if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new TypeError(`budgetUsd must be a positive number, got ${JSON.stringify(budgetUsd)}`);
    argv.push('--max-budget-usd', String(budgetUsd));
  }
  if (allowed.length > 0) argv.push('--allowedTools', ...allowed);
  if (disallowed.length > 0) argv.push('--disallowedTools', ...disallowed);
  argv.push('--');
  return argv;
}

const STDERR_TAIL_BYTES = 4096;
const KILL_GRACE_MS = 5000;

// Spawns the CLI and resolves when the child has closed. The exit code is
// the child's own, from its `close` event, and from nowhere else: a round
// was once reported as a success from a status the scheduler computed
// (docs/incidents.md, 29/07/2026 and 21/08/2026). `exitCode` is null when
// the child died by a signal (then `signal` names it) or never started
// (then `spawnError` holds the error code).
//
// On timeout the child gets SIGTERM, then SIGKILL after a grace period;
// `timedOut` says the kill was ours.
export function runModel({ claudeBin, argv, prompt, cwd, env = process.env, timeoutMs, onLine, killGraceMs = KILL_GRACE_MS }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const parser = createStreamParser();
    let stderrTail = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let graceTimer = null;

    const child = spawn(claudeBin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

    const finish = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({ record: parser.record(), stderrTail, durationMs: Date.now() - started, timedOut, ...fields });
    };

    const decoder = new StringDecoder('utf8');
    let pending = '';
    const take = (line) => {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      parser.push(clean);
      if (onLine) onLine(clean);
    };
    child.stdout.on('data', (chunk) => {
      pending += decoder.write(chunk);
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        take(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // The child may exit without reading its input (a CLI that refuses its
    // flags); the broken pipe is not the round's failure, the exit code is.
    child.stdin.on('error', () => {});

    child.on('error', (error) => {
      // Never started (ENOENT, EACCES): no close event will carry a code.
      if (child.pid === undefined) finish({ exitCode: null, signal: null, spawnError: error.code ?? String(error) });
    });
    child.on('close', (code, signal) => {
      pending += decoder.end();
      if (pending !== '') take(pending);
      pending = '';
      finish({ exitCode: code, signal, spawnError: null });
    });

    if (timeoutMs !== undefined && timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        graceTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      }, timeoutMs);
    }

    if (child.pid !== undefined) child.stdin.end(prompt ?? '');
  });
}
