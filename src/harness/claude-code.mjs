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
// TOOLS AND SKILLS. Measured on 24/09/2026 with Claude Code 2.1.281
// (docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md,
// measurement 3): with no --tools, a run exposes the default built-in set,
// which besides the tools below holds Task, Workflow, CronCreate,
// RemoteTrigger, SendMessage, Artifact and more, in both setting-source
// modes, and a Skill tool that loads skills. `--tools` with ROUND_TOOLS
// left exactly those built-in tools (MCP tools stay available), and
// `--disable-slash-commands` removed the Skill tool and every skill.
// ToolSearch stays in the set: a connector's tools are deferred, and the
// model loaded them through it before its first call (the controller's
// capture of 24/09/2026). src/guards/isolation.mjs checks, from the init
// event, that the built-in tools are exactly ROUND_TOOLS.
//
// `--verbose` is required: `-p --output-format stream-json` without it
// exits 1 ("When using --print, --output-format=stream-json requires
// --verbose"). The prompt never goes on the argument vector: `--` closes it
// and the prompt is written to standard input.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createStreamParser } from './stream.mjs';

export const ROUND_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'ToolSearch']);

export const ISOLATION_ARGS = Object.freeze([
  '-p',
  '--verbose',
  '--output-format', 'stream-json',
  '--permission-mode', 'dontAsk',
  '--permission-prompts', 'none',
  '--setting-sources', '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--tools', ROUND_TOOLS.join(','),
  '--no-session-persistence',
]);

// Built-in tools whose rule takes a scope, a path or a command. Allowed by
// its bare name, such a tool is granted on every file or every command:
// phase 2's round allowed a bare Read, which could read any file on disk
// (measurement 4 of the phase 3 plan). No round is launched with one.
const SCOPED_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);

// The rules one argument holds, split where the CLI splits a tool list
// (its help: "comma or space-separated"): at a comma or a space outside
// parentheses (a space inside a rule's parentheses is part of its scope,
// as in a path with a space).
export function rulesIn(arg) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of arg) {
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (current !== '') out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

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

// The rules among `allowed` that grant a scoped tool with no real scope:
// its bare name, an empty scope `Tool()`, or the all-matching `Tool(*)`
// (the scope read trimmed). Whether the CLI reads the last two as the
// whole tool is not measured; refusing them fails closed either way. An
// explicit scope, however wide (`Read(//**)`), is a deliberate grant and
// passes. The vault's configuration is checked with this before a round
// (curate, --dry and doctor's config-valid name the setting); buildArgv
// throws on it as the last line.
export function unscopedRules(allowed) {
  if (!Array.isArray(allowed)) return [];
  const found = [];
  for (const arg of allowed) {
    if (typeof arg !== 'string') continue;
    for (const rule of rulesIn(arg)) {
      const m = /^([A-Za-z]+)(?:\((.*)\))?$/s.exec(rule);
      if (m === null || !SCOPED_TOOLS.includes(m[1])) continue;
      const scope = m[2] === undefined ? null : m[2].trim();
      if (scope === null || scope === '' || scope === '*') found.push(rule);
    }
  }
  return found;
}

function checkScoped(allowed) {
  const [rule] = unscopedRules(allowed);
  if (rule === undefined) return;
  const tool = /^[A-Za-z]+/.exec(rule)[0];
  const example = tool === 'Bash' ? 'Bash(<command>:*)' : `${tool}(./**)`;
  throw new TypeError(`allowed: ${JSON.stringify(rule)} would grant the tool on every file or command; a round allows it only with a scope, such as ${example}`);
}

export function buildArgv({ model, maxTurns, budgetUsd, allowed = [], disallowed = [] } = {}) {
  checkRules('allowed', allowed);
  checkRules('disallowed', disallowed);
  checkScoped(allowed);
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
// After the CLI itself has exited, how long its standard output may stay
// open (a child of its own still writing, or holding the pipe) before the
// whole process group is killed so the round can finish.
const DRAIN_GRACE_MS = 2000;

// The child runs in a process group of its own (detached), and every kill
// is sent to the whole group: the commands the model runs through Bash are
// the CLI's children, and a round that ends, times out or is aborted must
// not leave one alive, least of all a `propose` still pushing after the
// round released the vault's lock (src/guards/lock.mjs, "THE ROUND'S
// TOKEN"). A group that is already gone is not an error.
function killGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

// Spawns the CLI and resolves when the child has closed. The exit code is
// the child's own, from its `close` event, and from nowhere else: a round
// was once reported as a success from a status the scheduler computed
// (docs/incidents.md, 29/07/2026 and 21/08/2026). `exitCode` is null when
// the child died by a signal (then `signal` names it) or never started
// (then `spawnError` holds the error code).
//
// On timeout, or when `abortSignal` fires, the child's process group gets
// SIGTERM, then SIGKILL after a grace period; `timedOut` says the timeout
// was ours, `aborted` holds the abort's reason (null when not aborted). A
// caller must read either as a failed run whatever exit code came with it:
// a CLI that catches SIGTERM may still exit 0. When the child closes, the
// group is killed once more with SIGKILL, so no grandchild outlives the
// run; and a grandchild that holds standard output open after the CLI
// exited is killed after DRAIN_GRACE_MS, so the run still ends.
// An `onLine` that throws aborts the run with that error as the reason.
export function runModel({
  claudeBin, argv, prompt, cwd, env = process.env, timeoutMs, onLine, killGraceMs = KILL_GRACE_MS, abortSignal, drainGraceMs = DRAIN_GRACE_MS,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const parser = createStreamParser();
    let stderrTail = '';
    let timedOut = false;
    let aborted = null;
    let settled = false;
    let timer = null;
    let graceTimer = null;
    let drainTimer = null;

    const child = spawn(claudeBin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });

    const stop = () => {
      if (graceTimer !== null) return;
      killGroup(child, 'SIGTERM');
      graceTimer = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs);
    };
    const onAbort = () => {
      if (aborted === null) aborted = abortSignal.reason ?? 'aborted';
      stop();
    };

    const finish = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(drainTimer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      if (fields.spawnError === null) killGroup(child, 'SIGKILL');
      resolve({ record: parser.record(), stderrTail, durationMs: Date.now() - started, timedOut, aborted, pid: child.pid ?? null, ...fields });
    };

    const decoder = new StringDecoder('utf8');
    let pending = '';
    const take = (line) => {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      parser.push(clean);
      if (onLine && aborted === null) {
        try {
          onLine(clean);
        } catch (error) {
          aborted = error;
          stop();
        }
      }
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
    child.on('exit', () => {
      drainTimer = setTimeout(() => killGroup(child, 'SIGKILL'), drainGraceMs);
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
        stop();
      }, timeoutMs);
    }
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    if (child.pid !== undefined) child.stdin.end(prompt ?? '');
  });
}
