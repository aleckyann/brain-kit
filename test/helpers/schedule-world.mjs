// Test-only scaffolding for `brain-kit schedule`: a scratch world where
// HOME, XDG_CONFIG_HOME and the state directory all live in a temporary
// directory, and `systemctl`, `launchctl` and `crontab` are fakes that
// only append their argument vector to a log. PATH holds nothing but the
// fakes' directory, so a test that forgot a fake reaches no real
// scheduler: the command is simply not found. Nothing here can install a
// timer on the machine running the suite.
//
// The vault sits under a directory with a space and an accented letter
// ("Área de trabalho"), because that is the path a real person has and the
// one quoting has to survive.
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from '../../src/lang.mjs';
import { runSchedule } from '../../src/commands/schedule.mjs';
import { makeTempDir } from './tmp.mjs';

export const VAULT_ID = 'vault-1a2b3c4d';
export const ACCENTED = 'Área de trabalho';

const FAKE_SYSTEMCTL = `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *show-environment*) exit "\${FAKE_SYSTEMCTL_PROBE:-0}" ;;
  *is-enabled*) if [ -n "$FAKE_SYSTEMCTL_DISABLED" ]; then echo disabled; exit 1; fi; echo enabled; exit 0 ;;
  *is-active*) echo active; exit 0 ;;
esac
exit "\${FAKE_SYSTEMCTL_STATUS:-0}"
`;

const FAKE_LAUNCHCTL = `#!/bin/sh
printf 'launchctl %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" = "bootout" ]; then exit "\${FAKE_BOOTOUT_STATUS:-0}"; fi
exit "\${FAKE_LAUNCHCTL_STATUS:-0}"
`;

const FAKE_CRONTAB = `#!/bin/sh
printf 'crontab %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" = "-l" ]; then
  if [ -f "$FAKE_CRONTAB" ]; then /bin/cat "$FAKE_CRONTAB"; exit 0; fi
  echo "no crontab for ana" >&2
  exit 1
fi
if [ "$1" = "-" ]; then /bin/cat > "$FAKE_CRONTAB"; exit 0; fi
exit 2
`;

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}

// Options:
//   vaultName   the vault directory's own name (default "vault")
//   schedule, timezone, enabled   written into the fixture configuration
//   machine     overrides for machine.json
//   fakes       which fakes to put on PATH (default all three)
export function makeScheduleWorld({ vaultName = 'vault', schedule, timezone = 'America/Sao_Paulo', enabled = true, machine = {}, fakes = ['systemctl', 'launchctl', 'crontab'] } = {}) {
  const base = realpathSync(makeTempDir('brain-kit-schedule-'));
  const home = join(base, 'home', 'ana');
  const xdg = join(base, 'xdg-config');
  const stateDir = join(base, 'state');
  const fakeBin = join(base, 'fake-bin');
  const log = join(base, 'commands.log');
  const crontab = join(base, 'crontab.txt');
  const vault = join(home, ACCENTED, vaultName);
  const claudeDir = join(base, 'opt', 'claude édition', 'bin');
  for (const dir of [home, xdg, stateDir, fakeBin, vault, claudeDir]) mkdirSync(dir, { recursive: true });
  if (fakes.includes('systemctl')) writeExecutable(join(fakeBin, 'systemctl'), FAKE_SYSTEMCTL);
  if (fakes.includes('launchctl')) writeExecutable(join(fakeBin, 'launchctl'), FAKE_LAUNCHCTL);
  if (fakes.includes('crontab')) writeExecutable(join(fakeBin, 'crontab'), FAKE_CRONTAB);
  const claude = writeExecutable(join(claudeDir, 'claude'), '#!/bin/sh\necho "2.1.300 (Claude Code)"\n');

  const config = JSON.parse(readFileSync(new URL('../fixtures/config/valid.json', import.meta.url), 'utf8'));
  config.vault.timezone = timezone;
  config.curate.enabled = enabled;
  if (schedule !== undefined) config.curate.schedule = schedule;
  writeFileSync(join(vault, 'brain-kit.config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(vault, 'index.md'), '# Index\n');

  const machineJson = {
    vault_id: VAULT_ID,
    canonical_path: vault,
    claude_bin: claude,
    path_extra: ['~/.local/bin', '/opt/tools/bin'],
    state_dir: stateDir,
    paths: {
      watermark: join(stateDir, 'watermark.json'),
      last_run: join(stateDir, 'last-run.json'),
      log_dir: join(stateDir, 'logs'),
    },
    ...machine,
  };
  writeFileSync(join(stateDir, 'machine.json'), JSON.stringify(machineJson, null, 2), { mode: 0o600 });

  const env = {
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    BRAIN_KIT_STATE_DIR: stateDir,
    PATH: fakeBin,
    FAKE_LOG: log,
    FAKE_CRONTAB: crontab,
  };
  const t = createTranslator('en');

  return {
    base, home, xdg, stateDir, fakeBin, vault, claude, claudeDir, log, crontab, env, t, machine: machineJson,
    unitDir: join(xdg, 'systemd', 'user'),
    agentsDir: join(home, 'Library', 'LaunchAgents'),
    name: `brain-kit-curate-${VAULT_ID}`,
    setMachine(overrides) {
      Object.assign(machineJson, overrides);
      writeFileSync(join(stateDir, 'machine.json'), JSON.stringify(machineJson, null, 2), { mode: 0o600 });
    },
    commands() {
      return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [];
    },
    async run(argv, deps = {}) {
      let stdout = '';
      let stderr = '';
      const io = { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } };
      const status = await runSchedule(argv, io, t, {
        env: { ...env, ...(deps.env ?? {}) },
        cwd: deps.cwd ?? vault,
        platform: deps.platform ?? 'linux',
        uid: 501,
        localZone: deps.localZone ?? timezone,
        ...Object.fromEntries(Object.entries(deps).filter(([key]) => !['env', 'cwd', 'platform', 'localZone'].includes(key))),
      });
      return { status, stdout, stderr };
    },
  };
}

// systemd's own reading of an ExecStart= or Environment= value: words split
// on blanks, a double-quoted run taken whole with C escapes undone, then
// the specifier `%%` and (ExecStart only) `$$` folded back. Written here,
// independently of the renderer, so a quoting mistake in one is not
// mirrored in the other.
export function systemdWords(value, { exec }) {
  const words = [];
  let i = 0;
  while (i < value.length) {
    while (value[i] === ' ' || value[i] === '\t') i++;
    if (i >= value.length) break;
    let word = '';
    while (i < value.length && value[i] !== ' ' && value[i] !== '\t') {
      if (value[i] === '"') {
        i++;
        while (i < value.length && value[i] !== '"') {
          if (value[i] === '\\') i++;
          word += value[i];
          i++;
        }
        if (value[i] !== '"') throw new Error(`unterminated quote in ${value}`);
        i++;
      } else {
        word += value[i];
        i++;
      }
    }
    words.push(word);
  }
  // A lone `%` is a specifier systemd expands (or rejects), and in
  // ExecStart a `$` before a name or a brace is a variable it expands: a
  // value that reaches either unescaped is not the value that was meant.
  return words.map((w) => {
    let out = '';
    for (let j = 0; j < w.length; j++) {
      const c = w[j];
      if (c === '%') {
        if (w[j + 1] !== '%') throw new Error(`unescaped specifier in ${w}`);
        out += '%';
        j++;
      } else if (exec && c === '$') {
        if (w[j + 1] === '$') { out += '$'; j++; } else if (/[A-Za-z_{]/.test(w[j + 1] ?? '')) throw new Error(`unescaped variable in ${w}`);
        else out += '$';
      } else out += c;
    }
    return out;
  });
}

// The files a `--dry` run prints: each "--- <path>" header, followed by the
// file's text up to the next header or the first "$ " command line.
export function dryFiles(stdout) {
  const files = {};
  let current = null;
  for (const line of stdout.split('\n')) {
    const header = /^--- (.+)$/.exec(line);
    if (header) { current = header[1]; files[current] = ''; continue; }
    if (line.startsWith('$ ')) { current = null; continue; }
    if (current !== null) files[current] += `${line}\n`;
  }
  return files;
}

// The value of every `Key=` line in a unit, in order.
export function unitValues(text, key) {
  return text.split('\n').filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
}

// A plist <string> back to its text.
export function xmlText(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// cronie's own pass over a command before handing it to /bin/sh: a `%`
// ends the command unless a backslash stands before it, and then the
// backslash goes.
export function cronCommand(command) {
  let out = '';
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      if (ch === '%') out = `${out.slice(0, -1)}%`;
      else out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { escaped = true; out += ch; continue; }
    if (ch === '%') break;
    out += ch;
  }
  return out;
}
