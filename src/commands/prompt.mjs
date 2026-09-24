// The `prompt` command: prints a skill's body, in the vault's own
// language, for the plugin's SKILL.md files to run through their `!`
// line (docs/superpowers/plans/2026-09-24-phase-1e-plugin-surface.md,
// task 3). A skill body is a small markdown file at
// lang/<code>/skills/<name>.md, holding placeholders written `{{name}}`
// that this command fills in before printing.
//
//   brain-kit prompt skill <name> [--vault <dir>]
//   brain-kit prompt --check
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
// placeholder this command does not know how to fill. It exits 0 when
// both hold, 1 otherwise, and never touches a vault. It never checks
// against SKILL_NAMES: that would fail on the real packs the moment a
// skill named there has not been written yet, which is task 4's own job
// for six of the seven, not what an outdated pack looks like.
//
// `deps.packsDir` is the one seam this module offers: production always
// reads lang/<code>/skills/ under KIT_ROOT, and a test pointing `--check`
// at a scratch copy of the packs (to prove a missing body or an unknown
// placeholder is actually caught) passes a different directory here,
// never editing the real packs to do it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { KIT_ROOT } from '../version.mjs';
import { createTranslator, resolveLang, SUPPORTED_LANGS } from '../lang.mjs';
import { findVaultRoot } from '../vault.mjs';
import { loadConfig, ConfigError } from '../config.mjs';

// The seven skills the plugin ships (task 4 writes six of these bodies;
// this task writes only `capture`, as a placeholder both packs share).
export const SKILL_NAMES = Object.freeze(['setup', 'curate-session', 'capture', 'ask', 'lint', 'review-stale', 'approve']);

// Every placeholder a body may use. Anything else left in a body's text
// (`{{x}}`) is never filled in: `skill` prints it back literally, and
// `--check` reports it as a problem.
const KNOWN_PLACEHOLDERS = Object.freeze(['today', 'today_iso', 'vault', 'log', 'capture_marker', 'human', 'agent', 'kit']);

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

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

function langFor(config, env) {
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

function parseArgs(argv) {
  if (argv.length === 0) return { error: 'usage' };
  const first = argv[0];
  if (first === '--help' || first === '-h') return { help: true };
  if (first === '--check') {
    if (argv.length > 1) return { error: 'argument', arg: argv[1] };
    return { mode: 'check' };
  }
  if (first === 'skill') {
    const name = argv[1];
    if (name === undefined) return { error: 'skill_name_missing' };
    const result = { mode: 'skill', name, vault: undefined };
    let i = 2;
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

  if (parsed.mode === 'check') {
    return runCheck(t, io, packsDir);
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

  const startDir = parsed.vault !== undefined ? resolve(cwd, parsed.vault) : cwd;
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
  io.stdout.write(render(text, vars));
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

function runCheck(t, io, packsDir) {
  const problems = [];
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

  // "Every skill has a body in every supported language" and "the two
  // packs carry the same set of skill files" are the same requirement
  // restated: with exactly two supported languages, whichever file set
  // is checked against the other says both. Checking against SKILL_NAMES
  // instead would fail this command on the real packs the moment a skill
  // named there has not been written yet (task 4's own job for six of
  // the seven), which is not what an outdated pack looks like.
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
