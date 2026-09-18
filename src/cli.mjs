import { EXIT } from './exit-codes.mjs';
import { kitVersion } from './version.mjs';
import { createTranslator, REFERENCE_LANG } from './lang.mjs';
import { runHook } from './commands/hook.mjs';

// command name -> async (argv, io, t) => exit code
const COMMANDS = new Map([
  ['hook', runHook],
]);

export async function main(argv, io) {
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
  const handler = COMMANDS.get(command);
  if (!handler) {
    io.stderr.write(`${t('cli.unknown_command', { command })}\n`);
    io.stderr.write(`${t('cli.usage', { version: kitVersion() })}\n`);
    return EXIT.USAGE;
  }
  return handler(rest, io, t);
}
