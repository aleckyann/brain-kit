// `brain-kit push-gate <remote-name> <remote-url> --patterns personal|config`:
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
// the gate an adopting vault installs (templates/githooks/pre-push) with
// `--patterns config`, the patterns the vault's configuration declares.
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
// each hold the rule without trusting the other to. A stream that exits 0
// must still answer for every reference line git sent: the lines are
// counted here, independently, and the stream's references must be
// exactly 1..n, or it refuses naming both counts.
//
// ITS OWN SENTENCES ARE ENGLISH, whatever BRAIN_KIT_LANG says: src/cli.mjs
// hands it a translator fixed to English, because every other line of the
// gate it prints among is English (see the note there).
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { decodeBytes } from '../io.mjs';
import { loadPatterns } from '../leak.mjs';
import { findVaultRoot } from '../vault.mjs';
import { parseEntries, perScanBudgetMs, preparePersonalScan, scanRecordStream, withoutByteOrderMark } from './scan-blobs.mjs';

// The pattern lists this command knows how to load. `personal` is the
// maintainer's own list outside any repository (src/leak.mjs,
// loadPatterns). `config` is the adopting vault's own, from its
// brain-kit.config.json (prepareConfigScan below), and it never reads the
// personal list: each value has a branch of its own in runPushGate, and a
// value without one is refused there rather than scanned with whichever
// list happens to be the fallback. There is no default: a default is a
// list nobody chose.
export const PATTERN_SOURCES = Object.freeze(['personal', 'config']);

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
  // A git stopped by a signal said nothing about the directory, so it must
  // not be reported as the wrong directory: that would send the person to
  // look for a problem that is not there.
  if (repository.status === null) {
    io.stderr.write(`${t('push_gate.git_killed', { signal: String(repository.signal) })}\n`);
    return EXIT.FAILURE;
  }
  if (repository.status !== 0) {
    io.stderr.write(`${t('push_gate.not_a_repository')}\n`);
    return EXIT.USAGE;
  }

  // Bytes, not text: the reference lines carry names git allows to be any
  // bytes, and the enumeration must see the ones git wrote. A read that
  // fails part way is refused rather than kept: the lines that did arrive
  // would be counted, enumerated and scanned as if they were the push.
  let input;
  try {
    input = await readAllBytes(io.stdin);
  } catch (error) {
    io.stderr.write(`${t('push_gate.stdin_unreadable', { reason: error.message })}\n`);
    return EXIT.FAILURE;
  }
  const records = spawnSync('bash', [recordsScript, args.remoteName, args.remoteUrl], {
    input,
    maxBuffer: maxStreamBytes,
  });
  // Its messages first, in the order it wrote them, before anything this
  // command says about them.
  if (records.stderr && records.stderr.length > 0) io.stderr.write(records.stderr);
  if (records.error) {
    // The bound applies to both of the enumeration's streams, and the
    // sentence has to name the one that passed it: the records, or its
    // messages. Either way nothing is scanned.
    if (records.error.code === 'ENOBUFS' && (records.stdout?.length ?? 0) >= maxStreamBytes) {
      io.stderr.write(`${t('push_gate.stream_too_large', { limit: maxStreamBytes })}\n`);
    } else if (records.error.code === 'ENOBUFS') {
      io.stderr.write(`${t('push_gate.messages_too_large', { limit: maxStreamBytes })}\n`);
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

  // THE STREAM MUST ANSWER FOR EVERY REFERENCE GIT SENT. An enumeration
  // that exits 0 having listed fewer references than git gave it is a push
  // whose missing references are never scanned, and it reads as "nothing
  // matched": an installed records.sh truncated to zero bytes did exactly
  // that and let a leak land. So the reference lines on standard input are
  // counted here, independently of the enumeration, and the stream's
  // `ref` records must be exactly 1..n, in order. The count follows the
  // enumeration's own loop: every newline ends a line, and an unterminated
  // last line counts when it carries a field.
  const stream = records.stdout.toString('latin1');
  const destinations = referenceDestinations(input);
  const sent = destinations.length;
  let listed;
  try {
    listed = parseEntries(stream).filter((entry) => entry.kind === 'ref');
  } catch {
    // A stream that does not parse is refused by the scanner, with its own
    // reason; there is nothing to count here.
    listed = null;
  }
  if (listed !== null) {
    if (listed.length !== sent) {
      io.stderr.write(`${t('push_gate.reference_count_mismatch', { sent, listed: listed.length })}\n`);
      return EXIT.FAILURE;
    }
    if (listed.some((entry, index) => entry.number !== String(index + 1))) {
      io.stderr.write(`${t('push_gate.reference_numbering', { sent })}\n`);
      return EXIT.FAILURE;
    }
    // And each one must be the destination git named on that line, read
    // here from the right the way the enumeration reads it, so a line
    // whose fields shifted is refused even if the enumeration's own parse
    // regressed. Neither name is printed: either may be the one that
    // matches a pattern.
    const differs = listed.findIndex((entry, index) => entry.name !== destinations[index]);
    if (differs !== -1) {
      io.stderr.write(`${t('push_gate.reference_name_mismatch', { number: differs + 1 })}\n`);
      return EXIT.FAILURE;
    }
  }

  // Loaded AFTER the enumeration, which is the order the maintainer's gate
  // always had (the hook enumerated, then scan-blobs checked the patterns
  // file), and still for every push that got this far, one with nothing in
  // it included: the fail-closed check is never scoped to "only once
  // something was found to scan".
  let prepared;
  if (args.patterns === 'personal') {
    prepared = preparePersonalScan(io, process.env);
    if (prepared === null) return EXIT.FAILURE;
  } else if (args.patterns === 'config') {
    const outcome = prepareConfigScan(io, t, args.remoteName, input, process.env);
    if (outcome.exit !== undefined) return outcome.exit;
    prepared = outcome.prepared;
  } else {
    // parsePushGateArgs admits only PATTERN_SOURCES, so this is reached
    // only by a value added there without a branch here, and that must not
    // scan with anything.
    io.stderr.write(`${t('push_gate.unknown_patterns', { value: args.patterns, expected: PATTERN_SOURCES.join(', ') })}\n`);
    return EXIT.USAGE;
  }
  return scanRecordStream(stream, { ...prepared, io });
}

// --- --patterns config ------------------------------------------------------
//
// WHICH CONFIGURATIONS SUPPLY THE PATTERNS (ruled 22/09/2026, widened
// 23/09/2026 after review). The configuration is data, and a pushed branch
// can delete a pattern from it and then violate that pattern in the same
// push. So the set is the generic credential shapes plus the UNION of
// privacy.secret_patterns from:
//
//   - the working tree's configuration, which is what is about to be
//     committed;
//   - the configuration at EVERY pushed tip: a branch can add a pattern,
//     and a pattern added can only refuse more;
//   - every configuration the push carries that no remote-tracking
//     reference holds yet, so a vault's first push, with nothing
//     published, still reads a pattern its own history declared;
//   - the configuration on the remote's default branch as this repository
//     knows it, which is what a person merged. For the named remote that is
//     the first of refs/remotes/<remote>/HEAD (a branch of that remote),
//     refs/remotes/<remote>/main and refs/remotes/<remote>/master that
//     resolves to a commit: `git remote add` plus a first push creates
//     <remote>/main and never <remote>/HEAD, which is how most vaults
//     start. On a push by url, or for a name with none of the three, the
//     same ladder is walked for EVERY configured remote.
//
// A union can only over-include. The one line saying the push is scanned
// without a default branch prints only when none of those resolved, and it
// names a command that makes one resolve in that case.
//
// A configuration that cannot be USED (not JSON, not a JSON object, not a
// file, or a privacy.secret_patterns that is not a list of strings) adds
// nothing and says so on one line, naming where it is; it is never
// reported as read. Nothing else in it is checked: a configuration another
// engine version wrote still contributes its patterns. An object git
// cannot read refuses, and so does a pattern that does not compile, naming
// the configuration it lives in, because refusing is the only safe answer
// and a person needs to know which file to fix.
//
// THE CONFIGURATION FILE'S OWN CONTENT is read against the generic shapes
// alone (see scanRecordStream's configContent), and only when that blob
// parses as a JSON object: it is where the literal patterns are declared,
// so it matches every one of them. A literal written into another field of
// the checked-out configuration is left unrefused, the trade-off the
// linter's `secrets` rule already makes for that one file
// (src/rules/lint.mjs). The same literal in the configuration's HISTORY,
// or in any JSON object stored at that path, is this gate's own accepted
// trade-off: the linter never reads history. Anything else stored under
// that name is an ordinary file.
//
// Returns { prepared } for scanRecordStream, or { exit } after saying why.
export function prepareConfigScan(io, t, remoteName, input, env = process.env, cwd = process.cwd()) {
  const line = (text) => io.stderr.write(`${text}\n`);
  const file = CONFIG_FILENAME;
  const remote = withoutUserinfo(remoteName);

  const vaultRoot = findVaultRoot(cwd);
  if (vaultRoot === null) {
    line(t('push_gate.not_a_vault', { file }));
    return { exit: EXIT.USAGE };
  }
  let working;
  try {
    working = loadConfig(vaultRoot);
  } catch (error) {
    line(t('push_gate.config_unloadable', { file, reason: error.message }));
    return { exit: EXIT.FAILURE };
  }
  const configPath = configPathInRepository(vaultRoot);

  // Each source is compiled on its own first, so a pattern that does not
  // compile is refused naming the configuration it came from.
  const sources = [{ kind: 'working', patterns: secretPatternsOf(working) }];

  if (configPath === null) {
    line(t('push_gate.config_outside_repository', { file }));
  } else {
    // Every pushed tip, once each, in the order git sent them.
    const seen = new Set();
    pushedTips(input).forEach(({ sha, number }) => {
      if (seen.has(sha)) return;
      seen.add(sha);
      sources.push({ kind: 'tip', number, sha, read: readConfigAtCommit(`${sha}^{commit}`, configPath, { missingCommitIsAbsent: true }) });
    });
    // Every configuration the push itself carries that no remote-tracking
    // reference holds yet: on a vault's first push nothing is published,
    // and a pattern declared in an earlier commit of the same push and
    // dropped on the pushed branch would otherwise be read nowhere. One
    // rev-list over the commits that changed the file; adding can only
    // over-include.
    const carried = carriedConfigCommits(sources.filter((source) => source.kind === 'tip').map((source) => source.sha), configPath);
    if (carried.failed) {
      line(t('push_gate.carried_config_list_failed', { path: configPath, reason: carried.reason }));
      return { exit: EXIT.FAILURE };
    }
    for (const commit of carried.commits) {
      sources.push({ kind: 'carried', commit: commit.slice(0, 7), read: readConfigAtCommit(commit, configPath) });
    }
    const branches = defaultBranches(remoteName);
    for (const branch of branches.resolved) {
      sources.push({ kind: 'default', branch: branch.name, read: readConfigAtCommit(branch.sha, configPath) });
    }
    if (branches.resolved.length === 0) {
      // Each names a command that makes a rung resolve in its own case:
      // a remote-tracking branch for a named remote, every configured
      // remote's for a push by url, and a remote to track for none.
      //
      // A named remote with no remote-tracking reference at all is either
      // one nothing is published to yet, where no command can make a
      // default branch appear and `set-head --auto` only fails ("Cannot
      // determine remote HEAD"), or one this clone never fetched, where a
      // fetch is what works. The line says both, and names only the fetch.
      if (branches.nameIsRemote && !hasRemoteTrackingRefs(remoteName)) {
        line(t('push_gate.default_branch_unresolved_unfetched', { file, remote, command: `git fetch ${quotedForShell(remote)}` }));
      } else if (branches.nameIsRemote) {
        const command = `git fetch ${quotedForShell(remote)} && git remote set-head ${quotedForShell(remote)} --auto`;
        line(t('push_gate.default_branch_unresolved_named', { file, remote, command }));
      } else if (branches.remotes.length > 0) {
        line(t('push_gate.default_branch_unresolved_by_url', { file, remote, remotes: branches.remotes.join(', ') }));
      } else {
        const command = `git remote add origin ${quotedForShell(remote)} && git fetch origin`;
        line(t('push_gate.default_branch_unresolved_no_remotes', { file, remote, command }));
      }
    }
  }

  for (const source of sources) {
    if (source.kind === 'working') continue;
    const { read } = source;
    if (read.state === 'failed') {
      if (source.kind === 'tip') line(t('push_gate.tip_config_read_failed', { path: configPath, number: source.number, reason: read.reason }));
      else if (source.kind === 'carried') line(t('push_gate.carried_config_read_failed', { path: configPath, commit: source.commit, reason: read.reason }));
      else line(t('push_gate.default_branch_read_failed', { path: configPath, branch: source.branch, reason: read.reason }));
      return { exit: EXIT.FAILURE };
    }
    if (read.state === 'unusable') {
      if (source.kind === 'tip') line(t('push_gate.tip_config_unusable', { path: configPath, number: source.number, reason: read.reason }));
      else if (source.kind === 'carried') line(t('push_gate.carried_config_unusable', { path: configPath, commit: source.commit, reason: read.reason }));
      else line(t('push_gate.default_config_unusable', { path: configPath, branch: source.branch, reason: read.reason }));
    } else if (read.state === 'absent' && source.kind === 'default') {
      line(t('push_gate.default_branch_no_config', { path: configPath, branch: source.branch }));
    }
    source.patterns = read.state === 'read' ? read.patterns : [];
  }

  for (const source of sources) {
    try {
      loadPatterns({ configPatterns: source.patterns });
    } catch (error) {
      if (source.kind === 'working') line(t('push_gate.pattern_uncompilable_working', { file, reason: error.message }));
      else if (source.kind === 'tip') line(t('push_gate.pattern_uncompilable_tip', { path: configPath, number: source.number, reason: error.message }));
      else if (source.kind === 'carried') line(t('push_gate.pattern_uncompilable_carried', { path: configPath, commit: source.commit, reason: error.message }));
      else line(t('push_gate.pattern_uncompilable_default', { path: configPath, branch: source.branch, reason: error.message }));
      return { exit: EXIT.FAILURE };
    }
  }

  const usedBranches = sources.filter((source) => source.kind === 'default' && source.read.state === 'read').map((source) => source.branch);
  const usedTips = sources.filter((source) => source.kind === 'tip' && source.read.state === 'read').length;
  const usedCarried = sources.filter((source) => source.kind === 'carried' && source.read.state === 'read').length;
  if (usedBranches.length > 0) {
    line(t('push_gate.config_patterns_union', { file, tips: usedTips, carried: usedCarried, branches: usedBranches.join(', ') }));
  }

  try {
    const patterns = loadPatterns({ configPatterns: sources.flatMap((source) => source.patterns) });
    const shapesOnly = loadPatterns({});
    const budgetMs = perScanBudgetMs(env);
    const configContent = configPath === null ? null : { path: Buffer.from(configPath, 'utf8').toString('latin1'), patterns: shapesOnly };
    return { prepared: { patterns, budgetMs, configContent } };
  } catch (error) {
    io.stderr.write(`pre-push: ${error.message}; refusing to push.\n`);
    return { exit: EXIT.FAILURE };
  }
}

// A word as a person can paste it into a POSIX shell: as it is when it
// holds nothing a shell reads specially, and single-quoted otherwise. Only
// for the remedy sentences, which a person copies; nothing here runs it.
export function quotedForShell(word) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

// privacy.secret_patterns of a configuration the schema already accepted.
function secretPatternsOf(config) {
  const listed = config?.privacy?.secret_patterns;
  return Array.isArray(listed) ? listed.filter((entry) => typeof entry === 'string') : [];
}

// Every git read here refuses replacement objects: a local `git replace`
// over the default branch's configuration would otherwise choose the
// patterns this push is judged by.
function gitRead(args, encoding = 'utf8') {
  return spawnSync('git', ['--no-replace-objects', ...args], {
    encoding,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

// The local object id of every reference line that is not a deletion, with
// the line's number, read from the right as the enumeration reads it. The
// enumeration has already refused a line whose ids are not ids.
export function pushedTips(bytes) {
  const tips = [];
  const text = Buffer.from(bytes).toString('latin1');
  const pieces = text.split('\n');
  const tail = pieces.pop();
  if (/[^ \t]/.test(tail)) pieces.push(tail);
  pieces.forEach((piece, index) => {
    const words = piece.split(' ');
    if (words.length < 4) return;
    const sha = words[words.length - 3];
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) || /^0+$/.test(sha)) return;
    tips.push({ sha, number: index + 1 });
  });
  return tips;
}

// The vault's configuration file as a path inside the repository being
// pushed (forward slashes, relative to its top level), which is the path
// every blob record of the push names it by. null when the vault root is
// not inside that repository, where no commit of it can hold the file.
function configPathInRepository(vaultRoot) {
  const top = gitRead(['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return null;
  let rel;
  try {
    rel = relative(realpathSync(top.stdout.replace(/\n$/, '')), realpathSync(vaultRoot));
  } catch {
    return null;
  }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const parts = rel === '' ? [] : rel.split(sep);
  return [...parts, CONFIG_FILENAME].join('/');
}

// The commits reachable from the pushed tips that change the configuration
// and that no remote-tracking reference reaches: what the push publishes
// for the first time. Tips that are not commits are left out, since
// rev-list refuses them. { commits } or { failed, reason }.
function carriedConfigCommits(tips, configPath) {
  const commits = [];
  for (const tip of tips) {
    const commit = gitRead(['rev-parse', '-q', '--verify', `${tip}^{commit}`]);
    if (!commit.error && commit.status === 0) commits.push(commit.stdout.trim());
  }
  if (commits.length === 0) return { commits: [] };
  const listed = gitRead(['rev-list', '--full-history', ...commits, '--not', '--remotes', '--', configPath]);
  if (listed.error) return { failed: true, reason: listed.error.message };
  if (listed.status !== 0) return { failed: true, reason: `git rev-list exited ${listed.status}` };
  return { commits: listed.stdout.split('\n').filter((line) => line !== '' && !commits.includes(line)) };
}

// Whether this clone holds any remote-tracking reference of `remote`.
function hasRemoteTrackingRefs(remote) {
  const listed = gitRead(['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/${remote}/`]);
  return !listed.error && listed.status === 0 && listed.stdout.trim() !== '';
}

const DEFAULT_BRANCH_RUNGS = ['HEAD', 'main', 'master'];

// The first rung of one remote's ladder that resolves to a commit, as
// { name, sha }, or null. HEAD counts only as a symbolic reference to a
// branch of that same remote.
function defaultBranchOf(remote) {
  const prefix = `refs/remotes/${remote}/`;
  for (const rung of DEFAULT_BRANCH_RUNGS) {
    let target = `${prefix}${rung}`;
    if (rung === 'HEAD') {
      const symref = gitRead(['symbolic-ref', '-q', target]);
      if (symref.error || symref.status !== 0) continue;
      target = symref.stdout.trim();
      if (!target.startsWith(prefix) || target.length === prefix.length) continue;
    }
    const commit = gitRead(['rev-parse', '-q', '--verify', `${target}^{commit}`]);
    if (commit.error || commit.status !== 0) continue;
    return { name: target.slice('refs/remotes/'.length), sha: commit.stdout.trim() };
  }
  return null;
}

// The default branches this push is judged against: the named remote's
// when its ladder resolves (its remote-tracking references decide, whether
// or not the name is still configured), and otherwise every configured
// remote's.
function defaultBranches(remoteName) {
  const listed = gitRead(['remote']);
  const remotes = listed.error || listed.status !== 0 ? [] : listed.stdout.split('\n').filter((name) => name !== '');
  const nameIsRemote = remotes.includes(remoteName);
  const own = defaultBranchOf(remoteName);
  if (own !== null) return { resolved: [own], nameIsRemote, remotes };
  const resolved = remotes.map(defaultBranchOf).filter((branch) => branch !== null);
  return { resolved, nameIsRemote, remotes };
}

// The configuration at `revision` (a commit), read as the blob it is, with
// cat-file: no text conversion, no filter, no replacement object. Returns
// { state: 'read', patterns } | 'absent' | 'unusable' (with a reason) |
// 'failed' (git could not read what it said was there).
function readConfigAtCommit(revision, configPath, { missingCommitIsAbsent = false } = {}) {
  const commit = gitRead(['rev-parse', '-q', '--verify', revision]);
  if (commit.error) return { state: 'failed', reason: commit.error.message };
  // A pushed tip that is a tag of a tree or a blob has no configuration.
  if (commit.status !== 0) return missingCommitIsAbsent ? { state: 'absent' } : { state: 'failed', reason: `${revision} does not resolve to a commit` };
  const sha = commit.stdout.trim();
  const entry = gitRead(['rev-parse', '-q', '--verify', `${sha}:${configPath}`]);
  if (entry.error) return { state: 'failed', reason: entry.error.message };
  if (entry.status !== 0) return { state: 'absent' };
  const oid = entry.stdout.trim();
  const type = gitRead(['cat-file', '-t', oid]);
  if (type.error || type.status !== 0) return { state: 'failed', reason: type.error ? type.error.message : `git cat-file exited ${type.status}` };
  if (type.stdout.trim() !== 'blob') return { state: 'unusable', reason: `it is a ${type.stdout.trim()}, not a file` };
  const blob = gitRead(['cat-file', 'blob', oid], 'buffer');
  if (blob.error || blob.status !== 0) return { state: 'failed', reason: blob.error ? blob.error.message : `git cat-file exited ${blob.status}` };
  let parsed;
  try {
    parsed = JSON.parse(withoutByteOrderMark(decodeBytes(blob.stdout)));
  } catch (error) {
    return { state: 'unusable', reason: error.message };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unusable', reason: 'it is not a JSON object' };
  // Only the shape this read needs, never the whole schema: a
  // configuration written by another version of the engine (a key this
  // one does not know, one it no longer has) still declares its patterns,
  // and the schema's refusal would drop them.
  const privacy = parsed.privacy;
  if (privacy === undefined) return { state: 'read', patterns: [] };
  if (privacy === null || typeof privacy !== 'object' || Array.isArray(privacy)) return { state: 'unusable', reason: 'its privacy field is not an object' };
  const listed = privacy.secret_patterns;
  if (listed === undefined) return { state: 'read', patterns: [] };
  if (!Array.isArray(listed) || listed.some((entry) => typeof entry !== 'string')) return { state: 'unusable', reason: 'its privacy.secret_patterns is not a list of strings' };
  return { state: 'read', patterns: listed };
}

// A url as it may be printed: without its userinfo, which can carry a
// token. The same rule as without_userinfo in src/push/records.sh: in a url
// with a scheme, everything in the authority up to its last `@`; in the scp
// form, a prefix before the first slash whose last `@` is followed by a
// colon. Anything else, a remote name or a local path, is itself.
export function withoutUserinfo(url) {
  const scheme = url.indexOf('://');
  if (scheme !== -1) {
    const rest = url.slice(scheme + 3);
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const at = authority.lastIndexOf('@');
    if (at === -1) return url;
    return `${url.slice(0, scheme + 3)}${authority.slice(at + 1)}${rest.slice(authority.length)}`;
  }
  const slash = url.indexOf('/');
  const prefix = slash === -1 ? url : url.slice(0, slash);
  const at = prefix.lastIndexOf('@');
  if (at === -1 || !prefix.slice(at + 1).includes(':')) return url;
  return url.slice(at + 1);
}

// All of standard input as bytes. Unlike src/io.mjs's readStdin, which
// resolves with what it has on a stream error, this rejects: see above.
// A terminal has no reference lines to give, and reads as none.
//
// EVERY CHUNK, not the first. A pipe hands over at most 64 KiB per read,
// and git writes each reference line in one write, so the first chunk of a
// long push ends on a line boundary: keeping only it is a push that parses,
// counts and scans perfectly, as its own first few hundred references.
// push-gate's count and the enumeration read the same bytes, so the
// cross-check above agrees with itself. Measured on 22/09/2026 with this
// listener registered once: 701 tags, the pattern in the last, landed with
// "nothing matched".
//
// A stream that CLOSES without ending or failing is refused too. Nothing
// says it delivered everything, and a promise left pending here settles
// nothing at all: the maintainer's gate happened to exit 13 on it (the
// top-level await in bin/brain-kit.mjs), and a caller without that await
// would have exited 0. A close after the end is the ordinary order and
// changes nothing, since the promise has already resolved.
export function readAllBytes(stream) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.isTTY) return resolve(Buffer.alloc(0));
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk, 'latin1')));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.on('close', () => reject(new Error('the stream closed before it ended')));
  });
}

// The destination name of every reference line the enumeration's loop will
// read out of these bytes, in order, held as latin1 like the stream. The
// loop runs once per newline, and once more for a final unterminated line
// that carries anything but blanks (spaces and tabs). A line with at least
// three spaces is read from the right, since only its first field, the
// source expression, can contain a space: the destination is the field
// before the last. A shorter line is the truncated case, split the way
// bash's `read` splits it (on runs of blanks, with none at either end),
// its destination the third field or nothing.
export function referenceDestinations(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const pieces = text.split('\n');
  const tail = pieces.pop();
  if (/[^ \t]/.test(tail)) pieces.push(tail);
  return pieces.map((line) => {
    const words = line.split(' ');
    if (words.length >= 4) return words[words.length - 2];
    return line.split(/[ \t]+/).filter((word) => word !== '')[2] ?? '';
  });
}

export function countReferenceLines(bytes) {
  return referenceDestinations(bytes).length;
}
