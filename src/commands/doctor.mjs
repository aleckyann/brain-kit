// The `doctor` command: runs the checks in src/doctor/checks.mjs
// against the vault found from [dir] or the working directory, and
// reports each one.
//
//   brain-kit doctor [dir] [--json] [--only <id,...>] [--probe] [--verbose | -v]
//
// Exit 0 when every check is ok or warn, 1 when any fails, 2 on a usage
// error. Outside any vault it is the machine check (below), with the same
// exit codes. The report is written in the vault's own
// language, as `validate`, `lint`, the hooks and `prompt` write theirs: the
// `lang` its configuration names, when that is a language the kit has a
// pack for. What this command reports includes a configuration it could not
// read, so when the file is missing, is not JSON, or names no supported
// language, the report falls back to the language the CLI's own translator
// speaks (BRAIN_KIT_LANG, then the locale), which is also the language of
// every message before a vault is found: the usage errors and "no vault".
//
// The text report is compact by default: the heading, the lines of the
// checks that are not ok (every warning and every failure, each exactly as
// the full report prints it, in the same order), one line saying how many ok
// lines were left out and how to see them, and the summary. A healthy run
// used to print 32 lines of jargon when the one thing a person needs is the
// last (the first stranger's m9, the second's F12). `--verbose` (`-v`) is
// the full list, as it always was, and `--json` is the full list in either
// case: a consumer of the JSON, and the Stop hook and the briefing that read
// checks, never see less than all of them. A status that is not ok is never
// left out, whatever it is called.
//
// OUTSIDE ANY VAULT it checks the machine and says so. `doctor` before `init`
// used to answer "no vault found" and nothing else, exit 2, while the README
// promises it tells whether "this machine and this vault are ready" (the
// first stranger's m2, the second's F24). Now it runs the checks that read
// no vault (MACHINE_CHECKS in src/doctor/checks.mjs: Node, git, brain-kit on
// PATH, gh and its login, the claude on PATH), in a context that holds no
// vault, under a heading that says only the machine is checked, in the
// language of the locale (there is no vault to ask). It ends with the same
// "no vault found" sentence the other commands give, which names the command
// that makes one. Exit 0 unless one of them fails, as inside a vault, and
// `--json` has the same shape with `vault: null`. `--only` may name only
// those checks, and `--probe`, which asks a vault's connectors, is refused:
// each is a usage error that runs nothing, never a quiet run of fewer checks
// than were asked for.
//
// `--only` with an id no check has is a usage error, never a run of the
// checks that do exist minus the typo: a person who asked for one check
// by a misspelt name and got "0 ok, 0 warn, 0 fail" and exit 0 would read
// that as the check passing.
//
// `--probe` asks the CLI, now, for the state of each claude.ai connector a
// round would read (src/doctor/checks.mjs, probeConnectors): it launches the
// round's own connector mode with a one-line prompt and kills it at its
// init event, before any model call, and writes nothing. It feeds the
// `connectors` check, so `--only` that leaves that check out is a usage
// error, never a probe nobody reads.
//
// A result's parameter may itself be a message, { messageKey, params }, or
// a list of them (a connector's state, a user rule, an isolation problem, in
// the kit's own sentence for it): renderMessage renders each in place, in
// the report's language, and --json keeps the structure in `params` beside
// the rendered `message`.
//
// `deps` is the seam the tests use to hand in the environment (PATH,
// HOME, the state directory), the working directory, the Node version and
// the time `gh auth status` is given.
// Production passes nothing.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME } from '../config.mjs';
import { createTranslator, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';
import { CHECK_IDS, MACHINE_CHECKS, MACHINE_CHECK_IDS, buildContext, exitCodeFor, probeConnectors, runChecks } from '../doctor/checks.mjs';

const JSON_VERSION = 'brain-kit.doctor/1';
const ROOT_INDEX = 'index.md';
const PROBED_CHECK = 'connectors';

function isMessage(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.messageKey === 'string';
}

// A result's sentence, with every parameter that is a message (or a list
// of messages, joined by a space) rendered first.
export function renderMessage(t, messageKey, params = {}) {
  const flat = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (isMessage(value)) flat[key] = renderMessage(t, value.messageKey, value.params);
    else if (Array.isArray(value) && value.length > 0 && value.every(isMessage)) flat[key] = value.map((item) => renderMessage(t, item.messageKey, item.params)).join(' ');
    else flat[key] = value;
  }
  return t(messageKey, flat);
}

function parseArgs(argv) {
  const result = { dir: undefined, json: false, help: false, only: null, probe: false, verbose: false };
  const addOnly = (value) => {
    const ids = String(value).split(',').map((id) => id.trim()).filter((id) => id !== '');
    if (ids.length === 0) return false;
    result.only = [...(result.only ?? []), ...ids];
    return true;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--probe') result.probe = true;
    else if (arg === '--verbose' || arg === '-v') result.verbose = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--only') {
      if (i + 1 >= argv.length || !addOnly(argv[i + 1])) return { error: 'only_value' };
      i++;
    } else if (arg.startsWith('--only=')) {
      if (!addOnly(arg.slice('--only='.length))) return { error: 'only_value' };
    } else if (arg.startsWith('-')) return { error: 'argument', arg };
    else if (result.dir === undefined) result.dir = arg;
    else return { error: 'argument', arg };
  }
  return result;
}

// What the tests hand in for the context, and nothing else.
function contextOptions(deps) {
  return {
    ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}), ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.probeTimeoutMs !== undefined ? { probeTimeoutMs: deps.probeTimeoutMs } : {}),
    ...(deps.ghTimeoutMs !== undefined ? { ghTimeoutMs: deps.ghTimeoutMs } : {}),
  };
}

function statusLabel(t, status) {
  if (status === 'ok') return t('doctor.status_ok');
  if (status === 'warn') return t('doctor.status_warn');
  if (status === 'fail') return t('doctor.status_fail');
  return String(status);
}

// The translator for the report: the vault's own language when its
// configuration names a supported one, else `t`, the CLI's.
function reportTranslator(ctx, t, io) {
  const read = ctx.config();
  const lang = read.ok && read.value !== null && typeof read.value === 'object' ? read.value.lang : undefined;
  if (!SUPPORTED_LANGS.includes(lang)) return t;
  return createTranslator(lang, { warn: (message) => io.stderr.write(`${message}\n`) });
}

export async function runDoctor(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parseArgs(argv);
  if (parsed.error === 'only_value') {
    io.stderr.write(`${t('doctor.only_needs_value')}\n`);
    io.stderr.write(`${t('doctor.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.error) {
    io.stderr.write(`${t('doctor.bad_argument', { arg: parsed.arg })}\n`);
    io.stderr.write(`${t('doctor.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('doctor.usage')}\n`);
    return EXIT.OK;
  }

  let ids = CHECK_IDS;
  if (parsed.only) {
    const unknown = parsed.only.filter((id) => !CHECK_IDS.includes(id));
    if (unknown.length > 0) {
      io.stderr.write(`${t('doctor.unknown_check', { ids: unknown, known: CHECK_IDS })}\n`);
      return EXIT.USAGE;
    }
    // Table order, not the order asked for, and each check once.
    ids = CHECK_IDS.filter((id) => parsed.only.includes(id));
  }
  if (parsed.probe && !ids.includes(PROBED_CHECK)) {
    io.stderr.write(`${t('doctor.probe_needs_connectors')}\n`);
    io.stderr.write(`${t('doctor.usage')}\n`);
    return EXIT.USAGE;
  }

  // The same refusal to climb from a path that is not real as validate's:
  // findVaultRoot's upward walk is lexical, and would "find" a vault above
  // a typo'd directory or above a file.
  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('doctor.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('doctor.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }
  const root = findVaultRoot(startDir);
  if (!root) return checkMachine({ parsed, startDir, env, deps, io, t });

  const ctx = buildContext({ root, env, ...contextOptions(deps) });
  const reportT = reportTranslator(ctx, t, io);
  if (parsed.probe) ctx.probe = await probeConnectors(ctx, { prompt: reportT('doctor.connectors.probe_prompt') });
  const results = runChecks(ctx, ids);
  const exitCode = exitCodeFor(results);
  const counts = tally(results);

  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(jsonReport(reportT, { vault: root, results, counts, exitCode }))}\n`);
    return exitCode;
  }

  io.stdout.write(renderReport(reportT, { heading: reportT('doctor.heading', { vault: root }), results, counts, verbose: parsed.verbose }));
  return exitCode;
}

function jsonReport(reportT, { vault, results, counts, exitCode }) {
  const checks = results.map(({ id, status, messageKey, params }) => ({
    id, status, messageKey, params, message: renderMessage(reportT, messageKey, params),
  }));
  return { version: JSON_VERSION, vault, checks, counts, exitCode };
}

function tally(results) {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const result of results) {
    if (result.status in counts) counts[result.status] += 1;
    else counts.fail += 1;
  }
  return counts;
}

// `doctor` where no vault was found: see the header. `startDir` is where the
// search began, which is also where the programs it runs are started.
function checkMachine({ parsed, startDir, env, deps, io, t }) {
  if (parsed.probe) {
    io.stderr.write(`${t('doctor.probe_needs_vault', { dir: startDir })}\n`);
    return EXIT.USAGE;
  }
  if (parsed.only) {
    const needVault = parsed.only.filter((id) => !MACHINE_CHECK_IDS.includes(id));
    if (needVault.length > 0) {
      io.stderr.write(`${t('doctor.only_needs_vault', { dir: startDir, ids: needVault, known: MACHINE_CHECK_IDS })}\n`);
      return EXIT.USAGE;
    }
  }
  const ids = parsed.only ? MACHINE_CHECK_IDS.filter((id) => parsed.only.includes(id)) : MACHINE_CHECK_IDS;
  const ctx = buildContext({ root: startDir, hasVault: false, env, ...contextOptions(deps) });
  const results = runChecks(ctx, ids, MACHINE_CHECKS);
  const exitCode = exitCodeFor(results);
  const counts = tally(results);
  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(jsonReport(t, { vault: null, results, counts, exitCode }))}\n`);
    return exitCode;
  }
  const text = renderReport(t, { heading: t('doctor.machine_only'), results, counts, verbose: parsed.verbose });
  io.stdout.write(`${text}${t('doctor.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
  return exitCode;
}

// The human report. The columns are as wide as the widest of ALL the results,
// listed or not, so a line is the same line in the compact report and in the
// full one.
function renderReport(reportT, { heading, results, counts, verbose }) {
  const width = Math.max(...results.map((r) => r.id.length));
  const labels = results.map((r) => statusLabel(reportT, r.status));
  const labelWidth = Math.max(...labels.map((label) => label.length));
  let text = `${heading}\n`;
  let left = 0;
  results.forEach((result, index) => {
    if (!verbose && result.status === 'ok') {
      left += 1;
      return;
    }
    const line = renderMessage(reportT, result.messageKey, result.params);
    text += `  ${labels[index].padEnd(labelWidth)}  ${result.id.padEnd(width)}  ${line}\n`;
  });
  if (left > 0) text += `${reportT(left === 1 ? 'doctor.ok_hidden_one' : 'doctor.ok_hidden', { count: left })}\n`;
  text += `${reportT('doctor.summary', { ok: counts.ok, warn: counts.warn, fail: counts.fail })}\n`;
  return text;
}
