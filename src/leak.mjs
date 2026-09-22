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
import { decodeBytes, decodeLatin1Text } from './io.mjs';

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
// Exported (fix round 2, src/rules/lint.mjs's own secrets rule): a caller
// that classifies a match by its `origin` field (see `matches.push` in
// `scanText`, below) rather than by re-inspecting the already-rendered
// `pattern` text needs this exact string to describe a personal-origin
// match, the same string this module already uses for the identical
// purpose, rather than inventing a second, independently-drifting label
// for the same fact.
export const PERSONAL_PATTERN_LABEL = 'a personal pattern';

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

// The wall-clock budget for an entire `scanText` call, across every line
// and every pattern, in addition to the per-evaluation `SCAN_TIMEOUT_MS`
// above. The two bound different things and neither substitutes for the
// other: `SCAN_TIMEOUT_MS` catches the ONE stuck evaluation, but a scan can
// be made of thousands of evaluations that EACH stay comfortably under
// that bound and still sum to an unbounded total, because the budget used
// to be spent per line AND per pattern (see `SCAN_LINE_SRC`'s own history
// below). No single call ever timed out, so nothing before this constant
// existed would ever raise, and the caller would simply wait; a
// ten-thousand-line file at that old per-(line, pattern) rate already
// extrapolated to hours.
//
// This is not a judgment call, it is a measurement, and the module was
// wrong once already for treating it as the former. Measured on the
// machine this was written on, scanning ORDINARY prose (no matches at
// all) against the six generic patterns before `SCAN_LINE_SRC` was hoisted
// to run every pattern for one line in a single sandbox call: one
// `vm.runInContext` call costs roughly 70-115 MICROseconds regardless of
// how little work is inside it, against roughly a TENTH of a microsecond
// for the same regex work run directly outside a sandbox. On content with
// nothing to find, which is most real content, that per-call overhead WAS
// the scan's cost, and paying it once per (line, pattern) rather than once
// per line meant a ten-thousand-line file alone cost several seconds
// against the OLD ceiling of ten seconds, using up roughly half of it on
// ordinary prose containing no secret at all. Hoisting the pattern loop
// inside the sandbox (calling once per line, not once per line per
// pattern) cut a representative scan's time by roughly three quarters;
// compiling `SCAN_LINE_SRC` once with `vm.Script` instead of passing it as
// a string to `runInContext` on every call was also measured and made no
// further difference, so it is not done.
//
// After hoisting, 100,000 lines (about 13 MB) of ordinary prose with no
// matches, scanned against the six generic patterns plus five typical
// vault-configured ones (eleven patterns total), measured at roughly 12.7
// seconds on that same machine. This constant is set with real margin
// above that measurement, specifically so a legitimate large file (a
// generated document, an exported log, a big diff) does not spuriously
// spend most or all of its budget on content that carries no secret at
// all: at this value, 100,000 lines of clean content is comfortably
// admitted, not merely tolerated.
//
// Exported, not a private implementation detail, specifically so this
// module's own tests can pin its VALUE directly rather than only its
// existence: a test that only ever exercises an override (see
// `deadlineAt`) never notices this constant growing by any factor at all,
// including one that would turn a bounded scan back into an effectively
// unbounded one.
export const OVERALL_SCAN_TIMEOUT_MS = 20000;

// THE BUDGET GROWS WITH THE WORK (final fix round 2). OVERALL_SCAN_TIMEOUT_MS
// above is a FLOOR now, not the whole budget: a caller that passes
// `accrue: true` to scanText gets that floor plus the rates below for every
// line it actually scans, so a large file is given time in proportion to
// how large it is, and a small one keeps the flat twenty seconds it always
// had.
//
// The unit is the LINE, not the byte, and that is a measurement, not a
// preference. On the machine this was written on, with the nine patterns a
// shipped configuration applies: one sandbox call per line costs about 120
// microseconds whatever the line holds, against about 1.6 NANOseconds per
// character for the regular expression work itself. A megabyte of two-byte
// lines therefore took 62 seconds and a megabyte of one long line took 2
// milliseconds: the same bytes, thirty thousand times apart. A budget in
// bytes alone would have to be sized for the first and would then bound
// the second by nothing, or be sized for ordinary prose and time out on an
// ordinary CSV, which is what the flat budget did (an export of 248,412
// short lines and no secret, refused as a crash). Both costs also grow with
// the number of patterns (about 95 microseconds plus 4 per pattern per
// line, and about 0.085 nanoseconds per pattern per character, measured at
// 9, 54 and 204 patterns), so the rates are per pattern too.
//
// Each rate below is about ten times what was measured, so a slower
// machine, a loaded one or a continuous-integration runner does not trip on
// ordinary content, while a pattern that is slow on every line still runs
// out a few seconds past the floor instead of hours later. The scanner's
// pre-filter (see scanText) makes most lines far cheaper than the full
// per-line cost these rates allow for; the rates are sized for the case
// where every line needs the full scan anyway, because a file where every
// line matches is a real file too (an export of addresses, say) and must
// not be refused as having timed out when it should be refused for what it
// holds.
export const ACCRUAL_PER_LINE_MS = 1;
export const ACCRUAL_PER_LINE_PER_PATTERN_MS = 0.04;
export const ACCRUAL_PER_CHAR_PER_PATTERN_MS = 0.000001;

// The ceiling on how much ONE file or ONE blob either gate will read into
// memory to scan, in bytes, and the SAME number for both gates (final fix
// round 2). It used to be two numbers sixty-four times apart: 4 MiB for the
// `secrets` lint rule, chosen rather than measured, which refused the first
// push of the one real vault in sight over an ordinary PDF; and 256 MiB for
// the maintainer's gate, which was not a scan ceiling at all but the output
// buffer of a git call, so a larger blob was refused as "git show could not
// be run". Neither was the right number and neither said what it was.
//
// 100 MiB is what an ordinary vault attachment is: it is the largest file
// the most common git host accepts in an ordinary push (GitHub refuses any
// file over 100 MiB outright), so an attachment an ordinary vault can hold
// at all is one this reads. Measured, not assumed: decoding 100 MiB of
// random bytes and splitting it into lines peaks at about 1.1 GB of
// resident memory, well inside a default Node heap. A file over it is
// refused, loudly and truthfully as too large, never skipped; the adopting
// vault's escape is `lint.secrets.exclude_paths`, which a pull request
// shows, and the maintainer's gate has no escape because its repository
// has no business holding such a file.
export const MAX_SCAN_BYTES = 100 * 1024 * 1024;

// The codes every error this scanner raises carries, so a caller can say
// WHICH failure it was rather than guessing from prose: a scan that ran out
// of time is not a scan that crashed, and a report that calls one the other
// sends its reader to debug the wrong thing.
export const SCAN_TIMEOUT = 'BRAIN_KIT_SCAN_TIMEOUT';
export const SCAN_FAILED = 'BRAIN_KIT_SCAN_FAILED';

function scanError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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
  // Decoded exactly as the content it is matched against is decoded
  // (src/io.mjs, decodeBytes), so a name written the ordinary way, accents
  // and all, matches that name wherever it appears. It used to be read as
  // UTF-8 while every channel was decoded one byte per character, and a
  // pattern holding an accented letter, written the ordinary way, matched
  // nothing at all, in silence; only its mojibake spelling refused.
  let content;
  try {
    content = decodeBytes(readFileSync(path));
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

// A pattern spelled as the mojibake of a name: every character of it one
// byte wide, and, read back as the bytes those characters stand for, it
// holds a well-formed UTF-8 sequence (an accented letter written as the two
// characters its UTF-8 bytes make when read one byte per character). Until
// 22/09/2026 that was the only spelling of an accented name that matched
// anything, because content was decoded one byte per character; now that
// content and patterns are decoded alike, it no longer matches the name it
// was written for. A list written that way would go on saying "nothing
// matched" about the very name it exists to catch, which is the useless
// list this gate refuses rather than accepts. No real name holds such a
// pair: the second character would be a C1 control or a symbol such as
// the copyright or the degree sign straight after an accented letter.
function isMojibakeSpelling(raw) {
  return !/[^\x00-\xff]/.test(raw) && decodeLatin1Text(raw) !== raw;
}

// Compiles the personal patterns file into tagged, compiled patterns.
function loadPersonalPatterns(env) {
  const path = personalPatternsPath(env);
  const usable = readPersonalPatternLines(path);
  return usable.map(({ raw, lineNumber }) => {
    if (isMojibakeSpelling(raw)) {
      throw new Error(`the personal leak pattern on line ${lineNumber} of ${path} is spelled as the mojibake of a name (its UTF-8 bytes read one byte per character), which no longer matches that name: write it the way you would write the name`);
    }
    return compilePattern(raw, 'personal', { path, lineNumber });
  });
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
//
// Fix round 2 (CRITICAL): a pattern's raw text that appears in more than
// one of these three sources used to compile TWICE (or three times),
// producing two independently-matching entries scanText treats as two
// unrelated patterns. This project's own shipped example configuration
// (test/fixtures/config/valid.json) names this exact shape: it lists
// `AKIA[0-9A-Z]{16}` in `privacy.secret_patterns`, and GENERIC_PATTERNS
// already carries the identical string. Three real secrets on three
// added lines then reported as "5 shown out of 6 found": every real
// match counted once for the 'generic' entry and once more for the
// 'config' entry, inflating both the shown findings and the truncation
// notice's own total, and every secrets test in this codebase already
// works around it by clearing `privacy.secret_patterns` to `[]`, so
// nothing exercised what a real adopter, running the shipped
// configuration unmodified, actually sees. Deduplicated by RAW TEXT,
// first occurrence wins, in the same generic-then-config-then-personal
// order these are already assembled in: a config or personal entry
// that merely repeats a shape GENERIC_PATTERNS already ships is folded
// into that one generic entry rather than compiled a second time, so
// its own match origin reads as 'generic' (safe: raw text identical to
// a versioned, public shape is not a new disclosure) and it is scanned
// exactly once. A compile failure is still checked for every personal
// pattern before this fold ever runs, so a malformed personal pattern
// that ALSO happens to duplicate a public one still raises first,
// unaffected by whether it would otherwise have been folded away.
export function loadPatterns({ env, configPatterns } = {}) {
  const compiled = [];
  const seenRaw = new Set();
  for (const raw of GENERIC_PATTERNS) {
    compiled.push(compilePattern(raw, 'generic'));
    seenRaw.add(raw);
  }
  for (const raw of configPatterns ?? []) {
    const entry = compilePattern(raw, 'config');
    if (seenRaw.has(raw)) continue; // already covered by an earlier source; scanning it again only double-counts every match
    compiled.push(entry);
    seenRaw.add(raw);
  }
  if (env !== undefined) {
    for (const entry of loadPersonalPatterns(env)) {
      if (seenRaw.has(entry.raw)) continue;
      compiled.push(entry);
      seenRaw.add(entry.raw);
    }
  }
  return compiled;
}

// A single, reused sandbox for every time-bounded scan this module runs.
// Created once rather than per call: `vm.createContext` has real overhead,
// and every call here only needs to set a few bindings and re-run the same
// source, not stand up a new global object each time.
const scanSandbox = vm.createContext(Object.create(null));

// The script executed inside `scanSandbox`, ONCE PER LINE for every
// pattern together, not once per (line, pattern). Measured (see the
// fix-round report): one `vm.runInContext` call costs on the order of
// seventy microseconds regardless of how little work is inside it, against
// roughly a tenth of a MICROsecond for the same regex work run directly.
// On ordinary content, where almost nothing matches, that per-call
// overhead was almost the entire cost of a scan; calling once per line
// instead of once per (line, pattern) cuts a representative scan's time by
// roughly three quarters, because the sandbox-entry cost is paid once per
// line rather than once per line per pattern. Compiling this script once
// with `vm.Script` instead of passing it as a string to `runInContext`
// every time was also measured and made no measurable difference, so it is
// not done here; the cost is in crossing into the sandbox, not in parsing
// the same few lines of source again.
//
// It is plain top-level code, not a function body: a vm script's
// completion value is the value of its last evaluated expression
// statement, which a `function` body does not give you without an
// explicit `return`, so this stays a flat script on purpose. For each
// pattern in `patterns` it finds EVERY match, retaining full
// `[index, length]` pairs for at most `keep` of them (so retention cannot
// allocate more than `keep` objects no matter how many matches exist) while
// still counting every match found (so each entry's `count` is exact even
// when far more matches exist than `keep`), ALL of it, every pattern on
// this line, inside the ONE timeout this whole call is run under. That one
// timeout is what turns two different-looking dangers into one bounded
// failure: a pattern whose backtracking never returns dies wherever it is
// in the loop, and a pattern that returns constantly (an `a*`-shaped
// pattern against a very long run of `a`) dies once the accumulated cost
// of all those cheap calls crosses the same budget, well before either one
// could allocate its way to an outage or hang the process. The cost of
// this coarser granularity is attribution: if the whole call times out,
// there is no way to ask the sandbox which pattern, or which iteration, it
// was on when V8 terminated it, so the caller cannot name a specific
// pattern in that message; see `scanLineForAllPatterns`.
const SCAN_LINE_SRC = `
var results = [];
for (var p = 0; p < patterns.length; p += 1) {
  var regex = patterns[p];
  var kept = [];
  var count = 0;
  regex.lastIndex = 0;
  var m = regex.exec(text);
  while (m !== null) {
    count += 1;
    if (kept.length < keep) { kept.push([m.index, m[0].length]); }
    if (m[0].length === 0) {
      // A zero-length match (an all-optional pattern) would otherwise pin
      // lastIndex in place and loop forever without ever reaching the
      // count that would let the caller's ceiling apply.
      regex.lastIndex += 1;
    }
    m = regex.exec(text);
  }
  results.push({ kept: kept, count: count });
}
results;
`;

// Runs `SCAN_LINE_SRC` for one line against EVERY pattern in `regexes`,
// together, in one sandbox call. `regexes` is passed BY REFERENCE into the
// sandbox (a vm context does not clone the bindings it is given), so each
// regex's `lastIndex` mutations, including the automatic reset to zero the
// specification performs on a failed match, are visible to this module
// exactly as a direct `regex.exec(text)` call would leave them; nothing
// here has to reset it again afterwards.
//
// Neither failure branch below names a specific pattern, unlike the
// per-pattern version this replaced: a timeout aborts the WHOLE call, and
// V8 gives back no information about which pattern, or which loop
// iteration, it was on when it terminated the script, so there is nothing
// true this function could attribute to any one entry, personal or not.
// Saying nothing specific is also what keeps the fail-closed contract
// trivially true here: a message with no pattern-derived content at all
// can never be the one that leaks a personal pattern's text.
function scanLineForAllPatterns(regexes, text, keep) {
  scanSandbox.patterns = regexes;
  scanSandbox.text = text;
  scanSandbox.keep = keep;
  try {
    return vm.runInContext(SCAN_LINE_SRC, scanSandbox, { timeout: SCAN_TIMEOUT_MS });
  } catch (err) {
    // `vm` tags an actual timeout with this specific code (verified
    // empirically in this Node version), and that is the ONLY failure this
    // function is entitled to call a timeout: a bare catch that relabels
    // every sandbox failure as "took too long" would send whoever reads it
    // chasing a catastrophic pattern that was never there, when the real
    // cause could be a bug in `SCAN_LINE_SRC` itself, a caller passing
    // something that is not a compiled pattern, or some other engine
    // error. Anything else still fails closed (it still throws, never
    // returns as if the scan had succeeded), but says so honestly, and
    // without the engine's own message: that message is arbitrary,
    // engine-controlled text with no origin gate of its own, and this
    // function's whole point is never to interpolate ungated text into
    // what it throws.
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      // The engine's own timeout error carries no information this module
      // needs to relay (it never names a pattern, only "script execution
      // timed out"), so it is replaced rather than wrapped: the message
      // here is what actually helps whoever reads it decide what to do
      // next.
      throw scanError(`one or more leak patterns took longer than ${SCAN_TIMEOUT_MS}ms to scan this line and were aborted rather than left to hang`, SCAN_TIMEOUT);
    }
    throw scanError('scanning this line against the leak patterns failed unexpectedly, not from a timeout', SCAN_FAILED);
  }
}

// THE PRE-FILTER (final fix round 2): which lines of a run of lines ANY
// pattern matches at all, asked in ONE sandbox call for the whole run
// rather than one call per line.
//
// The sandbox call is what a scan's time is made of (see
// OVERALL_SCAN_TIMEOUT_MS and the accrual rates above: about 120
// microseconds per call whatever is inside it), and most lines of most
// files match nothing. So the question "does anything match here" is asked
// of up to PREFILTER_MAX_LINES lines at once, and only a line that answers
// yes goes on to the full per-line scan below, which counts every match,
// keeps the spans and builds the redaction map exactly as before. Measured
// on ordinary content, that is the difference between about 120
// microseconds and well under one microsecond per line.
//
// EXACT, NOT A HEURISTIC, and the argument is short. Each line is tested
// ON ITS OWN, as the same string, by the same compiled pattern, from
// position zero: `test` from lastIndex 0 is true exactly when the full
// scan's first `exec` would find a match. A line every pattern answers
// false for is therefore a line the full scan would have found nothing on,
// which it would have added nothing to: no match, no span, zero to the
// total. Skipping it changes no result. A pattern that can match the empty
// string answers true on every line, so every line is scanned in full,
// which is slower and still exact. Testing the whole text at once instead
// would NOT be exact (an anchor or a lookaround behaves differently at a
// line boundary than at the edge of a string), which is why the lines are
// tested one by one inside the call.
//
// lastIndex is reset before every test, because a global pattern's `test`
// starts wherever the last use left it; a successful test leaves it past
// the match, and the full scan resets it again before its own first exec.
//
// The loop runs inside a function whose parameters are the sandbox's
// bindings, not over the bindings themselves: every read of a sandbox
// global goes through the context's property interceptor, and inside a
// loop of a thousand lines that interception, not the regular expression
// work, was measured as most of the call's cost (about 17 microseconds a
// line against about one once the bindings are locals).
const PREFILTER_SRC = `
(function (lines, patterns, from, to) {
  var hits = [];
  for (var i = from; i < to; i += 1) {
    var line = lines[i];
    for (var p = 0; p < patterns.length; p += 1) {
      var regex = patterns[p];
      regex.lastIndex = 0;
      if (regex.test(line)) { hits.push(i); break; }
    }
  }
  return hits;
})(lines, patterns, from, to);
`;

// How many lines, and how many characters, one pre-filter call covers at
// most. Bounded on both, so that one call stays far inside SCAN_TIMEOUT_MS
// for any content a real pattern list meets: at these sizes a call does
// about a millisecond of work. A single line longer than the character
// bound is a run of its own.
export const PREFILTER_MAX_LINES = 1024;
export const PREFILTER_MAX_CHARS = 256 * 1024;

function prefilterRunEnd(lines, start) {
  let end = start;
  let chars = 0;
  while (end < lines.length && end - start < PREFILTER_MAX_LINES) {
    const next = chars + lines[end].length;
    if (end > start && next > PREFILTER_MAX_CHARS) break;
    chars = next;
    end += 1;
  }
  return end;
}

// Runs PREFILTER_SRC over lines [from, to). The same failure handling as
// scanLineForAllPatterns: a timeout is called one, with its code, and
// anything else fails closed without relaying the engine's own text.
function linesWithAnyMatch(regexes, lines, from, to) {
  scanSandbox.patterns = regexes;
  scanSandbox.lines = lines;
  scanSandbox.from = from;
  scanSandbox.to = to;
  try {
    return vm.runInContext(PREFILTER_SRC, scanSandbox, { timeout: SCAN_TIMEOUT_MS });
  } catch (err) {
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw scanError(`one or more leak patterns took longer than ${SCAN_TIMEOUT_MS}ms to scan this line and were aborted rather than left to hang`, SCAN_TIMEOUT);
    }
    throw scanError('scanning this line against the leak patterns failed unexpectedly, not from a timeout', SCAN_FAILED);
  } finally {
    // The lines array is the whole text; it is not kept alive by the
    // sandbox past the call that needed it.
    scanSandbox.lines = undefined;
  }
}

// Lines end at LF, at CRLF, and at a lone CR (final fix round 2). A file
// whose only line breaks are carriage returns (classic Mac line endings)
// used to be one line here, so every finding in it was reported at line 1,
// while every other rule in this project, which reads through a reader that
// folds CR to LF, numbered the same file correctly: two readers disagreeing
// about one file. CRLF is still ONE line break, so a Windows file numbers
// exactly as it did.
function splitLines(text) {
  return text.includes('\r') ? text.split(/\r\n|\r|\n/) : text.split('\n');
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

// Masks one bounded region of `lineText` (`[regionStart, regionEnd)`,
// always at most `EXCERPT_CONTEXT_CHARS` wide by construction, see
// `buildExcerpt`) against every FULL-LINE span in `redactionSpans` that
// overlaps it, clipping each to the region and replacing it with the fixed
// marker. Spans are sorted before merging on purpose: the merge step below
// only ever WIDENS the END of the most recently merged range, on the
// assumption that nothing still to come could start earlier than what is
// already merged; unsorted input breaks that assumption, and a later span
// that starts before an earlier, wider one has already been merged in can
// be absorbed into it WITHOUT the merged range's own start moving down to
// meet it, silently dropping everything before that later span's start
// from being masked at all.
function maskRegion(lineText, regionStart, regionEnd, redactionSpans) {
  const regionText = lineText.slice(regionStart, regionEnd);
  const clipped = [];
  for (const [spanStart, spanEnd] of redactionSpans) {
    const clippedStart = Math.max(spanStart, regionStart);
    const clippedEnd = Math.min(spanEnd, regionEnd);
    if (clippedStart < clippedEnd) {
      clipped.push([clippedStart - regionStart, clippedEnd - regionStart]);
    }
  }
  if (clipped.length === 0) return regionText;
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
  let masked = '';
  let cursor = 0;
  for (const [spanStart, spanEnd] of merged) {
    masked += regionText.slice(cursor, spanStart) + REDACTION_MARKER;
    cursor = spanEnd;
  }
  masked += regionText.slice(cursor);
  return masked;
}

// Builds the excerpt for one finding: up to `EXCERPT_CONTEXT_CHARS` of
// context on EACH SIDE of its match, with every match either side overlaps
// replaced by the fixed marker, joined around one marker for the match
// itself. `redactionSpans` are FULL-LINE `[start, end)` pairs, not
// region-local ones, precisely so a neighbouring match that only PARTIALLY
// overlaps a side region (its own span starts before it, or ends after it)
// still gets masked wherever it overlaps: rescanning just the region's own
// text cannot find such a neighbour, because a pattern that requires its
// whole shape to match will not recognise a fragment of itself, and a
// match cut off at a region boundary is exactly a fragment.
// `tooDenseToRedactPrecisely` means the line carried more matches of some
// pattern than this module is willing to enumerate individually; in that
// case both sides are masked outright rather than risk a fragment
// surviving in an excerpt this module could not actually verify.
//
// The match itself is never included in either side region (a side region
// runs up to, but never across, `start` or `end`), so its own length can
// never widen the text this function has to consider: the total context
// this function ever looks at is bounded to `2 * EXCERPT_CONTEXT_CHARS`
// PLUS the two fixed markers, regardless of how long the match itself is.
// A single `start - CTX` to `end + CTX` window, by contrast, grows with
// the match's own length, which is unbounded for several of the generic
// shapes (`ghp_`, `sk-ant-` and the Slack shapes all end in `{N,}` with no
// upper bound); a genuinely long committed token would otherwise make the
// excerpt (and the work spent building it) scale with an attacker's own
// choice of secret length instead of staying fixed.
function buildExcerpt(lineText, start, end, redactionSpans, tooDenseToRedactPrecisely) {
  if (tooDenseToRedactPrecisely) {
    return REDACTION_MARKER;
  }
  // `beforeStart` MUST be clamped to zero explicitly: `String.prototype.slice`
  // treats a NEGATIVE index as counting back from the end of the string
  // (length + index), not as "clamp to the start", so an unclamped
  // `start - EXCERPT_CONTEXT_CHARS` near the beginning of a line would wrap
  // around and read from the wrong end of it entirely. `afterEnd` needs no
  // matching clamp: `slice` already clamps an END index that overshoots the
  // string's length down to that length, and `end` (a real match's end
  // position on THIS line) can never itself exceed `lineText.length`, so
  // there is no equivalent wraparound to guard against on this side.
  const beforeStart = Math.max(0, start - EXCERPT_CONTEXT_CHARS);
  const afterEnd = end + EXCERPT_CONTEXT_CHARS;
  const beforeText = maskRegion(lineText, beforeStart, start, redactionSpans);
  const afterText = maskRegion(lineText, end, afterEnd, redactionSpans);
  return `${beforeText}${REDACTION_MARKER}${afterText}`;
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
// Lines end at LF, CRLF or a lone CR (see splitLines); a file with no
// trailing newline still yields its last line as a scannable line, since
// `String.split` never drops a trailing non-terminated segment.
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
// `deadlineAt` is an ABSOLUTE point in time (an epoch millisecond value,
// comparable to `Date.now()`), not a duration, and this is deliberate. A
// duration measured from when ONE `scanText` call starts only ever bounds
// that one call; every real caller scans more than one file over the
// course of a run (a lint pass, a push gate walking a commit range), and a
// per-call duration budget resets for each one, so a whole run has no
// aggregate budget at all even though each individual call thinks it has
// one. Threading the SAME absolute deadline through every call in a run
// (compute it once, pass it to every `scanText` call that run makes) gives
// the run itself a total budget; a fresh duration per call cannot do that
// no matter what its number is. When omitted, this call gets its own
// deadline, `Date.now() + OVERALL_SCAN_TIMEOUT_MS`, which preserves this
// module's behaviour for a caller that only ever scans one thing.
//
// `now` is the CLOCK this function reads, injectable, defaulting to
// `Date.now`. It exists because the deadline is the one behaviour here
// that a test cannot pin without controlling time: a test that computes a
// tiny real deadline and then races real work against it asserts on how
// busy the machine is, not on what this module does, and such a test goes
// red on a loaded machine with nothing wrong and green on an idle one with
// a real regression present. Neither reading is worth anything, and a gate
// whose suite goes red for reasons unrelated to the gate teaches whoever
// reads it that red means noise. A clock is therefore passed in, and a
// test drives it.
//
// It cannot open a hole. A value that is not a function falls back to
// `Date.now` (the same shape as the `deadlineAt` fallback just above), so
// no caller can switch the deadline off by handing over something
// unusable; a caller that hands over a WORKING clock of its own can only
// make this function give up sooner or later, never skip a pattern or drop
// a match. No production caller passes it: src/commands/scan-blobs.mjs and
// src/rules/lint.mjs both leave it out and get the real clock.
//
// `accrue: true` makes `deadlineAt` a floor that grows by the accrual rates
// above for every line scanned, so the budget is proportional to the work
// (see ACCRUAL_PER_LINE_MS for the measurement that says the unit is the
// line). Anything but `true` leaves the deadline absolute. It cannot open a
// hole either: it can only make this function wait longer, and by a bounded,
// fixed amount per line, never forever.
export function scanText(text, patterns, { max, deadlineAt, now, accrue = false } = {}) {
  const effectiveMax = Number.isInteger(max) && max >= 0 ? max : DEFAULT_MAX;
  const clock = typeof now === 'function' ? now : Date.now;
  let allowedUntil = Number.isFinite(deadlineAt) ? deadlineAt : clock() + OVERALL_SCAN_TIMEOUT_MS;
  const cleaned = text.replace(/\0/g, '');
  const lines = splitLines(cleaned);
  const matches = [];
  let total = 0;
  // Hoisted once, outside the per-line loop: `patterns` itself does not
  // change across lines, so there is no reason to rebuild this array
  // ten thousand times for a ten thousand line file.
  const regexes = patterns.map((entry) => entry.regex);
  // The accrual (see ACCRUAL_PER_LINE_MS): what each line scanned adds to
  // the budget, only when the caller asked for a budget that grows with the
  // work. Off by default, so a caller that passes nothing keeps exactly the
  // absolute deadline it always had.
  const perLineMs = accrue === true ? ACCRUAL_PER_LINE_MS + ACCRUAL_PER_LINE_PER_PATTERN_MS * patterns.length : 0;
  const perCharMs = accrue === true ? ACCRUAL_PER_CHAR_PER_PATTERN_MS * patterns.length : 0;
  const accrueFor = (from, to) => {
    for (let i = from; i < to; i += 1) allowedUntil += perLineMs + lines[i].length * perCharMs;
  };

  // Checked before every sandbox call, the pre-filter's and the full
  // scan's alike: a sandbox call is the smallest unit of work this
  // function can interrupt between. The per-evaluation budget
  // (`SCAN_TIMEOUT_MS`) bounds one stuck call; this bounds the SUM of
  // every call a scan makes, which many calls that each finish comfortably
  // under that per-call budget can still exceed with no single call ever
  // raising. Checking here bounds how far past this deadline the scan can
  // overshoot to at most one more call's worth of work, never the whole
  // rest of the file.
  const checkDeadline = () => {
    if (clock() > allowedUntil) {
      throw scanError('the scan exceeded its deadline before finishing every line; refusing to report a partial result as if it were complete', SCAN_TIMEOUT);
    }
  };

  const scanOneLine = (index) => {
    const lineText = lines[index];
    const lineNumber = index + 1;
    const remainingBudget = effectiveMax - matches.length;
    const collectCap = Math.max(remainingBudget, REDACTION_SPAN_FLOOR);
    const findingCandidates = [];
    const redactionSpans = [];
    let tooDenseToRedactPrecisely = false;
    const results = scanLineForAllPatterns(regexes, lineText, collectCap);
    patterns.forEach((entry, patternIndex) => {
      const { kept, count } = results[patternIndex];
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
    });
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
        // The compiled entry's own origin ('generic' | 'config' |
        // 'personal'), alongside `pattern` (the already-decided DISPLAY
        // text `displayPattern` computed above), not instead of it: a
        // caller that needs to classify a match (src/rules/lint.mjs's
        // own secrets rule is the one that does) must read the fact
        // this module already knows for certain, not re-derive it by
        // inspecting the rendered text a second time. Re-deriving from
        // `pattern` alone is exactly the bug that shipped once: a
        // 'personal' match's own `pattern` is already the neutral
        // PERSONAL_PATTERN_LABEL, a string that is not, and was never
        // meant to be compared against, GENERIC_PATTERNS, so a second
        // classifier reading that already-laundered value has no
        // correct way to tell "personal" apart from "config" at all.
        origin: candidate.entry.origin,
        excerpt: buildExcerpt(lineText, candidate.start, candidate.end, redactionSpans, tooDenseToRedactPrecisely),
      });
    }
  };

  // The pre-filter first, a run of lines per sandbox call, and the full
  // per-line scan only for a line some pattern matched (see PREFILTER_SRC
  // for why that is exact). A run whose call times out is not a verdict on
  // the run: a pattern that is merely slow on many lines together can
  // outlast one call's budget where each line on its own would not, so the
  // rest of the text is scanned one line per call instead, which is how
  // this function worked before it had a pre-filter, and every line is
  // still read. A run of ONE line is the exception: the pre-filter's test
  // does no more than the full scan's first exec on that same line, so
  // that line cannot be scanned in its own call either, and the timeout is
  // the answer.
  let prefilter = true;
  let at = 0;
  while (at < lines.length) {
    checkDeadline();
    if (!prefilter) {
      scanOneLine(at);
      accrueFor(at, at + 1);
      at += 1;
      continue;
    }
    const end = prefilterRunEnd(lines, at);
    let hits;
    try {
      hits = linesWithAnyMatch(regexes, lines, at, end);
    } catch (error) {
      if (error.code !== SCAN_TIMEOUT || end - at === 1) throw error;
      prefilter = false;
      continue;
    }
    accrueFor(at, end);
    for (const index of hits) {
      checkDeadline();
      scanOneLine(index);
    }
    at = end;
  }
  return {
    matches,
    truncated: total > matches.length,
    total,
  };
}
