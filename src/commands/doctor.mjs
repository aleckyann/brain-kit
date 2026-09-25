// The `doctor` command: runs the checks in src/doctor/checks.mjs
// against the vault found from [dir] or the working directory, and
// reports each one.
//
//   brain-kit doctor [dir] [--json] [--only <id,...>] [--probe]
//
// Exit 0 when every check is ok or warn, 1 when any fails, 2 on a usage
// error or when no vault is found. The report is written in the language
// the CLI's own translator speaks (BRAIN_KIT_LANG), not the vault's: one
// of the things this command reports is a configuration it could not
// read, so the vault's declared language is not something it can rely on.
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
// HOME, the state directory), the working directory and the Node version.
// Production passes nothing.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { CHECK_IDS, buildContext, exitCodeFor, probeConnectors, runChecks } from '../doctor/checks.mjs';

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
  const result = { dir: undefined, json: false, help: false, only: null, probe: false };
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

function statusLabel(t, status) {
  if (status === 'ok') return t('doctor.status_ok');
  if (status === 'warn') return t('doctor.status_warn');
  if (status === 'fail') return t('doctor.status_fail');
  return String(status);
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
  if (!root) {
    io.stderr.write(`${t('doctor.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }

  const ctx = buildContext({
    root, env, ...(deps.nodeVersion !== undefined ? { nodeVersion: deps.nodeVersion } : {}), ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.probeTimeoutMs !== undefined ? { probeTimeoutMs: deps.probeTimeoutMs } : {}),
  });
  if (parsed.probe) ctx.probe = await probeConnectors(ctx, { prompt: t('doctor.connectors.probe_prompt') });
  const results = runChecks(ctx, ids);
  const exitCode = exitCodeFor(results);
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const result of results) {
    if (result.status in counts) counts[result.status] += 1;
    else counts.fail += 1;
  }

  if (parsed.json) {
    const checks = results.map(({ id, status, messageKey, params }) => ({
      id, status, messageKey, params, message: renderMessage(t, messageKey, params),
    }));
    io.stdout.write(`${JSON.stringify({ version: JSON_VERSION, vault: root, checks, counts, exitCode })}\n`);
    return exitCode;
  }

  const width = Math.max(...results.map((r) => r.id.length));
  const labels = results.map((r) => statusLabel(t, r.status));
  const labelWidth = Math.max(...labels.map((label) => label.length));
  let text = `${t('doctor.heading', { vault: root })}\n`;
  results.forEach((result, index) => {
    const line = renderMessage(t, result.messageKey, result.params);
    text += `  ${labels[index].padEnd(labelWidth)}  ${result.id.padEnd(width)}  ${line}\n`;
  });
  text += `${t('doctor.summary', { ok: counts.ok, warn: counts.warn, fail: counts.fail })}\n`;
  io.stdout.write(text);
  return exitCode;
}
