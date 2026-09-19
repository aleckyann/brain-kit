// The leak scanner: one implementation of "does this text carry a secret",
// used by the `secrets` lint rule and by the maintainer's push gate.
//
// This module exists because the shell version of the push gate
// (.githooks/pre-push) needed five rounds of fixes in one day, and every
// hole was the same shape: a status nobody read, or a set nobody
// enumerated. A first Node round fixed the holes that shape describes.
// A first review found a second shape, twice, in the one guarantee that
// matters most: a never-print promise that held on the typical shape (one
// generic pattern, one secret per line) and broke on the adversarial one
// (a personal pattern's own text riding out on every match; a second
// secret surviving next to the one a finding was actually about). Both are
// fixed here by reading `origin` before ever printing anything derived from
// a match, and by redacting every match an excerpt's window touches, not
// only the one the finding names.
//
// Two contracts are load-bearing everywhere in this file:
//   1. FAIL CLOSED. A caller that asks for personal patterns and cannot
//      read them gets an exception, never an empty list. A gate that
//      cannot read its list must stop a push, not wave it through. A scan
//      that cannot finish (a pattern that never returns) gets an
//      exception too, for the same reason: a gate that hangs is a gate
//      somebody bypasses, which is worse than a gate that refuses loudly.
//   2. NEVER PRINT WHAT IT FOUND. No finding, no error message and no
//      excerpt ever carries a personal pattern's own text or the text a
//      personal pattern matched; a personal pattern is represented by a
//      fixed, neutral label everywhere a public pattern would show its
//      source, and an excerpt masks every match it touches, not only the
//      one it is reporting.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

// A fixed, non-secret string that stands in for whatever matched. Never
// derived from the input, so it can never itself leak a fragment of a
// secret.
const REDACTION_MARKER = '[REDACTED]';

// What a personal pattern's own text is replaced by, everywhere this
// module would otherwise print a pattern's source: a finding's `pattern`
// field, and a compile or timeout error's description of which pattern was
// involved. A personal pattern can be a person's real name or a company's
// name shaped as a regular expression, and that text is exactly what this
// module exists to keep out of a terminal, a log file and a CI record.
const PERSONAL_PATTERN_LABEL = 'a personal pattern';

// How many characters of context are kept on each side of a match. Forty
// total (twenty each side), per the module's contract: an excerpt is
// "at most forty characters of surrounding context".
const EXCERPT_CONTEXT_CHARS = 20;

// The default cap on how many matches `scanText` returns. Every ceiling in
// this project reports how much it cut, which is why the cap is echoed
// back as `truncated` and `total` on the returned record rather than being
// a silent slice.
const DEFAULT_MAX = 5;

// The wall-clock budget given to scanning ONE line against ONE pattern
// (finding every match, not just the first). Generous for anything a real
// pattern does against real content: a non-pathological regular expression
// is linear or low-polynomial in the length of one line, so even a very
// long line finishes in a small fraction of this budget. It exists for the
// adversarial case: a catastrophically backtracking pattern, or a pattern
// that matches so often (an empty-ish pattern like `a*` against a long run
// of `a`) that merely counting its matches would otherwise run
// unboundedly. Both are bounded by the SAME timeout, because both are the
// same failure from this module's point of view: work that does not
// finish. Verified empirically against a classic `(a+)+$` payload before
// being relied on here (see the fix-round report).
const SCAN_TIMEOUT_MS = 2000;

// Versioned in this repository because these name no one: a private key
// header, the two GitHub token shapes, the Anthropic key shape, the AWS
// access key id shape, and the Slack token shapes. Always applied, on top
// of whatever a vault's own configuration or a user's personal file adds.
//
// This is the ONE copy: the anti-leak test (test/no-leak.test.mjs) and the
// push gate (.githooks/pre-push) both read these shapes from here rather
// than carrying their own copy, because three uncoordinated copies of the
// same six shapes is exactly the duplication this codebase has already had
// to fix, in another module, four times over.
//
// Writing the ACTUAL private key header out as one contiguous literal
// token is exactly what this repository's own push gate exists to catch
// (and has, once already); this is safe because it is the REGEX that
// recognises that shape, not an instance of it, so the parentheses and
// alternation break up the literal sequence the gate's own copy of this
// same pattern looks for.
export const GENERIC_PATTERNS = Object.freeze([
  '-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----',
  'ghp_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'sk-ant-[A-Za-z0-9_-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
]);

// The text a finding, or an error message, is allowed to show for a
// compiled pattern: its own source for a public pattern (generic or
// config), or the fixed neutral label for a personal one. This is the
// ONLY place in the module that makes that decision, so there is exactly
// one thing to audit for "does this ever print a personal pattern's text",
// and exactly one thing a future change to this rule has to touch.
function displayPattern(entry) {
  return entry.origin === 'personal' ? PERSONAL_PATTERN_LABEL : entry.raw;
}

// Compiles one pattern, case-insensitively, tagging it with where it came
// from. An empty pattern is refused outright: as a regular expression it
// matches the empty string at every position, which is indistinguishable
// from "flag everywhere", and a vault's own configuration schema allows an
// empty string as a `secret_patterns` entry with no complaint, so this has
// to be caught here rather than assumed away upstream.
//
// A compile failure is reported differently by origin, and that
// difference is the whole reason `origin` exists as a field rather than a
// second copy of the pattern text passed alongside it: a public pattern's
// own source is safe to print and is printed, along with the origin and,
// for a personal pattern, the ORIGINAL FILE LINE NUMBER it came from
// (`personalContext.lineNumber`, counted over every line of the file, not
// over the lines left after comments and blanks are filtered out, which
// would number a pattern on line 5 as if it were on line 2). A personal
// pattern's own text is never printed, in either the engine's own
// SyntaxError message (which embeds the invalid source, e.g. "Invalid
// regular expression: /.../: Unterminated character class") or this
// module's own message.
function compilePattern(raw, origin, personalContext) {
  if (raw.length === 0) {
    throw new Error(`leak pattern from ${origin} cannot be empty (an empty pattern matches everywhere)`);
  }
  let regex;
  try {
    regex = new RegExp(raw, 'gi');
  } catch {
    if (origin === 'personal') {
      throw new Error(`could not compile the personal leak pattern on line ${personalContext.lineNumber} of ${personalContext.path}: it is not a valid regular expression`);
    }
    throw new Error(`could not compile a leak pattern from ${origin}: ${raw}`);
  }
  return { raw, origin, regex };
}

// The personal patterns file's path: the override, when set (even to an
// empty string, which resolves to the default rather than to a path no one
// meant), or a path under the user's configuration directory. Reads the
// override with optional chaining rather than `env.BRAIN_KIT_LEAK_PATTERNS`
// directly, so `env: null` resolves to the default path instead of
// throwing a TypeError: `loadPatterns` treats the PRESENCE of the `env` key
// (not its truthiness) as "yes, load personal patterns too", precisely so
// that a null or otherwise falsy environment is never mistaken for "skip
// the personal list", which would be failing OPEN, the shell version's
// signature failure. `env: null` therefore still attempts the real default
// path and still fails closed if that path has a problem, exactly like
// `env: {}` would.
function personalPatternsPath(env) {
  const override = env?.BRAIN_KIT_LEAK_PATTERNS;
  if (override) return override;
  return join(homedir(), '.config', 'brain-kit', 'leak-patterns.txt');
}

// Reads the personal patterns file and returns its usable lines, each
// tagged with its ORIGINAL 1-based line number in the file: comments
// (lines starting with `#`, after trimming) and blank lines are dropped,
// because a personal patterns file is fed to this module's own compiler,
// not to a raw grep -f, and a blank line compiled as a pattern would match
// every line of every file it looks at. The line number travels with each
// surviving line specifically so a later compile failure can name where in
// the FILE it is, not where in the filtered list it landed.
//
// Every failure mode the file can be in is checked explicitly and raises
// naming the PATH, never the file's content: missing, a directory (and
// every other kind of non-regular entry `isFile` also refuses: a socket, a
// FIFO, a device node), present but unreadable, or carrying nothing usable
// (a zero-byte file and a file that is only comments and blanks both
// resolve to the same empty list, so one check covers both rather than two
// branches that would only ever differ in wording). Any one of these means
// the gate cannot see its list, and a gate that cannot see its list must
// stop, not proceed as if the list were empty.
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
  if (!stat.isFile()) {
    throw new Error(`leak patterns file is not a regular file (it may be a directory): ${path}`);
  }
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`leak patterns file is not readable: ${path} (${err.code ?? err.message})`);
  }
  const usable = [];
  content.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      usable.push({ raw: trimmed, lineNumber: index + 1 });
    }
  });
  if (usable.length === 0) {
    throw new Error(`leak patterns file has no usable pattern (it is empty, or carries only blanks and comments): ${path}`);
  }
  return usable;
}

// Compiles the personal patterns file into tagged, compiled patterns.
function loadPersonalPatterns(env) {
  const path = personalPatternsPath(env);
  const usable = readPersonalPatternLines(path);
  return usable.map(({ raw, lineNumber }) => compilePattern(raw, 'personal', { path, lineNumber }));
}

// Builds the full, compiled pattern list this scanner will apply.
//
// `GENERIC_PATTERNS` are always included. `configPatterns` (a vault's own
// `privacy.secret_patterns`) are public by nature and included whenever
// given. Personal patterns are included when the `env` KEY IS PRESENT on
// the options object at all, whatever its value: that presence is the
// caller's explicit statement "I want the personal list too", and also the
// caller's explicit acceptance of this call's fail-closed contract for
// that list. A caller that wants configPatterns alone, with no personal
// file involved at all, simply omits `env`; a missing or broken personal
// file is then not consulted, and so is never an error, exactly as the
// module's contract for "asking for those alone" requires. Testing
// PRESENCE (`env !== undefined`) rather than TRUTHINESS matters even for a
// deliberately falsy `env`, such as `null`: truthiness would read a null
// environment as "skip the personal list", which is failing OPEN exactly
// the way the shell version's own five holes did.
//
// Every pattern that fails to compile raises immediately, naming its
// source (and, for a public pattern, its text). A skipped pattern is a
// hole nobody sees, so nothing here is ever skipped.
export function loadPatterns({ env, configPatterns } = {}) {
  const compiled = [];
  for (const raw of GENERIC_PATTERNS) {
    compiled.push(compilePattern(raw, 'generic'));
  }
  for (const raw of configPatterns ?? []) {
    compiled.push(compilePattern(raw, 'config'));
  }
  if (env !== undefined) {
    compiled.push(...loadPersonalPatterns(env));
  }
  return compiled;
}

// A single, reused sandbox for every time-bounded scan this module runs.
// Created once rather than per call: `vm.createContext` has real overhead,
// and every call here only needs to set a few bindings and re-run the same
// source, not stand up a new global object each time.
const scanSandbox = vm.createContext(Object.create(null));

// The script executed inside `scanSandbox`. It is plain top-level code,
// not a function body: a vm script's completion value is the value of its
// last evaluated expression statement, which a `function` body does not
// give you without an explicit `return`, so this stays a flat script on
// purpose. It finds EVERY match of `regex` in `text`, retaining full
// `[index, length]` pairs for at most `keep` of them (so retention cannot
// allocate more than `keep` objects no matter how many matches exist) while
// still counting every match found (so `count` is exact even when far more
// matches exist than `keep`), all inside the ONE timeout this function is
// run under. That single timeout is what turns two different-looking
// dangers into one bounded failure: a pattern whose backtracking never
// returns dies on its first `exec` call, and a pattern that returns
// constantly (an `a*`-shaped pattern against a very long run of `a`) dies
// once the accumulated cost of all those cheap calls crosses the same
// budget, well before either one could allocate its way to an outage or
// hang the process.
const SCAN_LINE_SRC = `
var kept = [];
var count = 0;
regex.lastIndex = 0;
var m = regex.exec(text);
while (m !== null) {
  count += 1;
  if (kept.length < keep) { kept.push([m.index, m[0].length]); }
  if (m[0].length === 0) {
    // A zero-length match (an all-optional pattern) would otherwise pin
    // lastIndex in place and loop forever without ever reaching the count
    // that would let the caller's ceiling apply.
    regex.lastIndex += 1;
  }
  m = regex.exec(text);
}
({ kept: kept, count: count });
`;

// Runs `SCAN_LINE_SRC` for one (line, pattern) pair. `regex` is passed BY
// REFERENCE into the sandbox (a vm context does not clone the bindings it
// is given), so its `lastIndex` mutations, including the automatic reset
// to zero the specification performs on a failed match, are visible to
// this module exactly as a direct `regex.exec(text)` call would leave
// them; nothing here has to reset it again afterwards. `describe` is
// already the origin-appropriate text (see `displayPattern`): never the
// raw source of a personal pattern.
function scanLineForPattern(regex, text, keep, describe) {
  scanSandbox.regex = regex;
  scanSandbox.text = text;
  scanSandbox.keep = keep;
  try {
    return vm.runInContext(SCAN_LINE_SRC, scanSandbox, { timeout: SCAN_TIMEOUT_MS });
  } catch {
    // The engine's own timeout error carries no information this module
    // needs to relay (it never names the pattern, only "script execution
    // timed out"), so it is replaced rather than wrapped: the message here
    // is what actually helps whoever reads it decide what to do next.
    throw new Error(`a leak pattern took longer than ${SCAN_TIMEOUT_MS}ms to scan one line and was aborted rather than left to hang: ${describe}`);
  }
}

// The floor on how many matches, per (line, pattern), this module is
// willing to collect FULL SPANS for while building the redaction map for a
// line (see `scanText`). Generous for real content: no ordinary vault note
// or code diff line carries anywhere near this many distinct matches of
// one pattern. It exists so a line can be checked for "does anything else
// nearby need masking" without ever having to hold more than a small,
// fixed number of spans in memory, regardless of how a pathological
// pattern behaves on that line.
const REDACTION_SPAN_FLOOR = 200;

// Builds the excerpt for one finding: the (at most twenty characters each
// side) window of context around its match, with EVERY match that window
// overlaps replaced by the fixed marker, not only the match the finding is
// about. `redactionSpans` are FULL-LINE `[start, end)` pairs, not
// window-local ones, precisely so a neighbouring match that only PARTIALLY
// overlaps the window (its own span starts before the window, or ends
// after it) still gets masked wherever it overlaps: rescanning just the
// window's own text cannot find such a neighbour, because a pattern that
// requires its whole shape to match will not recognise a fragment of
// itself, and a match cut off at a window boundary is exactly a fragment.
// `tooDenseToRedactPrecisely` means the line carried more matches of some
// pattern than this module is willing to enumerate individually; in that
// case the whole window is masked rather than risk a fragment surviving in
// an excerpt this module could not actually verify.
function buildExcerpt(lineText, start, end, redactionSpans, tooDenseToRedactPrecisely) {
  // `windowStart` MUST be clamped to zero explicitly: `String.prototype.slice`
  // treats a NEGATIVE index as counting back from the end of the string
  // (length + index), not as "clamp to the start", so an unclamped
  // `start - EXCERPT_CONTEXT_CHARS` near the beginning of a line would wrap
  // around and read from the wrong end of it entirely. `windowEnd` needs no
  // matching clamp: `slice` already clamps an END index that overshoots the
  // string's length down to that length, and `end` (a real match's end
  // position on THIS line) can never itself exceed `lineText.length`, so
  // there is no equivalent wraparound to guard against on this side.
  const windowStart = Math.max(0, start - EXCERPT_CONTEXT_CHARS);
  const windowEnd = end + EXCERPT_CONTEXT_CHARS;
  const windowText = lineText.slice(windowStart, windowEnd);
  if (tooDenseToRedactPrecisely) {
    return REDACTION_MARKER;
  }
  const clipped = [];
  for (const [spanStart, spanEnd] of redactionSpans) {
    const clippedStart = Math.max(spanStart, windowStart);
    const clippedEnd = Math.min(spanEnd, windowEnd);
    if (clippedStart < clippedEnd) {
      clipped.push([clippedStart - windowStart, clippedEnd - windowStart]);
    }
  }
  if (clipped.length === 0) {
    // Only the reported match itself had zero length (an all-optional
    // pattern matching an empty string) and nothing else overlaps the
    // window. There is nothing to mask; the window stands as its own
    // excerpt.
    return windowText;
  }
  clipped.sort((a, b) => a[0] - b[0]);
  const merged = [clipped[0]];
  for (const span of clipped.slice(1)) {
    const last = merged[merged.length - 1];
    if (span[0] <= last[1]) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push(span);
    }
  }
  let excerpt = '';
  let cursor = 0;
  for (const [spanStart, spanEnd] of merged) {
    excerpt += windowText.slice(cursor, spanStart) + REDACTION_MARKER;
    cursor = spanEnd;
  }
  excerpt += windowText.slice(cursor);
  return excerpt;
}

// Scans `text` against `patterns` (as returned by `loadPatterns`) and
// returns `{ matches, truncated, total }`:
//   - `matches` is `[{ line, column, pattern, excerpt }]`, in reading
//     order (top to bottom, left to right within a line), capped at `max`
//     entries (default 5). `pattern` is a personal pattern's neutral label
//     rather than its text, for every match, not only for a compile
//     failure; see `displayPattern`.
//   - `truncated` is whether more matches existed than `matches` carries,
//     computed from what was ACTUALLY RETURNED (`total > matches.length`)
//     rather than from a comparison against the requested `max`: a `max`
//     that is not a valid non-negative integer (`NaN`, a string, a
//     negative number) falls back to the default instead of silently
//     producing an empty result that then claims nothing was cut, which is
//     what comparing against the raw, unvalidated `max` used to do.
//   - `total` is the true number of matches, counted even past the cap
//     (see `SCAN_LINE_SRC`), never merely the length of `matches`.
//
// This is a plain record rather than extra properties hung off an array,
// on purpose: an array's own properties do not survive `JSON.stringify`,
// `Array.prototype.map`, a spread, or any other ordinary handling of "the
// list of matches", so `truncated` and `total` used to vanish the moment a
// caller touched the value in any of those ways. A ceiling that only
// announces itself until someone touches the result is not announcing
// itself.
//
// NUL bytes are stripped before scanning, and the result is still scanned
// as text: the shell version of this scanner treated any blob containing a
// NUL as binary and skipped it outright, which was one of its five holes.
// Line splitting happens on `\n` alone; a file with no trailing newline
// still yields its last line as a scannable line, since `String.split`
// never drops a trailing non-terminated segment.
//
// The cap is applied WHILE scanning, not after: each pattern retains at
// most the line's remaining budget of matches (never more objects than
// that, regardless of how many matches actually exist), while still
// counting every match through to `total`. Retaining up to the remaining
// budget from EVERY pattern on a line, then merging and re-sorting by
// column before taking only what the budget allows, is what keeps the
// result in true reading order even though patterns are scanned in a
// fixed list order that need not match where their matches fall.
// One collection pass per (line, pattern) serves both purposes this
// function needs from it: the FIRST `remainingBudget` spans found (per
// pattern, per line) are candidates for the findings this call will
// actually return, and EVERY span collected, up to the generous
// `REDACTION_SPAN_FLOOR`, is also what `buildExcerpt` uses to mask any
// neighbour a finding's excerpt window touches. Collecting to
// `max(remainingBudget, REDACTION_SPAN_FLOOR)` rather than doing two
// separate passes (one small, for findings; one large, for redaction)
// means the accurate total this pattern contributed is counted exactly
// once per line, not twice.
export function scanText(text, patterns, { max } = {}) {
  const effectiveMax = Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX;
  const cleaned = text.replace(/\0/g, '');
  const lines = cleaned.split('\n');
  const matches = [];
  let total = 0;
  lines.forEach((lineText, index) => {
    const lineNumber = index + 1;
    const remainingBudget = effectiveMax - matches.length;
    const collectCap = Math.max(remainingBudget, REDACTION_SPAN_FLOOR);
    const findingCandidates = [];
    const redactionSpans = [];
    let tooDenseToRedactPrecisely = false;
    for (const entry of patterns) {
      const describe = displayPattern(entry);
      const { kept, count } = scanLineForPattern(entry.regex, lineText, collectCap, describe);
      total += count;
      if (count > kept.length) {
        // More matches of this one pattern exist on this line than this
        // module is willing to enumerate individually: it cannot vouch for
        // having found every neighbour a window might touch, so it falls
        // back to masking whole windows on this line rather than risk an
        // unenumerated match surviving in an excerpt.
        tooDenseToRedactPrecisely = true;
      }
      // Every kept span becomes both a finding candidate and a redaction
      // span, unfiltered here: the finding candidates are bounded to
      // `remainingBudget` by the SORT-THEN-SLICE below, not by limiting
      // what gets pushed per pattern (each pattern must offer up to
      // `remainingBudget` candidates for that slice to pick the true
      // reading-order top ones, per the k-way merge this relies on), and a
      // zero-length span is filtered out later by `buildExcerpt`'s own
      // `clippedStart < clippedEnd` check (a zero-length span always has
      // `clippedStart === clippedEnd`), so filtering it out twice would be
      // the same redundant guard this codebase has already learned to
      // remove rather than leave undefended.
      kept.forEach(([start, length]) => {
        findingCandidates.push({ line: lineNumber, column: start + 1, start, end: start + length, entry });
        redactionSpans.push([start, start + length]);
      });
    }
    // A performance fast path, not a correctness guard: sorting and
    // slicing an empty array is already a no-op, so a line with no
    // candidates at all would fall through the rest of this block and
    // push nothing regardless. This exists so the ORDINARY case, a line
    // with no matches at all (most lines, in most real content), skips the
    // sort call entirely rather than paying for it on every single line of
    // every scan.
    if (findingCandidates.length === 0) return;
    findingCandidates.sort((a, b) => a.column - b.column);
    for (const candidate of findingCandidates.slice(0, remainingBudget)) {
      matches.push({
        line: candidate.line,
        column: candidate.column,
        pattern: displayPattern(candidate.entry),
        excerpt: buildExcerpt(lineText, candidate.start, candidate.end, redactionSpans, tooDenseToRedactPrecisely),
      });
    }
  });
  return {
    matches,
    truncated: total > matches.length,
    total,
  };
}
