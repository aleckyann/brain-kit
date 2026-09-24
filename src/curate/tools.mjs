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

export const KIT_SUBCOMMANDS = Object.freeze(['validate', 'lint', 'propose']);

const BASE_ALLOWED = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);

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

// `extra` is the vault's `curate.allowed_tools_extra`, appended as given.
export function allowedTools(extra = []) {
  const kit = kitCommand();
  const kitRules = KIT_SUBCOMMANDS.flatMap((sub) => [`Bash(${kit} ${sub}:*)`, `Bash(node ${kit} ${sub}:*)`]);
  return [...BASE_ALLOWED, ...kitRules, ...extra];
}

// `extra` is the vault's `curate.disallowed_tools_extra`, appended as given.
export function disallowedTools(extra = []) {
  return [...BASE_DISALLOWED, ...extra];
}
