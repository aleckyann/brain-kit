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
//   - an annotated tag's MESSAGE and TAGGER identity;
//   - the whole raw HEADER BLOCK of every commit and of every tag object,
//     minus the identity spans the two channels above already scanned, so
//     that a header nobody enumerated (a tag object's own `tag` name, an
//     `encoding`, a `mergetag`, anything git grows next) is scanned by the
//     same clause as the ones that were enumerated;
//   - a REFERENCE's destination NAME, which is the field that decides
//     where the push lands and which sits on the remote afterwards,
//     readable by anyone who can list references, whether or not any
//     object went with it.
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
// A REFERENCE NAME is the same case taken further: there is no second
// field to identify a reference by, so a name that matched is never
// printed at all and the reference is named by its NUMBER in the push,
// which .githooks/pre-push assigns and uses in its own messages for the
// same reason. That number is the whole identification, and it is enough:
// it points at one line of the push the maintainer just typed.
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { EXIT } from '../exit-codes.mjs';
import { decodeLatin1Text, readStdin } from '../io.mjs';
import { MAX_SCAN_BYTES, OVERALL_SCAN_TIMEOUT_MS, loadPatterns, scanText } from '../leak.mjs';

// A generous ceiling on the output of one git call that LISTS or DESCRIBES
// (a batch of commit objects, a tree listing, a tag object). Node's own
// default (spawnSync's implicit maxBuffer, 1 MB) is small enough that an
// ordinary large push would overflow it and read back as a
// captured-error failure rather than real content; raising it here still
// fails closed the same way on anything that genuinely exceeds it;
// nothing above this is ever silently truncated and called clean.
//
// It is NOT the ceiling on a file's content any more (final fix round 2).
// It used to be, by accident: a blob over it was refused as "git show
// could not be run", which said nothing true, and it was sixty-four times
// the ceiling the adopting vault's gate applied to the very same file.
// Content is read against MAX_SCAN_BYTES (src/leak.mjs), the one number
// both gates share, and a blob over it is refused as too large, in those
// words.
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
export const METADATA_BATCH = 256;

// The batch size the metadata loop actually advances by, bounded below at
// one. The loop is `at += batch` over a list of commits, so a batch of zero
// never advances it: it spins forever, asking git about an empty slice each
// time round, and the push neither passes nor fails. A gate that HANGS is
// worse than one that refuses and worse than one that accepts, because
// those two at least tell you what happened; this one looks like a slow
// network. MAX_TAG_DEPTH below has had this bound since it was written and
// this one did not, which is the whole reason it is here.
//
// A value that is not a usable batch size becomes one rather than raising.
// One is always correct, only slower (one git process per commit, which is
// what this constant exists to avoid, not something it is required for), so
// there is no configuration mistake this can turn into a scan that does not
// happen. Anything that raised here would have to be caught somewhere, and
// a gate that refuses every push because a performance constant was
// mistyped teaches --no-verify.
export function metadataBatchSize(configured) {
  return Number.isInteger(configured) && configured >= 1 ? configured : 1;
}

// How far a chain of tag objects is followed (a tag of a tag of a tag).
// `git tag -a <new> <existing-tag>` builds one of these every time somebody
// re-tags, and `git push --tags` sends the whole chain, so this is ordinary
// traffic and not an adversarial shape. Bounded so a malformed chain cannot
// spin here; reaching the bound REFUSES rather than stopping quietly,
// because a chain still going when the bound runs out is something that
// should have been readable and was not, which is the refusing side of this
// module's own skip rule.
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

// Splits the NUL-separated record stream (see src/push/records.sh, which
// writes it, and which `push-gate` runs and hands to scanRecordStream; the
// maintainer's hook used to write it itself) into typed records. Every
// record is a kind followed by exactly the fields that kind takes, each field
// NUL-terminated:
//
//   blob   NUL <commit> NUL <mode> NUL <path> NUL
//   commit NUL <commit> NUL
//   tip    NUL <sha> NUL
//   ref    NUL <number> NUL <destination name> NUL
//
// THE REFERENCE RECORD CARRIES THE DESTINATION NAME, AND ONLY THAT.
// A push line gives the hook four fields, and two of them are names: the
// SOURCE (what is being pushed, local to this machine) and the
// DESTINATION (where it lands). Only the destination crosses the wire and
// only the destination exists on the remote afterwards, so only the
// destination is a channel. This gate has already learned once, the hard
// way, to read the field that decides where something lands rather than
// the one that says where it came from.
//
// Scanning the source as well was considered and rejected, and not only
// because it publishes nothing. It would take away the remedy: renaming
// on the way out, `git push origin <a local branch>:refs/heads/cleanup`,
// is exactly what a person does once this gate tells them their branch
// name is a problem, and a gate that refuses the fix it just asked for
// teaches --no-verify. The source name is not printed either, for the
// separate reason that it can be the same text as a destination name that
// matched.
//
// The NUMBER is the reference's position in the push, counted by the
// hook from 1 in the order git listed the lines. It exists because the
// name cannot be printed once it has matched, and a finding nobody can
// locate is a finding nobody acts on.
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
export const RECORD_PROTOCOL = 'brain-kit-scan-blobs-records-v3';

const RECORD_FIELDS = new Map([['blob', 3], ['commit', 1], ['tip', 1], ['ref', 2]]);

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
    else if (kind === 'ref') entries.push({ kind, number: values[0], name: values[1] });
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
//
// AND EVERY ONE PASSES --no-replace-objects, FIRST, BEFORE THE SUBCOMMAND.
// `git replace` installs a ref under refs/replace/ and every ordinary git
// read then reports the replacement wherever the original was asked about,
// while `git push` sends the object that is really there: the gate scanned
// one commit and the remote received another, with exit 0 and no output.
// The hook exports GIT_NO_REPLACE_OBJECTS for the same reason, and this is
// not redundant with it: the hook and this engine are one installation but
// two files, and a guarantee that holds only while both are current is not
// a guarantee. It is a FLAG rather than a second read of the environment
// because the environment is the thing being defended against here.
function git(args, input = undefined, { maxBuffer = GIT_MAX_BUFFER } = {}) {
  const options = { encoding: 'latin1', maxBuffer };
  if (input !== undefined) options.input = input;
  return spawnSync('git', ['--no-replace-objects', ...args], options);
}

// A git call that reads a FILE'S CONTENT, bounded by the ceiling both
// gates share rather than by the listing buffer above. spawnSync ends a
// child whose output passes the bound and reports ENOBUFS, and exactly
// the bound is still read, so the edge is the adopting vault's own ("over
// the limit", never "at it").
function gitContent(args) {
  return git(args, undefined, { maxBuffer: MAX_SCAN_BYTES });
}

// Why a content read failed, in words that say what happened. A blob over
// the ceiling is TOO LARGE, and says so; it is not a git that "could not
// be run", which is what the old shared buffer made it report.
function contentReadFailure(result, command) {
  if (result.error?.code === 'ENOBUFS') {
    return `it is larger than the ${MAX_SCAN_BYTES} byte limit this gate reads, so it was not scanned`;
  }
  if (result.error) return `${command} could not be run (${result.error.message})`;
  return `${command} exited ${result.status}`;
}

// Every way a per-invocation flag or an environment variable can inject
// git configuration into a child process. `git -c user.name=... push`
// propagates through GIT_CONFIG_PARAMETERS, and GIT_CONFIG_COUNT with its
// numbered KEY/VALUE pairs is the other half of the same mechanism.
const CONFIG_OVERRIDE_ENV_PREFIXES = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];

// The environment with those stripped. See readPushingIdentity for why
// exactly one git call in this module is made with it.
function envWithoutConfigOverrides(env) {
  const stripped = {};
  for (const [name, value] of Object.entries(env)) {
    if (CONFIG_OVERRIDE_ENV_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix))) continue;
    stripped[name] = value;
  }
  return stripped;
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
  const result = gitContent(['show', `${commit}:${path}`]);
  // git itself could not even be started (e.g. not found on PATH), the
  // blob is over the ceiling, or git refused: every one refuses the push
  // rather than treating the blob as clean. The hook already checks that
  // git exists before ever calling this command.
  if (result.error || result.status !== 0) {
    return { ok: false, reason: contentReadFailure(result, 'git show') };
  }
  return { ok: true, content: result.stdout ?? '' };
}

// An identity header's value as this module reports it: "Name <address>",
// the same shape readPushingIdentity builds, with git's trailing timestamp
// and zone cut off. A header with no address at all is reported whole
// rather than emptied, because an identity this cannot parse is still text
// the push publishes, and scanning more of it is the safe direction.
function identityFromHeader(value) {
  const end = value.lastIndexOf('>');
  return end === -1 ? value : value.slice(0, end + 1);
}

// Splits one raw commit object into the three things worth scanning.
// Headers run to the first empty line; a continuation line of a multi-line
// header (a gpgsig) begins with a space, so it can never be mistaken for
// the start of another one.
export function parseCommitObject(sha, body) {
  const blank = body.indexOf('\n\n');
  const headerText = blank === -1 ? body : body.slice(0, blank);
  const message = blank === -1 ? '' : body.slice(blank + 2);
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('author ')) author = identityFromHeader(line.slice('author '.length));
    else if (line.startsWith('committer ')) committer = identityFromHeader(line.slice('committer '.length));
  }
  return { sha, author, committer, message, headerText };
}

// THE WHOLE HEADER BLOCK, minus the spans a more specific channel already
// scanned.
//
// Six rounds of this gate answered "what else does an object publish?" by
// naming one more FIELD, and the naming has now been wrong twice inside
// the round that did the naming. An annotated tag records the name it was
// created under in its own `tag` header, so `git tag -a <a bad name>`
// followed by `git push origin <it>:refs/tags/<a clean name>` passed the
// reference-name channel and put the bad name on the remote inside the
// object, where cat-file prints it. A commit can carry `encoding`, any
// number of `parent` lines, a `gpgsig` with its continuation lines, and a
// `mergetag` that embeds an entire tag object; nothing bounds the set, and
// a list of fields is only ever as long as somebody's imagination on the
// day. So the block is scanned AS A WHOLE, which closes the named case and
// the unnamed ones in the same clause, and it is fewer clauses than the
// list it replaces.
//
// It scans the RESIDUE, not the raw block, and the difference is the whole
// design: every byte of the object is scanned exactly ONCE, by the most
// specific channel that covers it. The identity headers keep their own
// channels (AUTHOR IDENTITY, COMMITTER IDENTITY, TAGGER IDENTITY), because
// those findings name the remedy and because the identity exemption is
// keyed on them; their exact text is removed here so this scan neither
// reports the same leak twice under a vaguer name nor sees the pushing
// identity in every commit and deadlocks the maintainer the exemption was
// built for. Removal is by EXACT text on a line that declares that header,
// so a second, different `author` line (which no dedicated scan read) stays
// in the residue and is scanned here.
//
// The message is NOT part of this: the block ends at the first empty line
// and the message begins after it, so the two channels are disjoint by
// construction rather than by agreement, and there is nothing for them to
// drift apart about.
export function headerResidue(headerText, scannedIdentities) {
  const wanted = scannedIdentities.filter((entry) => entry.value !== '');
  if (wanted.length === 0) return headerText;
  return headerText.split('\n').map((line) => {
    for (const { key, value } of wanted) {
      if (!line.startsWith(`${key} `)) continue;
      const at = line.indexOf(value, key.length + 1);
      if (at === -1) continue;
      return line.slice(0, at) + line.slice(at + value.length);
    }
    return line;
  }).join('\n');
}

// Reads message and identity for a list of commits in ONE git process.
//
// This used to ask `git show -s --format=...%B%x00...` and split the
// result on NUL. The comment that stood here said the field-count and sha
// checks were the parse's own fail-closed clause against "a commit message
// carrying a NUL byte, which would shift every field after it". It does
// not shift. `%B` STOPS at a NUL byte, so git truncated the message before
// this module ever saw it, and everything after the NUL was never scanned
// at all: a reviewer wrote a commit object whose message was "harmless",
// a NUL, and then a pattern, and pushed it with exit 0 and the text in
// plaintext on the remote. The guards defended a mechanism that does not
// occur while the one that does occur was unguarded and untested, which is
// the worst arrangement of the two.
//
// So the OBJECT is read rather than a formatted field. `git cat-file
// --batch` emits "<sha> <type> <size>" and then exactly <size> bytes,
// which is framing a NUL cannot disturb: the length is declared, not
// inferred from a separator that the content is allowed to contain. Every
// record is still checked against the commit it was asked about, and now
// that check is load-bearing rather than decorative, because the byte
// count is what says where the next record begins.
function readCommitMetadata(shas) {
  const result = git(['cat-file', '--batch'], `${shas.join('\n')}\n`);
  if (result.error) throw new Error(`git cat-file could not be run (${result.error.message})`);
  if (result.status !== 0) throw new Error(`git cat-file exited ${result.status} while reading commit objects`);
  const out = result.stdout ?? '';
  const records = [];
  let at = 0;
  for (let i = 0; i < shas.length; i += 1) {
    const newline = out.indexOf('\n', at);
    if (newline === -1) {
      throw new Error(`git cat-file stopped after ${i} of ${shas.length} commit(s), with no header for the next one`);
    }
    const header = out.slice(at, newline);
    const parts = header.split(' ');
    if (parts.length !== 3) {
      throw new Error(`git cat-file answered "${header}" for the commit at position ${i + 1} of ${shas.length} instead of an object header`);
    }
    if (parts[0] !== shas[i]) {
      throw new Error(`git cat-file returned the object ${parts[0]} where ${shas[i]} was asked about (position ${i + 1} of ${shas.length})`);
    }
    if (parts[1] !== 'commit') {
      throw new Error(`git cat-file says ${shas[i]} is a ${parts[1]}, not a commit`);
    }
    const size = Number(parts[2]);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`git cat-file declared a size of "${parts[2]}" for ${shas[i]}, which is not a byte count`);
    }
    const body = out.slice(newline + 1, newline + 1 + size);
    if (body.length !== size) {
      throw new Error(`git cat-file declared ${size} byte(s) for ${shas[i]} and produced ${body.length}`);
    }
    records.push(parseCommitObject(shas[i], body));
    // The declared bytes, then git's own separating newline.
    at = newline + 1 + size + 1;
  }
  if (at !== out.length) {
    throw new Error(`git cat-file produced ${out.length - at} byte(s) more than the ${shas.length} commit(s) asked about account for`);
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
  let headerEnd = lines.length;
  for (; at < lines.length; at += 1) {
    const line = lines[at];
    if (line === '') { headerEnd = at; at += 1; break; }
    if (line.startsWith('object ')) target = line.slice('object '.length).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice('tagger '.length);
  }
  return {
    target,
    tagger,
    message: lines.slice(at).join('\n'),
    headerText: lines.slice(0, headerEnd).join('\n'),
  };
}

// The identity this push is being made under, as `git show` would render an
// author or committer of a commit made right now: "Name <address>".
//
// Read for ONE narrow purpose, the exemption in the metadata loop below.
// Returns null when either half is unset or unreadable, and null means NO
// exemption, so a configuration this cannot read makes the gate scan more
// rather than less.
//
// READ FROM THE CONFIGURATION FILES, NOT FROM THIS INVOCATION. `git -c
// user.name=... -c user.email=... push` propagates into every git call a
// hook makes, so the identity the exemption is keyed on used to be
// choosable by a flag, per push, leaving nothing behind in any file. A
// reviewer refused a commit authored under a pattern-matching name with an
// ordinary push and then pushed the same commit with exit 0 by naming that
// identity on the command line.
//
// The argument for leaving it was that somebody who can set
// GIT_CONFIG_PARAMETERS can equally set core.hooksPath, so nothing is
// gained. That is true about capability and wrong about shape, in the two
// ways the re-review names and I agree with. core.hooksPath is a
// persistent, visible change to a repository the maintainer reads, while
// `-c` is a per-command flag that leaves no trace and that a wrapper, an
// alias or an agent-composed push carries invisibly. And the blast radius
// differs: core.hooksPath turns the whole gate off, which is obvious the
// first time anything should have been caught, while `-c` turns off
// exactly this one channel and leaves the other four working, which reads
// as a gate that is on.
//
// So it is closed, and closing it costs nothing real. The deadlock the
// exemption exists for is a maintainer whose own name, as their git
// configuration FILES record it, is in their own pattern list; that is
// also the identity their commits are authored under, because that is
// where git reads an author from when it makes one. An identity supplied
// for one command is not a deadlock: nothing forces it, so nothing is
// owed an exemption for it.
function readPushingIdentity() {
  const env = envWithoutConfigOverrides(process.env);
  const name = spawnSync('git', ['--no-replace-objects', 'config', '--get', 'user.name'], { encoding: 'latin1', maxBuffer: GIT_MAX_BUFFER, env });
  const email = spawnSync('git', ['--no-replace-objects', 'config', '--get', 'user.email'], { encoding: 'latin1', maxBuffer: GIT_MAX_BUFFER, env });
  if (name.error || name.status !== 0 || email.error || email.status !== 0) return null;
  const readName = (name.stdout ?? '').replace(/\n+$/, '');
  const readEmail = (email.stdout ?? '').replace(/\n+$/, '');
  if (readName === '' || readEmail === '') return null;
  return `${readName} <${readEmail}>`;
}

// The personal pattern list and the per-scan budget, loaded the one way
// both callers load them (`scan-blobs` below and `push-gate`, which hands
// the enumeration's stream to scanRecordStream instead of reading stdin).
// Returns null after saying why when either cannot be loaded, and null
// REFUSES: the caller returns EXIT.FAILURE without scanning anything, which
// is this module's fail-closed contract (see its header), kept in one place
// so the two callers cannot come to disagree about it.
export function preparePersonalScan(io, env = process.env) {
  try {
    return { patterns: loadPatterns({ env }), budgetMs: perScanBudgetMs(env) };
  } catch (error) {
    io.stderr.write(`pre-push: ${error.message}; refusing to push.\n`);
    return null;
  }
}

export async function runScanBlobs(argv, io, { metadataBatch = METADATA_BATCH } = {}) {
  // Checked before a single byte of stdin is read, and before a single git
  // call runs: see this module's own header on why the fail-closed check
  // must not be scoped to "only once something was found to scan".
  const prepared = preparePersonalScan(io, process.env);
  if (prepared === null) return EXIT.FAILURE;
  const raw = await readStdin(io.stdin, { encoding: 'latin1' });
  return scanRecordStream(raw, { ...prepared, io, metadataBatch });
}

// Parses and scans one record stream (see parseEntries for its framing),
// held as latin1 text, one character per byte. Returns the exit code: OK
// when every channel was read and nothing matched (an exempt identity
// aside), FAILURE otherwise. Everything a push is refused or accepted for,
// once the stream exists, is decided here, for both callers.
export function scanRecordStream(raw, { patterns, budgetMs, io, metadataBatch = METADATA_BATCH }) {
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
  //
  // `exemptIfMatched` is the ONE narrow exception, and it exists because
  // one channel has no remedy. A content match is fixed by editing a file,
  // a path match by renaming one, a message match by rewriting the commit.
  // An AUTHOR IDENTITY match cannot be fixed by the person it is about: any
  // rewrite re-authors the commit as the same person, so a maintainer whose
  // own name is in their own pattern list, which is the single most likely
  // name for somebody protecting household data to put in it, has every
  // push refused forever with exactly two exits, deleting their own name
  // from the list or --no-verify. That is a deadlock that teaches the
  // bypass, and this gate has already rejected that shape twice.
  //
  // The exemption is EXACT and it is narrow: it applies only where the text
  // is byte for byte the identity this very push is configured under (see
  // readPushingIdentity). Somebody ELSE's name appearing as an author, which
  // is the case this channel exists for, still refuses. A substring match, a
  // case-insensitive match or a name-only match would all widen it into a
  // hole, and none of them is what a person cannot rewrite.
  //
  // The text is still SCANNED when it is exempt, not skipped: a scan that
  // cannot run still refuses. Only a match is forgiven, and it says so.
  // The identity itself is never printed, exactly because it matched.
  // Fix round 3 (finding E): counted so a clean push can SAY what it
  // checked. A clean run of this gate used to print nothing at all,
  // which made it byte-for-byte indistinguishable from no gate: delete
  // the installed hook directory and the same push succeeds with the
  // same empty output. That is this slice's own recurring shape (silence
  // read as safety) sitting in the one place where being wrong about it
  // publishes a credential. One line on success is the whole fix; its
  // ABSENCE is now the signal a maintainer can look for.
  let channelsScanned = 0;
  // Counted so the one clean summary line never says "nothing matched"
  // about a push in which something did match and was forgiven (final fix
  // round 2): an exemption applied is a fact the maintainer should see in
  // the summary too, not only in the line above it.
  let exemptionsApplied = 0;
  const scan = (text, channel, { exemptIfMatched = false } = {}) => {
    channelsScanned += 1;
    let result;
    try {
      // Every channel is held here as latin1, one character per byte, so
      // offsets, framing and the exact identity comparison stay
      // byte-exact; it is DECODED only now, the one way src/io.mjs
      // decodes for every scanner and every pattern source (final fix
      // round 2). Scanning the latin1 form made every pattern holding an
      // accented letter, written the ordinary way, match nothing.
      // The budget grows with the channel's size (src/leak.mjs, `accrue`),
      // the same budget the adopting vault's gate gives each file, so a
      // large ordinary blob is not refused as having run out of time. The
      // override above sets the floor it grows from, so a negative one
      // still refuses before a single line is read.
      result = scanText(decodeLatin1Text(text), patterns, { deadlineAt: Date.now() + budgetMs, accrue: true });
    } catch (error) {
      failed = true;
      io.stderr.write(`pre-push: could not scan ${channel}: ${error.message}; refusing instead of calling it clean.\n`);
      return false;
    }
    if (result.matches.length === 0) return true;
    if (exemptIfMatched) {
      exemptionsApplied += 1;
      io.stderr.write(`pre-push: ${channel} matches a pattern, but it is exactly the identity this push is being made under, so it is exempt and does not refuse the push (the identity itself is withheld). No rewrite can change it, so refusing here would leave only editing the patterns file or --no-verify.\n`);
      return false;
    }
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

  // The catch-all channel: see headerResidue above for why it is a block
  // and not a seventh field.
  //
  // WHAT IS WITHHELD, and the label says exactly that much and no more.
  // This is the MESSAGE channels' shape, not the PATH channel's: nothing
  // here re-derives or re-prints the block, and what the maintainer sees
  // is only leak.mjs's own per-match line, whose excerpt already replaces
  // the matched text with a fixed label and keeps the neutral pattern
  // name. A path is different because a path is printed in FULL, by this
  // module, in every later message about that blob, which is why that one
  // channel carries its own redaction and says so. Claiming "the headers
  // are withheld" here would have been false in the one direction that
  // matters: the excerpt does show the bytes AROUND a match, exactly as it
  // does for a commit message, and a label that oversells the contract is
  // how somebody ends up trusting it for something it never promised.
  //
  // A header block can hold SEVERAL matches. Each gets its own line under
  // this one channel, capped and counted by scanText exactly as every
  // other channel here caps and counts (leak.mjs's DEFAULT_MAX, then the
  // "...and N more" line). One match already refuses the push, so the cap
  // decides how much is reported, never whether it is caught, and a header
  // block is not special enough to deserve a second reporting rule.
  const scanHeaderBlock = (headerText, scannedIdentities, objectLabel) => {
    scan(
      headerResidue(headerText, scannedIdentities),
      `the header block of ${objectLabel} (OBJECT HEADER)`,
    );
  };

  // A PUSHED REF DOES NOT HAVE TO NAME A COMMIT, and this is what happens
  // when it does not. The tip loop below used to `break` on any object
  // type it did not recognise, which is a silent pass on an object that
  // very much had something to read: `git push origin <blob>:refs/leaks/one`
  // put a pattern on a bare remote with exit 0 and no output, and so did an
  // annotated tag naming a blob, and one naming a tree.
  //
  // Every type the chain can end at is handled BY NAME here, and the last
  // clause is a refusal rather than a fall-through, so a type nobody
  // thought of refuses instead of passing. That direction is the whole
  // lesson: this gate's skip rule says skip only what was never there, and
  // an object git will happily hand over is not that.
  const scanTerminalObject = (sha, type) => {
    const short = sha.slice(0, 7);
    // A commit tip carries no annotation of its own, and every commit this
    // push adds already has a `commit` record of its own.
    if (type === 'commit') return;

    if (type === 'blob') {
      const body = gitContent(['cat-file', 'blob', sha]);
      if (body.error || body.status !== 0) {
        failed = true;
        const reason = contentReadFailure(body, 'git cat-file');
        io.stderr.write(`pre-push: could not read the blob ${short} this push points a ref at: ${reason}; refusing instead of calling it clean.\n`);
        return;
      }
      scan(body.stdout ?? '', `the blob ${short} this push points a ref at (CONTENT)`);
      return;
    }

    if (type === 'tree') {
      // `-r` recurses, so every entry is a blob or a gitlink and no
      // subtree is left unvisited. `-z` keeps a path carrying a newline
      // intact, the same discipline the hook uses on its own lists.
      const listed = git(['ls-tree', '-r', '-z', sha]);
      if (listed.error || listed.status !== 0) {
        failed = true;
        const reason = listed.error ? `git ls-tree could not be run (${listed.error.message})` : `git ls-tree exited ${listed.status}`;
        io.stderr.write(`pre-push: could not list the tree ${short} this push points a ref at: ${reason}; refusing instead of calling it clean.\n`);
        return;
      }
      // THE FOURTH TIME, AND THE FIRST ONE IN CODE THIS ROUND WROTE.
      // `git ls-tree` on a tree with no entries succeeds and prints
      // nothing, and the loop below then runs zero times: nothing is
      // scanned, nothing is said, and the push carries on. Accepting it
      // is right, because an empty tree really has nothing in it to read,
      // but the SILENCE is not: a skip nobody can see reads exactly like
      // a scan that found nothing, which is the confusion this gate has
      // now shipped three times. It is the skipping side of this module's
      // own rule, so it says so out loud, like the gitlink does.
      //
      // The blob branch above needs no such line: an empty blob is
      // SCANNED, scanText really does run over its content and report
      // nothing. Here the loop does not run at all. That is the whole
      // difference the rule turns on.
      let entriesSeen = 0;
      for (const raw of (listed.stdout ?? '').split('\0')) {
        if (raw === '') continue;
        entriesSeen += 1;
        const tab = raw.indexOf('\t');
        if (tab === -1) {
          failed = true;
          io.stderr.write(`pre-push: git ls-tree produced an entry of the tree ${short} with no path in it; refusing rather than guessing what this push carries.\n`);
          continue;
        }
        const [entryMode, entryType, entrySha] = raw.slice(0, tab).split(' ');
        const entryPath = raw.slice(tab + 1);
        const pathIsClean = scan(entryPath, `a file name in the tree ${short} (PATH, the name itself is withheld)`);
        const label = pathIsClean ? decodeLatin1Text(entryPath) : REDACTED_PATH;
        if (entryMode === GITLINK_MODE) {
          io.stderr.write(`pre-push: skipping ${label} (in the tree ${short}): it is a gitlink (mode ${GITLINK_MODE}), whose content lives in another repository, so there is nothing here to read.\n`);
          continue;
        }
        if (entryType !== 'blob') {
          failed = true;
          io.stderr.write(`pre-push: ${label} (in the tree ${short}) is a ${entryType}, which this gate does not know how to read here; refusing instead of calling it clean.\n`);
          continue;
        }
        const content = gitContent(['cat-file', 'blob', entrySha]);
        if (content.error || content.status !== 0) {
          failed = true;
          const reason = contentReadFailure(content, 'git cat-file');
          io.stderr.write(`pre-push: could not read ${label} (in the tree ${short}): ${reason}; refusing instead of calling it clean.\n`);
          continue;
        }
        scan(content.stdout ?? '', `${label} (CONTENT, in the tree ${short})`);
      }
      if (entriesSeen === 0) {
        io.stderr.write(`pre-push: skipping the tree ${short} this push points a ref at: git lists no entries in it, so there is nothing here to read.\n`);
      }
      return;
    }

    failed = true;
    io.stderr.write(`pre-push: this push points a ref at the object ${short}, which git calls a "${type}"; this gate has no way to read one, and an object it cannot read is not an object that passed. Refusing instead of calling it clean.\n`);
  };

  const seenCommits = new Set();
  const commitQueue = [];
  // Counted for the one-line summary at the end (fix round 3, finding
  // E): references this gate actually READ, not references the hook
  // claimed, so a refusing record above is never counted as one checked.
  let refsSeen = 0;

  for (const entry of entries) {
    if (entry.kind === 'commit') {
      if (!seenCommits.has(entry.commit)) {
        seenCommits.add(entry.commit);
        commitQueue.push(entry.commit);
      }
      continue;
    }

    if (entry.kind === 'ref') {
      // THE NUMBER IS THE ONLY THING PRINTED ABOUT A REFERENCE, so the
      // number is checked before it is printed. Everything else in this
      // record is withheld the moment it matches, and a field that is
      // always printed is exactly where a name would have to travel to
      // survive that. The hook writes a decimal counter here; anything
      // else means the record did not come from the hook, or did not come
      // from it intact, and either way this module must not echo it back.
      // Refusing rather than printing a placeholder is the same direction
      // every other unreadable thing here takes.
      if (!/^[0-9]+$/.test(entry.number)) {
        failed = true;
        io.stderr.write('pre-push: a reference record in this push carries something other than a reference number in its number field, so this gate cannot say which reference it describes without printing the field itself; refusing instead of calling that reference clean.\n');
        continue;
      }
      // A push line with no destination name is not a push line this
      // module knows how to reason about: the destination is the field
      // that decides where everything else lands. It is the refusing side
      // of the skip rule, because something that should have been
      // readable was not.
      if (entry.name === '') {
        failed = true;
        io.stderr.write(`pre-push: reference #${entry.number} of this push has no destination name, so this gate cannot tell where it lands or scan the name it lands under; refusing instead of calling it clean.\n`);
        continue;
      }
      scan(entry.name, `the destination name of reference #${entry.number} of this push (REFERENCE NAME, the name itself is withheld)`);
      refsSeen += 1;
      continue;
    }

    if (entry.kind === 'tip') {
      // The CHAIN, not the first link. A tag object can name another tag
      // object, and each one carries a message and a tagger identity of its
      // own, so every level is scanned on the way down to the object the
      // chain finally names. Following only the first level is a ONE LINE
      // edit that walks a leak onto the remote in plaintext: the inner
      // tag's message is pushed with the outer one and never read. Both the
      // scanning of every level and the bound below are defended by tests
      // for that reason.
      let sha = entry.sha;
      // Counts TAG OBJECTS READ, not turns of the loop. The last turn reads
      // the commit (or blob, or tree) the chain finally names and breaks
      // out without following anything, so counting turns would make the
      // bound one tighter than it says it is and refuse a chain of exactly
      // MAX_TAG_DEPTH tags, which is ordinary traffic. Both edges have a
      // test: a chain AT the bound must push, one past it must refuse.
      let tagsRead = 0;
      while (sha !== null) {
        const type = git(['cat-file', '-t', sha]);
        if (type.error || type.status !== 0) {
          failed = true;
          const reason = type.error ? `git cat-file could not be run (${type.error.message})` : `git cat-file exited ${type.status}`;
          io.stderr.write(`pre-push: could not read the object ${sha.slice(0, 7)} this push points a ref at: ${reason}; refusing instead of calling it clean.\n`);
          break;
        }
        const objectType = (type.stdout ?? '').trim();
        if (objectType !== 'tag') {
          // The end of the chain. Handled by type, and a type this gate
          // does not know refuses rather than breaking out in silence.
          scanTerminalObject(sha, objectType);
          break;
        }
        if (tagsRead >= MAX_TAG_DEPTH) {
          failed = true;
          io.stderr.write(`pre-push: the ref this push points at is a chain of more than ${MAX_TAG_DEPTH} tag objects, so this gate stopped before reaching the object it finally names; refusing instead of calling the rest of the chain clean.\n`);
          break;
        }
        tagsRead += 1;
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
        // Every tag object git writes begins with `object`, `type` and
        // `tag` headers, so an EMPTY block is not "a tag with nothing in
        // its headers", it is a tag object this module failed to read.
        // The refusing side of the skip rule, and the same answer the
        // empty destination name gets.
        if (tag.headerText === '') {
          failed = true;
          io.stderr.write(`pre-push: the tag object ${short} has no header block at all, so this gate cannot read the name it was created under or what it points at; refusing instead of calling it clean.\n`);
          break;
        }
        scanHeaderBlock(tag.headerText, [{ key: 'tagger', value: tag.tagger }], `tag object ${short}`);
        if (tag.target === null) {
          // A tag object git printed, that this module read, and that names
          // no object at all. git does not produce this, which is exactly
          // why it must not be shrugged off: it means the chain ends
          // somewhere other than where the tag says it does, and whatever
          // is past it went unread.
          failed = true;
          io.stderr.write(`pre-push: the tag object ${short} names no object, so this gate cannot follow it to what this push actually points at; refusing instead of calling what it points at clean.\n`);
          break;
        }
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
    // Printed in the one decoding every scanner shares, so an accented
    // name reads as itself rather than as the two characters per letter
    // its latin1 form would print as.
    const label = pathIsClean ? decodeLatin1Text(path) : REDACTED_PATH;

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
      io.stderr.write(`pre-push: could not read ${label} (at ${short}): ${blob.reason}; refusing instead of calling it clean.\n`);
      continue;
    }

    scan(blob.content, `${label} (CONTENT, at ${short})`);
  }

  // Read once for the whole push, not once per commit: it is the same
  // answer every time and it costs two git processes.
  const pushingIdentity = commitQueue.length > 0 ? readPushingIdentity() : null;

  const batchSize = metadataBatchSize(metadataBatch);
  for (let at = 0; at < commitQueue.length; at += batchSize) {
    const batch = commitQueue.slice(at, at + batchSize);
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
      scan(record.author, `the author of commit ${short} (AUTHOR IDENTITY)`, {
        exemptIfMatched: pushingIdentity !== null && record.author === pushingIdentity,
      });
      if (record.committer !== record.author) {
        scan(record.committer, `the committer of commit ${short} (COMMITTER IDENTITY)`, {
          exemptIfMatched: pushingIdentity !== null && record.committer === pushingIdentity,
        });
      }
      // Every commit object git writes begins with a `tree` header, so an
      // empty block is an unread object rather than an object with nothing
      // in it. Refuses, like the tag above.
      if (record.headerText === '') {
        failed = true;
        io.stderr.write(`pre-push: commit ${short} has no header block at all, so this gate cannot read the headers it publishes; refusing instead of calling it clean.\n`);
        continue;
      }
      scanHeaderBlock(
        record.headerText,
        [{ key: 'author', value: record.author }, { key: 'committer', value: record.committer }],
        `commit ${short}`,
      );
    }
  }

  if (failed) return EXIT.FAILURE;
  // stderr, like every other line this gate writes: git's own stdout for
  // a push is the push's own report, and this is the gate talking about
  // itself. It names counts only, never a path, a name or a ref: the
  // number of channels is not a fact any pattern could hide in, which is
  // the same reasoning the reference-number record above already states
  // for the one other number this module prints.
  if (exemptionsApplied > 0) {
    io.stderr.write(`pre-push: brain-kit leak gate ran: scanned ${channelsScanned} channel(s) across ${refsSeen} reference(s) of this push; no match refuses it, and ${exemptionsApplied} identity match(es) were exempt because each is exactly the identity this push is made under (withheld).\n`);
    return EXIT.OK;
  }
  io.stderr.write(`pre-push: brain-kit leak gate ran: scanned ${channelsScanned} channel(s) across ${refsSeen} reference(s) of this push; nothing matched.\n`);
  return EXIT.OK;
}
