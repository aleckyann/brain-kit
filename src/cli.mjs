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
  ['validate', (argv, io, t) => runValidate(argv, io, t, walkVault)],
  ['lint', (argv, io, t) => runLint(argv, io, t, walkVault)],
  ['doctor', (argv, io, t) => runDoctor(argv, io, t)],
  ['scan-blobs', (argv, io) => runScanBlobs(argv, io)],
  ['push-gate', (argv, io) => runPushGate(argv, io, createTranslator(GATE_LANG, {
    warn: (message) => io.stderr.write(`${message}\n`),
  }))],
]);

export async function main(argv, io, { commands = BUILTIN_COMMANDS } = {}) {
  const { lang, unsupported } = resolveLangDetailed(process.env);
  const t = createTranslator(lang, {
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  if (unsupported !== null) io.stderr.write(`${t('lang.unsupported_setting', { value: unsupported, langs: SUPPORTED_LANGS, lang })}\n`);
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
