// The `schedule` command: installs, removes or reports the scheduler entry
// that runs `brain-kit curate` for one vault.
//
//   brain-kit schedule install|uninstall|status [dir] [--job curate|briefing] [--platform systemd|launchd|cron] [--dry]
//
// `--job briefing` (phase 4, task 4, ruling R-T11) is the morning
// briefing's task in the Claude desktop application instead: see the
// section at the end of this file. `--job curate` is the default.
//
// One entry per vault, named by what it does and whose it is,
// `brain-kit-curate-<vault_id>`, never by the time it runs
// (docs/incidents.md, 14/09/2026: files named "nightly" kept that name
// long after the routine moved to the morning). It fires at the windows in
// `curate.schedule`, in the machine's local time, and every window must be
// daytime, 07:00 to 22:59: the machine is on and connected then, and an
// overnight window fires at resume instead, before the network is up
// (same incident). The retries are safe only because the watermark makes a
// second round of the same day a no-op.
//
// What each platform gets, and why:
//   - systemd (user scope): a oneshot service and a timer with one
//     OnCalendar= per window and Persistent=false, so a window missed while
//     the machine slept is not caught up at resume. The service has no
//     After=, Wants= or any other line on a network target: in the user
//     scope that target does not exist and such a line is dead letter
//     (docs/incidents.md, 28/08/2026); the round waits for the network
//     itself. Written under $XDG_CONFIG_HOME/systemd/user (or
//     ~/.config/systemd/user), then daemon-reload, enable, restart.
//   - launchd: a LaunchAgent with one StartCalendarInterval entry per
//     window, written under ~/Library/LaunchAgents, then bootout and
//     bootstrap in the gui/<uid> domain. launchd has no switch to skip a
//     window missed during sleep: it fires once at wake. Declared, not
//     handled here; the engine's own network wait is what covers it.
//   - cron: one line per window inside a BEGIN/END block named like the
//     units, read with `crontab -l` and written back whole with
//     `crontab -`, every line outside the block kept byte for byte. cron
//     does not catch up missed windows.
//
// Each entry runs `<node> <kit>/bin/brain-kit.mjs curate <vault>` with
// absolute paths, quoted by the platform's own rules (a vault under a
// directory with a space and an accent is the ordinary case, not the edge),
// with PATH listing the machine's path_extra, then the directory of
// claude_bin, then node's own directory and the system directories,
// deduplicated: a reinstall that moves the claude binary between the two
// usual places must not kill the round (docs/incidents.md, 27/08/2026).
// The round's model runs `propose`, which pushes through the vault's
// pre-push gate (it runs the `brain-kit` on PATH and nothing else) and
// opens the pull request with `gh`: both must resolve on that PATH, so
// `install` looks for each there and, when one is not, adds the directory
// where the installing shell's own PATH finds it; when neither has it, it
// refuses (exit 2) naming the command and how to install it (final review
// I1, 24/09/2026: a unit PATH without them made every round fail in a
// way only the model's tool results could explain).
// LC_ALL=C.UTF-8 and TZ=<vault.timezone> complete the environment.
//
// `--dry` prints every file it would write and every command it would run,
// and changes nothing. `status` compares what is installed with what
// `install` would write now, asks the scheduler whether the entry is
// enabled, prints the next fire times and the last run's summary, and is
// exit 0 only when the entry is installed, current and enabled.
//
// `deps` hands in the environment, the working directory, the operating
// system, the user id, the machine's time zone, the clock, the node binary
// and the kit's entry point, for the tests. Production passes nothing.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, canonicalPathMatches, loadConfig, loadMachine } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { STATE_FILES, stateDirFor } from '../state.mjs';
import { KIT_ROOT } from '../version.mjs';
import { run } from '../exec.mjs';
import { expandHome, findExecutable, resolveClaude, shownInstant } from '../doctor/checks.mjs';
import { kitCommand } from '../curate/tools.mjs';
import { briefingSetting } from '../briefing/blocks.mjs';
import { createTranslator, resolveLang, SUPPORTED_LANGS } from '../lang.mjs';
import { signatureProblem, signatureProblems, startsWithSignature } from '../sources/transcripts-claude-code.mjs';

const ROOT_INDEX = 'index.md';
const ACTIONS = Object.freeze(['install', 'uninstall', 'status']);
// What an entry runs: the scheduled curator (the default), or the morning
// briefing's task in the desktop application.
export const JOBS = Object.freeze(['curate', 'briefing']);
export const PLATFORMS = Object.freeze(['systemd', 'launchd', 'cron']);
export const DAYTIME_FROM = '07:00';
export const DAYTIME_UNTIL = '23:00';
const SYSTEM_PATH = Object.freeze(['/usr/local/bin', '/usr/bin', '/bin']);
// What the round's own `propose` runs from PATH.
export const ROUND_COMMANDS = Object.freeze(['brain-kit', 'gh']);
const HALF_YEAR_DAYS = 182;
// Vixie cron (Debian, Ubuntu) and macOS cron cap a command near 1000 bytes
// and refuse the whole crontab above it; the kit refuses first, in its own
// words, with room to spare.
export const CRON_LINE_LIMIT = 900;
const PINNED_MARKERS = Object.freeze(['/_npx/', '/.nvm/versions/', '/fnm/node-versions/', '/.fnm/', '/.asdf/installs/', '/mise/installs/', '/.volta/tools/image/']);
const CRON_ENV_LINE = /^\s*(CRON_TZ|TZ|SHELL)\s*=/;
const TEMPLATES = join(KIT_ROOT, 'templates', 'schedule');
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function parseArgs(argv) {
  const result = { action: undefined, dir: undefined, platform: null, dry: false, help: false, job: 'curate' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--dry') result.dry = true;
    else if (arg === '--job') {
      if (i + 1 >= argv.length) return { error: 'job_value' };
      result.job = argv[++i];
    } else if (arg.startsWith('--job=')) result.job = arg.slice('--job='.length);
    else if (arg === '--platform') {
      if (i + 1 >= argv.length) return { error: 'platform_value' };
      result.platform = argv[++i];
    } else if (arg.startsWith('--platform=')) result.platform = arg.slice('--platform='.length);
    else if (arg.startsWith('-')) return { error: 'argument', arg };
    else if (result.action === undefined) result.action = arg;
    else if (result.dir === undefined) result.dir = arg;
    else return { error: 'argument', arg };
  }
  if (result.dry && result.action === 'status') return { error: 'argument', arg: '--dry' };
  // The briefing's task lives in the desktop application, not in a
  // scheduler this command writes: no platform to choose.
  if (result.job === 'briefing' && result.platform !== null) return { error: 'argument', arg: '--platform' };
  // Nor anything to dry-run: install --job briefing writes nothing anyway.
  if (result.job === 'briefing' && result.dry) return { error: 'argument', arg: '--dry' };
  return result;
}

// A value written into a unit file as one systemd word: `%` doubled, since
// systemd expands specifiers there; in an ExecStart argument (never the
// program, which systemd does not expand) also `$` doubled, since systemd
// expands variables there; then backslash and double quote escaped and the
// whole wrapped in double quotes.
function systemdQuote(value, { exec }) {
  let text = value.replace(/%/g, '%%');
  if (exec) text = text.replace(/\$/g, '$$$$');
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// One POSIX shell word, for the command cron hands to /bin/sh.
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// How a command is shown to a person (dry runs, failures): a word made only
// of safe characters as it is, anything else single-quoted.
function showCommand(program, args) {
  return [program, ...args].map((arg) => (/^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : shellQuote(arg))).join(' ');
}

function fill(template, values) {
  const text = readFileSync(join(TEMPLATES, template), 'utf8');
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`template ${template} names an unknown placeholder ${key}`);
    return values[key];
  });
}

function dedupe(list) {
  return [...new Set(list)];
}

function configHome(env, home) {
  const configured = env.XDG_CONFIG_HOME;
  return typeof configured === 'string' && isAbsolute(configured) ? configured : join(home, '.config');
}

function isValidTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Characters no scheduler file can carry safely: control characters break
// every format; a colon cannot sit inside a PATH entry; cron cannot carry a
// backslash at all (in front of a percent sign cronie keeps the percent and
// drops the backslash, whatever the quoting); and systemd refuses a single
// quote, a double quote or a backslash anywhere in the program ExecStart
// runs, quoted or not ("Executable path contains special characters", a
// unit with a fatal error that the timer would still start every window).
// The kit's own path is held to the same rule as node's: it is the other
// program path the entry names.
function unsafeFor(value, { pathEntry = false, program = false, platform }) {
  if ([...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return true;
  if (pathEntry && value.includes(':')) return true;
  if (program && platform === 'systemd' && /['"\\]/.test(value)) return true;
  return platform === 'cron' && value.includes('\\');
}

// A zone's offset from UTC at one moment, as Intl spells it ("-03:00").
function utcOffset(zone, at) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(at).find((part) => part.type === 'timeZoneName').value;
  return name === 'GMT' ? '+00:00' : name.slice(3);
}

// Whether two zones keep the same clock: the same UTC offset now and half a
// year from now, so a difference that only daylight saving time opens is
// caught, and two names for the same clock (Asia/Calcutta and Asia/Kolkata,
// or two cities of one country on one offset) are not a difference.
export function sameClock(a, b, now) {
  const later = new Date(now.getTime() + HALF_YEAR_DAYS * 24 * 60 * 60 * 1000);
  return [now, later].every((at) => utcOffset(a, at) === utcOffset(b, at));
}

// Where a program path sits in a directory that a version manager or the
// npx cache replaces or evicts: the entry records the absolute path, so it
// stops starting the day that directory goes (docs/incidents.md,
// 27/08/2026, for node or the kit instead of claude).
function pinnedByManager(path) {
  return PINNED_MARKERS.some((marker) => path.includes(marker));
}

// The PATH a scheduled round runs with: path_extra, claude's directory,
// node's directory and the system directories; then, for each command in
// ROUND_COMMANDS that none of them holds, the directory where the
// installing shell's PATH finds it. `missing` names the commands found in
// neither. `systemPath` is for the tests.
//
// `recorded`, for `status`: the PATH read back from the installed entry.
// When it starts with the same base directories, the directories install
// added after them are taken from it, not from the current shell, so a
// status run from a shell that does not find brain-kit or gh does not call
// a correctly installed entry outdated (re-review Minor, 24/09/2026).
export function roundPath({ extra = [], claude = null, node, env, systemPath = SYSTEM_PATH, recorded = null }) {
  const base = dedupe([...extra.map((dir) => expandHome(String(dir), env)), ...(claude ? [dirname(claude)] : []), dirname(node), ...systemPath]);
  const added = [];
  const missing = [];
  const kept = typeof recorded === 'string' ? recorded.split(':') : null;
  if (kept !== null && base.every((dir, index) => kept[index] === dir)) {
    added.push(...dedupe(kept.slice(base.length).filter((dir) => dir !== '' && !base.includes(dir))));
    for (const command of ROUND_COMMANDS) if (findExecutable(command, [...base, ...added]) === null) missing.push(command);
    return { dirs: dedupe([...base, ...added]), missing };
  }
  for (const command of ROUND_COMMANDS) {
    if (findExecutable(command, [...base, ...added]) !== null) continue;
    const found = findExecutable(command, String(env.PATH ?? '').split(delimiter));
    if (found === null) missing.push(command);
    else added.push(dirname(found));
  }
  return { dirs: dedupe([...base, ...added]), missing };
}

// The PATH of the entry installed for this vault, read back from its file
// (systemd, then launchd) or from its crontab block: { file, path }, or
// null when none is installed or its PATH cannot be read. doctor checks it
// reaches ROUND_COMMANDS; `status` passes its platform and compares with it.
export function installedRoundPath({ machine, env, platform = null }) {
  const home = env.HOME || homedir();
  const name = `brain-kit-curate-${machine.vault_id}`;
  const service = join(configHome(env, home), 'systemd', 'user', `${name}.service`);
  const serviceText = platform === null || platform === 'systemd' ? readText(service) : null;
  if (serviceText !== null) {
    const line = serviceText.split('\n').find((l) => l.startsWith('Environment="PATH='));
    if (line === undefined) return null;
    const quoted = line.slice('Environment='.length);
    const value = quoted.slice(1, -1).replace(/\\(.)/g, '$1').replace(/%%/g, '%');
    return { file: service, path: value.slice('PATH='.length) };
  }
  const plist = join(home, 'Library', 'LaunchAgents', `${name}.plist`);
  const plistText = platform === null || platform === 'launchd' ? readText(plist) : null;
  if (plistText !== null) {
    const match = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plistText);
    if (match === null) return null;
    const value = match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    return { file: plist, path: value };
  }
  if (platform !== null && platform !== 'cron') return null;
  const listed = run('crontab', ['-l'], { env });
  if (listed.status !== 0) return null;
  const lines = listed.stdout.split('\n');
  const begin = lines.findIndex((line) => opensBlock(line, name));
  if (begin === -1) return null;
  const entry = lines.slice(begin + 1).find((line) => / PATH='/.test(line));
  const match = entry === undefined ? null : / PATH='((?:[^']|'\\'')*)'/.exec(entry);
  if (match === null) return null;
  return { file: 'crontab', path: match[1].replace(/'\\''/g, "'").replace(/\\%/g, '%') };
}

function detectPlatform(env, os) {
  const probe = run('systemctl', ['--user', 'show-environment'], { env });
  if (probe.status === 0) return 'systemd';
  if (os === 'darwin') return 'launchd';
  return 'cron';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// The next `count` moments the windows fire after `now`, on the machine's
// clock, as DD/MM/YYYY HH:MM.
export function nextFireTimes(windows, now, count = 3) {
  const times = [];
  for (let day = 0; times.length < count && day <= count; day++) {
    for (const window of windows) {
      const [hour, minute] = window.split(':').map(Number);
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, minute);
      if (at > now && times.length < count) times.push(at);
    }
  }
  return times.map((d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
}

export async function runSchedule(argv, io, t, deps = {}) {
  return runScheduleSync(argv, io, t, deps);
}

// The command itself, which never waits on anything: `doctor`'s `schedule`
// check calls it directly to ask `status` the same question, the same way.
export function runScheduleSync(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const os = deps.platform ?? process.platform;
  const say = (line) => io.stdout.write(`${line}\n`);
  const complain = (line) => io.stderr.write(`${line}\n`);
  const usageError = (line) => {
    complain(line);
    complain(t('schedule.usage'));
    return EXIT.USAGE;
  };

  const parsed = parseArgs(argv);
  if (parsed.error === 'platform_value') return usageError(t('schedule.platform_needs_value'));
  if (parsed.error === 'job_value') return usageError(t('schedule.job_needs_value', { jobs: JOBS }));
  if (parsed.error) return usageError(t('schedule.bad_argument', { arg: parsed.arg }));
  if (parsed.help) {
    say(t('schedule.usage'));
    return EXIT.OK;
  }
  if (parsed.action === undefined) {
    complain(t('schedule.usage'));
    return EXIT.USAGE;
  }
  if (!ACTIONS.includes(parsed.action)) return usageError(t('schedule.unknown_action', { action: parsed.action }));
  if (!JOBS.includes(parsed.job)) return usageError(t('schedule.bad_job', { job: parsed.job, jobs: JOBS }));
  if (parsed.platform !== null && !PLATFORMS.includes(parsed.platform)) {
    return usageError(t('schedule.bad_platform', { platform: parsed.platform, platforms: PLATFORMS }));
  }

  let startDir = cwd;
  if (parsed.dir !== undefined) {
    startDir = resolve(cwd, parsed.dir);
    if (!existsSync(startDir)) {
      complain(t('schedule.path_not_found', { dir: startDir }));
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      complain(t('schedule.path_not_a_directory', { dir: startDir }));
      return EXIT.USAGE;
    }
  }
  const found = findVaultRoot(startDir);
  if (!found) {
    complain(t('schedule.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX }));
    return EXIT.USAGE;
  }
  const root = realpathSync(found);
  const config = loadConfig(root);
  const stateDir = stateDirFor(root, env);
  const machine = loadMachine(stateDir);
  // A machine file that records another path belongs to a vault that moved:
  // an entry installed from it would run a round against the wrong place.
  if (!canonicalPathMatches(machine.canonical_path, root)) {
    complain(t('schedule.moved', { recorded: machine.canonical_path, root }));
    return EXIT.USAGE;
  }
  if (parsed.job === 'briefing') {
    return briefingJob({ action: parsed.action, root, config, machine, env, t, say, complain, now: deps.now ?? new Date(), localZone: deps.localZone });
  }

  const node = deps.node ?? process.execPath;
  const kit = deps.kit ?? join(KIT_ROOT, 'bin', 'brain-kit.mjs');
  const argvOfRound = [node, kit, 'curate', root];
  const windows = dedupe(config.curate.schedule).sort();
  if (os === 'win32') {
    const command = argvOfRound.map((arg) => `"${arg}"`).join(' ');
    complain(t('schedule.windows_manual', { windows, command }));
    return EXIT.USAGE;
  }

  const home = env.HOME || homedir();
  const name = `brain-kit-curate-${machine.vault_id}`;
  const platform = parsed.platform ?? detectPlatform(env, os);
  const where = {
    systemd: join(configHome(env, home), 'systemd', 'user'),
    launchd: join(home, 'Library', 'LaunchAgents'),
  };
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const context = { env, t, say, complain, name, platform, where, uid, dry: parsed.dry, detected: parsed.platform === null };

  if (parsed.action === 'uninstall') return uninstall(context);

  if (parsed.action === 'install' && config.curate.enabled !== true) {
    complain(t('schedule.disabled', { file: CONFIG_FILENAME }));
    return EXIT.USAGE;
  }
  // Ruling R-T12: a round whose signature the transcripts source cannot
  // match reliably would read its own runs back as the person's work.
  const badCurate = signatureProblems(config).filter((entry) => entry.key !== 'briefing.signature');
  if (parsed.action === 'install' && badCurate.length > 0) {
    for (const entry of badCurate) complain(t('schedule.bad_signature', { key: entry.key, value: JSON.stringify(entry.value), file: CONFIG_FILENAME }));
    return EXIT.USAGE;
  }
  if (windows.length === 0) {
    complain(t('schedule.no_windows', { file: CONFIG_FILENAME }));
    return EXIT.USAGE;
  }
  const overnight = windows.filter((w) => w < DAYTIME_FROM || w >= DAYTIME_UNTIL);
  if (overnight.length > 0) {
    complain(t('schedule.overnight', { windows: overnight, from: DAYTIME_FROM, until: DAYTIME_UNTIL, file: CONFIG_FILENAME }));
    return EXIT.USAGE;
  }
  const timezone = config.vault.timezone;
  if (!isValidTimeZone(timezone)) {
    complain(t('schedule.bad_timezone', { timezone, file: CONFIG_FILENAME }));
    return EXIT.USAGE;
  }
  const extra = Array.isArray(machine.path_extra) ? machine.path_extra : [];
  const claude = resolveClaude(machine.claude_bin, extra, env, root);
  if (claude === null) {
    complain(t('schedule.claude_not_found', { bin: machine.claude_bin }));
    return EXIT.USAGE;
  }
  const recorded = parsed.action === 'status' ? installedRoundPath({ machine, env, platform })?.path ?? null : null;
  const { dirs: pathDirs, missing } = roundPath({ extra, claude, node, env, recorded, ...(deps.systemPath ? { systemPath: deps.systemPath } : {}) });
  if (parsed.action === 'install' && missing.length > 0) {
    for (const command of missing) {
      const hint = t(command === 'gh' ? 'schedule.hint_gh' : 'schedule.hint_brain_kit');
      complain(t('schedule.command_missing', { command, path: pathDirs.join(':'), hint }));
    }
    return EXIT.USAGE;
  }
  for (const [index, value] of [...argvOfRound, timezone].entries()) {
    if (unsafeFor(value, { platform, program: index < 2 })) {
      complain(t('schedule.unsafe_path', { path: value }));
      return EXIT.USAGE;
    }
  }
  for (const dir of pathDirs) {
    if (unsafeFor(dir, { pathEntry: true, platform })) {
      complain(t('schedule.unsafe_path', { path: dir }));
      return EXIT.USAGE;
    }
  }

  const rendered = render({ platform, name, where, vaultId: machine.vault_id, argv: argvOfRound, path: pathDirs.join(':'), timezone, windows });
  if (parsed.action === 'status') {
    // A relative machine.paths entry belongs to the state directory, never
    // to whatever directory status happens to run from.
    const configured = machine.paths?.last_run;
    const lastRun = typeof configured === 'string' && configured !== ''
      ? resolve(stateDir, expandHome(configured, env))
      : join(stateDir, STATE_FILES.LAST_RUN);
    return status(context, rendered, windows, lastRun, deps.now ?? new Date());
  }
  if (rendered.block !== undefined) {
    const longest = Math.max(...rendered.block.split('\n').map((line) => Buffer.byteLength(line)));
    if (longest > CRON_LINE_LIMIT) {
      complain(t('schedule.cron_line_too_long', { bytes: longest, limit: CRON_LINE_LIMIT }));
      return EXIT.USAGE;
    }
  }
  const localZone = deps.localZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (isValidTimeZone(localZone) && !sameClock(localZone, timezone, deps.now ?? new Date())) {
    complain(t('schedule.timezone_differs', { local: localZone, vault: timezone }));
  }
  for (const path of argvOfRound.slice(0, 2)) {
    if (pinnedByManager(path)) complain(t('schedule.pinned_path', { path }));
  }
  return install(context, rendered, windows);
}

// Every file (or, for cron, the block) `install` writes for a platform.
function render({ platform, name, where, vaultId, argv, path, timezone, windows }) {
  const hm = windows.map((w) => w.split(':').map(Number));
  if (platform === 'systemd') {
    const service = fill('systemd/brain-kit-curate.service', {
      VAULT_ID: vaultId,
      PATH_ASSIGNMENT: systemdQuote(`PATH=${path}`, { exec: false }),
      TZ_ASSIGNMENT: systemdQuote(`TZ=${timezone}`, { exec: false }),
      // The program itself is not variable-expanded by systemd, so its `$`
      // stays single; only the arguments after it have `$` doubled.
      EXEC_START: argv.map((arg, index) => systemdQuote(arg, { exec: index > 0 })).join(' '),
    });
    const timer = fill('systemd/brain-kit-curate.timer', {
      VAULT_ID: vaultId,
      NAME: name,
      ON_CALENDAR: windows.map((w) => `OnCalendar=*-*-* ${w}:00`).join('\n'),
    });
    return { files: [{ path: join(where.systemd, `${name}.service`), content: service }, { path: join(where.systemd, `${name}.timer`), content: timer }] };
  }
  if (platform === 'launchd') {
    const plist = fill('launchd/brain-kit-curate.plist', {
      VAULT_ID: vaultId,
      NAME: name,
      PROGRAM_ARGUMENTS: argv.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n'),
      PATH: xmlEscape(path),
      TZ: xmlEscape(timezone),
      CALENDAR: hm.map(([h, m]) => `    <dict>\n      <key>Hour</key>\n      <integer>${h}</integer>\n      <key>Minute</key>\n      <integer>${m}</integer>\n    </dict>`).join('\n'),
    });
    return { files: [{ path: join(where.launchd, `${name}.plist`), content: plist }] };
  }
  // cron: an assignment prefix sets the environment for this command alone,
  // never for the person's other lines; every `%` is escaped, since an
  // unescaped one ends the command.
  const command = [`PATH=${shellQuote(path)}`, 'LC_ALL=C.UTF-8', `TZ=${shellQuote(timezone)}`, ...argv.map(shellQuote)].join(' ').replace(/%/g, '\\%');
  const block = fill('cron/brain-kit-curate.cron', {
    NAME: name,
    LINES: hm.map(([h, m]) => `${m} ${h} * * * ${command}`).join('\n'),
  });
  return { block };
}

function runSteps(context, steps) {
  const { env, t, complain } = context;
  for (const [program, args, { tolerate = false, input } = {}] of steps) {
    const result = run(program, args, input === undefined ? { env } : { env, input });
    if (result.status !== 0 && !tolerate) {
      const detail = (result.stderr || result.stdout).trim() || t('schedule.no_output');
      complain(t('schedule.command_failed', { command: showCommand(program, args), status: result.status, detail }));
      return false;
    }
  }
  return true;
}

function showSteps(context, steps) {
  for (const [program, args] of steps) context.say(context.t('schedule.dry_command', { command: showCommand(program, args) }));
}

function serviceSteps(context, verb) {
  const { name, uid } = context;
  if (context.platform === 'systemd') {
    if (verb === 'install') {
      return [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', `${name}.timer`]], ['systemctl', ['--user', 'restart', `${name}.timer`]]];
    }
    return [['systemctl', ['--user', 'disable', '--now', `${name}.timer`]]];
  }
  const plist = join(context.where.launchd, `${name}.plist`);
  // bootout answers non-zero when the job is not loaded, which is the
  // ordinary state before a first install and after a manual unload.
  const bootout = ['launchctl', ['bootout', `gui/${uid}/${name}`], { tolerate: true }];
  return verb === 'install' ? [bootout, ['launchctl', ['bootstrap', `gui/${uid}`, plist]]] : [bootout];
}

// The person's crontab split around this vault's block: `before` and
// `after` are every other line, kept as they are.
function readCrontab(context) {
  const { env, t, complain, name } = context;
  const result = run('crontab', ['-l'], { env });
  let text = result.stdout;
  if (result.status !== 0) {
    if (!/no crontab/i.test(result.stderr)) {
      complain(t('schedule.crontab_read_failed', { detail: (result.stderr || result.stdout).trim() || t('schedule.no_output') }));
      return null;
    }
    text = '';
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const begin = lines.findIndex((line) => opensBlock(line, name));
  if (begin === -1) return { before: lines, block: null, after: [] };
  const end = lines.findIndex((line, i) => i > begin && line === `# END ${name}`);
  if (end === -1) {
    complain(t('schedule.crontab_broken', { name }));
    return null;
  }
  // A second copy of the block (pasted by hand) would sit among the lines
  // kept as the person's own, and keep firing after every install and
  // uninstall; refused, like a block with no end.
  if (lines.slice(end + 1).some((line) => opensBlock(line, name))) {
    complain(t('schedule.crontab_duplicate', { name }));
    return null;
  }
  return { before: lines.slice(0, begin), block: `${lines.slice(begin, end + 1).join('\n')}\n`, after: lines.slice(end + 1) };
}

function opensBlock(line, name) {
  return line === `# BEGIN ${name}` || line.startsWith(`# BEGIN ${name}:`);
}

// The other platforms holding an entry for this vault, when a command that
// detected its platform finds none there: an entry installed with
// `--platform cron` on a machine where systemd answers keeps firing, and
// "not installed" or "nothing to remove" would hide it.
function installedElsewhere(context) {
  const { env, name, platform, where } = context;
  const found = [];
  if (platform !== 'systemd' && ['service', 'timer'].some((kind) => existsSync(join(where.systemd, `${name}.${kind}`)))) found.push('systemd');
  if (platform !== 'launchd' && existsSync(join(where.launchd, `${name}.plist`))) found.push('launchd');
  if (platform !== 'cron') {
    const result = run('crontab', ['-l'], { env });
    if (result.status === 0 && result.stdout.split('\n').some((line) => opensBlock(line, name))) found.push('cron');
  }
  return found;
}

function writeCrontab(context, lines) {
  const input = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return runSteps(context, [['crontab', ['-'], { input }]]);
}

function install(context, rendered, windows) {
  const { t, say, name, platform, dry } = context;
  if (platform === 'cron') {
    if (dry) {
      say(t('schedule.dry_crontab_block'));
      printText(say, rendered.block);
      showSteps(context, [['crontab', ['-l']], ['crontab', ['-']]]);
      return EXIT.OK;
    }
    const current = readCrontab(context);
    if (current === null) return EXIT.FAILURE;
    // The block goes at the end, below every line of the person's own, so an
    // environment line of theirs (CRON_TZ, TZ, SHELL) applies to it too.
    const environment = [...current.before, ...current.after].filter((line) => CRON_ENV_LINE.test(line));
    if (environment.length > 0) context.complain(t('schedule.crontab_foreign_env', { lines: environment }));
    const block = rendered.block.replace(/\n$/, '').split('\n');
    if (!writeCrontab(context, [...current.before, ...current.after, ...block])) return EXIT.FAILURE;
    say(t('schedule.installed', { name, platform, windows }));
    return EXIT.OK;
  }
  const steps = serviceSteps(context, 'install');
  if (dry) {
    for (const file of rendered.files) {
      say(t('schedule.dry_file', { path: file.path }));
      printText(say, file.content);
    }
    showSteps(context, steps);
    return EXIT.OK;
  }
  for (const file of rendered.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
    say(t('schedule.wrote', { path: file.path }));
  }
  if (!runSteps(context, steps)) return EXIT.FAILURE;
  say(t('schedule.installed', { name, platform, windows }));
  return EXIT.OK;
}

// A file's text, line by line, without its final newline doubled.
function printText(say, text) {
  for (const line of text.replace(/\n$/, '').split('\n')) say(line);
}

function ownFiles(context) {
  const { name, platform, where } = context;
  if (platform === 'systemd') return [join(where.systemd, `${name}.service`), join(where.systemd, `${name}.timer`)];
  return [join(where.launchd, `${name}.plist`)];
}

function uninstall(context) {
  const { t, say, name, platform, dry } = context;
  if (platform === 'cron') {
    if (dry) {
      say(t('schedule.dry_remove_block', { name }));
      showSteps(context, [['crontab', ['-l']], ['crontab', ['-']]]);
      return EXIT.OK;
    }
    const current = readCrontab(context);
    if (current === null) return EXIT.FAILURE;
    if (current.block === null) return nothingToRemove(context);
    if (!writeCrontab(context, [...current.before, ...current.after])) return EXIT.FAILURE;
    say(t('schedule.uninstalled', { name, platform }));
    return EXIT.OK;
  }
  const present = ownFiles(context).filter((file) => existsSync(file));
  const stop = serviceSteps(context, 'uninstall');
  const reload = platform === 'systemd' ? [['systemctl', ['--user', 'daemon-reload']]] : [];
  if (dry) {
    showSteps(context, stop);
    for (const file of present) say(t('schedule.dry_remove', { path: file }));
    showSteps(context, reload);
    return EXIT.OK;
  }
  if (present.length === 0) return nothingToRemove(context);
  // A disable that fails (no user bus over SSH, a unit never loaded) still
  // lets the files go: otherwise the kit could never remove its own files.
  // The failure is said, and the run is exit 1, never a quiet success.
  const stopped = runSteps(context, stop);
  for (const file of present) {
    rmSync(file, { force: true });
    say(t('schedule.removed', { path: file }));
  }
  const reloaded = runSteps(context, reload);
  if (!stopped || !reloaded) {
    context.complain(t('schedule.uninstall_unconfirmed', { name, platform }));
    return EXIT.FAILURE;
  }
  say(t('schedule.uninstalled', { name, platform }));
  return EXIT.OK;
}

function nothingToRemove(context) {
  const { t, say, name, platform } = context;
  const elsewhere = context.detected ? installedElsewhere(context) : [];
  if (elsewhere.length > 0) {
    context.complain(t('schedule.found_elsewhere', { name, platform, platforms: elsewhere }));
    return EXIT.FAILURE;
  }
  say(t('schedule.nothing_installed', { name, platform }));
  return EXIT.OK;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Installed, current and enabled, or which of the three is not.
function installedState(context, rendered) {
  const { env, name, platform, uid } = context;
  if (platform === 'cron') {
    const current = readCrontab(context);
    if (current === null) return { state: 'unreadable' };
    if (current.block === null) return { state: 'absent' };
    return { state: current.block === rendered.block ? 'active' : 'outdated' };
  }
  const texts = rendered.files.map((file) => readText(file.path));
  if (texts.every((text) => text === null)) return { state: 'absent' };
  if (texts.some((text, i) => text !== rendered.files[i].content)) return { state: 'outdated' };
  const probes = platform === 'systemd'
    ? [['systemctl', ['--user', 'is-enabled', `${name}.timer`]], ['systemctl', ['--user', 'is-active', `${name}.timer`]]]
    : [['launchctl', ['print', `gui/${uid}/${name}`]]];
  for (const [program, args] of probes) {
    const result = run(program, args, { env });
    if (result.status !== 0) {
      const detail = (result.stdout || result.stderr).trim().split('\n')[0] || context.t('schedule.no_output');
      return { state: 'inactive', detail };
    }
  }
  return { state: 'active' };
}

function lastRunSummary(t, file) {
  const text = readText(file);
  if (text === null) return t('schedule.status_no_last_run', { file });
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return t('schedule.status_last_run_unreadable', { file, detail: error.message });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return t('schedule.status_last_run_unreadable', { file, detail: typeof value });
  }
  // A timestamp is shown to a person as DD/MM/YYYY HH:MM on the machine's
  // clock, the clock the windows fire on; every other scalar as it is.
  const summary = Object.entries(value)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${k}=${typeof v === 'string' && ISO_INSTANT.test(v) ? shownInstant(v) : v}`)
    .join(', ');
  return t('schedule.status_last_run', { summary });
}

function status(context, rendered, windows, lastRun, now) {
  const { t, say, name, platform } = context;
  const found = installedState(context, rendered);
  if (found.state === 'unreadable') return EXIT.FAILURE;
  if (found.state === 'absent') {
    say(t('schedule.status_not_installed', { name, platform }));
    const elsewhere = context.detected ? installedElsewhere(context) : [];
    if (elsewhere.length > 0) say(t('schedule.found_elsewhere', { name, platform, platforms: elsewhere }));
  } else if (found.state === 'outdated') say(t('schedule.status_outdated', { name, platform }));
  else if (found.state === 'inactive') say(t('schedule.status_inactive', { name, platform, detail: found.detail }));
  else {
    say(t('schedule.status_active', { name, platform }));
    say(t('schedule.status_next', { times: nextFireTimes(windows, now) }));
  }
  say(lastRunSummary(t, lastRun));
  return found.state === 'active' ? EXIT.OK : EXIT.FAILURE;
}

// --- the morning briefing's desktop task (phase 4, task 4) -------------------
//
// The briefing asks the person questions, so it runs in a session of their
// own, started by a scheduled task of the Claude desktop application
// (`~/.claude/scheduled-tasks/<taskId>/SKILL.md`, a cron in the machine's
// local time, run while the application is open and on its next launch when
// it was closed). Such a task can be created only from inside the
// application, with its scheduled-task tool: `install --job briefing`
// prints what to register there and exits 3 (a human step remains), and the
// setup skill's model creates it with those values exactly.
//
// That tool takes no working directory (measured 25/09/2026: taskId,
// prompt, description, cronExpression or fireAt, title,
// notifyOnCompletion), so the task's session does not start in the vault
// and the plugin's skill could not find it from there (ruling R-T11). The
// task's prompt is therefore exactly two lines: the briefing's signature,
// which the transcripts source's self-trace filter reads on a session's
// first user line to keep the briefing's own sessions away from the curator
// (decision B6); and one instruction, in the vault's language, to run the
// kit's own `prompt briefing --vault "<vault>"` with Bash and follow what
// it prints. The kit's path in that line is absolute, so a plugin update
// that moves the plugin's cache leaves it pointing at nothing: `status
// --job briefing` and doctor's `briefing` check read the task back and say
// so, with the fix (install again and update the task).

export const BRIEFING_TASK_PREFIX = 'brain-kit-briefing-';
// Five cron fields, the only shape the application's cronExpression takes.
const CRON_FIELDS = /^\S+(\s+\S+){4}$/;
// Characters a double-quoted bash word keeps special.
const BASH_SPECIAL = /[\\"$`]/g;
// A kit path kitCommand() quotes as it is, so none of these may be in it.
const KIT_UNSAFE = /["\\$`]/;
// The command line of the task's second line, as the kit writes it.
const BRIEFING_COMMAND = /node "((?:[^"\\]|\\.)*)" prompt briefing --vault "((?:[^"\\]|\\.)*)"/;

export function briefingTaskId(vaultId) {
  return `${BRIEFING_TASK_PREFIX}${vaultId}`;
}

// Where the desktop application keeps the task of `taskId`, under `env`'s HOME.
export function briefingTaskFile(env, taskId) {
  return join(env.HOME || homedir(), '.claude', 'scheduled-tasks', taskId, 'SKILL.md');
}

function hasControl(value) {
  return [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

// One bash word in double quotes: a vault named `Ana's "brain"` is still
// the one argument it is.
function bashQuoted(value) {
  return `"${value.replace(BASH_SPECIAL, (c) => `\\${c}`)}"`;
}

function bashUnquoted(inner) {
  return inner.replace(/\\(.)/g, '$1');
}

function vaultLang(config, env) {
  return SUPPORTED_LANGS.includes(config?.lang) ? config.lang : resolveLang(env);
}

// What to register for the vault at `root` (its real path), or { problem }
// naming why it cannot be registered: the task's id, title, cron,
// description and two-line prompt, the title, description and second line
// in the vault's own language.
export function briefingTask({ root, config, vaultId, env = process.env }) {
  const signature = briefingSetting(config, 'signature');
  if (signatureProblem(signature) !== null) {
    return { problem: { key: 'schedule.bad_signature', params: { key: 'briefing.signature', value: JSON.stringify(signature), file: CONFIG_FILENAME } } };
  }
  const cron = briefingSetting(config, 'schedule');
  if (typeof cron !== 'string' || !CRON_FIELDS.test(cron.trim())) {
    return { problem: { key: 'schedule.briefing_bad_cron', params: { value: JSON.stringify(cron), file: CONFIG_FILENAME } } };
  }
  const kit = kitCommand();
  if (KIT_UNSAFE.test(kit.slice(1, -1)) || hasControl(kit)) {
    return { problem: { key: 'schedule.briefing_unsafe_path', params: { path: kit.slice(1, -1) } } };
  }
  if (hasControl(root)) return { problem: { key: 'schedule.briefing_unsafe_path', params: { path: root } } };
  const vt = createTranslator(vaultLang(config, env));
  const command = `node ${kit} prompt briefing --vault ${bashQuoted(root)}`;
  const title = typeof config?.vault?.title === 'string' && config.vault.title.trim() !== '' ? config.vault.title.trim() : basename(root);
  return {
    taskId: briefingTaskId(vaultId),
    title: vt('schedule.briefing_title', { title }),
    cronExpression: cron.trim().split(/\s+/).join(' '),
    description: vt('schedule.briefing_description', { vault: root }),
    prompt: `${signature}\n${vt('schedule.briefing_run_line', { command })}`,
    signature,
    command,
  };
}

function samePath(a, b) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

// A task file's prompt: its text after any frontmatter the application
// writes above it.
function taskPrompt(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

// The version recorded in the package.json of the kit whose entry point is
// `kit` (<kit root>/bin/brain-kit.mjs), or '-' when it cannot be read.
function kitVersionAt(kit) {
  try {
    const version = JSON.parse(readFileSync(join(dirname(dirname(kit)), 'package.json'), 'utf8')).version;
    return typeof version === 'string' && version !== '' ? version : '-';
  } catch {
    return '-';
  }
}

// The registered task, read back: { state, signed, taskId, file, ... }
// where state is 'absent', 'unreadable' (detail), 'bad_signature' (the
// configured signature itself is refused by signatureProblem: problem),
// 'unsigned' (its prompt does not start with the signature: its sessions
// would reach the curator), 'no_command' (no line runs the kit's
// briefing), 'kit_missing' (kit: the path its line names, which no longer
// exists), 'vault_differs' (vault: the vault its line names), 'kit_other'
// (kit and current: it runs an existing kit that is not this one, with
// version and currentVersion) or 'ok' (kit). `signed` is the transcripts
// source's own predicate (startsWithSignature, ruling R-T12) applied to the
// task's prompt: exactly whether the curator would drop the session the
// task starts. 'ok' and 'kit_other' are the task working.
export function readBriefingTask({ root, config, vaultId, env = process.env, currentKit = kitCommand().slice(1, -1) }) {
  const taskId = briefingTaskId(vaultId);
  const file = briefingTaskFile(env, taskId);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'absent', taskId, file };
    return { state: 'unreadable', taskId, file, detail: error.code ?? error.message };
  }
  const signature = briefingSetting(config, 'signature');
  const prompt = taskPrompt(text);
  const signed = startsWithSignature(prompt, [signature]);
  const problem = signatureProblem(signature);
  if (problem !== null) return { state: 'bad_signature', signed, taskId, file, signature, problem };
  if (!signed) return { state: 'unsigned', signed, taskId, file, signature };
  // Only the prompt: a field of the frontmatter the application writes is
  // never the command.
  const match = BRIEFING_COMMAND.exec(prompt);
  if (match === null) return { state: 'no_command', signed, taskId, file };
  const kit = bashUnquoted(match[1]);
  const vault = bashUnquoted(match[2]);
  if (!existsSync(kit)) return { state: 'kit_missing', signed, taskId, file, kit };
  if (!samePath(vault, root)) return { state: 'vault_differs', signed, taskId, file, kit, vault };
  if (!samePath(kit, currentKit)) {
    return { state: 'kit_other', signed, taskId, file, kit, version: kitVersionAt(kit), current: currentKit, currentVersion: kitVersionAt(currentKit) };
  }
  return { state: 'ok', signed, taskId, file, kit };
}

function briefingJob({ action, root, config, machine, env, t, say, complain, now, localZone }) {
  const enabled = briefingSetting(config, 'enabled') === true;
  const vaultId = machine.vault_id;
  if (action === 'uninstall') {
    const taskId = briefingTaskId(vaultId);
    say(t('schedule.briefing_uninstall', { taskId, file: briefingTaskFile(env, taskId) }));
    return EXIT.DEGRADED;
  }
  if (action === 'status') {
    const found = readBriefingTask({ root, config, vaultId, env });
    const { taskId, file } = found;
    if (!enabled) {
      if (found.state === 'absent') {
        say(t('schedule.briefing_status_disabled', { file: CONFIG_FILENAME }));
        return EXIT.OK;
      }
      say(t('schedule.briefing_status_disabled_registered', { taskId, file, config: CONFIG_FILENAME }));
      return EXIT.FAILURE;
    }
    const again = 'brain-kit schedule install --job briefing';
    const signature = briefingSetting(config, 'signature');
    if (signatureProblem(signature) !== null) {
      say(t('schedule.bad_signature', { key: 'briefing.signature', value: JSON.stringify(signature), file: CONFIG_FILENAME }));
      return EXIT.FAILURE;
    }
    switch (found.state) {
      case 'absent': say(t('schedule.briefing_status_absent', { taskId, file, command: again })); break;
      case 'unreadable': say(t('schedule.briefing_status_unreadable', { taskId, file, detail: found.detail })); break;
      case 'unsigned': say(t('schedule.briefing_status_unsigned', { taskId, file, signature: found.signature, command: again })); break;
      case 'no_command': say(t('schedule.briefing_status_no_command', { taskId, file, command: again })); break;
      case 'kit_missing': say(t('schedule.briefing_status_kit_missing', { taskId, kit: found.kit, command: again })); break;
      case 'vault_differs': say(t('schedule.briefing_status_vault_differs', { taskId, vault: found.vault, root, command: again })); break;
      // A task that works, with the kit of another install: said, never a
      // failure (doctor run from a clone differs from the plugin's cache).
      case 'kit_other': say(t('schedule.briefing_status_kit_other', { taskId, kit: found.kit, version: found.version, current: found.current, currentVersion: found.currentVersion, command: again })); break;
      case 'ok': say(t('schedule.briefing_status_ok', { taskId, file, kit: found.kit })); break;
      default: throw new Error(`unknown briefing task state ${found.state}`);
    }
    return found.state === 'ok' || found.state === 'kit_other' ? EXIT.OK : EXIT.FAILURE;
  }
  // install
  if (!enabled) {
    complain(t('schedule.briefing_disabled', { file: CONFIG_FILENAME }));
    return EXIT.USAGE;
  }
  const task = briefingTask({ root, config, vaultId, env });
  if (task.problem) {
    complain(t(task.problem.key, task.problem.params));
    return EXIT.USAGE;
  }
  const zone = localZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = config.vault?.timezone;
  if (isValidTimeZone(zone) && isValidTimeZone(timezone) && !sameClock(zone, timezone, now)) {
    complain(t('schedule.briefing_timezone_differs', { local: zone, vault: timezone }));
  }
  say(t('schedule.briefing_register', { taskId: task.taskId }));
  // The field names are the application tool's own parameters, never
  // translated; the values of title and description are the vault's.
  say(t('schedule.briefing_field', { field: 'taskId', value: task.taskId }));
  say(t('schedule.briefing_field', { field: 'title', value: task.title }));
  say(t('schedule.briefing_field', { field: 'cronExpression', value: task.cronExpression }));
  say(t('schedule.briefing_field', { field: 'description', value: task.description }));
  say(t('schedule.briefing_prompt_follows'));
  say(task.prompt);
  return EXIT.DEGRADED;
}
