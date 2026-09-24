import { EXIT } from '../exit-codes.mjs';
import { readStdin } from '../io.mjs';
import { runSessionStart } from '../hooks/session-start.mjs';

export const HOOK_EVENTS = Object.freeze(['stop', 'session-start']);

// `brain-kit hook <event>`, called by Claude Code through hooks/hooks.json
// with the event JSON on standard input. A hook ALWAYS exits 0: its verdict
// travels in the JSON it prints, never in its exit code. Only a call naming
// no known event, which Claude Code never makes, is a usage error.
//
// The Stop hook is still a deliberate no-op here: consume the event JSON,
// print nothing, exit 0.
export async function runHook(argv, io, t, { env = process.env, now = () => new Date() } = {}) {
  const [event] = argv;
  if (!HOOK_EVENTS.includes(event)) {
    io.stderr.write(t('hook.unknown_event', { event: String(event), events: HOOK_EVENTS.join(', ') }) + '\n');
    return EXIT.USAGE;
  }
  const input = await readStdin(io.stdin);
  if (event === 'session-start') {
    const { stdout, stderr } = runSessionStart(input, env, now());
    if (stdout !== '') io.stdout.write(stdout);
    if (stderr !== '') io.stderr.write(stderr);
  }
  return EXIT.OK;
}
