import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { findProgram, pathEntries } from '../platform.mjs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import { SUPPORTED_LANGS, resolveLang } from '../lang.mjs';

// The answers `init` needs from a person, where they come from, and what
// each one may be.
//
// The questions, in the order they are asked: language; first name and
// handle; vault title; GitHub repository or "not yet"; confirmation that
// the repository will be private; time zone. The further questions a
// full setup needs (transcript projects, calendars, meeting notes, the
// briefing, a company domain, a cost cap) belong to the phases that own
// those subsystems and are not asked here.
//
// Three sources, never mixed silently:
//   - an answers file (--from-answers), a JSON object whose keys are
//     ANSWER_KEYS; an unknown key is refused, because a misspelt
//     "comit": true would otherwise be a commit silently not made;
//   - the defaults (--yes), each one shown to the person afterwards;
//   - a terminal, one question at a time, a blank line taking the default
//     shown in brackets and a bad answer asked again.
// When none of them can supply an answer (no terminal, no --yes, and the
// file lacks it), init refuses at once naming the first missing answer.
// It never reads a stdin that is not a terminal, so a closed stdin, or a
// pipe nobody will ever write to, can never make it wait.

export const QUESTIONS = Object.freeze(['lang', 'name', 'handle', 'title', 'repo', 'private', 'timezone']);
// Accepted in an answers file, never asked: `email` (a later phase asks
// for it with the calendar), and `commit`, because the first commit is
// the person's and init makes it only when told to in writing.
export const ANSWER_KEYS = Object.freeze([...QUESTIONS, 'email', 'commit']);

const HANDLE = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

export function isValidTimezone(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Null when `value` is an acceptable answer for `key`, otherwise the key
// itself, for the caller to name. `private` must be exactly true: the
// people/ directory and the other personal ones hold data about third
// parties, and a vault whose owner has said the repository will not be
// private is refused, not written with a warning.
export function invalidAnswer(key, value) {
  switch (key) {
    case 'lang': return SUPPORTED_LANGS.includes(value) ? null : key;
    case 'name': return typeof value === 'string' && value.trim() !== '' ? null : key;
    case 'handle': return typeof value === 'string' && HANDLE.test(value) ? null : key;
    case 'title': return typeof value === 'string' && value.trim() !== '' ? null : key;
    case 'repo': return value === null || (typeof value === 'string' && REPO.test(value)) ? null : key;
    case 'private': return value === true ? null : key;
    case 'timezone': return isValidTimezone(value) ? null : key;
    case 'email': return value === null || (typeof value === 'string' && EMAIL.test(value)) ? null : key;
    case 'commit': return typeof value === 'boolean' ? null : key;
    default: return key;
  }
}

// The name this machine knows its user by, for the name and handle
// defaults. The environment first, so a test (or a person) can pin it.
function userName(env) {
  const fromEnv = env.USER || env.LOGNAME || env.USERNAME;
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

// The short id a name suggests, which signs the person's approvals as
// human:<handle>: lower case, accents folded to ASCII, anything outside
// a-z0-9 a hyphen, hyphens collapsed and trimmed. null when nothing usable
// is left ("!!!", a name in a script with no Latin letters) or when what is
// left is not a handle, so a caller has to choose what to offer instead.
export function handleFromName(name) {
  if (name === undefined || name === null) return null;
  const slug = String(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return HANDLE.test(slug) ? slug : null;
}

export function toHandle(text) {
  return handleFromName(text) ?? 'owner';
}

// The short id offered for `name`, the one just typed: the one that name
// makes, else the one the system user's name makes (the default before the
// name was asked), else "owner". It used to be the system user's alone, so
// "Ana Souza" was offered "ana".
export function defaultHandle(name, env) {
  return handleFromName(name) ?? toHandle(userName(env));
}

// The language a vault defaults to: the one this CLI is already speaking
// (resolveLang in src/lang.mjs, the same function src/cli.mjs builds its
// translator from), so the questions and the default never disagree.
export function defaultLang(env) {
  return resolveLang(env);
}

// Every default, for one language. `title` needs that language's pack, and
// `handle` follows `name` when the caller already has one (typed, or in the
// answers file), and the system user's name when it does not.
export function defaultAnswers({ lang, env, t = null, name }) {
  const user = userName(env);
  let timezone = 'UTC';
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimezone(resolved)) timezone = resolved;
  } catch {
    // Keep UTC.
  }
  return {
    lang,
    name: user === '' ? 'Owner' : user,
    handle: defaultHandle(name, env),
    title: t === null ? 'Second brain' : t('init.default_title'),
    repo: null,
    private: true,
    timezone,
  };
}

// Reads an answers file. Returns { answers } or { error: { kind, ...} }
// for the caller to translate; never throws.
export function readAnswersFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { error: { kind: 'unreadable', detail: error.message } };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: { kind: 'not_json', detail: error.message } };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: { kind: 'not_object' } };
  const unknown = Object.keys(value).find((key) => !ANSWER_KEYS.includes(key));
  if (unknown !== undefined) return { error: { kind: 'unknown_key', key: unknown } };
  // A JSON "repo": "" and "email": "" mean none, like a blank line.
  const answers = { ...value };
  for (const key of ['repo', 'email']) if (answers[key] === '') answers[key] = null;
  return { answers };
}

// claude_bin for machine.json: the first executable file named `claude`
// on PATH, as an absolute path, or the literal `claude` when there is
// none, so a later command still has a name to try and `doctor` a name
// to report.
// On Windows the name is looked up with PATHEXT, as a shell does
// (src/platform.mjs): the native install is claude.exe.
export function resolveClaudeBin(env, platform = process.platform) {
  const executable = (candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  return findProgram('claude', pathEntries(env, platform), { platform, env, executable }) ?? 'claude';
}

// The name init suggests to `gh repo create`: the repository the person
// answered (owner/name), else the vault's folder name folded to the
// characters GitHub accepts in a repository name (accents dropped, anything
// else a dash, dashes and dots trimmed off the ends), else a fixed "brain"
// when nothing usable is left. Only ever printed, never run.
export function suggestedRepoName({ repo, dir }) {
  if (typeof repo === 'string' && REPO.test(repo)) return repo;
  const folded = basename(dir)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return folded === '' ? 'brain' : folded;
}

// yes / no: the English words always, and the chosen language's own from
// its pack (init.yes_words, init.no_words), accents and case ignored.
function plain(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

function wordsOf(list) {
  return list.split(',').map(plain).filter((word) => word !== '');
}

function parseYesNo(text, t) {
  const typed = plain(text);
  if (['y', 'yes', ...wordsOf(t('init.yes_words'))].includes(typed)) return true;
  if (['n', 'no', ...wordsOf(t('init.no_words'))].includes(typed)) return false;
  return undefined;
}

// Turns one typed line into an answer, or undefined when it cannot be one.
function parseTyped(key, line, fallback, t) {
  const text = line.trim();
  if (text === '') return fallback;
  if (key === 'private') return parseYesNo(text, t);
  return text;
}

// Asks every question in QUESTIONS that `preset` does not already
// answer, one at a time, over `stdin` (a terminal). `translatorFor(lang)`
// returns the translator for a language, so every question after the
// first is asked in the language just chosen, with its defaults.
// Resolves { answers } or { ended: key } when stdin ends before `key`
// was answered.
export async function askInteractively({ stdin, stdout, preset, env, translatorFor, t: initial }) {
  const rl = createInterface({ input: stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const answers = { ...preset };
  let t = initial;
  let defaults = null;
  try {
    for (const key of QUESTIONS) {
      if (key === 'lang' && answers.lang !== undefined) {
        t = translatorFor(answers.lang);
        continue;
      }
      if (key !== 'lang' && defaults === null) defaults = defaultAnswers({ lang: answers.lang, env, t });
      if (answers[key] !== undefined) continue;
      // The short id offered is made from the name just typed (or given before).
      const fallback = key === 'lang' ? defaultLang(env) : key === 'handle' ? defaultHandle(answers.name, env) : defaults[key];
      for (;;) {
        stdout.write(question(t, key, fallback));
        const next = await lines.next();
        if (next.done) return { ended: key };
        const value = parseTyped(key, next.value, fallback, t);
        if (value !== undefined && (invalidAnswer(key, value) === null || key === 'private')) {
          answers[key] = value;
          break;
        }
        stdout.write(`${t('init.answer_again', { answer: questionLabel(t, key) })}\n`);
      }
      if (key === 'lang') t = translatorFor(answers.lang);
    }
    return { answers };
  } finally {
    rl.close();
  }
}

// What a question is called, as its prompt begins (except the private
// repository's, whose prompt is a sentence): "Language", "First name", "Short
// id", for the messages that name a question to a person. The key is the
// answers file's name for it and means nothing to someone at a terminal.
export function questionLabel(t, key) {
  return t(`init.label_${key}`);
}

function shown(t, value) {
  if (value === null) return t('init.not_yet');
  if (value === true) return t('init.yes');
  return String(value);
}

function question(t, key, fallback) {
  const value = shown(t, fallback);
  switch (key) {
    case 'lang': return t('init.ask_lang', { langs: SUPPORTED_LANGS, value });
    case 'name': return t('init.ask_name', { value });
    case 'handle': return t('init.ask_handle', { value });
    case 'title': return t('init.ask_title', { value });
    case 'repo': return t('init.ask_repo', { value });
    case 'private': return t('init.ask_private', { value });
    default: return t('init.ask_timezone', { value });
  }
}

export function describeAnswer(t, value) {
  return shown(t, value);
}
