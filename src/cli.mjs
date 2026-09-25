import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXIT } from './exit-codes.mjs';
import { kitVersion } from './version.mjs';
import { createTranslator, resolveLangDetailed, SUPPORTED_LANGS } from './lang.mjs';
import { runHook } from './commands/hook.mjs';
import { runValidate } from './commands/validate.mjs';
import { runLint } from './commands/lint.mjs';
import { runScanBlobs } from './commands/scan-blobs.mjs';
import { runPushGate } from './commands/push-gate.mjs';
import { runInit } from './commands/init.mjs';
import { runDoctor } from './commands/doctor.mjs';
import { runUpdate } from './commands/update.mjs';
import { runSync } from './commands/sync.mjs';
import { runMachine } from './commands/machine.mjs';
import { runVerify } from './commands/verify.mjs';
import { runPropose } from './commands/propose.mjs';
import { runPrompt } from './commands/prompt.mjs';
import { runWatermark } from './commands/watermark.mjs';
import { runSchedule } from './commands/schedule.mjs';
import { runCurate } from './commands/curate.mjs';
import { runPreflight } from './commands/preflight.mjs';
import { runQuestions } from './commands/questions.mjs';
import { walkVault } from './vault.mjs';
import { ConfigError } from './config.mjs';

// command name -> async (argv, io, t) => exit code
//
// validate's own module never imports walkVault itself: this closure is
// the ONLY reference to the real function that reaches it. That is
// deliberate (fix round 1): a test spying on an injected walkVault
// parameter is worthless if the real function also sits reachable one
// import away inside validate.mjs's own module scope, since a second,
// accidental call could bypass the spy by using that other reference
// instead. With the reference owned here and handed down as the one
// and only way validate.mjs can reach it, there is no such bypass left.
// `scan-blobs` is internal (see src/commands/scan-blobs.mjs's own header):
// the maintainer's own push gate (.githooks/pre-push) is its only caller,
// it is never listed in cli.usage below, and its messages are plain
// English literals rather than translated strings, exactly like the shell
// pipeline it replaces never went through this project's translator
// either. It still goes through the same command map and the same error
// boundary as every public command, because a second, parallel dispatch
// path for "the internal one" would be a second thing to keep correct.
// `push-gate` is the gate behind one command (src/commands/push-gate.mjs):
// it runs the push enumeration and hands its stream to the same scanner.
// It is called by a pre-push hook, not by a person, so it is not listed in
// cli.usage either. Its own sentences come from the language packs like
// every command's, but through a translator FIXED to English: they print
// in between the lines of the enumeration and the scanner, which are
// English literals, and a report that switches language halfway through
// is broken whichever language it switches to. Translating the whole gate
// as one unit is a later, named item; until then BRAIN_KIT_LANG does not
// reach this command.
const GATE_LANG = 'en';
const BUILTIN_COMMANDS = new Map([
  ['hook', runHook],
  ['init', (argv, io, t) => runInit(argv, io, t, { walkVault })],
  ['update', (argv, io, t) => runUpdate(argv, io, t)],
  ['validate', (argv, io, t) => runValidate(argv, io, t, walkVault)],
  ['lint', (argv, io, t) => runLint(argv, io, t, walkVault)],
  ['doctor', (argv, io, t) => runDoctor(argv, io, t)],
  ['sync', (argv, io, t) => runSync(argv, io, t)],
  ['machine', (argv, io, t) => runMachine(argv, io, t)],
  ['verify', (argv, io, t) => runVerify(argv, io, t)],
  ['propose', (argv, io, t) => runPropose(argv, io, t, { walkVault })],
  ['prompt', (argv, io, t) => runPrompt(argv, io, t)],
  ['watermark', (argv, io, t) => runWatermark(argv, io, t)],
  ['schedule', (argv, io, t) => runSchedule(argv, io, t)],
  ['curate', (argv, io, t) => runCurate(argv, io, t)],
  ['preflight', (argv, io, t) => runPreflight(argv, io, t)],
  ['questions', (argv, io, t) => runQuestions(argv, io, t)],
  ['scan-blobs', (argv, io) => runScanBlobs(argv, io)],
  ['push-gate', (argv, io) => runPushGate(argv, io, createTranslator(GATE_LANG, {
    warn: (message) => io.stderr.write(`${message}\n`),
  }))],
]);

// `-C <dir>` before the command, as git's: the command runs exactly as if
// brain-kit had been started in <dir> (the working directory is changed for
// the command and changed back after it), so a vault is found from there
// and every relative path the command is given, `propose --only`'s
// included, is read from there. Several are applied in order, each relative
// to the one before. The morning briefing runs in a session whose working
// directory is not the vault (the desktop application's task has none), so
// every kit command its prompt names carries `-C "<vault>"` (final review
// of phase 4, finding C2). A missing, empty or unusable directory is exit 2.
function takeDirectories(argv, t, io) {
  let rest = argv;
  let dir = null;
  while (rest[0] === '-C') {
    const given = rest[1];
    if (given === undefined || given === '') {
      io.stderr.write(`${t('cli.dir_missing')}\n`);
      io.stderr.write(`${t('cli.usage', { version: kitVersion() })}\n`);
      return { code: EXIT.USAGE };
    }
    const target = resolve(dir ?? process.cwd(), given);
    let isDir;
    try {
      isDir = statSync(target).isDirectory();
    } catch {
      io.stderr.write(`${t('cli.dir_not_found', { dir: target })}\n`);
      return { code: EXIT.USAGE };
    }
    if (!isDir) {
      io.stderr.write(`${t('cli.dir_not_a_directory', { dir: target })}\n`);
      return { code: EXIT.USAGE };
    }
    dir = target;
    rest = rest.slice(2);
  }
  return { rest, dir };
}

export async function main(argv, io, { commands = BUILTIN_COMMANDS } = {}) {
  const { lang, unsupported } = resolveLangDetailed(process.env);
  const t = createTranslator(lang, {
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  if (unsupported !== null) io.stderr.write(`${t('lang.unsupported_setting', { value: unsupported, langs: SUPPORTED_LANGS, lang })}\n`);
  const taken = takeDirectories(argv, t, io);
  if (taken.code !== undefined) return taken.code;
  if (taken.dir === null) return dispatch(taken.rest, io, t, commands);
  const back = process.cwd();
  process.chdir(taken.dir);
  try {
    return await dispatch(taken.rest, io, t, commands);
  } finally {
    process.chdir(back);
  }
}

async function dispatch(argv, io, t, commands) {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout.write(`${t('cli.usage', { version: kitVersion() })}\n`);
    return EXIT.OK;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    io.stdout.write(`${kitVersion()}\n`);
    return EXIT.OK;
  }
  const handler = commands.get(command);
  if (!handler) {
    io.stderr.write(`${t('cli.unknown_command', { command })}\n`);
    io.stderr.write(`${t('cli.usage', { version: kitVersion() })}\n`);
    return EXIT.USAGE;
  }
  // Error boundary: a command that throws must still produce a clean exit
  // code and a one-line stderr message, not a raw stack trace to the user.
  try {
    return await handler(rest, io, t);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${error.message}\n`);
      return EXIT.USAGE;
    }
    io.stderr.write(`brain-kit: ${error.message}\n`);
    if (process.env.BRAIN_KIT_DEBUG) io.stderr.write(`${error.stack}\n`);
    return EXIT.FAILURE;
  }
}
