import { chmodSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { kitVersion, KIT_ROOT } from '../version.mjs';
import { createTranslator, SUPPORTED_LANGS } from '../lang.mjs';
import { CONFIG_FILENAME, MACHINE_FILENAME, validateConfig, validateMachine } from '../config.mjs';
import { STATE_FILES, ensureStateDir, stateDirFor, vaultIdFor } from '../state.mjs';
import { run } from '../exec.mjs';
import { completeDefaults } from '../init/config.mjs';
import {
  ANSWER_KEYS, QUESTIONS, askInteractively, defaultAnswers, defaultLang, describeAnswer, invalidAnswer, readAnswersFile, resolveClaudeBin,
} from '../init/answers.mjs';
import {
  GITIGNORE_PATH, inspectTarget, isInside, isoStamp, makeDirs, nearestExisting, rollback, writeNew, writeVault,
} from '../init/skeleton.mjs';
import { runValidate } from './validate.mjs';
import { runLint } from './lint.mjs';

// brain-kit init [dir] [--lang en|pt-BR] [--yes] [--from-answers <file>]
//
// Makes `dir` (default: the current directory) a new vault: the language
// skeleton, brain-kit.config.json completed from the answers, .gitignore,
// the pre-push hook, .brain-kit/manifest.json, a git repository pointed
// at the hook, and machine.json in the state directory, outside the
// vault. Then it runs `validate` and `lint --base all` on the result and
// exits with the worse of the two.
//
// The one rule this command is built around: every reason to refuse is
// decided before the first byte is written. A directory that is not
// empty, one that is already a repository, one that is (or is inside) a
// vault, a state directory that already holds a machine.json or sits
// inside the vault, an answers file that is wrong, and a missing answer
// that no one can be asked for: each exits 2 with nothing written,
// anywhere. The checks on the directories run twice, once before the
// questions and again just before writing, because a person answering
// questions takes long enough for something else to write there.
//
// It never commits unless the answers say `"commit": true`: the first
// commit of a vault is its owner's, made when they have looked at it; and
// even then only once validate and lint have both passed.
//
// A failure after the first write (a git that fails, a disk that fills)
// removes everything the run created, exactly, since the target was
// empty or absent: a half vault would be refused by the next init as
// "already a vault", with nothing able to finish it.
//
// `deps` is not part of the CLI surface: src/cli.mjs supplies walkVault,
// and tests may supply `env`, `now`, `cwd` (so no test ever resolves a
// path against the directory the suite runs from) and `checks` (the
// validate and lint runs) to reach the exit-code logic without a real
// vault failing.

const USAGE_FLAGS_WITH_VALUE = Object.freeze(['--lang', '--from-answers']);

function parseArgs(argv) {
  const result = { dir: undefined, lang: undefined, yes: false, answersFile: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (USAGE_FLAGS_WITH_VALUE.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) return { missingValue: arg };
      if (arg === '--lang') result.lang = value;
      else result.answersFile = value;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg.startsWith('-')) {
      return { error: arg };
    } else if (result.dir === undefined) {
      result.dir = arg;
    } else {
      return { error: arg };
    }
  }
  return result;
}

// The order in which two exit codes are "worse": a clean run is the
// best, a degraded or postponed one next, and a failure or a usage error
// the worst. Unknown codes rank as failures, never as success.
const EXIT_RANK = new Map([
  [EXIT.OK, 0],
  [EXIT.DEGRADED, 1],
  [EXIT.SOURCE_UNREAD, 2],
  [EXIT.TEMPFAIL, 3],
  [EXIT.UNAVAILABLE, 4],
  [EXIT.FAILURE, 5],
  [EXIT.USAGE, 6],
]);

export function worseExit(a, b) {
  const rank = (code) => (EXIT_RANK.has(code) ? EXIT_RANK.get(code) : EXIT_RANK.get(EXIT.FAILURE));
  return rank(b) > rank(a) ? b : a;
}

function readDefaults(lang) {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

// The path the vault will have once it exists, with every symbolic link
// in the part that already exists resolved, so machine.json's
// canonical_path, and the state directory derived from it, agree with
// the physical path a later command finds from its working directory.
function canonicalOf(target) {
  let existing = target;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

function refuseTarget(io, t, refusal) {
  const { dir, vault, count, detail } = refusal.params;
  let line;
  switch (refusal.key) {
    case 'not_a_directory': line = t('init.not_a_directory', { dir }); break;
    case 'inside_vault': line = t('init.inside_vault', { dir, vault }); break;
    case 'already_vault': line = t('init.already_vault', { dir }); break;
    case 'already_repository': line = t('init.already_repository', { dir }); break;
    case 'unreadable': line = t('init.unreadable', { dir, detail }); break;
    default: line = t('init.not_empty', { dir, count }); break;
  }
  io.stderr.write(`${line}\n`);
  return EXIT.USAGE;
}

// What a valid answer for `key` looks like, for the refusal naming it.
function expectation(t, key) {
  switch (key) {
    case 'lang': return t('init.expect_lang', { langs: SUPPORTED_LANGS });
    case 'name': return t('init.expect_text');
    case 'title': return t('init.expect_text');
    case 'handle': return t('init.expect_handle');
    case 'repo': return t('init.expect_repo');
    case 'private': return t('init.expect_private');
    case 'timezone': return t('init.expect_timezone');
    case 'email': return t('init.expect_email');
    default: return t('init.expect_boolean');
  }
}

function refuseAnswer(io, t, key, value) {
  if (key === 'private' && value === false) {
    io.stderr.write(`${t('init.private_required')}\n`);
    return EXIT.USAGE;
  }
  const expected = expectation(t, key);
  io.stderr.write(`${t('init.invalid_answer', { answer: key, value: JSON.stringify(value), expected })}\n`);
  return EXIT.USAGE;
}

function gitignoreText(t) {
  return [
    `# ${t('init.gitignore_header')}`,
    '',
    `# ${t('init.gitignore_dependencies')}`,
    'node_modules/',
    '',
    `# ${t('init.gitignore_environment')}`,
    '.env',
    '.env.*',
    '!.env.example',
    '',
    `# ${t('init.gitignore_system')}`,
    '.DS_Store',
    'Thumbs.db',
    '*.swp',
    '*~',
    '',
  ].join('\n');
}

function buildMachine(canonical, stateDir, env) {
  return {
    vault_id: vaultIdFor(canonical),
    canonical_path: canonical,
    claude_bin: resolveClaudeBin(env),
    state_dir: stateDir,
    paths: {
      lock: join(stateDir, STATE_FILES.LOCK),
      watermark: join(stateDir, STATE_FILES.WATERMARK),
      last_run: join(stateDir, STATE_FILES.LAST_RUN),
      log_dir: join(stateDir, STATE_FILES.LOG_DIR),
      questions_log: join(stateDir, STATE_FILES.QUESTIONS_LOG),
      snapshot: join(stateDir, STATE_FILES.SNAPSHOT),
    },
  };
}

// Every check on the two places init writes, in one function, so the
// second pass just before writing is the same code as the first.
function refuseLocations(io, t, target, stateDir, machinePath) {
  const refusal = inspectTarget(target);
  if (refusal !== null) return refuseTarget(io, t, refusal);
  if (isInside(stateDir, target)) {
    io.stderr.write(`${t('init.state_inside_vault', { state: stateDir, dir: target })}\n`);
    return EXIT.USAGE;
  }
  if (existsSync(machinePath)) {
    io.stderr.write(`${t('init.machine_exists', { file: machinePath })}\n`);
    return EXIT.USAGE;
  }
  return null;
}

export async function runInit(argv, io, t, {
  walkVault, env = process.env, now = () => new Date(), checks = null, cwd = process.cwd(),
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.missingValue) {
    io.stderr.write(`${t('init.missing_value', { flag: parsed.missingValue })}\n`);
    io.stderr.write(`${t('init.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.error) {
    io.stderr.write(`${t('init.bad_argument', { arg: parsed.error })}\n`);
    io.stderr.write(`${t('init.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('init.usage')}\n`);
    return EXIT.OK;
  }
  if (parsed.lang !== undefined && !SUPPORTED_LANGS.includes(parsed.lang)) {
    io.stderr.write(`${t('init.unknown_lang', { lang: parsed.lang, langs: SUPPORTED_LANGS })}\n`);
    return EXIT.USAGE;
  }

  // The answers file: read, and every answer in it judged, before any
  // directory is even looked at.
  let fileAnswers = {};
  if (parsed.answersFile !== undefined) {
    const file = resolve(cwd, parsed.answersFile);
    const read = readAnswersFile(file);
    if (read.error) {
      const { kind, detail, key } = read.error;
      let line;
      if (kind === 'unreadable') line = t('init.answers_unreadable', { file, detail });
      else if (kind === 'not_json') line = t('init.answers_not_json', { file, detail });
      else if (kind === 'not_object') line = t('init.answers_not_object', { file });
      else line = t('init.answers_unknown_key', { file, key, keys: ANSWER_KEYS });
      io.stderr.write(`${line}\n`);
      return EXIT.USAGE;
    }
    fileAnswers = read.answers;
    for (const [key, value] of Object.entries(fileAnswers)) {
      if (invalidAnswer(key, value) !== null) return refuseAnswer(io, t, key, value);
    }
    if (parsed.lang !== undefined && fileAnswers.lang !== undefined && fileAnswers.lang !== parsed.lang) {
      io.stderr.write(`${t('init.lang_conflict', { flag: parsed.lang, file: fileAnswers.lang })}\n`);
      return EXIT.USAGE;
    }
  }

  const target = canonicalOf(resolve(cwd, parsed.dir ?? '.'));
  const stateDir = resolve(stateDirFor(target, env));
  const machinePath = join(stateDir, MACHINE_FILENAME);
  const first = refuseLocations(io, t, target, stateDir, machinePath);
  if (first !== null) return first;

  const gitCheck = run('git', ['--version']);
  if (gitCheck.status !== 0) {
    io.stderr.write(`${t('init.git_unavailable', { detail: gitCheck.stderr.trim() })}\n`);
    return EXIT.FAILURE;
  }

  // The answers: the file's, then --lang, then (with --yes) the defaults
  // for whatever is still missing, then a terminal for the rest, and when
  // there is no terminal, a refusal naming the first answer missing.
  const answers = { ...fileAnswers };
  if (parsed.lang !== undefined) answers.lang = parsed.lang;
  const defaulted = [];
  if (parsed.yes) {
    if (answers.lang === undefined) {
      answers.lang = defaultLang(env);
      defaulted.push('lang');
    }
    const defaults = defaultAnswers({ lang: answers.lang, env, t: translatorFor(io, answers.lang) });
    for (const key of QUESTIONS) {
      if (answers[key] === undefined) {
        answers[key] = defaults[key];
        if (!defaulted.includes(key)) defaulted.push(key);
      }
    }
  }
  const missing = QUESTIONS.find((key) => answers[key] === undefined);
  if (missing !== undefined) {
    if (io.stdin?.isTTY !== true) {
      if (parsed.answersFile !== undefined) {
        io.stderr.write(`${t('init.answers_missing', { file: resolve(cwd, parsed.answersFile), answer: missing })}\n`);
      } else {
        io.stderr.write(`${t('init.missing_answer', { answer: missing })}\n`);
      }
      return EXIT.USAGE;
    }
    const asked = await askInteractively({
      stdin: io.stdin, stdout: io.stdout, preset: answers, env, translatorFor: (lang) => translatorFor(io, lang), t,
    });
    if (asked.ended !== undefined) {
      io.stderr.write(`\n${t('init.stdin_ended', { answer: asked.ended })}\n`);
      return EXIT.USAGE;
    }
    Object.assign(answers, asked.answers);
  }
  for (const key of QUESTIONS) {
    if (invalidAnswer(key, answers[key]) !== null) return refuseAnswer(io, translatorFor(io, answers.lang), key, answers[key]);
  }

  // From here on every sentence is in the vault's own language.
  t = translatorFor(io, answers.lang);
  const config = completeDefaults(readDefaults(answers.lang), answers, { kitVersion: kitVersion() });
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    io.stderr.write(`${t('init.config_invalid', { errors: configErrors })}\n`);
    return EXIT.FAILURE;
  }
  const machine = buildMachine(target, stateDir, env);
  const machineErrors = validateMachine(machine);
  if (machineErrors.length > 0) {
    io.stderr.write(`${t('init.machine_invalid', { errors: machineErrors })}\n`);
    return EXIT.FAILURE;
  }

  // Second pass, just before writing: see the header.
  const second = refuseLocations(io, t, target, stateDir, machinePath);
  if (second !== null) return second;

  // Nested inside another repository is allowed (an empty directory in a
  // dotfiles home, say): `git add -A` in the outer one records the vault
  // as one gitlink, never its files. It is said, not refused.
  const outer = run('git', ['rev-parse', '--show-toplevel'], { cwd: nearestExisting(target) });
  const outerRoot = outer.status === 0 ? outer.stdout.trim() : '';

  // --- from here on, init writes ---------------------------------------------
  //
  // The state directory and machine.json come first, before a byte of the
  // vault: an unwritable state home (a ~/.local/state an earlier sudo run
  // created) is the one precondition that cannot be proved by reading, so
  // it is proved by writing, where undoing it touches nothing of the
  // person's. Everything after that is recorded in the ledger, and any
  // failure until the repository is set up removes all of it.
  const ledger = [];
  try {
    makeDirs(ledger, stateDir);
    ensureStateDir(stateDir);
    writeNew(ledger, machinePath, `${JSON.stringify(machine, null, 2)}\n`, 0o600);
    chmodSync(machinePath, 0o600);
  } catch (error) {
    return undo(io, t, ledger, t('init.state_unwritable', { state: stateDir, detail: error.message }), target);
  }

  let manifest;
  try {
    manifest = writeVault(target, {
      lang: answers.lang,
      stamp: isoStamp(now()),
      ledger,
      files: {
        [CONFIG_FILENAME]: `${JSON.stringify(config, null, 2)}\n`,
        [GITIGNORE_PATH]: gitignoreText(t),
      },
    });
    // .git is recorded before git runs, so a git that fails halfway
    // through creating it is undone too; it did not exist (checked twice).
    ledger.push({ path: join(target, '.git'), kind: 'tree' });
    for (const [step, args] of [['git init', ['init', '-q']], ['git config core.hooksPath', ['config', 'core.hooksPath', '.githooks']]]) {
      const result = run('git', args, { cwd: target });
      if (result.status !== 0) throw new Error(t('init.git_failed', { step, detail: result.stderr.trim() }));
    }
  } catch (error) {
    return undo(io, t, ledger, error.message, target);
  }

  if (defaulted.length > 0) {
    io.stdout.write(`${t('init.using_defaults')}\n`);
    for (const key of defaulted) io.stdout.write(`  ${key}: ${describeAnswer(t, answers[key])}\n`);
  }
  io.stdout.write(`${t('init.created', { dir: target, count: manifest.files.length })}\n`);
  if (outerRoot !== '') io.stdout.write(`${t('init.nested_repository', { root: outerRoot })}\n`);
  io.stdout.write(`${t('init.state_written', { file: machinePath })}\n`);

  io.stdout.write(`${t('init.checking')}\n`);
  const runChecks = checks ?? {
    validate: (args, cio, ct) => runValidate(args, cio, ct, walkVault),
    lint: (args, cio, ct) => runLint(args, cio, ct, walkVault),
  };
  const validated = await runChecks.validate([target], io, t);
  const linted = await runChecks.lint([target, '--base', 'all'], io, t);
  const checked = worseExit(validated, linted);

  // The first commit, when asked for, only over a vault both checks
  // passed: a credential-shaped answer must never reach history, even a
  // history no one has pushed yet.
  let code = EXIT.OK;
  if (answers.commit !== true) {
    io.stdout.write(`${t('init.no_commit')}\n`);
  } else if (checked !== EXIT.OK) {
    io.stderr.write(`${t('init.commit_skipped')}\n`);
  } else {
    const added = run('git', ['add', '-A'], { cwd: target });
    const committed = added.status === 0 ? run('git', ['commit', '-q', '-m', t('init.commit_message')], { cwd: target }) : added;
    if (committed.status !== 0) {
      io.stderr.write(`${t('init.commit_failed', { detail: committed.stderr.trim() })}\n`);
      code = EXIT.DEGRADED;
    } else {
      io.stdout.write(`${t('init.committed')}\n`);
    }
  }
  return worseExit(code, checked);
}

// A failure after the first write: remove everything this run created,
// and say whether that worked, naming what is left when it did not.
function undo(io, t, ledger, detail, target) {
  const left = rollback(ledger);
  if (left.length === 0) io.stderr.write(`${t('init.rolled_back', { detail, dir: target })}\n`);
  else io.stderr.write(`${t('init.rollback_incomplete', { detail, left })}\n`);
  return EXIT.FAILURE;
}

function translatorFor(io, lang) {
  return createTranslator(lang, { warn: (message) => io.stderr.write(`${message}\n`) });
}
