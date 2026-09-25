// The `prompt` command: prints a skill's body, in the vault's own
// language, for the plugin's SKILL.md files to run through their `!`
// line (docs/superpowers/plans/2026-09-24-phase-1e-plugin-surface.md,
// task 3). A skill body is a small markdown file at
// lang/<code>/skills/<name>.md, holding placeholders written `{{name}}`
// that this command fills in before printing.
//
//   brain-kit prompt skill <name> [--vault <dir>]
//   brain-kit prompt curate [--vault <dir>]
//   brain-kit prompt briefing [--vault <dir>]
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
// `briefing` prints the morning briefing's prompt (phase 4, task 3):
// lang/<code>/prompts/briefing.md, or the vault's overlay at
// `briefing.prompt` (`.brain-kit/prompts/briefing.md` by default) when it
// exists, with its signature line put in front when it lacks one, as for
// curate. `{{blocks}}` is the vault's own `briefing.blocks`, rendered by
// src/briefing/blocks.mjs from the facts src/briefing/facts.mjs computes:
// the model presents the facts and never computes one. The blocks a
// configuration problem leaves out are named at the top of `{{blocks}}` and
// on stderr. This real render, and only it (never `--check`, never doctor),
// records the questions it placed as asked today (ruling R-T6), through
// markAsked, which takes the queue lock itself. The order is fixed (fix
// round 1, rulings R-T8 and R-T9): the whole text is rendered first (every
// block, the overlay, every placeholder); only then are the questions
// recorded, and only those whose id appears in that final text, so an
// overlay without `{{blocks}}` records none; then the text is written. A
// record that fails is said on stderr, the text is still written, and the
// exit is 3. Every failure before that writes one line to stdout, in the
// vault's language when there is one, saying what to tell the person, and
// records nothing: the briefing never hands the model an empty prompt.
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
// SKILL_NAMES has a body in every supported language (task 4 wrote the
// first seven, phase 3 the eighth and phase 4 the ninth, so a missing one
// is a broken pack, not unfinished work). It exits 0 when all three hold, 1 otherwise.
// Phase 2 extends it to lang/<code>/prompts/ (same file set and
// placeholders in both packs, the signature as first line, every
// contract marker present) and, when run inside a vault or with
// --vault, reads that vault's curate overlay and warns on stderr, never
// failing, for each contract marker it lacks, for a first line that is
// not the signature (the round puts the signature in front) and for
// each placeholder the round does not fill. It never writes to a vault.
//
// `deps.packsDir` is the one seam this module offers: production always
// reads lang/<code>/skills/ under KIT_ROOT, and a test pointing `--check`
// at a scratch copy of the packs (to prove a missing body or an unknown
// placeholder is actually caught) passes a different directory here,
// never editing the real packs to do it.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { KIT_ROOT } from '../version.mjs';
import { createTranslator, resolveLang, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';
import { CONFIG_FILENAME, loadConfig, loadMachine, ConfigError, MACHINE_FILENAME } from '../config.mjs';
import { kitCommand } from '../curate/tools.mjs';
import { stateDirFor } from '../state.mjs';
import { localDay } from '../guards/watermark.mjs';
import { GuardError } from '../guards/location.mjs';
import { briefingFacts, humanDay } from '../briefing/facts.mjs';
import { markAsked } from '../briefing/questions.mjs';
import {
  blockProblemLine, briefingBlocks, briefingLimits, renderBlocks, renderLimits, renderNeverRead, renderReadList, selectQuestions, validateBriefingBlocks,
} from '../briefing/blocks.mjs';

// The nine skills the plugin ships, one skills/<name>/SKILL.md each,
// and one body per name in every language pack. `seed-rituals` (phase 3,
// task 7) fills the weekly rhythm table from the person's own calendar
// connector, in their own session. `briefing` (phase 4, task 4) is the one
// SKILL.md with two `!` lines: its body, then `prompt briefing` itself,
// which the body says is the session's instructions.
export const SKILL_NAMES = Object.freeze(['setup', 'curate-session', 'capture', 'ask', 'lint', 'review-stale', 'approve', 'seed-rituals', 'briefing']);

// Every placeholder a body may use. Anything else left in a body's text
// (`{{x}}`) is never filled in: `skill` prints it back literally, and
// `--check` reports it as a problem.
const KNOWN_PLACEHOLDERS = Object.freeze(['today', 'today_iso', 'vault', 'log', 'capture_marker', 'human', 'agent', 'kit']);

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

// The prompts the kit ships, one lang/<code>/prompts/<name>.md each, and
// the placeholders a prompt may use. `signature` is prompts only: it is
// the first line of every prompt, by which the curator's own sessions are
// told apart from the person's.
export const PROMPT_NAMES = Object.freeze(['curate', 'briefing']);
const KNOWN_PROMPT_PLACEHOLDERS = Object.freeze(['parameters', 'kit', 'log', 'capture_marker', 'agent', 'today_iso', 'now_iso', 'signature', 'sources_line']);
// The briefing's own placeholders. `today_iso` is the log heading the
// captures go under (`## YYYY-MM-DD`), given so the model never derives it.
export const BRIEFING_PLACEHOLDERS = Object.freeze([
  'signature', 'today_human', 'today_iso', 'kit', 'blocks', 'read', 'never_read', 'limits', 'log', 'capture_marker', 'agent', 'now_iso',
]);
const PLACEHOLDERS_BY_PROMPT = Object.freeze({ curate: KNOWN_PROMPT_PLACEHOLDERS, briefing: BRIEFING_PLACEHOLDERS });
function promptPlaceholders(name) {
  return PLACEHOLDERS_BY_PROMPT[name] ?? KNOWN_PROMPT_PLACEHOLDERS;
}
const SIGNATURE_LINE = '{{signature}}';

// The last line a round's model writes, when the caller does not give the
// one for the sources it offers (`brain-kit prompt curate` standalone, and
// every caller of phase 2): the transcripts alone.
export const DEFAULT_SOURCES_LINE = 'BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed>';

// The rules the curate prompt paid for in incidents (docs/incidents.md,
// "Prompts, policy and evidence", "Connectors" and "Privacy"), each
// introduced in the prompt by `<!-- rule:<id> -->` in both packs. A pack
// prompt without one fails `--check`; a vault's overlay without one only
// warns, because the overlay is the owner's to write. Phase 3 (task 5)
// added the last four: a source that is unavailable, or a tool that is not
// there, is reported and never reached another way (the undated "a wrong
// allowlist burned every turn on workarounds"); a document is distilled,
// never logged as a link (11/08/2026); a document that does not open for a
// permission reason is said to be exactly that (10/08 and 21/08/2026); and
// nothing of anyone's private life is content, other people's schedules
// included (the undated "a colleague's medical appointment was in the
// calendar window").
export const CURATE_RULES = Object.freeze([
  'read-index-first', 'sample-from-end', 'log-before-note', 'never-verified', 'never-empty-unopened',
  'closed-uncertainty', 'only-kit-commands', 'propose-only', 'sources-line',
  'no-workaround', 'notes-first-class', 'no-access-label', 'third-party-privacy',
]);
// The briefing's contract (phase 4, decision B2: what stays out of
// configuration), each introduced by its marker in both packs: nothing in
// the never-read list is opened, every fact comes from the kit, the closed
// uncertainty vocabulary, no attestation of what was not opened, questions
// only through the kit's command, the vault changed only by one `propose
// --only`, and the limits the person set honoured.
export const BRIEFING_RULES = Object.freeze([
  'never-read', 'facts-from-kit', 'closed-uncertainty', 'never-empty-unopened', 'questions-by-command', 'propose-only', 'honour-limits',
]);
const RULES_BY_PROMPT = Object.freeze({ curate: CURATE_RULES, briefing: BRIEFING_RULES });

export function ruleMarker(rule) {
  return `<!-- rule:${rule} -->`;
}

// The contract rules `text` lacks, in CURATE_RULES order.
export function missingCurateRules(text) {
  return CURATE_RULES.filter((rule) => !text.includes(ruleMarker(rule)));
}

// The contract rules `text` lacks, in BRIEFING_RULES order.
export function missingBriefingRules(text) {
  return BRIEFING_RULES.filter((rule) => !text.includes(ruleMarker(rule)));
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

// Where a prompt (`curate` or `briefing`) comes from for this vault: its
// overlay at `<name>.prompt` when the file exists, otherwise the language
// pack's own.
function promptSource(name, { vaultRoot, config, lang, packsDir = join(KIT_ROOT, 'lang') }) {
  if (vaultRoot) {
    const overlay = join(vaultRoot, config?.[name]?.prompt ?? join('.brain-kit', 'prompts', `${name}.md`));
    if (existsSync(overlay)) return { path: overlay, overlay: true };
  }
  return { path: promptPath(packsDir, lang, name), overlay: false };
}

export function curatePromptSource(options) {
  return promptSource('curate', options);
}

export function briefingPromptSource(options) {
  return promptSource('briefing', options);
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

// Ruling M5 (task 4): the prompt a round runs must be a file of the
// reviewed tree. A versioned configuration pointing it outside the vault (an
// absolute path, `..`, or a link leading out) is refused: `curate` exits
// 2 on it and `prompt --check` reports it as an error. The briefing's
// `briefing.prompt` is held to the same rule (`section` 'briefing'). The
// path outside, or null.
export function promptOutsideVault(root, config, section = 'curate') {
  const setting = config[section]?.prompt;
  if (typeof setting !== 'string' || setting === '') return null;
  const target = resolve(root, setting);
  const inside = (base, path) => {
    const rel = relative(base, path);
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  };
  if (!inside(root, target)) return target;
  if (existsSync(target)) {
    try {
      if (!inside(realpathSync(root), realpathSync(target))) return target;
    } catch {
      return target;
    }
  }
  return null;
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

function signatureFor(config, defaults, section = 'curate') {
  return config?.[section]?.signature ?? defaults?.[section]?.signature;
}

// The curate prompt, rendered. `parameters` is the block the round
// computes, inserted verbatim; `now` is the round's own time, rendered as
// `{{now_iso}}` and `{{today_iso}}` on the vault's clock; `sourcesLine` is
// the last line the model must write, naming every source the round offers
// (DEFAULT_SOURCES_LINE when not given). An overlay whose first line is not
// the signature gets the signature line put in front of it. Throws when the
// prompt file cannot be read; the caller decides what that means.
export function renderCuratePrompt({ vaultRoot, config, lang, parameters, now = new Date(), sourcesLine = DEFAULT_SOURCES_LINE, packsDir = join(KIT_ROOT, 'lang') }) {
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
    sources_line: String(sourcesLine),
  };
  return render(text, vars);
}

// The briefing prompt's text before its placeholders are filled: the
// vault's overlay or the pack's prompt, frontmatter stripped, with the
// signature line put in front when the first line is not it. Throws when
// the file cannot be read.
export function briefingTemplate({ vaultRoot, config, lang, packsDir = join(KIT_ROOT, 'lang') }) {
  const defaults = defaultsFor(packsDir, lang);
  const { path } = briefingPromptSource({ vaultRoot, config, lang, packsDir });
  const text = stripFrontmatter(readFileSync(path, 'utf8'));
  return lacksSignatureLine(text, signatureFor(config, defaults, 'briefing')) ? `${SIGNATURE_LINE}\n\n${text}` : text;
}

// Every briefing placeholder but `{{blocks}}`'s own computation: `blocks` is
// the text renderBlocks made; `t` translates in the vault's language.
export function briefingVars({ vaultRoot, config, lang, blocks, now = new Date(), t, packsDir = join(KIT_ROOT, 'lang') }) {
  const defaults = defaultsFor(packsDir, lang);
  const clock = vaultClock(now, config?.vault?.timezone);
  return {
    signature: signatureFor(config, defaults, 'briefing'),
    today_human: humanDay(clock.date),
    today_iso: clock.date,
    kit: kitCommand(),
    blocks: String(blocks ?? ''),
    read: renderReadList(config, vaultRoot, t),
    never_read: renderNeverRead(config, t),
    limits: renderLimits(config, t),
    log: config?.taxonomy?.log ?? defaults.taxonomy.log,
    capture_marker: config?.taxonomy?.log_markers?.capture ?? defaults.taxonomy.log_markers.capture,
    agent: `${config?.actors?.agent_prefix ?? defaults.actors.agent_prefix}/<model>`,
    now_iso: clock.iso,
  };
}

// The briefing prompt, rendered, with `blocks` as the text of `{{blocks}}`.
// Throws when the prompt file cannot be read.
export function renderBriefingPrompt(options) {
  return render(briefingTemplate(options), briefingVars(options));
}

function firstLineOf(text) {
  return String(text ?? '').trim().split('\n')[0] ?? '';
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
  if (first === 'briefing') return parseVaultOption(argv, 1, { mode: 'briefing', vault: undefined });
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

  if (parsed.mode === 'briefing') {
    return runBriefing(io, { startDir, env, now, packsDir, deps });
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

// The real briefing render. Every refusal writes one line to stdout, in the
// vault's language when its configuration loads, and exits 2 (1 for a
// prompt file that cannot be read); none records a question as asked.
function runBriefing(io, { startDir, env, now, packsDir, deps }) {
  const warn = (message) => io.stderr.write(`${message}\n`);
  const root = findVaultRoot(startDir);
  if (!root) {
    const callerT = createTranslator(resolveLang(env), { warn });
    io.stdout.write(`${callerT('prompt.briefing_no_vault', { dir: startDir })}\n`);
    return EXIT.USAGE;
  }
  let config;
  try {
    config = loadConfig(root);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const callerT = createTranslator(resolveLang(env), { warn });
    io.stdout.write(`${callerT('prompt.briefing_config_invalid', { file: CONFIG_FILENAME, detail: firstLineOf(error.message) })}\n`);
    return EXIT.USAGE;
  }
  const lang = langFor(config, env);
  const t = createTranslator(lang, { warn });
  const outside = promptOutsideVault(root, config, 'briefing');
  if (outside !== null) {
    io.stdout.write(`${t('prompt.briefing_prompt_outside', { file: CONFIG_FILENAME, path: outside })}\n`);
    return EXIT.USAGE;
  }
  try {
    localDay(now, config.vault.timezone);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    io.stdout.write(`${t('prompt.briefing_bad_timezone', { timezone: config.vault.timezone, file: CONFIG_FILENAME })}\n`);
    return EXIT.USAGE;
  }
  // The prompt file first: a briefing whose prompt cannot be read records
  // no question as asked.
  let template;
  try {
    template = briefingTemplate({ vaultRoot: root, config, lang, packsDir });
  } catch (error) {
    const { path } = briefingPromptSource({ vaultRoot: root, config, lang, packsDir });
    io.stdout.write(`${t('prompt.briefing_unreadable', { path, detail: error.code ?? error.message })}\n`);
    return EXIT.FAILURE;
  }
  const stateDir = stateDirFor(root, env);
  let machine = null;
  if (existsSync(join(stateDir, MACHINE_FILENAME))) {
    try {
      machine = loadMachine(stateDir);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      io.stderr.write(`${t('prompt.briefing_machine_unreadable', { detail: error.message })}\n`);
    }
  }

  // 1. Render everything. Anything that fails here is one line on stdout,
  // and nothing is recorded.
  let text;
  let problems;
  let selection = null;
  try {
    const facts = briefingFacts({ root, config, machine, stateDir, now, env, deps: deps.facts ?? {} });
    const resolved = briefingBlocks(config, root);
    problems = resolved.problems;
    if (resolved.blocks.some((block) => block.id === 'questions')) selection = selectQuestions(facts.questions, briefingLimits(config).maxQuestions);
    const log = config.taxonomy?.log ?? defaultsFor(packsDir, lang).taxonomy.log;
    const blocksText = renderBlocks({ ...resolved, facts, config, root, t, kit: kitCommand(), log, selection });
    text = render(template, briefingVars({ vaultRoot: root, config, lang, blocks: blocksText, now, t, packsDir }));
    selection = selection === null ? null : { ...selection, today: facts.today };
  } catch (error) {
    io.stdout.write(`${t('prompt.briefing_failed', { detail: error.code ?? firstLineOf(error.message) })}\n`);
    return EXIT.FAILURE;
  }
  for (const problem of problems) io.stderr.write(`${t('prompt.briefing_block_problem', { problem: blockProblemLine(t, problem) })}\n`);

  // 2. Record as asked exactly the placed questions the final text shows
  // (ruling R-T9): each is written "[<id>]" in the questions block.
  let exit = EXIT.OK;
  const ids = selection === null ? [] : selection.placed.map((question) => question.id).filter((id) => text.includes(`[${id}]`));
  if (ids.length > 0) {
    try {
      markAsked(stateDir, ids, selection.today, { env });
    } catch (error) {
      // Any failure here is the degraded case: the text is still printed,
      // with one line telling the model the questions were NOT recorded.
      const detail = error instanceof GuardError
        ? t(error.messageKey, error.params)
        : `${typeof error.code === 'string' ? error.code : error.name}: ${firstLineOf(error.message)}`;
      io.stderr.write(`${t('prompt.briefing_mark_failed', { detail })}\n`);
      text = `${text.replace(/\n*$/, '')}\n\n${t('briefing.questions_not_recorded')}\n`;
      exit = EXIT.DEGRADED;
    }
  }

  // 3. The text.
  io.stdout.write(text);
  return exit;
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
  checkOverlay(t, io, startDir, problems);
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
      for (const placeholder of used.filter((p) => !promptPlaceholders(name).includes(p))) {
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
// A curate.prompt that points outside the vault is a problem (ruling M5):
// the round refuses to run it. The briefing's overlay and its
// briefing.prompt are checked the same way (checkBriefingOverlay), and each
// problem of briefing.blocks is a warning.
function checkOverlay(t, io, startDir, problems) {
  const { root, config } = resolveVault(startDir);
  if (!root) return;
  if (config) checkBriefingOverlay(t, io, root, config, problems);
  const outside = config ? promptOutsideVault(root, config) : null;
  if (outside !== null) {
    problems.push(t('prompt.check_prompt_outside', { path: outside, file: CONFIG_FILENAME }));
    return;
  }
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
  // An overlay written before phase 3 names only the transcripts in its
  // last line: the model is never told the connector sources' ids, so
  // their marks never move (final review M4).
  if (!placeholdersOf(text).includes('sources_line')) {
    io.stderr.write(`${t('prompt.check_overlay_no_sources_line', { path, placeholder: '{{sources_line}}' })}\n`);
  }
}

function checkBriefingOverlay(t, io, root, config, problems) {
  for (const problem of validateBriefingBlocks(config, root)) {
    io.stderr.write(`${t('prompt.check_blocks_problem', { problem: blockProblemLine(t, problem) })}\n`);
  }
  const outside = promptOutsideVault(root, config, 'briefing');
  if (outside !== null) {
    problems.push(t('prompt.check_briefing_prompt_outside', { path: outside, file: CONFIG_FILENAME }));
    return;
  }
  const { path, overlay } = briefingPromptSource({ vaultRoot: root, config, lang: SUPPORTED_LANGS[0] });
  if (!overlay) return;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    io.stderr.write(`${t('prompt.check_briefing_overlay_unreadable', { path, detail: error.code ?? error.message })}\n`);
    return;
  }
  // Ruling R-T9: an overlay without the signature as its first line, or
  // without `{{blocks}}`, fails the check, naming the file and what it
  // lacks; one without a list the model needs is warned about.
  if (lacksSignatureLine(text, signatureFor(config, null, 'briefing'))) {
    problems.push(t('prompt.check_briefing_overlay_no_signature', { path, placeholder: SIGNATURE_LINE }));
  }
  const used = placeholdersOf(text);
  if (!used.includes('blocks')) problems.push(t('prompt.check_briefing_overlay_no_blocks', { path, placeholder: '{{blocks}}' }));
  for (const list of ['never_read', 'read']) {
    if (!used.includes(list)) io.stderr.write(`${t('prompt.check_briefing_overlay_no_list', { path, placeholder: `{{${list}}}` })}\n`);
  }
  for (const rule of missingBriefingRules(text)) {
    io.stderr.write(`${t('prompt.check_briefing_overlay_missing_rule', { path, rule })}\n`);
  }
  for (const placeholder of placeholdersOf(text).filter((p) => !BRIEFING_PLACEHOLDERS.includes(p))) {
    io.stderr.write(`${t('prompt.check_briefing_overlay_unknown_placeholder', { path, placeholder: `{{${placeholder}}}` })}\n`);
  }
}
