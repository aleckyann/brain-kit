// Run by test/leak.test.mjs in a CHILD PROCESS, never in-process.
//
// The two catastrophic-pattern tests exist to prove a stuck regex
// evaluation gets interrupted. node:test's own `timeout` option cannot do
// that job for them: the test runner detects an overrun from its own event
// loop, and a truly stuck, synchronous call (which is exactly what a
// regression here would look like) never yields control back to that event
// loop at all, so the runner's timeout mechanism never gets a turn to fire.
// A regression that removed this module's internal protection would hang
// the whole `node --test` process forever, not fail one test.
//
// A child process is the one thing that CAN be killed from outside itself
// regardless of what it is doing: the parent process's own `spawnSync`
// `timeout` option is enforced by the operating system, not by this
// script's event loop, so the parent test always regains control within
// its own bounded wait, whether this script's call to `scanText` throws
// normally (the correct, current behaviour) or hangs forever (what a
// regression would look like).
import { loadPatterns, scanText } from '../../../src/leak.mjs';

const scenario = process.argv[2];
const evilLine = `${'a'.repeat(40)}!`; // never matches "$", forces exponential backtracking

function buildPatterns() {
  if (scenario === 'personal') {
    const patternsFile = process.argv[3];
    return loadPatterns({ env: { BRAIN_KIT_LEAK_PATTERNS: patternsFile } });
  }
  const catastrophicShape = ['(', 'a+', ')+$'].join('');
  return loadPatterns({ configPatterns: [catastrophicShape] });
}

const patterns = buildPatterns();
try {
  scanText(evilLine, patterns);
  // Reaching here means the catastrophic pattern was somehow evaluated
  // without throwing at all, which is itself a bug worth surfacing
  // distinctly from "it hung".
  process.stdout.write('NO_THROW\n');
  process.exit(2);
} catch (err) {
  process.stdout.write(`THREW:${err.message}\n`);
  process.exit(0);
}
