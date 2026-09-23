import { chmodSync, existsSync, realpathSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { kitVersion } from '../version.mjs';
import { createTranslator, SUPPORTED_LANGS } from '../lang.mjs';
import { CONFIG_FILENAME, MACHINE_FILENAME, validateConfig, validateMachine } from '../config.mjs';
import { STATE_FILES, ensureStateDir, stateDirFor, vaultIdFor } from '../state.mjs';
import { run } from '../exec.mjs';
import { localGitVarNames, withoutLocalGitVars } from '../git-env.mjs';
import { INSTALL_HOOK_COMMAND, installGate } from '../init/gate.mjs';
import { completeDefaults } from '../init/config.mjs';
import {
  adoptRepositoryState, adoptionPaths, buildAdoptionManifest, inferConfig, inspectAdoptTarget, readDefaults, writeAdoption,
} from '../init/adopt.mjs';
import {
  ANSWER_KEYS, QUESTIONS, askInteractively, defaultAnswers, defaultLang, describeAnswer, invalidAnswer, readAnswersFile, resolveClaudeBin,
} from '../init/answers.mjs';
import {
  GITIGNORE_PATH, gitignoreText, inspectTarget, isInside, isoStamp, makeDirs, makeOwnTree, nearestExisting, recordMode, rollback, writeNew,
  writeVault,
} from '../init/skeleton.mjs';
import { runValidate } from './validate.mjs';
import { runLint } from './lint.mjs';

// brain-kit init [dir] [--adopt] [--lang en|pt-BR] [--yes] [--from-answers <file>]
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
// `--adopt` brings an EXISTING vault under the kit instead (see
// src/init/adopt.mjs): the same answers, the same state directory and
// machine.json, the same two passes of checks before the first write and
// the same ledger undone on failure, but the directory must already be a
// vault shape (a root index.md, no configuration, no manifest), the
// configuration is inferred from its notes, and the only files written
// into it are brain-kit.config.json and .brain-kit/manifest.json, plus the
// push gate installGate (src/init/gate.mjs) writes and wires when nothing
// of the person's is in the way (a hook of their own, or a core.hooksPath
// pointing elsewhere, is left exactly as it is, and the line that adds the
// gate to it is printed). `--no-hook` skips the gate and says so. It never
// runs git init and never commits; the validate and lint it runs
// afterwards only read the repository, with GIT_OPTIONAL_LOCKS=0.
// Every inference is printed before the checks run.
//
// `deps` is not part of the CLI surface: src/cli.mjs supplies walkVault,
// and tests may supply `env`, `now`, `cwd` (so no test ever resolves a
// path against the directory the suite runs from) and `checks` (the
// validate and lint runs) to reach the exit-code logic without a real
// vault failing, and `infer` (adopt's inferConfig) to hand the refusal of
// an invalid configuration one that inference itself no longer produces.

const USAGE_FLAGS_WITH_VALUE = Object.freeze(['--lang', '--from-answers']);

// The variables that make git act on a repository other than the one its
// working directory is in, and their removal, live in src/git-env.mjs,
// shared with `doctor`, which asks git about a vault with the same
// variables removed. Every git command init runs, and the validate and
// lint it runs on the result, run with these removed: init acts on the
// vault it is creating and on nothing else.

// The same removal for code that runs in this process and reads
// process.env itself (validate and lint), restored afterwards. While they
// run, GIT_OPTIONAL_LOCKS=0 is set as well: a read-only git command may
// otherwise refresh the index file as a side effect (git's own
// documentation of the variable), and an adopted vault's repository must
// come out of adopt byte for byte as it went in.
async function withProcessEnvCleaned(names, fn) {
  const saved = {};
  for (const name of [...names, 'GIT_OPTIONAL_LOCKS']) {
    if (Object.hasOwn(process.env, name)) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  }
  process.env.GIT_OPTIONAL_LOCKS = '0';
  try {
    return await fn();
  } finally {
    delete process.env.GIT_OPTIONAL_LOCKS;
    Object.assign(process.env, saved);
  }
}

function parseArgs(argv) {
  const result = { dir: undefined, lang: undefined, yes: false, answersFile: undefined, help: false, adopt: false, noHook: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (USAGE_FLAGS_WITH_VALUE.includes(arg)) {
      const value = argv[++i];
      if (value === undefined) return { missingValue: arg };
      if (arg === '--lang') result.lang = value;
      else result.answersFile = value;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (arg === '--adopt') {
      result.adopt = true;
    } else if (arg === '--no-hook') {
      result.noHook = true;
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
  // --no-hook skips adopt's gate; init always installs one, into the
  // repository it creates.
  if (result.noHook && !result.adopt) return { error: '--no-hook' };
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

// Under --adopt, a vault already adopted is refused with the way to adopt
// it again (the three files to remove), never with `update`, which does
// not redo an inference.
function refuseTarget(io, t, refusal, { adopt, machinePath }) {
  const { dir, vault, count, detail } = refusal.params;
  let line;
  switch (refusal.key) {
    case 'not_a_directory': line = t('init.not_a_directory', { dir }); break;
    case 'inside_vault': line = t('init.inside_vault', { dir, vault }); break;
    case 'already_vault':
      if (adopt) line = t('init.adopt_already_vault', { dir, machine: machinePath });
      else line = t('init.already_vault', { dir });
      break;
    case 'already_repository': line = t('init.already_repository', { dir }); break;
    case 'unreadable': line = t('init.unreadable', { dir, detail }); break;
    case 'adopt_no_index': line = t('init.adopt_no_index', { dir }); break;
    case 'adopt_brain_kit_not_directory': line = t('init.adopt_brain_kit_not_directory', { path: refusal.params.path }); break;
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

function buildMachine(canonical, stateDir, env) {
  return {
    vault_id: vaultIdFor(canonical),
    canonical_path: canonical,
    claude_bin: resolveClaudeBin(env),
    state_dir: stateDir,
    paths: {
      watermark: join(stateDir, STATE_FILES.WATERMARK),
      last_run: join(stateDir, STATE_FILES.LAST_RUN),
      log_dir: join(stateDir, STATE_FILES.LOG_DIR),
      questions_log: join(stateDir, STATE_FILES.QUESTIONS_LOG),
    },
  };
}

// Every check on the two places init writes, in one function, so the
// second pass just before writing is the same code as the first. The check
// on the target is inspectTarget for a new vault, inspectAdoptTarget for
// an existing one.
function refuseLocations(io, t, target, stateDir, machinePath, adopt, env) {
  const refusal = adopt ? inspectAdoptTarget(target) : inspectTarget(target);
  if (refusal !== null) return refuseTarget(io, t, refusal, { adopt, machinePath });
  // A vault is a repository: the kit works only through pull requests, and
  // what adopt records is asked of git (see src/init/adopt.mjs). A folder
  // that is not in one is refused with the way to make it one, the
  // .gitignore first, so nothing the person keeps out of git is ever
  // committed or named. A repository git cannot read is refused later, by
  // the listing, with git's own words.
  // Without git at all, "run git init" would send the person to a command
  // that cannot run: git missing is said as git missing.
  const repository = adopt ? adoptRepositoryState(target, env) : null;
  if (repository?.state === 'no_git') {
    io.stderr.write(`${t('init.adopt_git_missing', { dir: target, detail: repository.detail })}\n`);
    return EXIT.USAGE;
  }
  if (repository?.state === 'none') {
    io.stderr.write(`${t('init.adopt_not_repository', { dir: target })}\n`);
    return EXIT.USAGE;
  }
  if (isInside(stateDir, target)) {
    io.stderr.write(`${t('init.state_inside_vault', { state: stateDir, dir: target })}\n`);
    return EXIT.USAGE;
  }
  if (existsSync(machinePath)) {
    if (adopt) io.stderr.write(`${t('init.adopt_machine_exists', { file: machinePath })}\n`);
    else io.stderr.write(`${t('init.machine_exists', { file: machinePath })}\n`);
    return EXIT.USAGE;
  }
  return null;
}

export async function runInit(argv, io, t, {
  walkVault, env = process.env, now = () => new Date(), checks = null, cwd = process.cwd(), infer = inferConfig,
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
    // adopt never commits: the history of a vault that already exists is
    // its owner's. A "commit": true it would silently not honour is
    // refused, like an unknown key, rather than ignored.
    if (parsed.adopt && fileAnswers.commit === true) {
      io.stderr.write(`${t('init.adopt_commit', { file: resolve(cwd, parsed.answersFile) })}\n`);
      return EXIT.USAGE;
    }
  }

  const target = canonicalOf(resolve(cwd, parsed.dir ?? '.'));
  // Canonical like the target, so a state directory reached through a
  // symbolic link into the vault is seen to be inside it.
  const stateDir = canonicalOf(resolve(cwd, stateDirFor(target, env)));
  const machinePath = join(stateDir, MACHINE_FILENAME);
  const first = refuseLocations(io, t, target, stateDir, machinePath, parsed.adopt, env);
  if (first !== null) return first;

  // adopt needs git too, and has already asked it whether the vault is a
  // repository.
  if (!parsed.adopt) {
    const gitCheck = run('git', ['--version']);
    if (gitCheck.status !== 0) {
      io.stderr.write(`${t('init.git_unavailable', { detail: gitCheck.stderr.trim() })}\n`);
      return EXIT.FAILURE;
    }
  }
  const localVars = localGitVarNames(env);
  const gitEnv = withoutLocalGitVars(env, localVars);

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
  // For adopt, the configuration is what the vault's own notes say, and
  // the manifest lists every file already there; both are built, and
  // judged, before anything is written.
  let inferred = null;
  let adoption = null;
  if (parsed.adopt) {
    // A folder or a file somewhere inside the vault that cannot be read
    // is a vault adopt cannot describe, nor record in the manifest: a
    // refusal, like a root it cannot list, and nothing is written.
    try {
      // One list, what git would publish, for both: the configuration and
      // the manifest are committed, and neither may learn from a file git
      // ignores.
      const files = adoptionPaths(target, env);
      inferred = infer(target, { lang: answers.lang, env, files });
      adoption = buildAdoptionManifest(target, { lang: answers.lang, env, files });
    } catch (error) {
      io.stderr.write(`${t('init.adopt_unreadable', { dir: target, detail: error.code ?? error.message })}\n`);
      return EXIT.USAGE;
    }
    if (!adoption.files.some((entry) => entry.path === 'index.md')) {
      io.stderr.write(`${t('init.adopt_no_index', { dir: target })}\n`);
      return EXIT.USAGE;
    }
  }
  const config = completeDefaults(inferred?.config ?? readDefaults(answers.lang), answers, { kitVersion: kitVersion() });
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
  const second = refuseLocations(io, t, target, stateDir, machinePath, parsed.adopt, env);
  if (second !== null) return second;

  // Nested inside another repository is allowed (an empty directory in a
  // dotfiles home, say): `git add -A` in the outer one records the vault
  // as one gitlink, never its files. It is said, not refused. An adopted
  // vault is usually its own repository, which says nothing worth saying.
  let outerRoot = '';
  if (!parsed.adopt) {
    const outer = run('git', ['rev-parse', '--show-toplevel'], { cwd: nearestExisting(target), env: gitEnv });
    outerRoot = outer.status === 0 ? outer.stdout.trim() : '';
  }

  // A state directory that already exists keeps its mode if this run
  // fails, and is named on success if init tightened it.
  let priorMode = null;
  try {
    const st = statSync(stateDir);
    if (st.isDirectory()) priorMode = st.mode & 0o7777;
  } catch {
    // Absent: init creates it.
  }

  // --- from here on, init writes ---------------------------------------------
  //
  // The state directory and machine.json come first, before a byte of the
  // vault: an unwritable state home (a ~/.local/state an earlier sudo run
  // created) is the one precondition that cannot be proved by reading, so
  // it is proved by writing, where undoing it touches nothing of the
  // person's. Everything after that is recorded in the ledger, and any
  // failure until the repository is set up undoes all of it.
  //
  // SIGINT and SIGTERM (a Ctrl-C, a service manager stopping) are held
  // for the length of the writes: the writes are synchronous, so a signal
  // is only seen once they stop, and a git child it killed is a failure
  // like any other. Either way the ledger is undone, and init exits with
  // the conventional status for that signal.
  const ledger = [];
  let interrupted = null;
  const onSignal = (signal) => {
    interrupted ??= signal;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let failure = null;
  let manifest;
  try {
    try {
      makeDirs(ledger, stateDir);
      if (priorMode !== null && priorMode !== 0o700) recordMode(ledger, stateDir, priorMode);
      ensureStateDir(stateDir);
      writeNew(ledger, machinePath, `${JSON.stringify(machine, null, 2)}\n`, 0o600);
      chmodSync(machinePath, 0o600);
    } catch (error) {
      failure = t('init.state_unwritable', { state: stateDir, detail: error.message });
    }
    if (failure === null && parsed.adopt) {
      try {
        writeAdoption(target, { ledger, configText: `${JSON.stringify(config, null, 2)}\n`, manifest: adoption });
        manifest = adoption;
      } catch (error) {
        failure = error.message;
      }
    } else if (failure === null) {
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
        makeOwnTree(ledger, join(target, '.git'));
        for (const [step, args] of [['git init', ['init', '-q']], ['git config core.hooksPath', ['config', 'core.hooksPath', '.githooks']]]) {
          const result = run('git', args, { cwd: target, env: gitEnv });
          if (result.status !== 0) throw new Error(t('init.git_failed', { step, detail: result.stderr.trim() }));
        }
      } catch (error) {
        failure = error.message;
      }
    }
    // Let a signal that arrived during the synchronous writes be delivered.
    await new Promise((settle) => setImmediate(settle));
    await new Promise((settle) => setImmediate(settle));
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  if (interrupted !== null) {
    undo(io, t, ledger, t('init.interrupted', { signal: interrupted }), target);
    return 128 + (osConstants.signals[interrupted] ?? 0);
  }
  if (failure !== null) return undo(io, t, ledger, failure, target);

  if (defaulted.length > 0) {
    io.stdout.write(`${t('init.using_defaults')}\n`);
    for (const key of defaulted) io.stdout.write(`  ${key}: ${describeAnswer(t, answers[key])}\n`);
  }
  if (parsed.adopt) {
    io.stdout.write(`${t('init.adopted', { dir: target, count: manifest.files.length })}\n`);
    io.stdout.write(`${t('init.adopt_inferred')}\n`);
    for (const note of inferred.notes) io.stdout.write(`  - ${t(note.messageKey, note.params)}\n`);
  } else {
    io.stdout.write(`${t('init.created', { dir: target, count: manifest.files.length })}\n`);
  }
  if (outerRoot !== '') io.stdout.write(`${t('init.nested_repository', { root: outerRoot })}\n`);
  io.stdout.write(`${t('init.state_written', { file: machinePath })}\n`);
  if (priorMode !== null && priorMode !== 0o700) {
    io.stdout.write(`${t('init.state_tightened', { state: stateDir, mode: priorMode.toString(8) })}\n`);
  }

  // The adopter's gate, once the adoption is written: installGate leaves a
  // hook the person already has exactly as it is and says how to add the
  // gate to it. Only a gate that failed to install changes the exit code
  // (to at least 3): the adoption itself is done, and a person must look.
  let gateFailed = false;
  if (parsed.adopt && parsed.noHook) {
    io.stdout.write(`${t('init.adopt_no_hook', { command: INSTALL_HOOK_COMMAND })}\n`);
  } else if (parsed.adopt) {
    const gate = installGate(target, { env });
    gateFailed = gate.outcome === 'failed';
    (gateFailed ? io.stderr : io.stdout).write(`${t(gate.messageKey, gate.params)}\n`);
  }

  if (parsed.adopt) io.stdout.write(`${t('init.adopt_checking')}\n`);
  else io.stdout.write(`${t('init.checking')}\n`);
  const runChecks = checks ?? {
    validate: (args, cio, ct) => runValidate(args, cio, ct, walkVault),
    lint: (args, cio, ct) => runLint(args, cio, ct, walkVault),
  };
  const [validated, linted] = await withProcessEnvCleaned(localVars, async () => [
    await runChecks.validate([target], io, t),
    await runChecks.lint([target, '--base', 'all'], io, t),
  ]);
  const checked = worseExit(validated, linted);
  if (parsed.adopt) {
    io.stdout.write(`${t('init.adopt_no_commit')}\n`);
    return gateFailed ? worseExit(checked, EXIT.DEGRADED) : checked;
  }

  // The first commit, when asked for, only over a vault both checks
  // passed: a credential-shaped answer must never reach history, even a
  // history no one has pushed yet.
  let code = EXIT.OK;
  if (answers.commit !== true) {
    io.stdout.write(`${t('init.no_commit')}\n`);
  } else if (checked !== EXIT.OK) {
    io.stderr.write(`${t('init.commit_skipped')}\n`);
  } else {
    const added = run('git', ['add', '-A'], { cwd: target, env: gitEnv });
    const committed = added.status === 0 ? run('git', ['commit', '-q', '-m', t('init.commit_message')], { cwd: target, env: gitEnv }) : added;
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
