// `brain-kit scan-blobs`: the Node half of the maintainer push gate
// (.githooks/pre-push). Bash keeps the one job it is still good at, asking
// git what a push contains (which commits, which paths, with which modes,
// in what order); this command does everything else, because the shell
// version of that "everything else" needed five rounds of fixes in one day,
// and every hole was the same shape: a status nobody read, or a set nobody
// enumerated (see .githooks/pre-push's own history comment for the five).
//
// Reads a stream of NUL-separated records from standard input (see
// parseEntries below for the exact framing) and scans EVERY channel a push
// carries content through, not only blob content:
//
//   - a blob's CONTENT, read with `git show <commit>:<path>`;
//   - a blob's PATH, which is text the push publishes just as surely as the
//     content is, and which in a knowledge vault carries a person's or a
//     client's name at least as often as the prose does, because that is
//     how a vault is organised;
//   - a commit's MESSAGE;
//   - a commit's AUTHOR and COMMITTER identity (name and address);
//   - an annotated tag's MESSAGE and TAGGER identity.
//
// Every one of those goes through the same pattern list, the same scanner,
// the same fail-closed behaviour and the same never-print contract, and
// every finding names WHICH channel matched, because "a path matched" and
// "a line matched" ask different things of the person reading it: one is
// fixed by editing a file, the other by renaming one or rewriting a commit.
//
// Exits non-zero the moment anything found across the whole push looks like
// a secret, or the moment anything could not be read or scanned at all: a
// blob nobody could examine is not a blob that passed.
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
// SKIP ONLY WHAT WAS NEVER THERE. The rule that decides between refusing
// and skipping, and the only one: refuse when something that should have
// been readable could not be read, and skip when there was nothing to read
// in the first place. A gitlink (mode 160000) is the one shape on the skip
// side, because its content lives in another repository and no amount of
// reading this one will produce it; every skip says so out loud. A blob
// whose object is missing, a path git will not accept, a scan that raises:
// all of those are the refusing side.
//
// NEVER PRINT WHAT IT FOUND, also inherited unchanged. Every finding below
// prints a match's `pattern` field (leak.mjs's own neutral label for a
// personal pattern, never its text) and its `excerpt` (leak.mjs's own
// redacted context, which never contains the matched text itself, personal
// or not). Nothing here re-derives or re-prints raw content next to a
// finding, unlike the shell version this replaces, which printed the raw
// matched line (up to 200 bytes of it, secret included) to stderr. The one
// new place this contract had to be extended is the PATH: a path is
// normally printed in full (it is how the maintainer finds the file), which
// is safe precisely while it matches no pattern, so a path that DOES match
// is replaced by a fixed label everywhere it would otherwise be printed,
// for every message about that blob, not only for the finding itself.
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { EXIT } from '../exit-codes.mjs';
import { readStdin } from '../io.mjs';
import { loadPatterns, scanText, OVERALL_SCAN_TIMEOUT_MS } from '../leak.mjs';

// A generous ceiling on the output of one git call. Node's own default
// (spawnSync's implicit maxBuffer, 1 MB) is small enough that an ordinary
// large asset (an exported log, a big generated document) would overflow
// it and read back as a captured-error failure rather than real content;
// raising it here still fails closed the same way on anything that
// genuinely exceeds it; nothing above this is ever silently truncated and
// called clean.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

// The tree entry mode git gives a submodule reference. Its "content" is a
// commit in a different repository, so there is nothing in THIS repository
// to read: see the skip rule in this module's own header.
const GITLINK_MODE = '160000';

// How many commits are asked about in one `git show -s` call. Commit
// metadata (message, author, committer) is read for the whole push in
// batches rather than one process per commit, because process startup is
// what this gate's running time is made of. The batch exists only to keep
// the argument list bounded on a push that carries thousands of commits (a
// first import, or the full-history fallback scan).
const METADATA_BATCH = 256;

// How far a chain of tag objects is followed (a tag of a tag of a tag).
// Bounded rather than unbounded so a cycle, which git itself will not
// normally produce, cannot spin here.
const MAX_TAG_DEPTH = 10;

// The label that replaces a path in EVERY message about a blob whose path
// itself matched a pattern. See the never-print note in this module's
// header: printing the path is how a maintainer finds the file, and it is
// safe exactly while the path matches nothing.
const REDACTED_PATH = '<a file name that matched a pattern; withheld>';

// The environment variable that overrides the per-blob scan budget, in
// milliseconds. It exists so a test can reach the deadline path in
// milliseconds instead of twenty seconds, which is what makes both the
// deadline argument below and the refusal it causes pinnable by a test
// rather than a comment nothing can fail (see this module's own fix-round
// report). A value that is not a number refuses the push rather than
// falling back to the default: an environment nobody can parse is an
// instruction nobody read.
//
// It cannot open a hole. A larger value only makes the gate wait longer
// before giving up; a smaller or negative one only makes it refuse sooner.
// No value of it causes a pattern to be skipped or a match to be dropped.
export const SCAN_BUDGET_ENV = 'BRAIN_KIT_SCAN_BUDGET_MS';

// The wall-clock budget one scan gets: a FRESH one per scan, deliberately
// not one budget shared across the whole push. OVERALL_SCAN_TIMEOUT_MS
// (leak.mjs's own export) was measured against ONE scanText call, roughly
// 13 seconds for 100,000 lines of ordinary prose with real margin added on
// top; that measurement says nothing about a SECOND, unrelated blob still
// having budget left. A push can carry anywhere from one blob to several
// hundred (a large rename, a vendored update, a first import of an existing
// vault), and a shared budget would let an ordinary push with many
// normal-sized files exhaust it partway through and abort with no verdict
// at all, refusing a perfectly clean push for having too much perfectly
// ordinary content, not for anything it found. Each scan getting the full,
// generously-measured budget keeps the guarantee this module actually needs
// (no single scan runs unbounded) without inventing a new, unmeasured
// number for "a whole push's worth of scanning", which is exactly the
// mistake OVERALL_SCAN_TIMEOUT_MS's own header warns a caller away from
// making up. src/rules/lint.mjs's own secrets rule makes the SAME choice,
// a fresh deadline per file, for the identical reason; the two are aligned.
//
// The default IS OVERALL_SCAN_TIMEOUT_MS, restated on purpose rather than
// inherited by omitting the argument: with the override above, what this
// function returns is a value a test pins and a mutation changes, so the
// choice lives in behaviour instead of only in this comment.
export function perScanBudgetMs(env) {
  const raw = env?.[SCAN_BUDGET_ENV];
  if (raw === undefined || raw === '') return OVERALL_SCAN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${SCAN_BUDGET_ENV} is set to "${raw}", which is not a number of milliseconds`);
  }
  return parsed;
}

// Splits the NUL-separated stream this command's stdin is built from (see
// .githooks/pre-push, which writes it) into typed records. Every record is
// a kind followed by exactly the fields that kind takes, each field
// NUL-terminated:
//
//   blob   NUL <commit> NUL <mode> NUL <path> NUL
//   commit NUL <commit> NUL
//   tip    NUL <sha> NUL
//
// The producer's own trailing NUL after the very last field is the only
// thing that can leave an empty string at the end of the split; anything
// else wrong (an unknown kind, a record that ends mid-way through its
// fields) is a malformed producer, not something to shrug off, so it raises
// rather than guessing what was meant. Note which way that error points: a
// producer this parser cannot understand means the work list it described
// is not the work list that got scanned.
//
// The stream's shape is VERSIONED, and the token below is written into
// this file as a literal so the hook can find it by reading the file. The
// hook is run by git out of the working tree, while THIS module comes out
// of the commit being pushed (see .githooks/pre-push's seventh round, (i)),
// so the two halves of one protocol can be different ages. A copy of this
// command older than the record stream would read every field one place
// out and refuse the push over hundreds of paths that do not exist, which
// is fail-closed but tells whoever reads it nothing true; the hook checks
// for this token first and refuses with one line that says what happened.
export const RECORD_PROTOCOL = 'brain-kit-scan-blobs-records-v2';

const RECORD_FIELDS = new Map([['blob', 3], ['commit', 1], ['tip', 1]]);

export function parseEntries(raw) {
  if (raw.length === 0) return [];
  const fields = raw.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  const entries = [];
  let at = 0;
  while (at < fields.length) {
    const kind = fields[at];
    const arity = RECORD_FIELDS.get(kind);
    if (arity === undefined) {
      throw new Error(`scan-blobs received a record of an unknown kind at field ${at} of its input; refusing to guess what it describes`);
    }
    if (at + arity >= fields.length) {
      throw new Error(`scan-blobs received a "${kind}" record with ${fields.length - at - 1} field(s) instead of ${arity}; refusing to guess how to complete it`);
    }
    const values = fields.slice(at + 1, at + 1 + arity);
    if (kind === 'blob') entries.push({ kind, commit: values[0], mode: values[1], path: values[2] });
    else if (kind === 'commit') entries.push({ kind, commit: values[0] });
    else entries.push({ kind, sha: values[0] });
    at += arity + 1;
  }
  return entries;
}

// Every git call this module makes reads bytes, never text: 'latin1'
// decodes every byte 0-255 to the code point of the same value, never
// throwing on a byte sequence that is not valid UTF-8 (exactly the bytes an
// arbitrary binary blob is full of) and never collapsing several bytes into
// one code point the way UTF-8 decoding would, so a pattern written against
// byte offsets keeps matching the same content it always did. This is also
// what makes the shell version's own `LC_ALL=C` unnecessary: a byte-for-byte
// mapping has no locale to depend on in the first place. The paths arriving
// on standard input are decoded the same way, for the same reason and so
// that both halves of this module agree about what a byte is.
function git(args) {
  return spawnSync('git', args, { encoding: 'latin1', maxBuffer: GIT_MAX_BUFFER });
}

// The one place a path crosses back OUT of this module's byte world into
// git's argument list. Node encodes a spawn argument as UTF-8, so a path
// held here as one code point per byte has to be turned back into the
// string whose UTF-8 encoding is those same bytes; for the overwhelmingly
// common case (a path that IS valid UTF-8, accents and all) that round
// trips exactly. A path carrying a byte sequence that is not valid UTF-8
// cannot survive an argument list at all: it used to be handed over with a
// replacement character in it, and the push was then refused with a message
// blaming git for not finding the file, which sent whoever read it to
// debug the wrong thing. Returns null instead, so the caller can refuse
// while naming the real cause.
function pathAsGitArgument(bytePath) {
  const bytes = Buffer.from(bytePath, 'latin1');
  const asText = bytes.toString('utf8');
  if (!Buffer.from(asText, 'utf8').equals(bytes)) return null;
  return asText;
}

function readBlob(commit, path) {
  const result = git(['show', `${commit}:${path}`]);
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

// Reads message and identity for a list of commits in as few git processes
// as the argument list allows. The format is NUL-separated on purpose: a
// commit message contains newlines by design, so no line-oriented framing
// could bound one record. `git show -s` prints the records in the order the
// commits were given and separates them with a newline, which is why the
// first field of each record is trimmed before it is checked.
//
// Every record is verified against the commit it was asked about, and the
// whole call refuses if the field count or any of those ids does not line
// up. That check is the parse's own fail-closed clause: a commit message
// carrying a NUL byte (unusual, but a commit object may hold arbitrary
// bytes) would shift every field after it, and shifted fields must never be
// scanned as if they were the thing they are labelled as.
function readCommitMetadata(shas) {
  const format = '%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00';
  const result = git(['show', '-s', `--format=${format}`, ...shas]);
  if (result.error) throw new Error(`git show could not be run (${result.error.message})`);
  if (result.status !== 0) throw new Error(`git show exited ${result.status} while reading commit metadata`);
  const fields = (result.stdout ?? '').split('\0');
  if (fields[fields.length - 1] === '' || fields[fields.length - 1] === '\n') fields.pop();
  if (fields.length !== shas.length * 6) {
    throw new Error(`git show returned ${fields.length} field(s) for ${shas.length} commit(s) instead of ${shas.length * 6}`);
  }
  const records = [];
  for (let i = 0; i < shas.length; i += 1) {
    const at = i * 6;
    const sha = fields[at].replace(/^\n+/, '');
    if (sha !== shas[i]) {
      throw new Error(`git show returned metadata for a different commit than the one asked about (position ${i + 1} of ${shas.length})`);
    }
    records.push({
      sha,
      author: `${fields[at + 1]} <${fields[at + 2]}>`,
      committer: `${fields[at + 3]} <${fields[at + 4]}>`,
      message: fields[at + 5],
    });
  }
  return records;
}

// Splits a tag object as `git cat-file tag` prints it into the two things
// worth scanning (the tagger identity and the message) plus the object it
// points at, so a tag of a tag can be followed. Headers end at the first
// empty line; a tag object with no message has no empty line at all, which
// is a message of '' and not an error.
function parseTagObject(text) {
  const lines = text.split('\n');
  let target = null;
  let tagger = '';
  let at = 0;
  for (; at < lines.length; at += 1) {
    const line = lines[at];
    if (line === '') { at += 1; break; }
    if (line.startsWith('object ')) target = line.slice('object '.length).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice('tagger '.length);
  }
  return { target, tagger, message: lines.slice(at).join('\n') };
}

export async function runScanBlobs(argv, io) {
  // Checked before a single byte of stdin is read, and before a single git
  // call runs: see this module's own header on why the fail-closed check
  // must not be scoped to "only once something was found to scan".
  let patterns;
  let budgetMs;
  try {
    patterns = loadPatterns({ env: process.env });
    budgetMs = perScanBudgetMs(process.env);
  } catch (error) {
    io.stderr.write(`pre-push: ${error.message}; refusing to push.\n`);
    return EXIT.FAILURE;
  }

  const raw = await readStdin(io.stdin, { encoding: 'latin1' });
  let entries;
  try {
    entries = parseEntries(raw);
  } catch (error) {
    io.stderr.write(`pre-push: ${error.message}; refusing to push.\n`);
    return EXIT.FAILURE;
  }

  let failed = false;

  // Scans one piece of text and reports what it found, naming the CHANNEL
  // the text came from (`channel` reads as an object: "notes.md (CONTENT,
  // at 1a2b3c4)", "the message of commit 1a2b3c4 (COMMIT MESSAGE)"), so
  // both the finding and a failure to scan name the same thing and the
  // person reading knows which action the finding asks for: a content
  // match is fixed by editing a file, a path match by renaming one, a
  // message or identity match by rewriting the commit.
  //
  // Returns whether the text is CLEAN, so a caller that needs to decide
  // whether a value is safe to print (the path, below) can ask that
  // question without reaching into the result; a scan that raised is
  // neither clean nor scanned, and answers false.
  //
  // `max` is deliberately not passed: leak.mjs's DEFAULT_MAX (5) is the cap
  // this gate wants, one match already refuses the push, and restating a
  // library default as an argument makes a choice no test can fail. The
  // deadline IS passed, because with SCAN_BUDGET_ENV it is a value a test
  // can pin. A scan that raises refuses the push: that conversion, not the
  // catch itself, is the whole point of catching here, since one blob that
  // cannot be scanned must not stop the rest of the push being examined,
  // and a reported-then-forgotten failure is a push accepted unexamined.
  const scan = (text, channel) => {
    let result;
    try {
      result = scanText(text, patterns, { deadlineAt: Date.now() + budgetMs });
    } catch (error) {
      failed = true;
      io.stderr.write(`pre-push: could not scan ${channel}: ${error.message}; refusing instead of calling it clean.\n`);
      return false;
    }
    if (result.matches.length === 0) return true;
    failed = true;
    io.stderr.write(`pre-push: possible leak in ${channel}:\n`);
    for (const match of result.matches) {
      io.stderr.write(`    line ${match.line}, column ${match.column} (${match.pattern}): ${match.excerpt}\n`);
    }
    if (result.truncated) {
      io.stderr.write(`    ...and ${result.total - result.matches.length} more match(es) not shown.\n`);
    }
    return false;
  };

  const seenCommits = new Set();
  const commitQueue = [];

  for (const entry of entries) {
    if (entry.kind === 'commit') {
      if (!seenCommits.has(entry.commit)) {
        seenCommits.add(entry.commit);
        commitQueue.push(entry.commit);
      }
      continue;
    }

    if (entry.kind === 'tip') {
      let sha = entry.sha;
      for (let depth = 0; depth < MAX_TAG_DEPTH && sha !== null; depth += 1) {
        const type = git(['cat-file', '-t', sha]);
        if (type.error || type.status !== 0) {
          failed = true;
          const reason = type.error ? `git cat-file could not be run (${type.error.message})` : `git cat-file exited ${type.status}`;
          io.stderr.write(`pre-push: could not read the object ${sha.slice(0, 7)} this push points a ref at: ${reason}; refusing instead of calling it clean.\n`);
          break;
        }
        if ((type.stdout ?? '').trim() !== 'tag') break; // a commit tip carries no annotation of its own
        const body = git(['cat-file', 'tag', sha]);
        if (body.error || body.status !== 0) {
          failed = true;
          const reason = body.error ? `git cat-file could not be run (${body.error.message})` : `git cat-file exited ${body.status}`;
          io.stderr.write(`pre-push: could not read the tag object ${sha.slice(0, 7)}: ${reason}; refusing instead of calling it clean.\n`);
          break;
        }
        const short = sha.slice(0, 7);
        const tag = parseTagObject(body.stdout ?? '');
        scan(tag.message, `the message of tag object ${short} (TAG MESSAGE)`);
        scan(tag.tagger, `the tagger of tag object ${short} (TAGGER IDENTITY)`);
        sha = tag.target;
      }
      continue;
    }

    const { commit, mode, path } = entry;
    const short = commit.slice(0, 7);
    // The path FIRST, before anything about this blob is printed: whether
    // the path is safe to print is decided by scanning it, and every later
    // message about this blob uses the answer.
    const pathIsClean = scan(path, `a file name at ${short} (PATH, the name itself is withheld)`);
    const label = pathIsClean ? path : REDACTED_PATH;

    if (mode === GITLINK_MODE) {
      // Explicit, and said out loud: see the skip rule in the header.
      io.stderr.write(`pre-push: skipping ${label} (at ${short}): it is a gitlink (mode ${GITLINK_MODE}), whose content lives in another repository, so there is nothing here to read.\n`);
      continue;
    }

    const argPath = pathAsGitArgument(path);
    if (argPath === null) {
      failed = true;
      io.stderr.write(`pre-push: could not read ${label} (at ${short}): its path is not valid UTF-8, so it cannot be handed to git in an argument list; refusing instead of calling it clean.\n`);
      continue;
    }

    const blob = readBlob(commit, argPath);
    if (!blob.ok) {
      failed = true;
      const reason = blob.status === null
        ? `git show could not be run (${blob.detail})`
        : `git show exited ${blob.status}`;
      io.stderr.write(`pre-push: could not read ${label} (at ${short}): ${reason}; refusing instead of calling it clean.\n`);
      continue;
    }

    scan(blob.content, `${label} (CONTENT, at ${short})`);
  }

  for (let at = 0; at < commitQueue.length; at += METADATA_BATCH) {
    const batch = commitQueue.slice(at, at + METADATA_BATCH);
    let records;
    try {
      records = readCommitMetadata(batch);
    } catch (error) {
      failed = true;
      io.stderr.write(`pre-push: could not read the message and identity of ${batch.length} commit(s) of this push: ${error.message}; refusing instead of calling them clean.\n`);
      continue;
    }
    for (const record of records) {
      const short = record.sha.slice(0, 7);
      scan(record.message, `the message of commit ${short} (COMMIT MESSAGE)`);
      scan(record.author, `the author of commit ${short} (AUTHOR IDENTITY)`);
      if (record.committer !== record.author) {
        scan(record.committer, `the committer of commit ${short} (COMMITTER IDENTITY)`);
      }
    }
  }

  return failed ? EXIT.FAILURE : EXIT.OK;
}
