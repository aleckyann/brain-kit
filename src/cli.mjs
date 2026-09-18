import { EXIT } from './exit-codes.mjs';
import { kitVersion } from './version.mjs';
import { createTranslator, REFERENCE_LANG } from './lang.mjs';
import { runHook } from './commands/hook.mjs';
import { ConfigError } from './config.mjs';

// command name -> async (argv, io, t) => exit code
const BUILTIN_COMMANDS = new Map([
  ['hook', runHook],
]);

export async function main(argv, io, { commands = BUILTIN_COMMANDS } = {}) {
  const t = createTranslator(process.env.BRAIN_KIT_LANG || REFERENCE_LANG, {
    warn: (message) => io.stderr.write(`${message}\n`),
  });
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
