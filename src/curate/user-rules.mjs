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
// known meaning (`unreadable`: a file that cannot be read or parsed, or
// whose path is not absolute; a rule that splits, holds a parenthesis or a
// control character in its scope, or a write rule whose scope could climb
// out of its literal prefix). A Bash rule that covers the round's
// `node <kit>` forms only is mirrored, and `dropNodeForms` tells the round
// to leave those forms out of its allow list, keeping the direct ones.
//
// Paths in a rule from user settings resolve as Claude Code resolves them
// there: `//x` is /x, `~/x` is under the home directory, `/x` is under the
// settings file's own folder, and `./x` or `x` is under the round's
// working directory, the vault root. A scope is judged by its literal
// prefix, the text before its first glob character, in every spelling of
// the paths involved: as written, and with links followed.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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

// The user settings files a connector-mode round loads: settings.json and
// settings.local.json of CLAUDE_CONFIG_DIR when it is set, of ~/.claude
// otherwise, the ones that exist. A CLAUDE_CONFIG_DIR that is set but is
// not an absolute path, the empty string included, is resolved by the CLI
// in the round's own working directory (or read its own way), so the kit
// cannot tell which files the round loads: both names are then returned
// as they are, and mirrorUserRules refuses a path that is not absolute
// (review M3, 25/09/2026).
export function userSettingsFiles(env = process.env) {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (typeof configured === 'string' && !isAbsolute(configured)) return SETTINGS_FILES.map((name) => join(configured, name));
  const dir = typeof configured === 'string' ? configured : join(env.HOME || homedir(), '.claude');
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
// outside parentheses: a rule that split there would be denied as other
// rules than the one the person allowed. How the CLI tracks parentheses
// nested inside a scope is not measured (with a splitter that reads
// "inside parentheses" as a flag, `Bash(echo $(date) ok)` comes apart and
// its allow survives), so a scope holding `(` or `)` is never mirrored
// (ruling I1 of 25/09/2026, as src/curate/rule-path.mjs decides for the
// round's own rules). A tool name holds no space, comma or parenthesis
// (RULE), so what passes both is one piece for any splitter
// (test/user-rules.test.mjs checks every mirrored rule with rulesIn). Nor
// is a control character mirrored: its meaning inside a scope is not
// measured.
function parseRule(rule) {
  if (hasControlCharacter(rule)) return null;
  const m = RULE.exec(rule);
  if (m === null) return null;
  const spec = m[2] === undefined ? null : m[2];
  if (spec !== null && (spec.includes('(') || spec.includes(')'))) return null;
  return { tool: m[1], spec };
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

// A path as written and, when it exists, as the file system resolves it
// with every link followed: the CLI works in the physical folder, and the
// kit may have been handed a link to it (review M1, 25/09/2026). Both
// spellings name the same place, so a scope inside either spelling of the
// vault is inside the vault, and one covering either covers it.
function spellings(path) {
  const written = resolve(path);
  try {
    const real = realpathSync(written);
    return real === written ? [written] : [written, real];
  } catch {
    return [written];
  }
}

// Where a path rule's scope points: the absolute paths its literal prefix
// resolves to (one per spelling of its base, and of the folder it names),
// whether that prefix stops inside a name (`va*`), so the rule also reaches
// every name that merely starts with it, and whether what follows the
// prefix could climb out of it (a `..` segment, or `{` alternatives), which
// a literal prefix cannot judge (review M2).
function scopeOf(spec, { settingsDirs, vaults, homes }) {
  const text = spec.trim();
  let bases = vaults;
  let rest = text;
  if (text.startsWith('//')) {
    bases = [sep];
    rest = text.slice(2);
  } else if (text === '~' || text.startsWith('~/')) {
    bases = homes;
    rest = text.slice(2);
  } else if (text.startsWith('/')) {
    bases = settingsDirs;
    rest = text.slice(1);
  }
  const { literal, globbed } = literalPrefix(rest);
  const partial = globbed && literal !== '' && !literal.endsWith('/');
  const tail = rest.slice(literal.length);
  const written = bases.map((base) => resolve(base, literal));
  // Where a link leads says nothing about the other names that start like
  // it, so a scope stopping inside a name is judged as written only.
  const paths = partial ? written : written.flatMap((path) => spellings(path));
  return { paths: [...new Set(paths)], partial, climbs: /(^|\/)\.\.(\/|$)/.test(tail) || tail.includes('{') };
}

// The vault itself or a folder that holds it, or a name one of them starts
// with when the scope stops inside a name.
function coversVault(path, partial, vault) {
  const ancestorOrSelf = path === vault || vault.startsWith(path.endsWith(sep) ? path : path + sep);
  return ancestorOrSelf || (partial && vault.startsWith(path));
}

// Everything the scope reaches is inside the vault (the vault itself
// included, when the scope names exactly it).
function insideVault(path, partial, vault) {
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
  const vaults = spellings(vaultRoot);
  const homes = spellings(home);
  const covers = (scope) => scope.paths.some((path) => vaults.some((vault) => coversVault(path, scope.partial, vault)));
  const inside = (scope) => !scope.climbs && scope.paths.some((path) => vaults.some((vault) => insideVault(path, scope.partial, vault)));
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
    const allow = isAbsolute(file) ? allowRules(file) : null;
    if (allow === null) {
      blocking.push({ rule: null, file, reason: 'unreadable' });
      continue;
    }
    const where = { settingsDirs: spellings(dirname(file)), vaults, homes };
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
        if (spec === null || !inside(scopeOf(spec, where))) add(widenedReads, rule);
        continue;
      }
      if (WRITE_TOOLS.includes(tool)) {
        const scope = spec === null ? null : scopeOf(spec, where);
        if (scope !== null && scope.climbs) blocking.push({ rule, file, reason: 'unreadable' });
        else if (scope === null || covers(scope)) blocking.push({ rule, file, reason: 'covers_vault' });
        else if (!inside(scope)) add(deny, rule);
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
