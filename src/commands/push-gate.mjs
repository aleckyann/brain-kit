// `brain-kit push-gate <remote-name> <remote-url> --patterns personal`:
// the whole push gate behind one command. It runs the push enumeration
// (src/push/records.sh) on the pre-push reference lines it reads from
// standard input, reads the enumeration's STATUS, and only when that says
// the stream is the whole push does it scan the stream with the scan-blobs
// engine (src/commands/scan-blobs.mjs), under the pattern list named by
// --patterns. Exit 0 when every channel was read and nothing matched, 1
// when anything matched or could not be read, 2 for a usage mistake or a
// directory that is not a repository.
//
// WHY ONE COMMAND. The enumeration is the most reviewed code in this
// repository, and the gate brain-kit ships to other people needs exactly
// the knowledge it holds. Written twice, one copy is the one somebody
// forgets. So there is one copy, and both gates reach it through here: the
// maintainer's hook (.githooks/pre-push) with `--patterns personal`, and
// the shipped gate with the list its own configuration names.
//
// WHERE THE ENUMERATION IS READ FROM. The copy beside this module, resolved
// from this module's own location and from nothing else: not the current
// directory, not the repository being pushed, not an environment variable.
// The enumeration decides what is scanned at all, so whoever can write the
// copy that runs decides what passes, and the only copy this can reach is
// the one installed with the engine that is running. For the maintainer's
// gate that is the snapshot under the git directory (.githooks/install-gate),
// which no commit and no checkout can reach.
//
// THE STATUS BEFORE THE STREAM. A stream from an enumeration that failed is
// a prefix of the push, and a prefix is exactly the shape that parses
// perfectly and scans clean. So a failure to run it, a non-zero status and
// a stop by signal all refuse before one byte of its output is parsed, and
// the enumeration itself writes no stream when it fails, so the two halves
// each hold the rule without trusting the other to.
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../exit-codes.mjs';
import { readStdin } from '../io.mjs';
import { preparePersonalScan, scanRecordStream } from './scan-blobs.mjs';

// The pattern lists this command knows how to load. `personal` is the
// maintainer's own list outside any repository (src/leak.mjs,
// loadPatterns). There is no default: a default is a list nobody chose.
export const PATTERN_SOURCES = Object.freeze(['personal']);

// Resolved against this module, never against the current directory: see
// the header on where the enumeration is read from.
export const RECORDS_SCRIPT = fileURLToPath(new URL('../push/records.sh', import.meta.url));

// The most record stream one push may hand over. It is held in memory whole
// either way (the scan-blobs engine always read its whole stream before
// parsing it), so this is a bound that refuses out loud where memory would
// fail less clearly; spawnSync stops a child that passes it and reports
// ENOBUFS, which refuses below. A blob record is its kind, a commit id, a
// mode and a path, so the bound is hundreds of thousands of files.
export const RECORD_STREAM_MAX_BYTES = 256 * 1024 * 1024;

// Returns { ok: true, remoteName, remoteUrl, patterns } or
// { ok: false, render } naming the first mistake, where render(t) is the
// translated sentence (a literal key at every call, so test/message-keys
// can check each one against both packs).
export function parsePushGateArgs(argv) {
  const positional = [];
  let patterns;
  let patternsSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--patterns') {
      if (patternsSeen) return { ok: false, render: (t) => t('push_gate.bad_argument', { arg }) };
      patternsSeen = true;
      patterns = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--') || positional.length === 2) {
      return { ok: false, render: (t) => t('push_gate.bad_argument', { arg }) };
    }
    positional.push(arg);
  }
  if (positional.length !== 2 || positional[0] === '') {
    return { ok: false, render: (t) => t('push_gate.missing_remote') };
  }
  if (patterns === undefined || patterns === '') {
    return { ok: false, render: (t) => t('push_gate.missing_patterns', { expected: PATTERN_SOURCES.join(', ') }) };
  }
  if (!PATTERN_SOURCES.includes(patterns)) {
    return { ok: false, render: (t) => t('push_gate.unknown_patterns', { value: patterns, expected: PATTERN_SOURCES.join(', ') }) };
  }
  return { ok: true, remoteName: positional[0], remoteUrl: positional[1], patterns };
}

// The options exist for tests, which drive this in a process of their own
// to reach a signal and an overflow without producing either for real. The
// command line never passes them (src/cli.mjs calls this with three
// arguments), so no argument, environment variable or file a push can
// write selects the enumeration; a JavaScript caller that imports this
// module can already run anything it likes and gains nothing here.
export async function runPushGate(argv, io, t, { recordsScript = RECORDS_SCRIPT, maxStreamBytes = RECORD_STREAM_MAX_BYTES } = {}) {
  const args = parsePushGateArgs(argv);
  if (!args.ok) {
    io.stderr.write(`${args.render(t)}\n`);
    io.stderr.write(`${t('push_gate.usage')}\n`);
    return EXIT.USAGE;
  }

  // Asked before anything else runs, because the enumeration's own answer
  // outside a repository is a list of git errors that reads like a broken
  // push rather than like the wrong directory.
  const repository = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' });
  if (repository.error) {
    io.stderr.write(`${t('push_gate.git_unrunnable', { reason: repository.error.message })}\n`);
    return EXIT.FAILURE;
  }
  if (repository.status !== 0) {
    io.stderr.write(`${t('push_gate.not_a_repository')}\n`);
    return EXIT.USAGE;
  }

  // Bytes, not text: the reference lines carry names git allows to be any
  // bytes, and the enumeration must see the ones git wrote.
  const input = Buffer.from(await readStdin(io.stdin, { encoding: 'latin1' }), 'latin1');
  const records = spawnSync('bash', [recordsScript, args.remoteName, args.remoteUrl], {
    input,
    maxBuffer: maxStreamBytes,
  });
  // Its messages first, in the order it wrote them, before anything this
  // command says about them.
  if (records.stderr && records.stderr.length > 0) io.stderr.write(records.stderr);
  if (records.error) {
    if (records.error.code === 'ENOBUFS') {
      io.stderr.write(`${t('push_gate.stream_too_large', { limit: maxStreamBytes })}\n`);
    } else {
      io.stderr.write(`${t('push_gate.enumeration_unrunnable', { reason: records.error.message })}\n`);
    }
    return EXIT.FAILURE;
  }
  if (records.status !== 0) {
    if (records.status === null) {
      io.stderr.write(`${t('push_gate.enumeration_killed', { signal: String(records.signal) })}\n`);
    } else {
      io.stderr.write(`${t('push_gate.enumeration_failed', { status: records.status })}\n`);
    }
    return EXIT.FAILURE;
  }

  // Loaded AFTER the enumeration, which is the order the maintainer's gate
  // always had (the hook enumerated, then scan-blobs checked the patterns
  // file), and still for every push that got this far, one with nothing in
  // it included: the fail-closed check is never scoped to "only once
  // something was found to scan".
  const prepared = preparePersonalScan(io, process.env);
  if (prepared === null) return EXIT.FAILURE;
  return scanRecordStream(records.stdout.toString('latin1'), { ...prepared, io });
}
