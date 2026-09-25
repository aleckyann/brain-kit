// The `lint` command: whether a vault's content is HEALTHY, per
// src/rules/lint.mjs's own eight rules. This module is the sibling
// src/commands/validate.mjs already is for the two conformance rulers: the
// one place that actually walks the vault, and the one place that decides
// how a person reads what the ruler found.
//
// This command follows validate.mjs's own established shape rather than
// inventing a second one, in every place the two commands face the same
// problem: the single walkVault call, handed down by src/cli.mjs exactly
// like validate's own (this module never imports walkVault itself, for the
// identical reason validate.mjs's own header states - a second, real
// reference reachable from this module's own scope would make any test
// spying on the injected parameter worthless); the reader that strips a
// leading byte-order mark and folds CRLF/CR to LF and caches per path
// (makeReadFile, imported from validate.mjs rather than rebuilt a second
// time, the same reuse this module also makes of isMarkdown below); and the
// directory-resolution errors (a path that does not exist, a path that is a
// file, no vault found from here upward), copied from validate.mjs's own
// runValidate almost verbatim because the two commands answer the exact
// same three questions about where a person pointed them, and repeating an
// established shape is not the same defect as repeating an implementation
// this codebase has already needed to keep from drifting.
//
// What is genuinely new here: the health ruler carries no format-defined
// tier (must/should), only a per-rule `severity` the vault's own
// configuration sets ('error', 'warn' or the rule not running at all,
// 'off'); the grouping this command's own report needs is by that
// severity, not by a ruler+level partition, since there is only one ruler.
// And a change's SCOPE - which lines count as "added" - comes from
// src/git.mjs and a requested `--base`, printed as one line up front,
// because a person who does not know what was in scope cannot read a
// report that only judges added lines for two of its eight rules and one
// clause of a third (tables, style, and privacy's third-party keywords;
// see src/rules/lint.mjs's own header for why everything else judges the
// whole vault regardless of scope).
//
// `--rule` restricts which rule ids this run considers. The restriction is
// applied by forcing every EXCLUDED rule's own `lint.<rule>` setting to
// 'off' in a COPY of the vault's configuration handed to runLintRules
// (buildRestrictedConfig, below): this is the same mechanism the vault's
// own configuration already uses to turn a rule off entirely (see
// src/rules/lint.mjs's own runLintRules, "a rule whose severity resolves to
// 'off' is never even called"), reused rather than duplicated, so
// restricting by flag costs exactly as little as a vault owner restricting
// by configuration already does: the excluded rule's own check() is never
// called, not merely filtered out of the report afterwards. The vault's
// OWN configured severities (including a rule the vault itself already
// turned off) are read separately, before this restriction is built, to
// compute what "skipped" means for THIS run's own summary (see
// computeSkippedRuleIds below): a rule excluded by --rule is not reported
// as "skipped", since the person who typed the flag already knows they
// excluded it; only a rule that would have run, had it not been off in the
// vault's own configuration, is.
//
// Example data throughout this module's own comments and its test file:
// the fictional owner Ana and example.com, per this project's standing
// rule against a real name or company leaking through a fixture built to
// test the public engine.
import { existsSync, lstatSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot, isUnderPath } from '../vault.mjs';
import { fileSetMessage, listPublishable, noteFileSet } from '../file-set.mjs';
import { createTranslator, REFERENCE_LANG } from '../lang.mjs';
import { LINT_RULES, runLintRules, severityFor } from '../rules/lint.mjs';
import { keywordMatchers } from '../rules/privacy-keywords.mjs';
import { KNOWN_BASES, addedLines, changedPaths, resolveBase } from '../git.mjs';
import { isMarkdown, makeReadFile, makeScanFile } from './validate.mjs';

const ROOT_INDEX = 'index.md';
const RULE_IDS = Object.freeze(LINT_RULES.map((rule) => rule.id));

// The identity of the --json envelope, exactly as validate.mjs's own
// JSON_VERSION exists: added now, on the day this envelope is first
// published, because adding a version field to a shape a consumer already
// parses IS the breaking change a version field exists to prevent. A
// consumer holding both this and validate's own envelope, or a future
// `doctor` command's, needs a way to tell the three apart; this is it for
// this one.
const JSON_VERSION = 'brain-kit.lint/1';

const DEFAULT_BASE = 'auto';

function parseArgs(argv) {
  const result = { dir: undefined, ruleIds: [], base: DEFAULT_BASE, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--rule') {
      const value = argv[++i];
      if (value === undefined) return { error: arg };
      result.ruleIds.push(value);
    } else if (arg === '--base') {
      const value = argv[++i];
      if (value === undefined) return { error: arg };
      result.base = value;
    } else if (arg.startsWith('-')) {
      return { error: arg };
    } else if (result.dir === undefined) {
      result.dir = arg;
    } else {
      return { error: arg };
    }
  }
  return result;
}

// Builds the config handed to runLintRules once --rule has restricted this
// run: every rule NOT named on the command line is forced to 'off' in a
// COPY of `config.lint` (the original object is never mutated: other
// settings this module never touches, taxonomy, privacy and the rest,
// survive untouched via the outer spread). `ruleIds.length === 0` (no
// --rule at all) returns `config` completely unchanged, so a run with no
// restriction pays no cost for this function existing and reads exactly
// the vault's own configuration, warts and all.
function buildRestrictedConfig(config, ruleIds) {
  if (ruleIds.length === 0) return config;
  const allowed = new Set(ruleIds);
  const lint = { ...(config?.lint ?? {}) };
  for (const rule of LINT_RULES) {
    if (!allowed.has(rule.id)) lint[rule.settingKey] = 'off';
  }
  return { ...config, lint };
}

// Which of the CONSIDERED rules (every rule id this run's own --rule
// restriction still lets run, or all eight when there was none) resolve to
// 'off' in the vault's OWN, unrestricted configuration. Read against the
// original `config`, never the restricted copy buildRestrictedConfig
// produces: after that copy exists, every excluded rule also reads 'off',
// which would make an intentional --rule exclusion indistinguishable from
// a vault that genuinely turned a considered rule off, exactly the
// confusion this run's own summary exists to prevent (see this module's
// own header).
function computeSkippedRuleIds(config, ruleIds) {
  const considered = ruleIds.length === 0 ? RULE_IDS : ruleIds;
  return considered.filter((id) => {
    const rule = LINT_RULES.find((r) => r.id === id);
    return severityFor(rule, config) === 'off';
  });
}

// --- the set the secrets rule reads (final fix round 2) -------------------
//
// WHAT THE SECRETS RULE READS IS EVERY FILE THIS PUSH COULD PUBLISH, and
// this is the one place that set is drawn, once per run, handed to the rule
// in its context exactly the way the walk's own result is.
//
// Inside a git repository it is git's answer (src/git.mjs,
// publishablePaths): what git tracks, plus what it would add, which is
// every untracked file it does not ignore; dot-paths included, ignored
// files excluded, and never the git directory. Outside a repository there
// is no git to ask, and it is the vault walk plus dot-paths, still never
// .git.
//
// What the set leaves out, and why each one is SAID rather than dropped
// (the report prints every non-empty one; see buildReport):
//
//   - `excluded`: under `lint.secrets.exclude_paths`, the vault's own,
//     deliberate escape for a file it knows to be safe and too large to
//     read. It is a configuration key, so a pull request shows it.
//   - `gitlinks` and `embedded`: a submodule, or a directory holding a
//     repository of its own. Their content is not in this repository.
//   - `absent`: a file git tracks that is not in the working tree, or not
//     reachable there without following a symbolic link out of it (a
//     directory replaced by a link). What the working tree holds is what
//     this rule reads; what only a commit holds for such a file is not
//     read, and the report says so.
//   - `undecodable`: a name that is not valid UTF-8, which cannot be
//     opened by name. It is published, so the rule refuses over it rather
//     than skipping it.
//   - `failure`: git could not produce the listing at all. The rule
//     refuses rather than falling back to some other list.
//
// `validate.ignore_paths` does NOT narrow this set inside a repository:
// that setting says which files the validator and the note rules judge,
// and a file git publishes is published whatever a validator was told to
// skip. Outside a repository, the walk is the whole answer and applies it.
function secretScanExcludes(config) {
  const setting = config?.lint?.secrets;
  const list = setting !== null && typeof setting === 'object' && !Array.isArray(setting) ? setting.exclude_paths : undefined;
  return Array.isArray(list) ? list.filter((entry) => typeof entry === 'string' && entry !== '') : [];
}

// Whether a path git lists is really there in the working tree, as a
// vault path: it exists, and every directory above it is a real directory
// rather than a symbolic link (reading through one would read a file
// outside the vault, which the push does not publish). Only "no such
// entry" answers no; any other failure answers yes, so the read itself
// fails and the rule reports it, which is the refusing direction.
function makeWorkingTreeCheck(root) {
  const realDirectory = new Map();
  const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
  const isRealDirectory = (relDir) => {
    if (relDir === '.') return true;
    if (!realDirectory.has(relDir)) {
      let answer;
      try {
        answer = lstatSync(join(root, ...relDir.split('/'))).isDirectory() && isRealDirectory(posix.dirname(relDir));
      } catch (error) {
        answer = !missing(error);
      }
      realDirectory.set(relDir, answer);
    }
    return realDirectory.get(relDir);
  };
  return (relPath) => {
    if (!isRealDirectory(posix.dirname(relPath))) return false;
    try {
      lstatSync(join(root, ...relPath.split('/')));
      return true;
    } catch (error) {
      return !missing(error);
    }
  };
}

// The listing itself is src/file-set.mjs's listPublishable (task 6 of
// slice 1C): asked once per run, a failure turned into a value, and the
// same answer the note rules' own set is drawn from, so the secrets rule
// and the other seven can never read two different lists of one vault.

// Builds the set from the listing (or its failure) and the one walk this
// run made. Exported so the rule's own tests can build the context this
// command builds, rather than a second approximation of it.
export function buildSecretScan(root, config, { listing, walked }) {
  const excludePaths = secretScanExcludes(config);
  const isExcluded = (path) => excludePaths.some((prefix) => isUnderPath(path, prefix));
  const scan = {
    source: 'git',
    files: [],
    excludePaths,
    excluded: [],
    excludeUnmatched: [],
    gitlinks: [],
    embedded: [],
    absent: [],
    undecodable: [],
    failure: null,
  };
  if (listing.failure) {
    scan.failure = listing.failure;
    return scan;
  }
  if (listing.listed === null) {
    scan.source = 'walk';
    scan.reason = listing.reason ?? 'outside-repo';
    for (const path of walked) {
      if (isExcluded(path)) scan.excluded.push(path);
      else scan.files.push(path);
    }
    scan.excludeUnmatched = unmatchedExcludes(excludePaths, scan.excluded);
    return scan;
  }
  const inWorkingTree = makeWorkingTreeCheck(root);
  for (const path of listing.listed.files) {
    if (isExcluded(path)) scan.excluded.push(path);
    else if (!inWorkingTree(path)) scan.absent.push(path);
    else scan.files.push(path);
  }
  for (const name of listing.listed.undecodable) {
    if (isExcluded(name)) scan.excluded.push(name);
    else scan.undecodable.push(name);
  }
  scan.gitlinks = listing.listed.gitlinks;
  scan.embedded = listing.listed.embedded;
  scan.excludeUnmatched = unmatchedExcludes(excludePaths, scan.excluded);
  return scan;
}

// The entries of lint.secrets.exclude_paths that excluded nothing: no path
// the set was drawn from sits under them. The report names them apart, so
// an entry written the wrong way ("./attachments/x.csv", where git lists
// "attachments/x.csv") is never listed as if it had excluded the file it
// names, while that file was read all along.
function unmatchedExcludes(excludePaths, excluded) {
  return excludePaths.filter((entry) => !excluded.some((path) => isUnderPath(path, entry)));
}

// At most this many paths are printed on one of the report's "not
// scanned" lines; the rest are counted, never dropped in silence.
const LISTED_PATHS = 10;

function listedPaths(t, paths) {
  if (paths.length <= LISTED_PATHS) return paths;
  return [...paths.slice(0, LISTED_PATHS), t('lint.list_more', { count: paths.length - LISTED_PATHS })];
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const aLine = a.line ?? -1;
    const bLine = b.line ?? -1;
    if (aLine !== bLine) return aLine - bLine;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.check < b.check ? -1 : a.check > b.check ? 1 : 0;
  });
}

// Fix round 2 (MINOR): `finding.file` is not guaranteed to be a real
// path for every finding this command can now render. A `rule-crashed`
// defect (src/rules/lint.mjs's own runLintRules, on catching a whole
// rule's own exception) has no one file to blame at all and carries
// `file: null`; the old fallback (`finding.line != null ? ... :
// finding.file`) only ever guarded the LINE half of the location, so a
// null `file` fell straight through to the template literal below and
// printed the literal word "null" as if it were a real path. Guarded
// here instead, with a fixed marker rather than the field's own value.
const NO_FILE_MARKER = '(no file)';

function formatFinding(finding, t) {
  if (finding.file == null) return `${NO_FILE_MARKER}  ${finding.id}  ${t(finding.messageKey, finding.params ?? {})}`;
  const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
  return `${location}  ${finding.id}  ${t(finding.messageKey, finding.params ?? {})}`;
}

// One line, always shown in the text report, saying which base this run
// actually used and why, from resolveBase's own machine-readable `reason`
// (src/git.mjs, which explicitly declines to know about language packs
// itself and leaves this translation to "the command that prints... a
// later task", this one). The `default` branch turns a reason this
// function does not recognise into a thrown error rather than a message
// key silently rendered as `undefined`: src/git.mjs is free to add a new
// reason code without this module noticing, and a reason nobody taught
// this switch about is exactly the kind of unnamed-return-value gap this
// task's own brief warns a mutation pass cannot find by itself.
function scopeMessage(t, base) {
  switch (base.reason) {
    case 'outside-repo':
      return t('lint.scope.outside_repo');
    case 'all-explicit':
      return t('lint.scope.all_explicit');
    case 'no-commits':
      return t('lint.scope.no_commits');
    case 'worktree-explicit':
      return t('lint.scope.worktree_explicit');
    case 'merge-base-explicit':
      return t('lint.scope.merge_base_explicit', { defaultBranch: base.defaultBranch });
    case 'merge-base-unavailable':
      return t('lint.scope.merge_base_unavailable');
    case 'merge-base-same-as-current':
      return t('lint.scope.merge_base_same_as_current');
    case 'auto-since-merge-base':
      return t('lint.scope.auto_since_merge_base', { defaultBranch: base.defaultBranch });
    case 'auto-merge-base-unavailable':
      return t('lint.scope.auto_merge_base_unavailable');
    case 'auto-no-default-branch':
      return t('lint.scope.auto_no_default_branch');
    case 'auto-on-default-branch':
      return t('lint.scope.auto_on_default_branch');
    case 'auto-on-default-branch-clean':
      return t('lint.scope.auto_on_default_branch_clean');
    default:
      throw new Error(`brain-kit: unrecognised scope reason "${base.reason}"`);
  }
}

function renderGroup(t, key, findings) {
  const lines = [`== ${t(`lint.heading_${key}`)} ==`, t(`lint.explain_${key}`)];
  if (findings.length === 0) {
    lines.push(t('lint.group_clean'));
  } else {
    for (const finding of sortFindings(findings)) lines.push(formatFinding(finding, t));
  }
  lines.push('');
  return lines;
}

// The tool-defect section, mirroring validate.mjs's own "tool defect"
// bucket in spirit (a finding this run cannot vouch for as an ordinary
// content result, ALWAYS shown when non-empty, never merged into
// errors or warnings), but HIDDEN entirely, heading and all, when there
// is nothing in it: unlike errors and warnings, which are always one of
// this ruler's two possible outcomes, a defect is not an outcome every
// run has an opinion about, so an empty section here says nothing,
// rather than "no findings in this group" about a category most runs
// will never touch at all.
function renderDefectSection(t, defects) {
  if (defects.length === 0) return [];
  const lines = [`== ${t('lint.heading_defect')} ==`, t('lint.explain_defect')];
  for (const finding of sortFindings(defects)) lines.push(formatFinding(finding, t));
  lines.push('');
  return lines;
}

// Fix round 2 (CRITICAL, the worst output this tool can produce): this
// used to decide "clean" from `errors`/`warnings`/`skippedIds` alone,
// never consulting `linesRestricted`, computed one line away in
// buildReport from the very `base` this run already resolved. A vault
// whose secret sits already committed on the default branch, checked
// with the default `auto` scope (which diffs the worktree against HEAD,
// per src/git.mjs's own header), shows zero findings for exactly that
// secret, because it is not a line THIS run added; the same vault
// checked with `--base all` reports it as an error. Before this fix,
// the first run printed "Result: no findings." with no more caveat than
// a run that genuinely checked everything, which is indistinguishable,
// on screen, from an actual clean bill of health: the worst thing this
// tool can say, since a person who trusts it once and is wrong once
// stops trusting its true findings too. `linesRestricted` (true for
// every base but `all`) now joins `skippedIds` under the exact same
// caveat this module already had a sentence for
// (`lint.verdict_clean_but_partial`): a clean report from a run that
// did not check every rule, or did not check every line, is not the
// same claim as a clean vault, and this verdict says so instead of
// staying silent about which one it is making.
// The degraded verdict names WHAT degraded the run (final fix round 2). It
// used to say "{count} rule(s) crashed" for every defect there was, so a
// file that merely ran out of scan time was reported as a crash, which
// sends whoever reads it to debug the wrong thing. Each kind of defect is
// counted and named on its own; a kind nobody taught this function about
// is still counted, as "other", never dropped.
function degradedCauses(t, defects) {
  const counted = (checks) => defects.filter((f) => checks.includes(f.check)).length;
  const causes = [];
  const crashed = counted(['rule-crashed']);
  if (crashed > 0) causes.push(t('lint.degraded_part.rule_crashed', { count: crashed }));
  const timedOut = counted(['file-scan-timed-out']);
  if (timedOut > 0) causes.push(t('lint.degraded_part.timed_out', { count: timedOut }));
  const scanFailed = counted(['file-scan-failed']);
  if (scanFailed > 0) causes.push(t('lint.degraded_part.scan_failed', { count: scanFailed }));
  const unreadable = counted(['file-read-failed', 'file-name-undecodable']);
  if (unreadable > 0) causes.push(t('lint.degraded_part.unreadable', { count: unreadable }));
  const listing = counted(['publishable-list-failed']);
  if (listing > 0) causes.push(t('lint.degraded_part.listing_failed'));
  const other = defects.length - crashed - timedOut - scanFailed - unreadable - listing;
  if (other > 0) causes.push(t('lint.degraded_part.other', { count: other }));
  return causes;
}

function renderVerdict(t, { errors, warnings, defects, skippedIds, linesRestricted }) {
  if (defects.length > 0) return t('lint.verdict_degraded', { causes: degradedCauses(t, defects) });
  if (errors.length > 0) {
    // A file too large to read fails the run as an error, and the verdict
    // says that is what some of the errors are, because "fails because of
    // the error(s) above" over a file nobody read reads as a credential
    // found, and a person who goes looking for one finds nothing.
    const tooLarge = errors.filter((f) => f.check === 'file-too-large').length;
    if (tooLarge > 0) return t('lint.verdict_failing_too_large', { count: tooLarge });
    return t('lint.verdict_failing');
  }
  if (warnings.length > 0) return t('lint.verdict_warnings_only');
  if (skippedIds.length > 0 || linesRestricted) return t('lint.verdict_clean_but_partial');
  return t('lint.verdict_clean');
}

// Builds the whole report (text, the --json object, and the exit code)
// from one findings array already produced by runLintRules, the resolved
// scope base, the markdown file count, the skipped-rule ids and the
// --rule restriction (if any). Exported and pure (no filesystem, no
// argv), mirroring validate.mjs's own buildReport, so the grouping, the
// verdict and the JSON shape can all be tested directly against a
// hand-built findings array without spawning the real binary or running
// a real rule first.
//
// `defect: true` findings (src/rules/lint.mjs's own runLintRules, on a
// rule that threw) are partitioned OUT of `errors`/`warnings` here,
// never counted as either: a tool malfunction is not a content finding,
// counting it as an ordinary "error" would fail the run for the WRONG
// reason and let the true error count silently include a result this
// tool itself does not vouch for.
//
// `fileSet` (task 6 of slice 1C) is the set the note rules read, git's
// list or the folder walk (src/file-set.mjs). The text report says which,
// right under the scope line, and the JSON carries it as `fileSet`.
// Optional, so a test of the grouping alone need not invent one; runLint
// always passes it.
//
// `privacyKeywords` (phase 3, fix round 1): null when privacy's keyword
// clause was not in play (the rule did not run, or no keyword is
// configured), else `{ checked }`, false when the run had no change to
// judge. The text report prints one line when it is false; the JSON
// carries it as it is.
export function buildReport(findings, { t, base, fileCount, skippedIds, restrictedTo = [], ignoredPaths = [], secretScan = null, fileSet = null, privacyKeywords = null }) {
  const defects = findings.filter((f) => f.defect === true);
  const errors = findings.filter((f) => f.defect !== true && f.severity === 'error');
  const warnings = findings.filter((f) => f.defect !== true && f.severity === 'warn');
  const linesRestricted = base.kind !== 'all';

  const scope = {
    base: base.kind,
    reason: base.reason,
    files: fileCount,
    linesRestricted,
  };
  const counts = { error: errors.length, warn: warnings.length, defect: defects.length, skipped: skippedIds.length };
  // Fix round 2 (MINOR): `findings` used to reach the --json envelope in
  // whatever order runLintRules happened to produce it, while the text
  // report's own three groups were always sorted (sortFindings, above).
  // A consumer parsing --json and a person reading the text report of
  // the SAME run could see the same findings in two different orders;
  // sorted here too, once, so both halves of one report agree.
  const sortedFindings = sortFindings(findings);
  const json = {
    version: JSON_VERSION,
    findings: sortedFindings,
    counts,
    scope,
    skipped: skippedIds,
    restrictedTo,
    ignoredPaths,
    // What the note rules read (null when the caller did not say).
    fileSet: fileSet === null ? null : { source: fileSet.source, reason: fileSet.reason ?? null, notes: fileCount, unpublished: fileSet.unpublished },
    // What the secrets rule read, or that it did not run at all: the same
    // facts the text report's own secrets lines state, for a consumer
    // that reads this instead.
    secrets: secretScan === null
      ? { ran: false }
      : {
          ran: true,
          source: secretScan.source,
          scanned: secretScan.files.length,
          excludePaths: secretScan.excludePaths,
          excluded: secretScan.excluded,
          excludeUnmatched: secretScan.excludeUnmatched,
          gitlinks: secretScan.gitlinks,
          embedded: secretScan.embedded,
          absent: secretScan.absent,
          listingFailed: secretScan.failure !== null,
        },
    privacyKeywords,
  };

  const lines = [];
  lines.push(scopeMessage(t, base));
  if (fileSet !== null) lines.push(fileSetMessage(t, fileSet, fileCount));
  // The secrets rule's own reach, printed whenever that rule RAN and never
  // when it did not (final fix round 2: it used to be printed always, so
  // a vault with `lint.secrets: "off"` was told every file is scanned
  // for secrets on every run, right beside the line saying the rule was
  // skipped, and `--rule tables` printed it and then "no findings").
  // It says which set it read, git's or the walk's, and how many files,
  // because "every file" was a claim the walk's dot-path exclusion made
  // false for the one file most likely to hold a credential, `.env`.
  // When git could not produce its listing the rule read nothing, and the
  // defect section and the verdict say so; a reach line then would
  // describe a set that was never drawn.
  const secretsRead = secretScan !== null && secretScan.failure === null;
  if (secretsRead) {
    if (secretScan.source === 'git') lines.push(t('lint.secrets_reach_git', { count: secretScan.files.length }));
    else if (secretScan.reason === 'vault-not-listed') lines.push(t('lint.secrets_reach_walk_vault_not_listed', { count: secretScan.files.length }));
    else lines.push(t('lint.secrets_reach_walk', { count: secretScan.files.length }));
  }
  // `validate.ignore_paths`, said out loud whenever it is in force, and
  // truthfully about the secrets rule: inside a repository that rule reads
  // what git publishes whatever the validator was told to skip, and
  // outside one it reads the walk, which does apply the setting. Printed
  // only when the setting actually excludes something.
  if (ignoredPaths.length > 0) {
    if (secretsRead && secretScan.source === 'git') lines.push(t('lint.scope_ignored_paths_secrets_still_read', { paths: ignoredPaths }));
    else lines.push(t('lint.scope_ignored_paths', { paths: ignoredPaths }));
  }
  // Everything the secrets set left out, each kind on its own line and
  // only when it is non-empty (see buildSecretScan for why none of them
  // may pass in silence), and only when a set was drawn at all: with no
  // listing, nothing was left out of anything. An exclusion that matched
  // nothing is named on a line of its own, never among the ones that did.
  if (secretsRead) {
    const matched = secretScan.excludePaths.filter((entry) => !secretScan.excludeUnmatched.includes(entry));
    if (matched.length > 0) lines.push(t('lint.secrets_excluded', { paths: matched, count: secretScan.excluded.length }));
    if (secretScan.excludeUnmatched.length > 0) lines.push(t('lint.secrets_exclude_unmatched', { paths: secretScan.excludeUnmatched }));
    const elsewhere = [...secretScan.gitlinks, ...secretScan.embedded];
    if (elsewhere.length > 0) lines.push(t('lint.secrets_other_repositories', { paths: listedPaths(t, elsewhere) }));
    if (secretScan.absent.length > 0) lines.push(t('lint.secrets_absent', { count: secretScan.absent.length, paths: listedPaths(t, secretScan.absent) }));
  }
  if (privacyKeywords !== null && privacyKeywords.checked === false) lines.push(t('lint.privacy_keywords_not_checked'));
  if (restrictedTo.length > 0) lines.push(t('lint.restricted_to', { ids: restrictedTo }));
  lines.push('');
  lines.push(...renderDefectSection(t, defects));
  lines.push(...renderGroup(t, 'error', errors));
  lines.push(...renderGroup(t, 'warn', warnings));
  lines.push(t('lint.counts_summary', { error: errors.length, warn: warnings.length, skipped: skippedIds.length }));
  if (skippedIds.length > 0) lines.push(t('lint.skipped_list', { ids: skippedIds }));
  lines.push('');
  lines.push(renderVerdict(t, { errors, warnings, defects, skippedIds, linesRestricted }));
  const text = `${lines.join('\n')}\n`;

  // Fix round 2 (CRITICAL): a rule that crashed used to leave no exit
  // code of its own at all, since the exception never reached this far
  // (see src/rules/lint.mjs's own runLintRules for the catch that now
  // keeps it from escaping). `defects.length > 0` takes priority over
  // both other outcomes: a degraded run's own error count is not
  // trustworthy (the rule that crashed might have found more, or might
  // have found the very thing another rule's error count is missing),
  // so this is its own exit code, never quietly folded into FAILURE or
  // OK.
  const exitCode = defects.length > 0 ? EXIT.DEGRADED : errors.length > 0 ? EXIT.FAILURE : EXIT.OK;
  return { text, json, exitCode };
}

// runLint(argv, io, t, walkVault) - `walkVault` is not part of the CLI
// surface, exactly as validate.mjs's own runValidate documents: src/cli.mjs
// owns the only reference to the real function, closing over it itself and
// handing it down as the one and only way this module can reach it. This
// module never imports walkVault directly, so there is no second reference
// in its own scope a future change could reach instead of the parameter.
export async function runLint(argv, io, t, walkVault) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${t('lint.bad_argument', { arg: parsed.error })}\n`);
    io.stderr.write(`${t('lint.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('lint.usage')}\n`);
    return EXIT.OK;
  }

  if (!KNOWN_BASES.includes(parsed.base)) {
    io.stderr.write(`${t('lint.unknown_base', { base: parsed.base, ids: KNOWN_BASES })}\n`);
    io.stderr.write(`${t('lint.usage')}\n`);
    return EXIT.USAGE;
  }

  // An unknown --rule id is a usage error, never a silent run over
  // whichever ids it DID recognise: reporting only the first offending id
  // (rather than every one at once) is the same first-divergence
  // discipline src/rules/lint.mjs's own columns and tables rules already
  // apply to their own messages, kept here for the identical reason, one
  // thing to fix and re-run against beats a list to read all at once.
  const unknownRule = parsed.ruleIds.find((id) => !RULE_IDS.includes(id));
  if (unknownRule !== undefined) {
    io.stderr.write(`${t('lint.unknown_rule', { rule: unknownRule, ids: RULE_IDS })}\n`);
    io.stderr.write(`${t('lint.usage')}\n`);
    return EXIT.USAGE;
  }

  // A path argument that names neither a vault root nor a real location
  // inside one is a usage error, never a silent climb to whichever vault
  // happens to enclose it: see validate.mjs's own runValidate for why
  // findVaultRoot's purely lexical upward walk makes checking this first
  // necessary, not merely tidy.
  let startDir = process.cwd();
  if (parsed.dir !== undefined) {
    startDir = resolve(parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('lint.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('lint.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }

  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('lint.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }

  const config = loadConfig(root); // may throw ConfigError; src/cli.mjs's boundary maps it to exit 2

  // Every user-facing string this command itself writes, from here on,
  // comes from the language pack the VAULT declared (config.lang), exactly
  // as validate.mjs's own reportT does and for the identical reason: `t`,
  // the translator this function was called with, reflects the operator's
  // own environment and is only right for the usage errors above, which
  // happen before any vault, and therefore any vault language, is known.
  const reportT = createTranslator(config?.lang ?? REFERENCE_LANG, {
    warn: (message) => io.stderr.write(`${message}\n`),
  });

  // The single walkVault call this whole command depends on, exactly one,
  // with everything included: the markdown file list and the `context.all`
  // set every rule's link resolution needs both come from this ONE
  // result, never a second walk (see this module's own header), and so
  // does the secrets rule's set outside a git repository.
  //
  // `{ all: true }` used to be UNDEFENDED here, and the whole-slice
  // review proved it: dropping the argument passed all 801 tests, while
  // silently changing what `classifyTargetPath` answered about every
  // attachment in the vault and making `lint` and `validate` disagree
  // about what the vault contains. It is defended by the secrets rule's
  // set outside a repository, which is this walk, so without the
  // argument a credential committed in a non-markdown file is invisible
  // again.
  //
  // Final fix round 2: whether the secrets rule will run at all is known
  // before anything is read, so a run that does not use it pays nothing
  // for its set, and the one walk below asks for dot-entries only when
  // that set is going to be the walk's (outside a git repository).
  //
  // Task 6 of slice 1C: git's list is asked for on EVERY run now, once,
  // because the seven rules that read notes judge it too (src/file-set.mjs):
  // inside a repository they read the walk's files git publishes, so a
  // note git ignores never fails the run the adopter's push gate makes on
  // every push. The secrets rule and the note rules read the same listing,
  // so the two can never disagree about what this vault publishes.
  const restrictedConfig = buildRestrictedConfig(config, parsed.ruleIds);
  const secretsRule = LINT_RULES.find((rule) => rule.scansEveryFile === true);
  const secretsRuns = severityFor(secretsRule, restrictedConfig) !== 'off';
  const listing = listPublishable(root);
  const walkDotEntries = secretsRuns && listing.listed === null;
  const walked = walkVault(root, config, { all: true, dotEntries: walkDotEntries });
  // One walk, two views: the note rules' set is this walk with every
  // dot-path dropped, narrowed to what git publishes inside a repository;
  // the secrets rule's set is buildSecretScan's.
  const fileSet = noteFileSet(walked, listing);
  const all = fileSet.files;
  const files = all.filter(isMarkdown);
  const secretScan = secretsRuns ? buildSecretScan(root, config, { listing, walked }) : null;

  // Disclosed rather than silently relied on: passing `config` here
  // (instead of the `restrictedConfig` built above) is currently
  // UNFALSIFIABLE by any test in test/lint.test.mjs. computeSkippedRuleIds'
  // own `considered` set is always either every rule id (no --rule at all,
  // in which case restrictedConfig equals config exactly, by
  // buildRestrictedConfig's own first line) or exactly the --rule ids
  // themselves (which buildRestrictedConfig never touches, only the
  // EXCLUDED ids are forced to 'off'); either way, `considered` never
  // contains an id the two configs actually disagree on, so a mutation
  // swapping this argument for `restrictedConfig` passes the whole suite.
  // Kept as `config` anyway, deliberately, for what it is not dead for:
  // it is the argument this function's own contract actually promises
  // ("read against the vault's OWN, unrestricted configuration"), and the
  // one that stays correct if `considered` is ever widened later, which a
  // silently-equivalent `restrictedConfig` would not survive.
  const skippedIds = computeSkippedRuleIds(config, parsed.ruleIds);
  // `scanFile` is the second reader this context carries, used by the
  // `secrets` rule alone: unnormalised bytes, decoded exactly as
  // src/commands/scan-blobs.mjs decodes a blob, with the per-file size
  // ceiling both gates share. See makeScanFile
  // (src/commands/validate.mjs) for why a scanner must not share the
  // markdown reader's normalisation. `secretScan` is the set that rule
  // reads (buildSecretScan, above), or null when it does not run.
  const context = {
    root,
    config: restrictedConfig,
    all: new Set(all),
    readFile: makeReadFile(root),
    scanFile: makeScanFile(root),
    secretScan,
  };

  const base = resolveBase(root, parsed.base);
  // The scope contract src/git.mjs's own header promises runLintRules:
  // `{ files, addedLines(relPath) -> Set<number> | null }`, plus, since
  // phase 3, `addedText(relPath) -> Array<{ line, text }> | null`. `files`
  // here is deliberately the CHANGED paths this base considers
  // (changedPaths' own return, null for the `all` base), not the vault's
  // markdown file list above. privacy's keyword clause reads it for
  // exactly that null: no change to judge (fix round 1).
  //
  // src/git.mjs's OWN exported `addedLines(root, base, relPath)` does NOT
  // return the Set: it returns `Array<{ line, text }> | null` (every
  // added line's text alongside its number, for a caller that needs the
  // text too). tables and style (src/rules/lint.mjs) call
  // `.has(lineNumber)` and read `.size` on what `addedLines` returns, so
  // handing the raw array straight through would fail the very first
  // scoped file a real run touches; the map to line numbers, wrapped in a
  // Set, is what builds the contract runLintRules was promised. `addedText`
  // hands the raw array on, for privacy's keyword clause, which judges the
  // text of each line git says was added rather than the file read back at
  // those numbers (a lone carriage return breaks a line for the markdown
  // reader and not for git).
  //
  // Asked once per file and kept (phase 3, task 6): three readers ask
  // about the same file, and each answer costs git processes. Keeping the
  // first answer also means every reader judges the very same set of
  // lines. Removing the cache changes no finding, only the number of git
  // processes a run spawns, so no test can see it go; this sentence is the
  // disclosure.
  const addedByFile = new Map();
  const addedFor = (relPath) => {
    if (!addedByFile.has(relPath)) {
      const raw = addedLines(root, base, relPath);
      addedByFile.set(relPath, raw === null ? null : { lines: new Set(raw.map((entry) => entry.line)), entries: raw });
    }
    return addedByFile.get(relPath);
  };
  const scope = {
    // Fix round 3 (finding H): `changedPaths` now returns VAULT-relative
    // paths (src/git.mjs, `--relative`), so `scope.files` finally speaks
    // the same path language as `files` and `context.all`. It used to be
    // repository-relative, which agreed with everything else only for a
    // vault that IS the repository root; in a vault nested inside a
    // larger repository the first rule to read this field would have
    // inherited the mismatch in silence, since no rule reads it today.
    files: changedPaths(root, base),
    addedLines: (relPath) => addedFor(relPath)?.lines ?? null,
    addedText: (relPath) => addedFor(relPath)?.entries ?? null,
  };
  // Whether privacy's keyword clause was in play, and if so whether it
  // judged anything (fix round 1): in play when the privacy rule runs in
  // this run and the configuration lists a keyword; it judges nothing when
  // the scope has no change to judge (the `all` base, `scope.files` null,
  // the one condition the clause itself reads). The report says so in one
  // line, so a whole-vault run that found no keyword is never read as one
  // that looked.
  const privacyRule = LINT_RULES.find((rule) => rule.id === 'privacy');
  const keywordsInPlay = severityFor(privacyRule, restrictedConfig) !== 'off' && keywordMatchers(config).length > 0;
  const privacyKeywords = keywordsInPlay ? { checked: scope.files !== null } : null;

  const findings = runLintRules(files, context, scope);
  // A listing git could not produce leaves the note rules reading the walk
  // (src/file-set.mjs), which can hold files git ignores. That is a run
  // this tool cannot vouch for, so it is a defect, and the run is degraded
  // whether or not the secrets rule (which reports the same failure for
  // its own set) ran at all.
  if (fileSet.failure) {
    findings.push({
      ruler: 'lint',
      id: 'file-set',
      check: 'publishable-list-failed',
      severity: 'error',
      defect: true,
      file: null,
      line: null,
      absence: false,
      messageKey: 'lint.tool_defect.note_set_list_failed',
      params: { status: fileSet.failure.status },
    });
  }

  const { text, json, exitCode } = buildReport(findings, {
    t: reportT,
    base,
    fileCount: files.length,
    skippedIds,
    restrictedTo: parsed.ruleIds,
    ignoredPaths: Array.isArray(config?.validate?.ignore_paths) ? config.validate.ignore_paths : [],
    secretScan,
    fileSet,
    privacyKeywords,
  });

  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(json)}\n`);
    return exitCode;
  }
  io.stdout.write(text);
  return exitCode;
}
