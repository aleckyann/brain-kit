// The `validate` command: the one place that actually walks a vault and
// hands the two rulers (src/rules/spec.mjs, src/rules/house.mjs) the
// shared { files, context } the ruler contract promises them. Every rule
// in both files was written against that contract without ever being
// able to call walkVault itself; this module is the side that keeps the
// promise, which is why the single walkVault call below is not a detail,
// it is the whole point of this file (see src/vault.mjs's own header,
// defect 4).
//
// This module owns three things no rule owns: resolving which directory
// is the vault, building context.readFile's normalisation and cache
// exactly once, and deciding how a person reads the two rulers' output.
// That last part is a presentation choice with a safety property behind
// it: a specification `must` finding means the bundle is not
// conformant, a specification `should` finding means it merely departs
// from the format's own guidance, and a house finding means it departs
// from this one vault's own declared preferences and carries no
// conformance tier at all, because the format's two tiers are not a
// vault's to claim. The three are a PARTITION, not three filters: every
// finding lands in exactly one of must/should/house, or, if its ruler
// and level combination is not one this command recognises, in a fourth
// "tool defect" bucket that is ALWAYS shown (fix round 1) rather than
// silently falling out of every group and out of the counts while still
// turning the exit code red. Flattening any of the first three would
// tell a person their vault is broken when it is only opinionated;
// swallowing the fourth would tell them nothing is wrong when the tool
// itself does not know what it just found. Both are the confident-wrong
// reading this command exists to prevent.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot } from '../vault.mjs';
import { createTranslator, REFERENCE_LANG } from '../lang.mjs';
import { PARSER_LIMITS, frontmatterKeyLine, readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { runSpecRules } from '../rules/spec.mjs';
import { applyTimestampDeviation, runHouseRules } from '../rules/house.mjs';

const ROOT_INDEX = 'index.md';
const RULERS = Object.freeze(['spec', 'house']);

// The identity of the --json envelope: which command produced it and
// which revision of its shape this is. One key, and it is here on the
// day the envelope is first published rather than the day it first
// changes, because adding a version field to a shape consumers already
// parse IS the breaking change a version field exists to prevent.
// Phase 1B's `lint` and 1D's `doctor` will emit envelopes of their own,
// and without this a consumer holding one of the three has no way to
// tell which it has. Bump the number when a key is removed or changes
// meaning; adding a key is not a bump.
const JSON_VERSION = 'brain-kit.validate/1';

// What makes the run fail, as a house setting rather than a fixed law.
//
// Section 11 of the Open Knowledge Format lists what a consumer "MUST
// NOT reject a bundle because of", and that list bites HERE, at the exit
// code, not in the prose above it: in a command wired into CI, the exit
// code IS the reject decision. Every tier blocked it before this
// setting, so a bundle that is fully conformant to the format failed the
// run over a log heading written in prose, which is a rejection section
// 11 tells a consumer not to make. The verdict line was honest about
// what it was doing and the exit code was still the wrong answer.
//
// - 'must'        only a specification `must` finding (a real
//                 non-conformance) fails the run. This is the setting an
//                 adopter who reads section 11 and wants the format's
//                 own answer should choose.
// - 'must+should' conformance and the format's own guidance, but not
//                 this one vault's house preferences.
// - 'any'         anything at all fails the run. The DEFAULT, so nothing
//                 changes for anyone who says nothing.
//
// The default is 'any' and not 'must', deliberately. This command is
// producer-side: its reader is the person who wrote the vault, and for
// them a house rule they themselves declared is exactly as worth
// stopping for as a conformance failure, which is the whole reason the
// house ruler exists. A tool that quietly stopped failing on findings it
// used to fail on would also change every existing adopter's build in
// the direction that hides problems, which is the worse direction to be
// wrong in. The section 11 argument is real and it is answered by making
// the lever exist and documenting it, not by moving it for everyone.
//
// An unclassifiable finding (the tool-defect bucket) blocks under EVERY
// setting, including 'must'. A finding this command cannot classify is
// never something it can also vouch for as safe to ignore, and that is a
// statement about the tool, not about the vault, so no vault setting
// gets to wave it through.
const FAIL_ON_DEFAULT = 'any';

export function computeBlocking({ must, should, house, unexpected }, failOn = FAIL_ON_DEFAULT) {
  if (unexpected.length > 0) return true;
  if (must.length > 0) return true;
  if (failOn === 'must') return false;
  if (should.some((f) => !f.warning)) return true;
  if (failOn === 'must+should') return false;
  return house.length > 0;
}

function parseArgs(argv) {
  const result = { dir: undefined, onlyProblems: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === '--only-problems') result.onlyProblems = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg.startsWith('-')) return { error: arg };
    else if (result.dir === undefined) result.dir = arg;
    else return { error: arg };
  }
  return result;
}

// Builds the context.readFile the ruler contract promises every rule:
// one normalisation (byte-order mark stripped, CRLF and lone CR folded
// to LF), applied once per file and cached, so a dozen rules reading one
// file cost one disk read, and no rule ever has to remember Windows line
// endings exist on its own. Exported so a test can exercise the cache
// directly, by writing a real file, reading it once, changing the bytes
// on disk, and reading it again: the second call must still return the
// FIRST content, or the cache clause is not real.
export function makeReadFile(root) {
  const cache = new Map();
  return function readFile(relPath) {
    if (!cache.has(relPath)) {
      let text = readFileSync(join(root, relPath), 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      text = text.replace(/\r\n?/g, '\n');
      cache.set(relPath, text);
    }
    return cache.get(relPath);
  };
}

// The one place this module decides what counts as a markdown file, so
// it can never quietly diverge from src/vault.mjs's OWN definition
// (fix round 1: an `.endsWith('.md')` string check here used to be a
// SECOND definition, coincidentally agreeing with vault.mjs's
// `extname(name) === '.md'` for every case this project's fixtures
// happened to exercise, which is exactly how two definitions drift
// apart unnoticed). `all` already comes from ONE walkVault call; this
// only re-derives which of its entries are markdown, using the same
// primitive vault.mjs itself uses.
function isMarkdown(path) {
  return extname(path) === '.md';
}

// Notes whose stale_after has passed: informational only, computed here
// rather than by either ruler because it answers a different question
// than either one asks. spec.mjs's stale-after-format only checks that
// the VALUE is a well-formed ISO 8601 datetime with an offset; it is
// silent on whether that moment has actually passed, on purpose, since a
// clock reading is not a conformance fact about the bundle. A value this
// function cannot parse at all is skipped rather than reported: the
// malformed-shape case is already spec.mjs's finding (or, for a shape
// the regex reader cannot see at all, PARSER_LIMITS), and reporting it a
// second time here as "not stale" or "stale" would both be a guess this
// function has no basis for.
// `now` defaults to the real clock but is a real parameter (fix round
// 2), not a fixed default folded away: the boundary this function draws
// (a note stale ON the moment it expires, not only strictly after) is a
// deliberate `<=`, and the only way to pin that exact tie down in a test
// is to hand this function a `now` equal to some note's own stale_after
// and confirm it comes back stale, alongside a note one millisecond
// later that does not. Exported for exactly that test.
export function computeStale(files, context, now = new Date()) {
  const stale = [];
  for (const file of files) {
    const { frontmatter } = splitFrontmatter(context.readFile(file));
    const staleAfter = readScalar(frontmatter, 'stale_after');
    if (staleAfter === null || staleAfter === undefined) continue; // absent, or a shape this reader cannot see
    const when = new Date(staleAfter);
    if (Number.isNaN(when.getTime())) continue; // not parseable at all: nothing this function can claim
    if (when.getTime() <= now.getTime()) {
      stale.push({ file, line: frontmatterKeyLine(frontmatter, 'stale_after'), staleAfter });
    }
  }
  return stale.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
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

// The three groups the format's own tiers define, as a PARTITION: every
// finding lands in exactly one of must/should/house, decided by the
// SAME ruler+level combination the two rulers themselves promise (see
// src/rules/spec.mjs and src/rules/house.mjs's own headers: a spec
// finding always carries level 'must' or 'should', a house finding
// never carries a level at all). Anything else - a spec finding with an
// unrecognised level, a house finding that carries one anyway - is a
// defect in THIS TOOL, not in the vault it was checking, and goes in
// `unexpected` rather than nowhere. Exported so this partition can be
// tested directly, with a hand-built finding no real rule would ever
// produce, without needing either ruler to actually misbehave first.
//
// Fix round 2: a `must` finding that ALSO carries `warning: true` is
// its own kind of incoherence, one level up from a stray ruler/level
// combination. `must` is the format's own conformance tier; `warning`
// exists so a `should` finding can be downgraded for a vault mid
// migration, and applyTimestampDeviation is written to never touch a
// `must` finding at all. Today that guard is the only thing keeping the
// two apart, in a file this module does not own; trusting it, rather
// than also refusing the combination here, is the exact one-forgetful-
// rule-away shape this partition already exists to close for a stray
// level. A `must`+`warning` finding goes to `unexpected` too, for the
// same reason: printed under "not conformant" while also being excused
// from the exit code is a contradiction no reader should ever see on
// screen, whichever file forgets to prevent it first.
export function partitionFindings(combined) {
  const must = [];
  const should = [];
  const house = [];
  const unexpected = [];
  for (const finding of combined) {
    if (finding.ruler === 'spec' && finding.level === 'must') {
      if (finding.warning) unexpected.push(finding);
      else must.push(finding);
    } else if (finding.ruler === 'spec' && finding.level === 'should') {
      should.push(finding);
    } else if (finding.ruler === 'house' && finding.level === undefined) {
      house.push(finding);
    } else {
      unexpected.push(finding);
    }
  }
  return { must, should, house, unexpected };
}

// Every rule module hands this command a message KEY and PARAMS, never a
// formed sentence (src/rules/spec.mjs and src/rules/house.mjs's own
// headers): this is the one place a finding's message is actually
// rendered into text, through `t`, the translator built from the
// VAULT's own config.lang. That is the whole point of carrying a key
// and params this far instead of a string: a rule module has no notion
// of the vault's language, and building an English sentence there,
// underneath a heading this command already framed in the vault's own
// language, is the exact bug this refactor removes.
function renderMessage(finding, t) {
  return t(finding.messageKey, finding.params ?? {});
}

function formatFinding(finding, t) {
  const tag = finding.warning ? `${t('validate.warning_tag')} ` : '';
  const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
  return `${location}  ${finding.id}  ${tag}${renderMessage(finding, t)}`;
}

function formatDefect(finding, t) {
  const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file;
  return `${location}  ruler=${finding.ruler} id=${finding.id} level=${finding.level}  ${renderMessage(finding, t)}`;
}

// Renders one of the three format-defined groups. --only-problems drops
// a group with no findings ENTIRELY (heading, explanation and all), and
// this operates on the GROUP, never on an individual rule: there is no
// per-rule inventory of what actually ran, so a rule that checked
// everything and found nothing is indistinguishable, from here, from a
// rule that never ran at all. Hiding on a per-rule basis would claim
// knowledge this command does not have; hiding a whole group that
// genuinely produced zero findings makes no such claim, since the group
// itself, and therefore whether anything in it fired, is always known.
function renderGroup(t, key, findings, onlyProblems) {
  if (onlyProblems && findings.length === 0) return [];
  const lines = [`== ${t(`validate.heading_${key}`)} ==`, t(`validate.explain_${key}`)];
  if (findings.length === 0) {
    lines.push(t('validate.group_clean'));
  } else {
    for (const finding of sortFindings(findings)) lines.push(formatFinding(finding, t));
  }
  lines.push('');
  return lines;
}

function renderDefectSection(t, unexpected) {
  if (unexpected.length === 0) return [];
  const lines = [`== ${t('validate.heading_defect')} ==`, t('validate.explain_defect')];
  for (const finding of sortFindings(unexpected)) lines.push(formatDefect(finding, t));
  lines.push('');
  return lines;
}

function renderStaleSection(t, stale, onlyProblems) {
  if (onlyProblems && stale.length === 0) return [];
  const lines = [`== ${t('validate.heading_stale')} ==`, t('validate.explain_stale')];
  if (stale.length === 0) {
    lines.push(t('validate.stale_none'));
  } else {
    for (const entry of stale) lines.push(t('validate.stale_entry', { file: entry.file, staleAfter: entry.staleAfter }));
  }
  lines.push('');
  return lines;
}

// The verdict line, when there is one, reads the EXACT SAME predicate
// the exit code does (fix round 1: it used to read must.length instead,
// so a vault with only should or only house findings exited 1 while
// this line said the vault was conformant - the one lie this command
// exists to prevent, on its own last line). `hasBlocking` is that
// predicate, computed once by the caller and passed in rather than
// re-derived here, so the two can never read it differently again.
function renderVerdict(t, { must, should, house, unexpected, stale, hasBlocking, failOn }) {
  if (unexpected.length > 0) return t('validate.verdict_unexpected');
  const totalKnown = must.length + should.length + house.length;
  if (totalKnown === 0) {
    // Fix round 2: "no departures" was said unconditionally, even right
    // below a list of stale notes this same report just printed. Those
    // notes ARE a departure from the vault's own review cadence, only
    // not a conformance or house one, so the clean verdict says that
    // instead of flatly denying what is still on screen above it.
    return stale.length > 0 ? t('validate.verdict_clean_with_stale') : t('validate.verdict_clean');
  }
  if (!hasBlocking) {
    // Two different reasons nothing blocks, and they must not share a
    // sentence. "Every finding was downgraded to a warning" is true
    // only when the deviation actually downgraded them; when the
    // findings are ordinary and this vault's validate.fail_on simply
    // does not count them, saying they were downgraded would be the
    // report describing a mechanism that never ran. The exact test is
    // whether the default setting WOULD have blocked this same set.
    if (computeBlocking({ must, should, house, unexpected }, 'any')) {
      return t('validate.verdict_not_blocking', { failOn });
    }
    return t('validate.verdict_warnings_only');
  }
  if (must.length > 0) return t('validate.verdict_broken');
  return t('validate.verdict_blocking');
}

function renderReport(t, { must, should, house, unexpected, stale, onlyProblems, hasBlocking, failOn }) {
  const lines = [];
  lines.push(...renderDefectSection(t, unexpected));
  lines.push(...renderGroup(t, 'must', must, onlyProblems));
  lines.push(...renderGroup(t, 'should', should, onlyProblems));
  lines.push(...renderGroup(t, 'house', house, onlyProblems));
  lines.push(t('validate.counts_summary', { must: must.length, should: should.length, house: house.length, unexpected: unexpected.length }));
  lines.push('');
  lines.push(...renderStaleSection(t, stale, onlyProblems));
  lines.push(renderVerdict(t, { must, should, house, unexpected, stale, hasBlocking, failOn }));
  return `${lines.join('\n')}\n`;
}

// Builds the whole report (text, the --json object, and the exit code)
// from one combined findings array and one stale list, both already
// final. Exported and pure (no filesystem, no argv) so the partition,
// the verdict and the JSON shape can all be tested directly against a
// hand-built `combined`, including a shape no real rule can currently
// produce (the unexpected-level case), without spawning the real binary
// or making either ruler misbehave first.
export function buildReport(combined, stale, { onlyProblems = false, t, failOn = FAIL_ON_DEFAULT }) {
  const { must, should, house, unexpected } = partitionFindings(combined);
  // The SAME predicate drives the exit code and the verdict line,
  // computed from the PARTITIONED buckets (fix round 2), not from raw
  // `combined`: `unexpected` always blocks, whatever its own `warning`
  // flag says, since a finding this command cannot classify is never
  // something it can also vouch for as safe to ignore. `must` always
  // blocks too (and, after the partition fix above, never carries
  // `warning` at all: a `must` finding that did was already moved into
  // `unexpected`). `should` blocks unless every one of its findings was
  // downgraded; `house` has no `warning` concept. Which of those tiers
  // actually reaches the exit code is now the vault's own
  // validate.fail_on (see computeBlocking above), defaulting to the
  // everything-blocks answer this command has always given.
  // Staleness never even reaches `combined`, so it is structurally
  // incapable of affecting this.
  const hasBlocking = computeBlocking({ must, should, house, unexpected }, failOn);
  const warnings = should.filter((f) => f.warning).length;
  const counts = { must: must.length, should: should.length, house: house.length, unexpected: unexpected.length, warnings };
  const json = { version: JSON_VERSION, findings: combined, stale, counts, parserLimits: PARSER_LIMITS, rulers: RULERS, failOn, blocking: hasBlocking };
  const text = renderReport(t, { must, should, house, unexpected, stale, onlyProblems, hasBlocking, failOn });
  return { text, json, exitCode: hasBlocking ? EXIT.FAILURE : EXIT.OK };
}

// runValidate(argv, io, t, walkVault) - `walkVault` is not part of the
// CLI surface; src/cli.mjs's own BUILTIN_COMMANDS entry is the only
// place that supplies it, closing over the real function it imports
// itself. validate.mjs never imports walkVault directly (fix round 1):
// with no second reference to the real function anywhere in this
// module's scope, there is no way for a future change to reach a second
// walk that bypasses whatever this parameter is in a test.
export async function runValidate(argv, io, t, walkVault) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${t('validate.bad_argument', { arg: parsed.error })}\n`);
    io.stderr.write(`${t('validate.usage')}\n`);
    return EXIT.USAGE;
  }
  if (parsed.help) {
    io.stdout.write(`${t('validate.usage')}\n`);
    return EXIT.OK;
  }

  // A path argument that names neither a vault root nor a real location
  // inside one is a usage error, never a silent climb to whichever
  // vault happens to enclose it (fix round 1). Climbing at all is only
  // safe once we know the given path is real: findVaultRoot's own
  // upward walk is purely lexical (dirname on a string), so it will
  // happily "find" a vault above a typo'd subdirectory, or above a
  // FILE, that was never the scope anyone asked to validate.
  let startDir = process.cwd();
  if (parsed.dir !== undefined) {
    startDir = resolve(parsed.dir);
    if (!existsSync(startDir)) {
      io.stderr.write(`${t('validate.path_not_found', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
    if (!statSync(startDir).isDirectory()) {
      io.stderr.write(`${t('validate.path_not_a_directory', { dir: startDir })}\n`);
      return EXIT.USAGE;
    }
  }

  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('validate.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }

  const config = loadConfig(root); // may throw ConfigError; src/cli.mjs's boundary maps it to exit 2

  // Every user-facing string this command itself writes, from here on,
  // comes from the language pack the VAULT declared (config.lang), not
  // from the operator's own BRAIN_KIT_LANG. `t`, the translator this
  // function was called with, reflects the operator's environment and
  // is only right for the usage errors above, which happen before any
  // vault, and therefore any vault language, is known.
  const reportT = createTranslator(config?.lang ?? REFERENCE_LANG, {
    warn: (message) => io.stderr.write(`${message}\n`),
  });

  // The single walkVault call the whole ruler contract depends on: both
  // views handed to both rulers below come from this ONE result, never
  // a second walk, so the two rulers can never disagree about what the
  // vault contains (src/vault.mjs's own header, defect 4).
  const all = walkVault(root, config, { all: true });
  const files = all.filter(isMarkdown);
  const context = { root, config, all: new Set(all), readFile: makeReadFile(root) };

  const specFindings = runSpecRules(files, context);
  const houseFindings = runHouseRules(files, context);
  const combined = applyTimestampDeviation([...specFindings, ...houseFindings], config);
  const stale = computeStale(files, context);

  const { text, json, exitCode } = buildReport(combined, stale, {
    onlyProblems: parsed.onlyProblems,
    t: reportT,
    failOn: config?.validate?.fail_on ?? FAIL_ON_DEFAULT,
  });

  if (parsed.json) {
    io.stdout.write(`${JSON.stringify(json)}\n`);
    return exitCode;
  }
  io.stdout.write(text);
  return exitCode;
}
