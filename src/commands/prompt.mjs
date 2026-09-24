// The `prompt` command: prints a skill's body, in the vault's own
// language, for the plugin's SKILL.md files to run through their `!`
// line (docs/superpowers/plans/2026-09-24-phase-1e-plugin-surface.md,
// task 3). A skill body is a small markdown file at
// lang/<code>/skills/<name>.md, holding placeholders written `{{name}}`
// that this command fills in before printing.
//
//   brain-kit prompt skill <name> [--vault <dir>]
//   brain-kit prompt curate [--vault <dir>]
//   brain-kit prompt --check [--vault <dir>]
//
// `curate` prints the prompt a scheduled curate round hands the model
// (docs/superpowers/plans/2026-09-24-phase-2-scheduled-curator.md, task
// 4): lang/<code>/prompts/curate.md, or the vault's own overlay at
// `curate.prompt` (`.brain-kit/prompts/curate.md` by default) when it
// exists. Standalone, the parameters block the round computes is one
// translated line saying `brain-kit curate` fills it in at run time;
// `brain-kit curate` itself calls renderCuratePrompt with the real block.
// The prompt's first line is always `{{signature}}`: the transcripts
// source recognises the curator's own runs by it and leaves them out.
//
// `skill` always exits 0: the body is what a model reads in place of a
// SKILL.md's own prose, and a failure that left stdout empty would hand
// the model nothing to act on at all (this slice's own recurring shape).
// Every failure path still writes ONE line to stdout, in the target
// language, saying the body could not be loaded and to run
// `brain-kit doctor`.
//
// `--check` is the pack-parity guard behind test/plugin.test.mjs (task
// 4): the two packs carry the same set of skill files (which is what
// "every skill has a body in every supported language" comes down to,
// with exactly two supported languages), and no body anywhere uses a
// placeholder this command does not know how to fill, and every name in
// SKILL_NAMES has a body in every supported language (task 4 wrote all
// seven, so a missing one is now a broken pack, not unfinished work). It
// exits 0 when all three hold, 1 otherwise. Phase 2 extends it to
// lang/<code>/prompts/ (same file set and placeholders in both packs,
// the signature as first line, every contract marker present) and, when
// run inside a vault or with --vault, reads that vault's curate overlay
// and warns on stderr, never failing, for each contract marker it lacks,
// for a first line that is not the signature (the round puts the
// signature in front) and for each placeholder the round does not fill.
// It never writes to a vault.
//
// `deps.packsDir` is the one seam this module offers: production always
// reads lang/<code>/skills/ under KIT_ROOT, and a test pointing `--check`
// at a scratch copy of the packs (to prove a missing body or an unknown
// placeholder is actually caught) passes a different directory here,
// never editing the real packs to do it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { KIT_ROOT } from '../version.mjs';
import { createTranslator, resolveLang, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';
import { loadConfig, ConfigError } from '../config.mjs';
import { kitCommand } from '../curate/tools.mjs';

// The seven skills the plugin ships, one skills/<name>/SKILL.md each,
// and one body per name in every language pack.
export const SKILL_NAMES = Object.freeze(['setup', 'curate-session', 'capture', 'ask', 'lint', 'review-stale', 'approve']);

// Every placeholder a body may use. Anything else left in a body's text
// (`{{x}}`) is never filled in: `skill` prints it back literally, and
// `--check` reports it as a problem.
const KNOWN_PLACEHOLDERS = Object.freeze(['today', 'today_iso', 'vault', 'log', 'capture_marker', 'human', 'agent', 'kit']);

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

// The prompts the kit ships, one lang/<code>/prompts/<name>.md each, and
// the placeholders a prompt may use. `signature` is prompts only: it is
// the first line of every prompt, by which the curator's own sessions are
// told apart from the person's.
export const PROMPT_NAMES = Object.freeze(['curate']);
const KNOWN_PROMPT_PLACEHOLDERS = Object.freeze(['parameters', 'kit', 'log', 'capture_marker', 'agent', 'today_iso', 'now_iso', 'signature']);
const SIGNATURE_LINE = '{{signature}}';

// The rules the curate prompt paid for in incidents (docs/incidents.md,
// "Prompts, policy and evidence", "Connectors" and "Privacy"), each
// introduced in the prompt by `<!-- rule:<id> -->` in both packs. A pack
// prompt without one fails `--check`; a vault's overlay without one only
// warns, because the overlay is the owner's to write.
export const CURATE_RULES = Object.freeze([
  'read-index-first', 'sample-from-end', 'log-before-note', 'never-verified', 'never-empty-unopened',
  'closed-uncertainty', 'only-kit-commands', 'propose-only', 'sources-line',
]);
const RULES_BY_PROMPT = Object.freeze({ curate: CURATE_RULES });

export function ruleMarker(rule) {
  return `<!-- rule:${rule} -->`;
}

// The contract rules `text` lacks, in CURATE_RULES order.
export function missingCurateRules(text) {
  return CURATE_RULES.filter((rule) => !text.includes(ruleMarker(rule)));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// DD/MM/YYYY, local time: the format this project's own house style
// requires for a date a human reads (a skill body is exactly that).
function todayDMY(now) {
  return `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;
}

// YYYY-MM-DD, local time: the format the vault's own log headings use
// (`## YYYY-MM-DD`), never the human-facing one above.
function todayISO(now) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function defaultsFor(packsDir, lang) {
  return JSON.parse(readFileSync(join(packsDir, lang, 'config.defaults.json'), 'utf8'));
}

function skillsDir(packsDir, lang) {
  return join(packsDir, lang, 'skills');
}

function bodyPath(packsDir, lang, name) {
  return join(skillsDir(packsDir, lang), `${name}.md`);
}

// The vault root found from `--vault` or the working directory, and its
// configuration when it loads. A vault whose configuration is missing or
// invalid is treated exactly like no vault for the placeholders that come
// from it (log, capture_marker, human, agent fall back to the pack's own
// defaults), because a broken configuration is still not a reason to hand
// the model an empty body.
function resolveVault(startDir) {
  const root = findVaultRoot(startDir);
  if (!root) return { root: null, config: null };
  try {
    return { root, config: loadConfig(root) };
  } catch (error) {
    if (error instanceof ConfigError) return { root, config: null };
    throw error;
  }
}

export function langFor(config, env) {
  if (config && SUPPORTED_LANGS.includes(config.lang)) return config.lang;
  return resolveLang(env);
}

function buildVars({ root, config, lang, packsDir, now, skillT }) {
  const defaults = defaultsFor(packsDir, lang);
  const kitPath = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
  return {
    today: todayDMY(now),
    today_iso: todayISO(now),
    vault: root ?? skillT('prompt.no_vault'),
    log: config?.taxonomy?.log ?? defaults.taxonomy.log,
    capture_marker: config?.taxonomy?.log_markers?.capture ?? defaults.taxonomy.log_markers.capture,
    human: config?.actors?.human ?? defaults.actors.human,
    agent: `${config?.actors?.agent_prefix ?? defaults.actors.agent_prefix}/<model>`,
    kit: `node "${kitPath}"`,
  };
}

// Fills every KNOWN placeholder found in `text`; an unknown one is left
// exactly as written (task 3's own contract: `skill` prints it literally,
// `--check` is the thing that complains).
function render(text, vars) {
  return text.replace(PLACEHOLDER_RE, (match, name) => (name in vars ? String(vars[name]) : match));
}

function promptsDir(packsDir, lang) {
  return join(packsDir, lang, 'prompts');
}

function promptPath(packsDir, lang, name) {
  return join(promptsDir(packsDir, lang), `${name}.md`);
}

// A prompt goes to the model on standard input with its frontmatter
// stripped (incident of 29/07/2026, the prompt's frontmatter read as a
// command line flag): an overlay kept as a vault document may carry one,
// and its first line must still be the signature.
function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

// Where the curate prompt comes from for this vault: its overlay when the
// file exists, otherwise the language pack's own.
export function curatePromptSource({ vaultRoot, config, lang, packsDir = join(KIT_ROOT, 'lang') }) {
  if (vaultRoot) {
    const overlay = join(vaultRoot, config?.curate?.prompt ?? join('.brain-kit', 'prompts', 'curate.md'));
    if (existsSync(overlay)) return { path: overlay, overlay: true };
  }
  return { path: promptPath(packsDir, lang, 'curate'), overlay: false };
}

// `now` as the vault's own clock reads it: `date` (YYYY-MM-DD) and `iso`
// (ISO 8601 with the UTC offset, e.g. 2026-09-24T09:30:00-03:00) in
// `timeZone`, or in the process's own zone when `timeZone` is missing or
// not one Intl knows (a fresh config's "<vault-timezone>" placeholder).
// The model in a round cannot read a clock (dontAsk denies `date`), and
// the validator requires generated.at to carry an explicit offset, so the
// round hands it this value instead of letting it guess.
export function vaultClock(now, timeZone) {
  let parts = null;
  if (timeZone) {
    try {
      const format = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
      });
      parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]));
    } catch {
      parts = null;
    }
  }
  if (parts) {
    const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.slice(3);
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return { date, iso: `${date}T${parts.hour}:${parts.minute}:${parts.second}${offset}` };
  }
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const offset = `${sign}${pad2(Math.floor(Math.abs(minutes) / 60))}:${pad2(Math.abs(minutes) % 60)}`;
  const date = todayISO(now);
  return { date, iso: `${date}T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}${offset}` };
}

function firstNonEmptyLine(text) {
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

// True when a prompt's first non-empty line is neither the signature
// placeholder nor the rendered signature itself. The transcripts source
// recognises the curator's own sessions by that first line (ruling R3), so
// an overlay that starts with anything else would make the next round read
// the curator's own runs as the owner's and capture its own output as new.
export function lacksSignatureLine(text, signature) {
  const first = firstNonEmptyLine(stripFrontmatter(text));
  return first !== SIGNATURE_LINE && first !== signature;
}

function signatureFor(config, defaults) {
  return config?.curate?.signature ?? defaults?.curate?.signature;
}

// The curate prompt, rendered. `parameters` is the block the round
// computes, inserted verbatim; `now` is the round's own time, rendered as
// `{{now_iso}}` and `{{today_iso}}` on the vault's clock. An overlay whose
// first line is not the signature gets the signature line put in front of
// it. Throws when the prompt file cannot be read; the caller decides what
// that means.
export function renderCuratePrompt({ vaultRoot, config, lang, parameters, now = new Date(), packsDir = join(KIT_ROOT, 'lang') }) {
  const defaults = defaultsFor(packsDir, lang);
  const { path } = curatePromptSource({ vaultRoot, config, lang, packsDir });
  const signature = signatureFor(config, defaults);
  let text = stripFrontmatter(readFileSync(path, 'utf8'));
  if (lacksSignatureLine(text, signature)) text = `${SIGNATURE_LINE}\n\n${text}`;
  const clock = vaultClock(now, config?.vault?.timezone);
  const vars = {
    parameters: String(parameters ?? ''),
    kit: kitCommand(),
    log: config?.taxonomy?.log ?? defaults.taxonomy.log,
    capture_marker: config?.taxonomy?.log_markers?.capture ?? defaults.taxonomy.log_markers.capture,
    agent: `${config?.actors?.agent_prefix ?? defaults.actors.agent_prefix}/<model>`,
    today_iso: clock.date,
    now_iso: clock.iso,
    signature,
  };
  return render(text, vars);
}

function parseVaultOption(argv, start, result) {
  let i = start;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--vault') {
      i += 1;
      if (i >= argv.length) return { error: 'vault_value' };
      result.vault = argv[i];
      i += 1;
    } else {
      return { error: 'argument', arg };
    }
  }
  return result;
}

function parseArgs(argv) {
  if (argv.length === 0) return { error: 'usage' };
  const first = argv[0];
  if (first === '--help' || first === '-h') return { help: true };
  if (first === '--check') return parseVaultOption(argv, 1, { mode: 'check', vault: undefined });
  if (first === 'curate') return parseVaultOption(argv, 1, { mode: 'curate', vault: undefined });
  if (first === 'skill') {
    const name = argv[1];
    if (name === undefined) return { error: 'skill_name_missing' };
    return parseVaultOption(argv, 2, { mode: 'skill', name, vault: undefined });
  }
  return { error: 'argument', arg: first };
}

export async function runPrompt(argv, io, t, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? new Date();
  const packsDir = deps.packsDir ?? join(KIT_ROOT, 'lang');

  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.stdout.write(`${t('prompt.usage')}\n`);
    return EXIT.OK;
  }
  if (parsed.error === 'usage') {
    io.stderr.write(`${t('prompt.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.error === 'skill_name_missing') {
    io.stderr.write(`${t('prompt.skill_name_missing')}\n`);
    io.stderr.write(`${t('prompt.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.error === 'vault_value') {
    io.stderr.write(`${t('prompt.vault_value_missing')}\n`);
    io.stderr.write(`${t('prompt.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.error === 'argument') {
    io.stderr.write(`${t('prompt.bad_argument', { arg: parsed.arg })}\n`);
    io.stderr.write(`${t('prompt.usage')}\n`);
    return EXIT.USAGE;
  }

  const startDir = parsed.vault !== undefined ? resolve(cwd, parsed.vault) : cwd;

  if (parsed.mode === 'check') {
    return runCheck(t, io, packsDir, startDir);
  }

  if (parsed.mode === 'curate') {
    return runCurate(io, { startDir, env, now, packsDir });
  }

  // mode === 'skill'. Unlike the usage errors above (a malformed
  // invocation a SKILL.md's own fixed command line never produces),
  // an unknown skill name is written to STDOUT, not stderr: this is
  // still the text that stands in for the body a SKILL.md's "!" line
  // expects, and it must not be empty just because the name was wrong.
  if (!SKILL_NAMES.includes(parsed.name)) {
    io.stdout.write(`${t('prompt.unknown_skill', { name: parsed.name, names: [...SKILL_NAMES] })}\n`);
    return EXIT.USAGE;
  }

  const { root, config } = resolveVault(startDir);
  const lang = langFor(config, env);
  const skillT = createTranslator(lang, { warn: (message) => io.stderr.write(`${message}\n`) });
  const vars = buildVars({ root, config, lang, packsDir, now, skillT });

  let text;
  try {
    text = readFileSync(bodyPath(packsDir, lang, parsed.name), 'utf8');
  } catch {
    io.stdout.write(`${skillT('prompt.body_unreadable', { name: parsed.name })}\n`);
    return EXIT.FAILURE;
  }
  // Outside a vault a vault-only body would still tell the model to open
  // the log, and it would create one in whatever directory the session is
  // in. One line first says to write nothing; setup is the skill that
  // makes a vault, so it is left alone.
  const notice = root === null && parsed.name !== 'setup' ? `${skillT('prompt.no_vault_notice', { dir: startDir })}\n\n` : '';
  io.stdout.write(notice + render(text, vars));
  return EXIT.OK;
}

// Like `skill`, `curate` never leaves stdout empty on failure: one line,
// in the target language, says the prompt could not be loaded.
function runCurate(io, { startDir, env, now, packsDir }) {
  const { root, config } = resolveVault(startDir);
  const lang = langFor(config, env);
  const langT = createTranslator(lang, { warn: (message) => io.stderr.write(`${message}\n`) });
  let text;
  try {
    text = renderCuratePrompt({ vaultRoot: root, config, lang, parameters: langT('prompt.curate_parameters_standalone'), now, packsDir });
  } catch (error) {
    const { path } = curatePromptSource({ vaultRoot: root, config, lang, packsDir });
    io.stdout.write(`${langT('prompt.curate_unreadable', { path, detail: error.code ?? error.message })}\n`);
    return EXIT.FAILURE;
  }
  io.stdout.write(text);
  return EXIT.OK;
}

function listSkillFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md') && statSync(join(dir, name)).isFile())
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return null;
  }
}

function runCheck(t, io, packsDir, startDir) {
  const problems = [];
  checkPrompts(t, packsDir, problems);
  checkOverlay(t, io, startDir);
  const filesByLang = {};
  for (const lang of SUPPORTED_LANGS) {
    const names = listSkillFiles(skillsDir(packsDir, lang));
    if (names === null) {
      problems.push(t('prompt.check_dir_unreadable', { lang, dir: skillsDir(packsDir, lang) }));
      filesByLang[lang] = [];
    } else {
      filesByLang[lang] = names;
    }
  }

  // Every skill the plugin ships needs a body in every supported
  // language, checked against SKILL_NAMES directly: two packs in parity
  // could still both lack the same body.
  for (const lang of SUPPORTED_LANGS) {
    const present = new Set(filesByLang[lang]);
    for (const name of SKILL_NAMES) {
      if (!present.has(name)) problems.push(t('prompt.check_missing_body', { name, lang }));
    }
  }

  // And the two packs carry the same set of skill files, so a body that
  // exists in one language only is reported even when its name is not
  // (yet) in SKILL_NAMES.
  const [langA, langB] = SUPPORTED_LANGS;
  const setA = new Set(filesByLang[langA]);
  const setB = new Set(filesByLang[langB]);
  for (const name of filesByLang[langA]) {
    if (!setB.has(name)) problems.push(t('prompt.check_pack_mismatch', { name, lang: langA, other: langB }));
  }
  for (const name of filesByLang[langB]) {
    if (!setA.has(name)) problems.push(t('prompt.check_pack_mismatch', { name, lang: langB, other: langA }));
  }

  for (const lang of SUPPORTED_LANGS) {
    for (const name of filesByLang[lang]) {
      const file = bodyPath(packsDir, lang, name);
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        problems.push(t('prompt.check_body_unreadable', { name, lang, detail: error.code ?? error.message }));
        continue;
      }
      const unknown = [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].filter((p) => !KNOWN_PLACEHOLDERS.includes(p));
      for (const placeholder of unknown) problems.push(t('prompt.check_unknown_placeholder', { name, lang, placeholder: `{{${placeholder}}}` }));
    }
  }

  if (problems.length === 0) {
    io.stdout.write(`${t('prompt.check_ok')}\n`);
    return EXIT.OK;
  }
  for (const problem of problems) io.stdout.write(`${problem}\n`);
  return EXIT.FAILURE;
}

function placeholdersOf(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort();
}

// The prompts in both packs: the same set of files, every name in
// PROMPT_NAMES present, only known placeholders, the same placeholders in
// both languages, the signature placeholder as the first line, and every
// contract marker the prompt owes.
function checkPrompts(t, packsDir, problems) {
  const namesByLang = {};
  for (const lang of SUPPORTED_LANGS) {
    const names = listSkillFiles(promptsDir(packsDir, lang));
    if (names === null) {
      problems.push(t('prompt.check_prompts_dir_unreadable', { lang, dir: promptsDir(packsDir, lang) }));
      namesByLang[lang] = [];
    } else {
      namesByLang[lang] = names;
    }
    for (const name of PROMPT_NAMES) {
      if (!namesByLang[lang].includes(name)) problems.push(t('prompt.check_missing_prompt', { name, lang }));
    }
  }
  const [langA, langB] = SUPPORTED_LANGS;
  for (const [lang, other] of [[langA, langB], [langB, langA]]) {
    for (const name of namesByLang[lang]) {
      if (!namesByLang[other].includes(name)) problems.push(t('prompt.check_prompt_mismatch', { name, lang, other }));
    }
  }
  const placeholdersByLang = {};
  for (const lang of SUPPORTED_LANGS) {
    placeholdersByLang[lang] = {};
    for (const name of namesByLang[lang]) {
      let text;
      try {
        text = readFileSync(promptPath(packsDir, lang, name), 'utf8');
      } catch (error) {
        problems.push(t('prompt.check_prompt_unreadable', { name, lang, detail: error.code ?? error.message }));
        continue;
      }
      const used = placeholdersOf(text);
      placeholdersByLang[lang][name] = used;
      for (const placeholder of used.filter((p) => !KNOWN_PROMPT_PLACEHOLDERS.includes(p))) {
        problems.push(t('prompt.check_prompt_unknown_placeholder', { name, lang, placeholder: `{{${placeholder}}}` }));
      }
      if (text.split(/\r?\n/)[0] !== SIGNATURE_LINE) problems.push(t('prompt.check_prompt_first_line', { name, lang, line: SIGNATURE_LINE }));
      for (const rule of RULES_BY_PROMPT[name] ?? []) {
        if (!text.includes(ruleMarker(rule))) problems.push(t('prompt.check_prompt_missing_rule', { name, lang, rule }));
      }
    }
  }
  for (const name of namesByLang[langA]) {
    const a = placeholdersByLang[langA][name];
    const b = placeholdersByLang[langB][name];
    if (a && b && a.join(' ') !== b.join(' ')) problems.push(t('prompt.check_prompt_placeholders_differ', { name, lang: langA, other: langB }));
  }
}

// The vault's own curate overlay, when there is one: a missing contract
// marker, a first line that is not the signature (the round puts it in
// front) and a placeholder the round does not fill are each a warning on
// stderr, never a failure, because the overlay is the owner's to write.
function checkOverlay(t, io, startDir) {
  const { root, config } = resolveVault(startDir);
  if (!root) return;
  const { path, overlay } = curatePromptSource({ vaultRoot: root, config, lang: SUPPORTED_LANGS[0] });
  if (!overlay) return;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    io.stderr.write(`${t('prompt.check_overlay_unreadable', { path, detail: error.code ?? error.message })}\n`);
    return;
  }
  if (lacksSignatureLine(text, signatureFor(config, null))) {
    io.stderr.write(`${t('prompt.check_overlay_signature_prepended', { path, line: SIGNATURE_LINE })}\n`);
  }
  for (const rule of missingCurateRules(text)) {
    io.stderr.write(`${t('prompt.check_overlay_missing_rule', { path, rule })}\n`);
  }
  for (const placeholder of placeholdersOf(text).filter((p) => !KNOWN_PROMPT_PLACEHOLDERS.includes(p))) {
    io.stderr.write(`${t('prompt.check_overlay_unknown_placeholder', { path, placeholder: `{{${placeholder}}}` })}\n`);
  }
}
