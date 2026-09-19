// `brain-kit scan-blobs`: the Node half of the maintainer push gate
// (.githooks/pre-push). Bash keeps the one job it is still good at, asking
// git what a push contains (which commits, which paths, in what order);
// this command does everything else, because the shell version of that
// "everything else" needed five rounds of fixes in one day, and every
// hole was the same shape: a status nobody read, or a set nobody
// enumerated (see .githooks/pre-push's own history comment for the five).
//
// Reads a stream of NUL-separated (commit, path) pairs from standard
// input (see parseEntries below for the exact framing), reads each named
// blob's content itself via `git show <commit>:<path>`, and scans it with
// src/leak.mjs. Exits non-zero the moment anything found across the whole
// push looks like a secret, or the moment anything could not be read or
// scanned at all: a blob nobody could examine is not a blob that passed.
//
// FAIL CLOSED, inherited unchanged from leak.mjs. `loadPatterns` is called
// with `env: process.env`, so a personal patterns file
// (BRAIN_KIT_LEAK_PATTERNS, or the default under ~/.config/brain-kit) that
// is missing, empty, a directory, or carries an invalid pattern makes
// loadPatterns throw, and that exception is never caught here: a gate that
// cannot read its own list must stop the push, not scan with fewer
// patterns than it was told to use. This is checked ONCE, before a single
// byte of standard input is even read, so a broken patterns file refuses
// every push regardless of what that push touches, exactly like the shell
// version's own unconditional check used to.
//
// NEVER PRINT WHAT IT FOUND, also inherited unchanged. Every message below
// prints a match's `pattern` field (leak.mjs's own neutral label for a
// personal pattern, never its text) and its `excerpt` (leak.mjs's own
// redacted context, which never contains the matched text itself, personal
// or not). Nothing in this file re-derives or re-prints raw blob content
// next to a finding, unlike the shell version this replaces, which printed
// the raw matched line (up to 200 bytes of it, secret included) to stderr.
import { spawnSync } from 'node:child_process';
import { EXIT } from '../exit-codes.mjs';
import { readStdin } from '../io.mjs';
import { loadPatterns, scanText, OVERALL_SCAN_TIMEOUT_MS } from '../leak.mjs';

// The print cap per blob, same value the shell version's own MAX_HITS used:
// generous for anything a real leak looks like, and never the thing that
// decides whether a push is refused (one match already refuses; this only
// bounds how much gets printed about it). leak.mjs's own returned record
// carries `truncated` and `total` precisely so a caller can say "and N
// more" instead of silently dropping them, which is exactly what this
// module does below rather than destructuring only `matches` out of the
// return (see leak.mjs's own header on that exact mistake).
const MAX_MATCHES_PER_BLOB = 5;

// A generous ceiling on one blob's content. Node's own default
// (spawnSync's implicit maxBuffer, 1 MB) is small enough that an ordinary
// large asset (an exported log, a big generated document) would overflow
// it and read back as a captured-error failure rather than real content;
// raising it here still fails closed the same way on anything that
// genuinely exceeds it; nothing above this is ever silently truncated and
// called clean.
const GIT_SHOW_MAX_BUFFER = 256 * 1024 * 1024;

// Splits the NUL-separated stream this command's stdin is built from
// (see .githooks/pre-push, which writes it) into { commit, path } pairs.
// Every record is exactly two NUL-terminated fields, commit then path, so
// the producer's own trailing NUL after the very last record is the only
// thing that can leave an empty string at the end of the split; anything
// else wrong with the field count is a malformed producer, not an empty
// path to shrug off, so it raises rather than guessing a pairing.
export function parseEntries(raw) {
  if (raw.length === 0) return [];
  const fields = raw.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  if (fields.length === 0 || fields.length % 2 !== 0) {
    throw new Error(`scan-blobs received a malformed input (${fields.length} NUL-separated field(s), which is not a whole number of (commit, path) pairs); refusing to guess how to pair them`);
  }
  const entries = [];
  for (let i = 0; i < fields.length; i += 2) {
    entries.push({ commit: fields[i], path: fields[i + 1] });
  }
  return entries;
}

// Reads one blob's content the same way the shell version's own `git show
// "$sha:$path"` did, as raw bytes: 'latin1' decodes every byte 0-255 to
// the code point of the same value, never throwing on a byte sequence
// that is not valid UTF-8 (exactly the bytes an arbitrary binary blob is
// full of) and never collapsing several bytes into one code point the way
// UTF-8 decoding would, so a pattern written against byte offsets keeps
// matching the same content it always did. This is also what makes the
// shell version's own `LC_ALL=C` no longer necessary: a byte-for-byte
// mapping has no locale to depend on in the first place.
function readBlob(cwd, commit, path) {
  const ref = `${commit}:${path}`;
  const result = spawnSync('git', ['show', ref], { cwd, encoding: 'latin1', maxBuffer: GIT_SHOW_MAX_BUFFER });
  if (result.error) {
    // git itself could not even be started (e.g. not found on PATH). The
    // hook already checks for this before ever calling this command, so
    // reaching it here is not expected, but it must still refuse rather
    // than silently treat the blob as clean.
    return { ok: false, status: null, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, status: result.status, detail: null };
  }
  return { ok: true, content: result.stdout ?? '' };
}

export async function runScanBlobs(argv, io) {
  // Checked before a single byte of stdin is read, and before a single
  // `git show` runs: see this module's own header on why the fail-closed
  // check must not be scoped to "only once something was found to scan".
  let patterns;
  try {
    patterns = loadPatterns({ env: process.env });
  } catch (error) {
    io.stderr.write(`pre-push: ${error.message}; refusing to push.\n`);
    return EXIT.FAILURE;
  }

  const raw = await readStdin(io.stdin);
  let entries;
  try {
    entries = parseEntries(raw);
  } catch (error) {
    io.stderr.write(`pre-push: ${error.message}; refusing to push.\n`);
    return EXIT.FAILURE;
  }

  const cwd = process.cwd();
  let failed = false;

  for (const { commit, path } of entries) {
    const shortSha = commit.slice(0, 7);
    const blob = readBlob(cwd, commit, path);
    if (!blob.ok) {
      failed = true;
      const reason = blob.status === null
        ? `git show could not be run (${blob.detail})`
        : `git show exited ${blob.status}`;
      io.stderr.write(`pre-push: could not read ${path} (at ${shortSha}): ${reason}; refusing instead of calling it clean.\n`);
      continue;
    }

    let result;
    try {
      // A FRESH deadline per blob, deliberately not one deadline shared
      // across the whole push. OVERALL_SCAN_TIMEOUT_MS (leak.mjs's own
      // export) was measured against ONE scanText call, roughly 13 seconds
      // for 100,000 lines of ordinary prose with real margin added on top;
      // that measurement says nothing about a SECOND, unrelated blob still
      // having budget left. The `secrets` lint rule threads one such
      // deadline across an entire vault's worth of files on purpose,
      // because a lint run genuinely is one bounded unit of work the vault
      // owner asked for once; a push is not that. A push can carry
      // anywhere from one blob to several hundred (a large rename, a
      // vendored update, a first import of an existing vault), and a
      // shared budget would let an ordinary push with many normal-sized
      // files exhaust it partway through and abort with no verdict at all,
      // refusing a perfectly clean push for having too much perfectly
      // ordinary content, not for anything it found. Each blob getting the
      // full, generously-measured budget keeps the guarantee this module
      // actually needs (no single blob's scan runs unbounded) without
      // inventing a new, unmeasured number for "a whole push's worth of
      // scanning", which is exactly the mistake OVERALL_SCAN_TIMEOUT_MS's
      // own header warns a caller away from making up.
      result = scanText(blob.content, patterns, { max: MAX_MATCHES_PER_BLOB, deadlineAt: Date.now() + OVERALL_SCAN_TIMEOUT_MS });
    } catch (error) {
      failed = true;
      io.stderr.write(`pre-push: could not scan ${path} (at ${shortSha}): ${error.message}; refusing instead of calling it clean.\n`);
      continue;
    }

    const { matches, truncated, total } = result;
    if (matches.length > 0) {
      failed = true;
      io.stderr.write(`pre-push: possible leak in ${path} (at ${shortSha}):\n`);
      for (const match of matches) {
        io.stderr.write(`    line ${match.line}, column ${match.column} (${match.pattern}): ${match.excerpt}\n`);
      }
      if (truncated) {
        io.stderr.write(`    ...and ${total - matches.length} more match(es) in this blob not shown.\n`);
      }
    }
  }

  return failed ? EXIT.FAILURE : EXIT.OK;
}
