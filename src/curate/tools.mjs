// What the model in a curate round may run, and what it may never run
// (docs/superpowers/plans/2026-09-24-phase-2-scheduled-curator.md, tasks
// 4 and 6). The prompt names the kit's commands through `{{kit}}`, and
// test/prompt-curate.test.mjs proves every command the prompt tells the
// model to run is granted here: a prompt that names a tool the allowlist
// does not grant makes the model burn its turns on workarounds (incident
// "a wrong allowlist burned every turn on workarounds", docs/incidents.md).
//
// Measured on 24/09/2026 against Claude Code 2.1.281: a double-quoted
// absolute path containing a space matches a `Bash(<path> <sub>:*)` rule
// per subcommand, another subcommand of the same executable is denied,
// and in one of two runs the model put `node` in front of the kit on its
// own. So each subcommand is granted twice, bare and behind `node`.
//
// There is deliberately no `Bash(node:*)` in the denylist: a deny rule
// wins over an allow rule, so it would also block the allowed
// `node <kit> <sub>` form, and `--permission-mode dontAsk` already denies
// every `node` command no rule allows.
import { join } from 'node:path';
import { KIT_ROOT } from '../version.mjs';
import { unsafeRuleCharacters } from './rule-path.mjs';

export const KIT_SUBCOMMANDS = Object.freeze(['validate', 'lint', 'propose']);

// Edit and Write are granted inside the vault only. Measured by the
// controller on 24/09/2026 against Claude Code 2.1.281: `Edit(./**)` and
// `Write(./**)` (paths relative to the round's working directory, the
// vault root) let the model write in the vault and denied a write outside
// it, and a path deny rule such as `Edit(./.githooks/**)` wins over them.
// Bare `Edit`/`Write` would reach any file the user can write.
//
// Reads are scoped the same way (phase 3, task 1). Phase 2 allowed a bare
// Read, Glob and Grep, which reach any file the user can read. Measured on
// 24/09/2026 against Claude Code 2.1.281 (measurement 4 of
// docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md and the
// controller's rulings R-A1 and R-A2): `Read(./**)` plus
// `Read(//<absolute dir>/**)` denied a read of /etc/hostname and allowed
// the vault and that directory; `Read(//<dir with a space>/<accented
// name>.jsonl)` allowed that exact file and denied its sibling; with
// `Glob(./**)` and `Grep(./**)`, a Glob in /etc and a Grep of /etc/hosts
// were denied and both worked inside the vault. ToolSearch reads no file:
// it is how the model loads a connector's deferred tools.
const BASE_ALLOWED = Object.freeze(['Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)', 'ToolSearch']);

// An absolute path as a permission rule names it: `//` and the path without
// its leading slash, the form Claude Code reads from the root of the file
// system. A path that is not absolute is refused: relative to where the
// round runs, it would name another file. So is a path holding a character
// whose meaning inside a rule is not measured (src/curate/rule-path.mjs):
// the callers never pass one (the transcripts source lists such a file as
// unreadable, and machine.json refuses such a transcripts_dir), and this
// is the last line, for any caller that would.
function rulePath(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError(`${label}: not an absolute path: ${JSON.stringify(path)}`);
  const unsafe = unsafeRuleCharacters(path);
  if (unsafe.length > 0) throw new TypeError(`${label}: ${JSON.stringify(path)} holds ${unsafe.join(' ')}, which a read rule cannot carry with a known meaning`);
  return `//${path.slice(1)}`;
}

function readFileRule(file) {
  return `Read(${rulePath(file, 'readFiles')})`;
}

// A directory and everything under it. The root itself would be the whole
// disk, and is refused.
function readDirRule(dir) {
  const path = rulePath(dir, 'readDirs').replace(/\/+$/, '');
  if (path === '') throw new TypeError(`readDirs: the root of the file system is not a read root: ${JSON.stringify(dir)}`);
  return `Read(${path}/**)`;
}

// What the model must never write, even inside the vault: what runs code
// (hooks, git's own configuration, CI, Claude Code settings), what decides
// the kit's own behaviour, and what decides what git sees. Review of task 6,
// finding I6: the model edited the tracked pre-push hook, ran `propose`
// (whose push ran the hook, outside every allowlist) and wrote the hook
// back byte for byte, leaving no trace. `propose`, joined to a round,
// also refuses when any of these differs from HEAD (defense in depth).
// `.mcp.json` declares MCP servers a session may start before any
// permission check; connector mode runs without --strict-mcp-config, and
// whether it starts a working directory's `.mcp.json` is not measured
// (review M4 of task 2, 25/09/2026).
export const PROTECTED_PATHS = Object.freeze([
  '.githooks', '.git', '.github', '.claude', '.brain-kit', 'brain-kit.config.json', '.gitignore', '.gitattributes', '.gitmodules', '.mcp.json',
]);

// Both forms for every protected path, the path itself and everything
// under it, for Edit and for Write: a rule for a directory that happens to
// be a file (or the reverse) still holds.
function protectedRules() {
  return PROTECTED_PATHS.flatMap((path) => [`Edit(./${path})`, `Edit(./${path}/**)`, `Write(./${path})`, `Write(./${path}/**)`]);
}

const BASE_DISALLOWED = Object.freeze([
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(gh:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(rm:*)',
  'WebFetch',
  'WebSearch',
]);

// This kit's own entry point as a double-quoted absolute path, with no
// `node` in front: the exact string `{{kit}}` renders to in the curate
// prompt, and the prefix of every Bash rule below.
export function kitCommand() {
  return `"${join(KIT_ROOT, 'bin', 'brain-kit.mjs')}"`;
}

// Characters a double-quoted bash word keeps special.
const BASH_SPECIAL = /[\\"$`]/g;

// One bash word in double quotes: a vault named `Ana's "brain"` is still
// the one argument it is.
export function bashQuoted(value) {
  return `"${value.replace(BASH_SPECIAL, (c) => `\\${c}`)}"`;
}

// The kit's command as run from anywhere for the vault at `dir`: the kit's
// global `-C <dir>` (src/cli.mjs) in front of the subcommand, both paths one
// bash word each. The morning briefing names every kit command this way,
// because the session it runs in may have any working directory (final
// review of phase 4, finding C2). For a kit path with none of bash's
// special characters in it, the prefix is exactly kitCommand().
export function kitCommandIn(dir) {
  return `${bashQuoted(join(KIT_ROOT, 'bin', 'brain-kit.mjs'))} -C ${bashQuoted(dir)}`;
}

// `extra` is the vault's `curate.allowed_tools_extra`, appended as given.
// `readFiles` are absolute paths the round may read, each one exactly (the
// transcripts its plan lists, ruling R-A2), and `readDirs` absolute
// directories it may read everything under; nothing else outside the vault
// is readable.
export function allowedTools(extra = [], { readFiles = [], readDirs = [] } = {}) {
  const kit = kitCommand();
  const kitRules = KIT_SUBCOMMANDS.flatMap((sub) => [`Bash(${kit} ${sub}:*)`, `Bash(node ${kit} ${sub}:*)`]);
  const readRules = [...new Set([...readFiles.map(readFileRule), ...readDirs.map(readDirRule)])];
  return [...BASE_ALLOWED, ...readRules, ...kitRules, ...extra];
}

// `extra` is the vault's `curate.disallowed_tools_extra`, appended as given.
export function disallowedTools(extra = []) {
  return [...BASE_DISALLOWED, ...protectedRules(), ...extra];
}
