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
//   - a read rule (Read, Glob, Grep, LS) that is bare, or whose scope
//     overlaps the vault or one of the round's own read rules (the
//     transcripts its plan lists, a curate.allowed_tools_extra read):
//     mirrored, it would deny the round's own reads; it is recorded in
//     `widenedReads` when it reaches outside the vault, and never
//     mirrored. A read rule whose scope is disjoint from all of them is
//     mirrored (ruling R-F2 of 25/09/2026);
//   - a write rule inside the vault: the round's own Edit(./**) and its
//     protected-path denies already govern it.
// A rule that cannot be mirrored without denying the round's own tools
// refuses connector mode for the round (a `blocking` entry): a write rule
// covering the vault or a folder that holds it (`covers_vault`), a Bash
// rule covering every command or one of the round's own kit commands
// (`covers_kit`), and a settings file or a rule that cannot be read with a
// known meaning (`unreadable`: a file that cannot be read or parsed, or
// whose path is not absolute; a rule that splits, holds a parenthesis, a
// control character, an odd number of double quotes or a final backslash
// in its scope, a write rule whose scope could climb out of its literal
// prefix, or a path rule to mirror whose resolved form holds a character
// no rule can carry). A Bash rule that covers the round's `node <kit>`
// forms only is mirrored, and `dropNodeForms` tells the round to leave
// those forms out of its allow list, keeping the direct ones.
//
// Paths in a rule from user settings resolve as Claude Code resolves them
// there: `//x` is /x, `~/x` is under the home directory, `/x` is under the
// settings file's own folder, and `./x` or `x` is under the round's
// working directory, the vault root. A rule on the command line has no
// settings file, and how the CLI anchors `/x` there is not measured, so a
// mirrored path rule is never passed as written: it goes to
// --disallowedTools in its resolved absolute form, `Tool(//<path>)`, the
// literal prefix resolved from its base as the CLI will use it (the home
// directory as the round's environment gives it, the settings folder as
// listed, the vault's real path for a relative scope, since that is the
// child's working directory) followed by the rest of the scope unchanged
// (final review I3). A scope is judged by its literal prefix, the text
// before its first glob character: it covers the vault when any spelling
// of the paths involved does (as written, and with links followed), and is
// inside the vault only when that resolved path is inside the vault's real
// path (review N1 of task 2).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { rulesIn } from '../harness/claude-code.mjs';
import { unsafeRuleCharacters } from './rule-path.mjs';
import { KIT_SUBCOMMANDS, kitCommand, PROTECTED_PATHS } from './tools.mjs';

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
// (review M3, 25/09/2026). The same holds for the fallback folder under a
// HOME that is set but not absolute (review N5 of task 2).
export function userSettingsFiles(env = process.env) {
  const configured = env.CLAUDE_CONFIG_DIR;
  const dir = typeof configured === 'string' ? configured : join(env.HOME || homedir(), '.claude');
  if (!isAbsolute(dir)) return SETTINGS_FILES.map((name) => join(dir, name));
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
// measured. Nor a scope ending in a backslash or holding an odd number of
// double quotes: under a splitter that reads escapes or quotes across the
// list, both unmeasured, either would swallow the rules after it (review
// N3 of task 2).
function parseRule(rule) {
  if (hasControlCharacter(rule)) return null;
  const m = RULE.exec(rule);
  if (m === null) return null;
  const spec = m[2] === undefined ? null : m[2];
  if (spec !== null && (spec.includes('(') || spec.includes(')'))) return null;
  if (spec !== null && (spec.endsWith('\\') || (spec.split('"').length - 1) % 2 === 1)) return null;
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

// A folder and a relative path under it, as one absolute path: a leading
// slash of the relative part never replaces the folder (`~//x` is under
// home), and a trailing slash is dropped (the path, not the text).
function under(base, literal) {
  return resolve(join(base, literal));
}

// Where a path rule's scope points: the absolute paths its literal prefix
// resolves to (one per spelling of its base, and of the folder it names),
// whether that prefix stops inside a name (`va*`), so the rule also reaches
// every name that merely starts with it, whether what follows the prefix
// could climb out of it (a `..` segment, or `{` alternatives), which a
// literal prefix cannot judge (review M2), `cliPath`, the prefix resolved
// from its base as the CLI will use it (`base` as the caller gives it),
// and `absolute`, the whole scope in that resolved form, the text a
// mirrored rule carries.
function scopeOf(spec, { settingsDirs, settingsDir, vaults, vaultCwd, homes, home }) {
  const text = spec.trim();
  let bases = vaults;
  let base = vaultCwd;
  let rest = text;
  if (text.startsWith('//')) {
    bases = [sep];
    base = sep;
    rest = text.slice(2);
  } else if (text === '~' || text.startsWith('~/')) {
    bases = homes;
    base = home;
    rest = text.slice(2);
  } else if (text.startsWith('/')) {
    bases = settingsDirs;
    base = settingsDir;
    rest = text.slice(1);
  }
  const { literal, globbed } = literalPrefix(rest);
  const partial = globbed && literal !== '' && !literal.endsWith('/');
  const tail = rest.slice(literal.length);
  const written = bases.map((each) => under(each, literal));
  // Where a link leads says nothing about the other names that start like
  // it, so a scope stopping inside a name is judged as written only.
  const paths = partial ? written : written.flatMap((path) => spellings(path));
  const cliPath = under(base, literal);
  // The literal prefix names a folder when it ends with a slash or is
  // empty: what follows it then starts below that folder.
  const folder = literal === '' || literal.endsWith('/');
  const absolute = tail === '' && !(folder && literal !== '') ? cliPath : `${cliPath === sep ? '' : cliPath}${folder ? '/' : ''}${tail}`;
  return { paths: [...new Set(paths)], partial, climbs: /(^|\/)\.\.(\/|$)/.test(tail) || tail.includes('{'), cliPath, tail, absolute };
}

// The mirrored form of a path rule, `Tool(//<absolute path>)`, or null
// when its resolution holds a character no rule can carry (in the resolved
// prefix, any of src/curate/rule-path.mjs's; in the rest of the scope,
// whose glob characters are the person's own, a comma or a backslash): the
// CLI's reading of it on the command line is not measured, so such a rule
// is `unreadable` (final review I3).
function absoluteRule(tool, scope) {
  if (unsafeRuleCharacters(scope.cliPath).length > 0 || /[\\,]/.test(scope.tail)) return null;
  return `${tool}(/${scope.absolute})`;
}

// Whether two scopes can name a common path: each is a path and everything
// under it, or, stopping inside a name, every path starting with it.
function region(path, partial) {
  return { path, partial };
}

function inRegion(path, r) {
  if (r.partial) return path.startsWith(r.path);
  return path === r.path || path.startsWith(r.path.endsWith(sep) ? r.path : r.path + sep);
}

function overlapsRegion(a, b) {
  return inRegion(a.path, b) || inRegion(b.path, a) || (a.partial && b.partial && (a.path.startsWith(b.path) || b.path.startsWith(a.path)));
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

// The regions the round's own read rules name (the vault's `./**`, each
// transcript its plan lists, a curate.allowed_tools_extra read), each in
// every spelling; `all` when one of them is a bare read tool. A rule on
// the command line with a single leading slash is taken at both anchors
// it could have, the vault and the root of the file system.
function ownReadRegions(own, where) {
  const regions = [];
  for (const rule of own) {
    const parsed = parseRule(rule);
    if (parsed === null || !READ_TOOLS.includes(parsed.tool)) continue;
    if (parsed.spec === null) return 'all';
    const scope = scopeOf(parsed.spec, { ...where, settingsDirs: [...where.vaults, sep], settingsDir: where.vaultCwd });
    for (const path of scope.paths) regions.push(region(path, scope.partial));
  }
  return regions;
}

export function mirrorUserRules({ files = [], ownAllowed = [], vaultRoot, home = homedir(), kit = kitCommand() } = {}) {
  if (typeof vaultRoot !== 'string' || !isAbsolute(vaultRoot)) throw new TypeError(`mirrorUserRules: vaultRoot must be an absolute path, got ${JSON.stringify(vaultRoot)}`);
  const vaults = spellings(vaultRoot);
  const vaultCwd = vaults.at(-1);
  const homes = spellings(home);
  const covers = (scope) => scope.paths.some((path) => vaults.some((vault) => coversVault(path, scope.partial, vault)));
  // Inside only as the CLI resolves it, against the child's working
  // directory, the vault's real path (review N1 of task 2).
  const inside = (scope) => !scope.climbs && insideVault(scope.cliPath, scope.partial, vaultCwd);
  // A scope that names a folder of the vault only through a link (a linked
  // home or settings folder): the round's own Edit(./**) governs it like any
  // vault path, so it is mirrored only when it reaches one of the kit's
  // protected paths, whose deny the round's own rules name in the real
  // spelling only (scoped re-review, residual of N1). Its ordinary vault
  // folders (memory/, notes/) are never denied to the round that way.
  // (A climbing scope never gets here: it is unreadable above.)
  const throughLink = (scope) => scope.paths.some((path) => vaults.some((vault) => insideVault(path, scope.partial, vault)));
  const protectedRegions = vaults.flatMap((vault) => PROTECTED_PATHS.map((name) => region(join(vault, name), false)));
  const reachesProtected = (scope) => scope.paths.some((path) => protectedRegions.some((r) => overlapsRegion(region(path, scope.partial), r)));
  const own = new Set(ownAllowed.filter((rule) => typeof rule === 'string').flatMap((rule) => rulesIn(rule)));
  const readRegions = ownReadRegions(own, { vaults, vaultCwd, homes, home: resolve(home) });
  const vaultRegions = vaults.map((vault) => region(vault, false));
  const overlapsReads = (scope) => readRegions === 'all'
    || scope.paths.some((path) => [...vaultRegions, ...readRegions].some((r) => overlapsRegion(region(path, scope.partial), r)));
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
    const where = { settingsDirs: spellings(dirname(file)), settingsDir: dirname(file), vaults, vaultCwd, homes, home: resolve(home) };
    const mirror = (rule, tool, scope) => {
      const form = absoluteRule(tool, scope);
      if (form === null) blocking.push({ rule, file, reason: 'unreadable' });
      else add(deny, form);
    };
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
        const scope = spec === null ? null : scopeOf(spec, where);
        if (scope !== null && inside(scope)) continue;
        if (scope === null || scope.climbs || overlapsReads(scope)) add(widenedReads, rule);
        else mirror(rule, tool, scope);
        continue;
      }
      if (WRITE_TOOLS.includes(tool)) {
        const scope = spec === null ? null : scopeOf(spec, where);
        if (scope !== null && scope.climbs) blocking.push({ rule, file, reason: 'unreadable' });
        else if (scope === null || covers(scope)) blocking.push({ rule, file, reason: 'covers_vault' });
        else if (!inside(scope) && (!throughLink(scope) || reachesProtected(scope))) mirror(rule, tool, scope);
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
