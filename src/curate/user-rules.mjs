// What the person's own Claude Code allow rules would grant a round in
// connector mode, and what the round does about each one (phase 3,
// decision D3 of docs/superpowers/plans/2026-09-24-phase-3-connector-sources.md).
//
// Connector mode loads the user settings (`--setting-sources user`,
// src/harness/claude-code.mjs), which is what makes the claude.ai
// connectors appear, and with them every allow rule of the person's.
// Measured on 24/09/2026 with Claude Code 2.1.281 (measurement 3 of the
// plan): a user rule allowing `Bash(rtk curl *)` let `rtk curl` run inside
// such a round, and the same rule passed in --disallowedTools denied it,
// because a deny wins over an allow. So every user allow rule is mirrored
// as a deny, except:
//   - a rule the round's own allow list already holds, exactly, or scoped
//     for a tool the round allows by its bare name (ToolSearch): the round
//     grants it anyway, and mirrored it would deny the round's own tool;
//   - a read rule (Read, Glob, Grep, LS): mirrored, a bare `Read` would
//     deny the round's own reads; it is recorded in `widenedReads` when it
//     reaches outside the vault, and never mirrored;
//   - a write rule inside the vault: the round's own Edit(./**) and its
//     protected-path denies already govern it.
// A rule that cannot be mirrored without denying the round's own tools
// refuses connector mode for the round (a `blocking` entry): a write rule
// covering the vault or a folder that holds it (`covers_vault`), a Bash
// rule covering every command or one of the round's own kit commands
// (`covers_kit`), and a settings file or a rule that cannot be read with a
// known meaning (`unreadable`). A Bash rule that covers the round's
// `node <kit>` forms only is mirrored, and `dropNodeForms` tells the round
// to leave those forms out of its allow list, keeping the direct ones.
//
// Paths in a rule from user settings resolve as Claude Code resolves them
// there: `//x` is /x, `~/x` is under the home directory, `/x` is under the
// settings file's own folder, and `./x` or `x` is under the round's
// working directory, the vault root. A scope is judged by its literal
// prefix, the text before its first glob character.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { rulesIn } from '../harness/claude-code.mjs';
import { KIT_SUBCOMMANDS, kitCommand } from './tools.mjs';

const SETTINGS_FILES = Object.freeze(['settings.json', 'settings.local.json']);
const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const GLOB_CHARACTERS = Object.freeze(['*', '?', '[', '{']);

// `Tool` or `Tool(scope)`. A tool name starts with a letter, a digit, `_`
// or `*` (never a dash, which the CLI would read as an option) and holds
// no space, comma or parenthesis; MCP names such as
// `mcp__claude_ai_Gmail__send_email` and `mcp__server__*` fit.
const RULE = /^([A-Za-z0-9_*][A-Za-z0-9_.:*-]*)(?:\((.*)\))?$/;

// The user settings files a connector-mode round loads, among
// settings.json and settings.local.json of CLAUDE_CONFIG_DIR when it is
// set, of ~/.claude otherwise: the ones that exist.
export function userSettingsFiles(env = process.env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : null;
  const dir = configured ?? join(env.HOME || homedir(), '.claude');
  return SETTINGS_FILES.map((name) => join(dir, name)).filter((file) => existsSync(file));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The allow rules of one settings file; null when the file cannot be read
// or parsed, or holds them in any shape but a list of strings. A file with
// no permissions, or permissions with no allow list, allows nothing.
function allowRules(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  if (data.permissions === undefined) return [];
  if (!isPlainObject(data.permissions)) return null;
  const { allow } = data.permissions;
  if (allow === undefined) return [];
  if (!Array.isArray(allow) || !allow.every((rule) => typeof rule === 'string')) return null;
  return allow;
}

function hasControlCharacter(text) {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

// `{ tool, spec }` for a rule the CLI reads as exactly one rule, Tool
// (spec null) or Tool(spec); null otherwise. A mirrored rule goes back to
// the CLI in --disallowedTools, which splits its list at commas and spaces
// outside parentheses: a rule that splits there (its first piece is then
// not the whole rule, or there is none) would be denied as other rules
// than the one the person allowed. A control character inside a scope has
// no measured meaning either.
function parseRule(rule) {
  if (hasControlCharacter(rule) || rulesIn(rule)[0] !== rule) return null;
  const m = RULE.exec(rule);
  return m === null ? null : { tool: m[1], spec: m[2] === undefined ? null : m[2] };
}

// The text before the first glob character, and whether there was one.
function literalPrefix(text) {
  let end = text.length;
  for (const ch of GLOB_CHARACTERS) {
    const at = text.indexOf(ch);
    if (at !== -1 && at < end) end = at;
  }
  return { literal: text.slice(0, end), globbed: end < text.length };
}

// Where a path rule's scope points: the absolute path its literal prefix
// resolves to, and whether that prefix stops inside a name (`va*`), so the
// rule also reaches every name that merely starts with it.
function scopeOf(spec, { settingsDir, vault, home }) {
  const text = spec.trim();
  let base = vault;
  let rest = text;
  if (text.startsWith('//')) {
    base = sep;
    rest = text.slice(2);
  } else if (text === '~' || text.startsWith('~/')) {
    base = home;
    rest = text.slice(2);
  } else if (text.startsWith('/')) {
    base = settingsDir;
    rest = text.slice(1);
  }
  const { literal, globbed } = literalPrefix(rest);
  return { path: resolve(base, literal), partial: globbed && literal !== '' && !literal.endsWith('/') };
}

// The vault itself or a folder that holds it, or a name one of them starts
// with when the scope stops inside a name.
function coversVault({ path, partial }, vault) {
  const ancestorOrSelf = path === vault || vault.startsWith(path.endsWith(sep) ? path : path + sep);
  return ancestorOrSelf || (partial && vault.startsWith(path));
}

// Everything the scope reaches is inside the vault (the vault itself
// included, when the scope names exactly it).
function insideVault({ path, partial }, vault) {
  return (path === vault && !partial) || path.startsWith(vault + sep);
}

// The literal command a Bash rule's scope starts with: the text before its
// first wildcard, a `:*` suffix read as one, trimmed.
function commandPrefix(spec) {
  const { literal, globbed } = literalPrefix(spec);
  const text = globbed && spec[literal.length] === '*' && literal.endsWith(':') ? literal.slice(0, -1) : literal;
  return text.trim();
}

// A denied command prefix hits one of the round's own command forms when
// every invocation of the form starts with it, or it names some of them.
function overlaps(prefix, form) {
  return form.startsWith(prefix) || prefix.startsWith(form);
}

export function mirrorUserRules({ files = [], ownAllowed = [], vaultRoot, home = homedir(), kit = kitCommand() } = {}) {
  if (typeof vaultRoot !== 'string' || !isAbsolute(vaultRoot)) throw new TypeError(`mirrorUserRules: vaultRoot must be an absolute path, got ${JSON.stringify(vaultRoot)}`);
  const vault = resolve(vaultRoot);
  const own = new Set(ownAllowed.filter((rule) => typeof rule === 'string').flatMap((rule) => rulesIn(rule)));
  const kitForms = KIT_SUBCOMMANDS.map((sub) => `${kit} ${sub}`);
  const nodeForms = kitForms.map((form) => `node ${form}`);
  const deny = [];
  const widenedReads = [];
  const blocking = [];
  let dropNodeForms = false;
  const add = (list, rule) => {
    if (!list.includes(rule)) list.push(rule);
  };

  for (const file of files) {
    const allow = allowRules(file);
    if (allow === null) {
      blocking.push({ rule: null, file, reason: 'unreadable' });
      continue;
    }
    const where = { settingsDir: dirname(file), vault, home };
    for (const rule of allow) {
      if (own.has(rule)) continue;
      const parsed = parseRule(rule);
      if (parsed === null) {
        blocking.push({ rule, file, reason: 'unreadable' });
        continue;
      }
      const { tool, spec } = parsed;
      if (spec !== null && own.has(tool)) continue;
      if (READ_TOOLS.includes(tool)) {
        if (spec === null || !insideVault(scopeOf(spec, where), vault)) add(widenedReads, rule);
        continue;
      }
      if (WRITE_TOOLS.includes(tool)) {
        const scope = spec === null ? null : scopeOf(spec, where);
        if (scope === null || coversVault(scope, vault)) blocking.push({ rule, file, reason: 'covers_vault' });
        else if (!insideVault(scope, vault)) add(deny, rule);
        continue;
      }
      if (tool === 'Bash') {
        const prefix = spec === null ? null : commandPrefix(spec);
        if (prefix === null || kitForms.some((form) => overlaps(prefix, form))) {
          blocking.push({ rule, file, reason: 'covers_kit' });
          continue;
        }
        if (nodeForms.some((form) => overlaps(prefix, form))) dropNodeForms = true;
        add(deny, rule);
        continue;
      }
      add(deny, rule);
    }
  }
  return { deny, widenedReads, blocking, dropNodeForms };
}

// The message naming one blocking entry, for the round's log, `curate
// --dry` and doctor.
export function blockingMessage({ rule, file, reason }) {
  if (reason === 'unreadable' && rule === null) return { messageKey: 'curate.user_rules.unreadable', params: { file } };
  if (reason === 'unreadable') return { messageKey: 'curate.user_rules.unreadable_rule', params: { rule, file } };
  return { messageKey: `curate.user_rules.${reason}`, params: { rule, file } };
}
