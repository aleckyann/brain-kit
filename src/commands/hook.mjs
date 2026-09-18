import { EXIT } from '../exit-codes.mjs';
import { readStdin } from '../io.mjs';

export const HOOK_EVENTS = Object.freeze(['stop', 'session-start']);

// Phase 0: the plugin ships the hook wiring before the vault logic exists.
// Until Phase 1 lands the vault sentinel and the dirty-tree check, every event
// is a deliberate no-op: consume the event JSON, print nothing, exit 0. A hook
// that printed anything here would block or pollute every Claude Code session
// that has the plugin enabled.
export async function runHook(argv, io, t) {
  const [event] = argv;
  if (!HOOK_EVENTS.includes(event)) {
    io.stderr.write(t('hook.unknown_event', { event: String(event), events: HOOK_EVENTS.join(', ') }) + '\n');
    return EXIT.USAGE;
  }
  await readStdin(io.stdin);
  return EXIT.OK;
}
