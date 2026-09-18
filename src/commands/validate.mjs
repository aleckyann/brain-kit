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
// vault's to claim. Flattening any of the three into one undifferentiated
// list would tell a person their vault is broken when it is only
// opinionated, and that confident-wrong reading is the one thing this
// tool must never do, because it is also the one thing that gets a
// validator switched off.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXIT } from '../exit-codes.mjs';
import { CONFIG_FILENAME, loadConfig } from '../config.mjs';
import { findVaultRoot, walkVault as realWalkVault } from '../vault.mjs';
import { PARSER_LIMITS, frontmatterKeyLine, readScalar, splitFrontmatter } from '../frontmatter.mjs';
import { runSpecRules } from '../rules/spec.mjs';
import { applyTimestampDeviation, runHouseRules } from '../rules/house.mjs';

const ROOT_INDEX = 'index.md';
const RULERS = Object.freeze(['spec', 'house']);
const GROUP_KEYS = Object.freeze(['must', 'should', 'house']);

function parseArgs(argv) {
  const result = { dir: undefined, onlyProblems: false, json: false };
  for (const arg of argv) {
    if (arg === '--only-problems') result.onlyProblems = true;
    else if (arg === '--json') result.json = true;
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
// endings exist on its own. splitFrontmatter re-normalises defensively
// on its own input too, but this is the one normalisation every reader,
// not only splitFrontmatter's callers, actually sees.
function makeReadFile(root) {
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
function computeStale(files, context, now) {
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

function formatFinding(finding, t) {
  const line = finding.line ?? '-';
  const tag = finding.warning ? `${t('validate.warning_tag')} ` : '';
  return `${finding.file}:${line}  ${finding.id}  ${tag}${finding.message}`;
}

// Renders one of the three groups (see this file's own header for why
// three, and why never flattened). --only-problems drops a group with no
// findings ENTIRELY (heading, explanation and all): without it, every
// group is shown, a clean one saying so in words, so a person can tell
// "this rule ran and found nothing" apart from "this rule never ran".
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

function renderReport(t, { must, should, house, stale, onlyProblems }) {
  const lines = [];
  lines.push(...renderGroup(t, 'must', must, onlyProblems));
  lines.push(...renderGroup(t, 'should', should, onlyProblems));
  lines.push(...renderGroup(t, 'house', house, onlyProblems));
  lines.push(t('validate.counts_summary', { must: must.length, should: should.length, house: house.length }));
  lines.push('');
  lines.push(`== ${t('validate.heading_stale')} ==`);
  lines.push(t('validate.explain_stale'));
  if (stale.length === 0) {
    lines.push(t('validate.stale_none'));
  } else {
    for (const entry of stale) lines.push(t('validate.stale_entry', { file: entry.file, staleAfter: entry.staleAfter }));
  }
  lines.push('');
  const totalFindings = must.length + should.length + house.length;
  if (totalFindings === 0) {
    lines.push(t('validate.verdict_clean'));
  } else if (must.length > 0) {
    lines.push(t('validate.verdict_broken'));
  } else {
    lines.push(t('validate.verdict_opinionated'));
  }
  return `${lines.join('\n')}\n`;
}

// runValidate(argv, io, t, deps?) - deps is test-only dependency
// injection (never used by src/cli.mjs, which calls this with three
// arguments): `walkVault` lets a test spy on the single call this
// function is required to make, and `now` lets a staleness test use a
// fixed clock instead of the real one. Both default to the real thing.
export async function runValidate(argv, io, t, { walkVault = realWalkVault, now = new Date() } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.stderr.write(`${t('validate.bad_argument', { arg: parsed.error })}\n`);
    io.stderr.write(`${t('validate.usage')}\n`);
    return EXIT.USAGE;
  }

  const startDir = parsed.dir ? resolve(parsed.dir) : process.cwd();
  const root = findVaultRoot(startDir);
  if (!root) {
    io.stderr.write(`${t('validate.no_vault', { dir: startDir, config: CONFIG_FILENAME, index: ROOT_INDEX })}\n`);
    return EXIT.USAGE;
  }

  const config = loadConfig(root); // may throw ConfigError; src/cli.mjs's boundary maps it to exit 2

  // The single walkVault call the whole ruler contract depends on: both
  // views handed to both rulers below come from this ONE result, never
  // a second walk, so the two rulers can never disagree about what the
  // vault contains (src/vault.mjs's own header, defect 4).
  const all = walkVault(root, config, { all: true });
  const files = all.filter((path) => path.endsWith('.md'));
  const context = { root, config, all: new Set(all), readFile: makeReadFile(root) };

  const specFindings = runSpecRules(files, context);
  const houseFindings = runHouseRules(files, context);
  const combined = applyTimestampDeviation([...specFindings, ...houseFindings], config);
  const stale = computeStale(files, context, now);

  const must = combined.filter((f) => f.ruler === 'spec' && f.level === 'must');
  const should = combined.filter((f) => f.ruler === 'spec' && f.level === 'should');
  const house = combined.filter((f) => f.ruler === 'house');
  const warnings = should.filter((f) => f.warning).length;

  // Staleness never affects this: a build that starts failing because
  // time passed is a build people switch off. A `should` finding
  // downgraded to a warning by applyTimestampDeviation is excluded here
  // too; a `must` finding, which the downgrade can never touch, always
  // counts.
  const exitCode = combined.some((f) => !f.warning) ? EXIT.FAILURE : EXIT.OK;

  if (parsed.json) {
    io.stdout.write(
      `${JSON.stringify({
        findings: combined,
        stale,
        counts: { must: must.length, should: should.length, house: house.length, warnings },
        parserLimits: PARSER_LIMITS,
        rulers: RULERS,
      })}\n`,
    );
    return exitCode;
  }

  io.stdout.write(renderReport(t, { must, should, house, stale, onlyProblems: parsed.onlyProblems }));
  return exitCode;
}

// exported for tests only, so a regression to a fourth group name (or a
// reordering) fails loudly instead of silently in a string comparison
export const VALIDATE_GROUP_KEYS = GROUP_KEYS;
