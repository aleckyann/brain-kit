// The leak scanner: one implementation of "does this text carry a secret",
// used by the `secrets` lint rule and by the maintainer's push gate.
//
// This module exists because the shell version of the push gate
// (.githooks/pre-push) needed five rounds of fixes in one day, and every
// hole was the same shape: a status nobody read, or a set nobody
// enumerated. In Node, the equivalent mistakes raise instead of returning
// empty:
//   - a missing, empty, unreadable or directory patterns file throws,
//     rather than the scan silently running with fewer patterns than the
//     caller believes it has;
//   - a pattern that fails to compile throws naming its source, rather
//     than being skipped and leaving a hole nobody sees;
//   - a NUL byte is stripped and the text is still scanned, rather than
//     the whole blob being waved through as "binary".
//
// Two contracts are load-bearing everywhere in this file:
//   1. FAIL CLOSED. A caller that asks for personal patterns and cannot
//      read them gets an exception, never an empty list. A gate that
//      cannot read its list must stop a push, not wave it through.
//   2. NEVER PRINT WHAT IT FOUND. `scanText`'s excerpts never contain the
//      matched text, only surrounding context with the match replaced by a
//      fixed marker; and the personal patterns file's own CONTENT (the
//      names worth protecting) is never included in an error message
//      either, only the file's path and, for a bad line, its line number.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A fixed, non-secret string that stands in for whatever matched. Never
// derived from the input, so it can never itself leak a fragment of a
// secret.
const REDACTION_MARKER = '[REDACTED]';

// How many characters of context are kept on each side of a match. Forty
// total (twenty each side), per the module's contract: an excerpt is
// "at most forty characters of surrounding context".
const EXCERPT_CONTEXT_CHARS = 20;

// The default cap on how many matches `scanText` returns. Every ceiling in
// this project reports how much it cut, which is why the cap is echoed
// back as `truncated` and `total` on the returned array rather than being
// a silent slice.
const DEFAULT_MAX = 5;

// Versioned in this repository because these name no one: a private key
// header, the two GitHub token shapes, the Anthropic key shape, the AWS
// access key id shape, and the Slack token shapes. Always applied, on top
// of whatever a vault's own configuration or a user's personal file adds.
//
// Writing the ACTUAL header out as one contiguous literal token is exactly
// what this repository's own push gate exists to catch (and has, once
// already); this is safe because it is the REGEX that recognises that
// shape, not an instance of it, so the parentheses and alternation break
// up the literal sequence the gate's own copy of this same pattern looks
// for.
export const GENERIC_PATTERNS = Object.freeze([
  '-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----',
  'ghp_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'sk-ant-[A-Za-z0-9_-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
]);

// Compiles one pattern, case-insensitively, tagging it with where it came
// from. `describe` is what an error is allowed to print about the pattern
// itself: the raw source for a public pattern (generic or config), or
// `null` for a personal one, whose content must never be printed.
function compileOne(raw, origin, describe) {
  try {
    return { raw, origin, regex: new RegExp(raw, 'gi') };
  } catch (err) {
    const detail = describe === null ? '' : `: ${describe}`;
    throw new Error(`could not compile a leak pattern from ${origin}${detail}: ${err.message}`);
  }
}

// The personal patterns file's path: the override, when set (even to an
// empty string, which resolves to the default rather than to a path no one
// meant), or a path under the user's configuration directory. The list of
// names worth protecting is itself the data worth protecting, so this path
// never points inside a repository and its resolution never depends on
// anything this module would print elsewhere.
function personalPatternsPath(env) {
  const override = env.BRAIN_KIT_LEAK_PATTERNS;
  if (override) return override;
  return join(homedir(), '.config', 'brain-kit', 'leak-patterns.txt');
}

// Reads the personal patterns file and returns its usable lines: comments
// (lines starting with `#`, after trimming) and blank lines are dropped,
// because a personal patterns file is fed to this module's own compiler,
// not to a raw grep -f, and a blank line compiled as a pattern would match
// every line of every file it looks at.
//
// Every failure mode the file can be in is checked explicitly and raises
// naming the PATH, never the file's content: missing, a directory, present
// but unreadable, empty, or carrying nothing but comments and blanks. Any
// one of these means the gate cannot see its list, and a gate that cannot
// see its list must stop, not proceed as if the list were empty.
function readPersonalPatternLines(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`leak patterns file not found: ${path}`);
    }
    throw new Error(`leak patterns file could not be inspected: ${path} (${err.code ?? err.message})`);
  }
  // A directory is not a regular file, so `isDirectory` needs no branch of
  // its own: `isFile` already refuses it, along with every other kind of
  // non-regular entry (a socket, a FIFO, a device node) that is just as
  // unreadable as a list of patterns.
  if (!stat.isFile()) {
    throw new Error(`leak patterns file is not a regular file (it may be a directory): ${path}`);
  }
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`leak patterns file is not readable: ${path} (${err.code ?? err.message})`);
  }
  // A zero-byte file and a file that is only comments and blank lines both
  // resolve to the same empty list of usable patterns, so both are refused
  // by this one check rather than by two branches that would only ever
  // differ in wording, never in outcome.
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) {
    throw new Error(`leak patterns file has no usable pattern (it is empty, or carries only blanks and comments): ${path}`);
  }
  return lines;
}

// Compiles the personal patterns file into tagged, compiled patterns. A
// compile failure names the source and the LINE NUMBER, never the pattern
// text itself: a personal pattern can be a person's real name or a
// company's name shaped as a regex, and that is exactly the content this
// module promises never to print.
function loadPersonalPatterns(env) {
  const path = personalPatternsPath(env);
  const lines = readPersonalPatternLines(path);
  return lines.map((raw, index) => {
    try {
      return { raw, origin: 'personal', regex: new RegExp(raw, 'gi') };
    } catch {
      // The engine's own SyntaxError embeds the invalid regular expression
      // source in its message (e.g. "Invalid regular expression: /.../:
      // Unterminated character class"), which would print exactly the
      // content this module promises never to print. Only the line number
      // and the file's path are named; the pattern text itself is not.
      throw new Error(`could not compile the personal leak pattern on line ${index + 1} of ${path}: it is not a valid regular expression`);
    }
  });
}

// Builds the full, compiled pattern list this scanner will apply.
//
// `GENERIC_PATTERNS` are always included. `configPatterns` (a vault's own
// `privacy.secret_patterns`) are public by nature and included whenever
// given. Personal patterns are included ONLY when `env` is passed: that is
// the caller's explicit statement "I want the personal list too", and it
// is also the caller's explicit acceptance of this call's fail-closed
// contract for that list. A caller that wants configPatterns alone, with
// no personal file involved at all, simply omits `env`; a missing or
// broken personal file is then not consulted, and so is never an error,
// exactly as the module's contract for "asking for those alone" requires.
//
// Every pattern that fails to compile raises immediately, naming its
// source (and, for a public pattern, its text). A skipped pattern is a
// hole nobody sees, so nothing here is ever skipped.
export function loadPatterns({ env, configPatterns } = {}) {
  const compiled = [];
  for (const raw of GENERIC_PATTERNS) {
    compiled.push(compileOne(raw, 'generic', raw));
  }
  for (const raw of configPatterns ?? []) {
    compiled.push(compileOne(raw, 'config', raw));
  }
  if (env !== undefined) {
    compiled.push(...loadPersonalPatterns(env));
  }
  return compiled;
}

// Builds the excerpt for one match: at most twenty characters before it and
// twenty after, with the match itself replaced by the fixed marker. Never
// includes the matched text; the caller passes only the surrounding slices.
function buildExcerpt(lineText, start, end) {
  const before = lineText.slice(Math.max(0, start - EXCERPT_CONTEXT_CHARS), start);
  const after = lineText.slice(end, end + EXCERPT_CONTEXT_CHARS);
  return `${before}${REDACTION_MARKER}${after}`;
}

// Scans `text` against `patterns` (as returned by `loadPatterns`) and
// returns `[{ line, column, pattern, excerpt }]`, in reading order (top to
// bottom, left to right within a line), capped at `max` entries.
//
// The cap is reported, not silent: the returned array carries `truncated`
// (whether the total exceeded `max`) and `total` (how many matches there
// actually were), as own properties on the array itself. Every ceiling in
// this project says how much it cut.
//
// NUL bytes are stripped before scanning, and the result is still scanned
// as text: the shell version of this scanner treated any blob containing a
// NUL as binary and skipped it outright, which was one of its five holes.
// Line splitting happens on `\n` alone; a file with no trailing newline
// still yields its last line as a scannable line, since `String.split`
// never drops a trailing non-terminated segment.
export function scanText(text, patterns, { max = DEFAULT_MAX } = {}) {
  const cleaned = text.replace(/\0/g, '');
  const lines = cleaned.split('\n');
  const all = [];
  lines.forEach((lineText, index) => {
    const lineNumber = index + 1;
    const lineMatches = [];
    for (const { raw, regex } of patterns) {
      regex.lastIndex = 0;
      let match = regex.exec(lineText);
      while (match !== null) {
        const start = match.index;
        const end = start + match[0].length;
        lineMatches.push({ line: lineNumber, column: start + 1, pattern: raw, start, end });
        if (match[0].length === 0) {
          // A zero-length match (an all-optional pattern) would otherwise
          // pin `lastIndex` in place and loop forever.
          regex.lastIndex += 1;
        }
        match = regex.exec(lineText);
      }
    }
    lineMatches.sort((a, b) => a.column - b.column);
    for (const found of lineMatches) {
      all.push({
        line: found.line,
        column: found.column,
        pattern: found.pattern,
        excerpt: buildExcerpt(lineText, found.start, found.end),
      });
    }
  });
  const total = all.length;
  const result = all.slice(0, max);
  result.truncated = total > max;
  result.total = total;
  return result;
}
