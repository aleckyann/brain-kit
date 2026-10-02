// Release gate and Release notes for brain-kit. Maintainer tooling: it is
// not part of the npm package (package.json "files" does not list it) and it
// has no dependency beyond Node itself and the repository's own
// src/git-env.mjs.
//
//   node scripts/release-notes.mjs check [--tag vX.Y.Z]
//   node scripts/release-notes.mjs notes --version X.Y.Z [--prev vA.B.C] [--repo owner/name]
//
// `check` is the mechanical half of two promises: every tag says what was
// done in it (the CHANGELOG section of its version is the specification of
// the tag, and the Release workflow publishes it as the Release body), and
// the documentation cannot fall behind a release (the version in
// package.json must be the one the stage section of each status document
// was last re-read for: README.md, the Portuguese front door, under its own
// stage heading, and the two complete guides, docs/guia.md in Portuguese and
// docs/guide.md in English, under "Status"; STATUS_DOCUMENTS below names
// them). Without --tag it runs on every `npm test` and in CI on every
// push; with --tag it also judges the tag the Release workflow was started
// by. Each problem is one line, `<check id>: <what is wrong and the fix>`,
// and the ids are stable: tests and the maintainer checklist name them. They
// are package-version, changelog-section, changelog-order, changelog-raw-html,
// status-stamp, status-latest-tag, install-literals, tag-version,
// tag-annotated and unreleased-empty; docs/releasing.md says what each one
// refuses.
//
// The CHANGELOG is read line by line with a few simple rules, no markdown
// library: a heading is a line of at most three spaces, one or two `#`, a
// space and a text, outside a fenced code block. A fence opens with three or
// more backticks or tildes and closes with at least as many of the same
// character.
//
// changelog-raw-html reads the section of the version in package.json the way
// GitHub reads a Release body: text that looks like an HTML tag (`<word>`,
// `<word attr>`, `</word>`, `<!--`) is HTML there, and its sanitizer drops an
// element it does not know, so a placeholder such as `<folder>` vanishes from
// the notes (the final review of 0.0.9). Code fences and inline code spans are
// skipped, and a span may run across the lines of one paragraph, so the
// section is judged by paragraph: a blank line, a list item, a heading, a
// quote line or a table row starts a new one, which keeps a stray backtick
// from reaching into the next bullet. An autolink (`<https://...>`,
// `<name@example.com>`), a backslash escape and a `<` that no tag starts are
// not offences. Older sections are history and are not judged.
//
// Git is only ever started with an argument array, never a shell string, and
// a tag name is looked up only after it was shown to be `v` plus a semver
// version, so nothing a tag is called reaches a pattern or a shell.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withoutLocalGitVars } from '../src/git-env.mjs';

// GitHub refuses a Release body over 125000 characters. The bound here is
// lower to leave room for the diff line the notes end with, and it is
// denounced when it bites rather than cutting the text.
export const MAX_BODY_CHARS = 120000;
export const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';

const SEMVER_RE = new RegExp(`^${SEMVER}$`);
const TAG_RE = new RegExp(`^v(${SEMVER})$`);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEADING_RE = /^ {0,3}(#{1,2})(?:[ \t]+(.*))?$/;
const STAMP_RE = /<!--\s*status-reviewed:\s*(.*?)\s*-->/g;
const LITERAL_RES = [/v\d+\.\d+\.\d+/, /second-brain-kit-\d+\.\d+\.\d+\.tgz/];

// The status documents: each with the level-two heading of the section that
// says the stage (the stamp sits right under it) and the latest-tag sentence
// that section must hold, in the document's language. README.md has been the
// Portuguese front door since 02/10/2026, with a short stage section; the
// complete guides carry the phase table under "Status". The Portuguese words
// carry accented letters, built from their code points so this file stays
// ASCII.
const E_ACUTE = String.fromCharCode(0xe9);
const A_ACUTE = String.fromCharCode(0xe1);
const PORTUGUESE_SENTENCE = (version) => `A tag mais recente ${E_ACUTE} a \`v${version}\`.`;
const ENGLISH_SENTENCE = (version) => `The latest tag is \`v${version}\`.`;
const STATUS_DOCUMENTS = {
  'README.md': { heading: `Em que p${E_ACUTE} est${A_ACUTE}`, sentence: PORTUGUESE_SENTENCE },
  'docs/guia.md': { heading: 'Status', sentence: PORTUGUESE_SENTENCE },
  'docs/guide.md': { heading: 'Status', sentence: ENGLISH_SENTENCE },
};
export const STATUS_FILES = Object.keys(STATUS_DOCUMENTS);

const quote = (value) => JSON.stringify(String(value));
const problem = (id, message) => ({ id, message });

export function formatProblem({ id, message }) {
  return `${id}: ${message.replace(/[\u0000-\u001f\u007f]/g, ' ')}`;
}

// ------------------------------------------------------------------ semver

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(value);
  if (!match) throw new Error(`${quote(value)} is not a semver version`);
  return { core: [match[1], match[2], match[3]].map(BigInt), pre: match[4] === undefined ? null : match[4].split('.') };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const [x, y] = [BigInt(a), BigInt(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Semver 2.0 precedence: numeric fields as numbers, a prerelease below its
// release, prerelease identifiers one by one (numbers below words, a shorter
// list below a longer one it starts).
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i += 1) {
    const order = compareIdentifiers(x.pre[i], y.pre[i]);
    if (order !== 0) return order;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

// ------------------------------------------------------------------- lines

// Splits a text into lines and marks the ones inside a fenced code block.
// `fenced` is true for the fence lines themselves too; `delimiter` is true
// for those, so a caller that reads the code skips the info string.
// `unclosedAt` is the line of a fence still open at the end of the text, or
// null: everything after such a fence is code, headings included.
function scanDocument(text) {
  const items = [];
  let open = null;
  text.split(/\r\n|\n/).forEach((raw, index) => {
    const line = index + 1;
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (open) {
      const closes = fence !== null && fence[1][0] === open.char && fence[1].length >= open.size && fence[2].trim() === '';
      if (closes) open = null;
      items.push({ text: raw, line, fenced: true, delimiter: closes });
      return;
    }
    // A backtick fence whose info string holds a backtick is inline code.
    if (fence !== null && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      open = { char: fence[1][0], size: fence[1].length, line };
      items.push({ text: raw, line, fenced: true, delimiter: true });
      return;
    }
    items.push({ text: raw, line, fenced: false, delimiter: false });
  });
  return { items, unclosedAt: open === null ? null : open.line };
}

function scanLines(text) {
  return scanDocument(text).items;
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

// ---------------------------------------------------------------- CHANGELOG

// The level-two headings that name a version or Unreleased, in file order,
// each with the text up to the next level-one or level-two heading. Any
// other level-two heading ends a section and is not an entry; those are
// listed apart as `strays`, because a heading that looks like Unreleased but
// is not hides its entries from every other check. `unclosedAt` is the line
// of a code fence the text never closes.
export function parseChangelog(text) {
  const entries = [];
  const strays = [];
  let current = null;
  const { items, unclosedAt } = scanDocument(text);
  for (const item of items) {
    if (!item.fenced) {
      const heading = HEADING_RE.exec(item.text.trimEnd());
      if (heading) {
        current = null;
        if (heading[1].length === 2) {
          const title = heading[2] ?? '';
          const token = title.split(/[ \t]/)[0];
          if (SEMVER_RE.test(token)) current = { kind: 'version', version: token };
          else if (/^unreleased$/i.test(title)) current = { kind: 'unreleased' };
          if (current) {
            Object.assign(current, { heading: item.text.trim(), line: item.line, lines: [] });
            entries.push(current);
          } else {
            strays.push({ heading: item.text.trim(), line: item.line });
          }
        }
        continue;
      }
    }
    if (current) current.lines.push(item.text);
  }
  return {
    entries: entries.map(({ lines, ...entry }) => ({ ...entry, body: trimBlankEdges(lines).join('\n') })),
    strays,
    unclosedAt,
  };
}

export function checkChangelogSection(text, version) {
  const id = 'changelog-section';
  if (text === null || text === undefined) return [problem(id, 'CHANGELOG.md is missing or unreadable')];
  const heading = `## ${version}`;
  const parsed = parseChangelog(text);
  // Without this the next message would blame a heading the fence is hiding.
  if (parsed.unclosedAt !== null) {
    return [problem(id, `CHANGELOG.md ends inside an unclosed code fence opened at line ${parsed.unclosedAt}; every heading after it is read as code, close the fence`)];
  }
  const hits = parsed.entries.filter((entry) => entry.kind === 'version' && entry.version === version);
  if (hits.length === 0) {
    return [problem(id, `CHANGELOG.md has no "${heading}" heading; rename "## Unreleased" to "${heading} (tagged \`v${version}\`, not on npm)" and say in it what was done`)];
  }
  if (hits.length > 1) {
    return [problem(id, `CHANGELOG.md has ${hits.length} "${heading}" headings (lines ${hits.map((hit) => hit.line).join(', ')}); keep one`)];
  }
  const [entry] = hits;
  if (entry.body === '') {
    return [problem(id, `the "${heading}" section (line ${entry.line}) is empty; it is the specification of the tag and the body of the Release, write what was done in it`)];
  }
  if (entry.body.length > MAX_BODY_CHARS) {
    return [problem(id, `the "${heading}" section (line ${entry.line}) is ${entry.body.length} characters, over the ${MAX_BODY_CHARS} this check allows (GitHub refuses a Release body over 125000); move detail into docs/ and link it`)];
  }
  return [];
}

export function checkChangelogOrder(text) {
  const id = 'changelog-order';
  if (text === null || text === undefined) return [];
  const problems = [];
  const { entries, strays } = parseChangelog(text);
  const unreleased = entries.filter((entry) => entry.kind === 'unreleased');
  if (unreleased.length > 1) {
    problems.push(problem(id, `"## Unreleased" appears ${unreleased.length} times (lines ${unreleased.map((entry) => entry.line).join(', ')}); keep one`));
  }
  const firstVersion = entries.find((entry) => entry.kind === 'version');
  // Above the first version heading only "## Unreleased" may stand. Anything
  // else ("## [Unreleased]", "## Unreleased (next)", "## Unreleased:") is no
  // entry, so what is written under it would pass unreleased-empty.
  for (const stray of strays) {
    if (!firstVersion || stray.line < firstVersion.line) {
      problems.push(problem(id, `${quote(stray.heading)} (line ${stray.line}) sits above the first version heading but is not exactly "## Unreleased"; entries under it would escape the Unreleased check, rename it or move it`));
    }
  }
  for (const entry of unreleased) {
    if (firstVersion && entry.line > firstVersion.line) {
      problems.push(problem(id, `"## Unreleased" (line ${entry.line}) sits below "## ${firstVersion.version}" (line ${firstVersion.line}); it belongs above every version heading`));
    }
  }
  const seen = new Map();
  let previous = null;
  for (const entry of entries.filter((candidate) => candidate.kind === 'version')) {
    // A version seen before is denounced here, so the order test below only
    // ever compares two different versions.
    if (seen.has(entry.version)) {
      problems.push(problem(id, `version ${entry.version} appears twice (lines ${seen.get(entry.version)} and ${entry.line}); keep one section per version`));
      continue;
    }
    seen.set(entry.version, entry.line);
    if (previous && compareSemver(previous.version, entry.version) < 0) {
      problems.push(problem(id, `"## ${entry.version}" (line ${entry.line}) is not below "## ${previous.version}" (line ${previous.line}); version headings must be strictly descending`));
    }
    previous = entry;
  }
  return problems;
}

// What GitHub reads as an HTML tag in a Release body: an opening or a closing
// tag, with attributes or without, and a comment. The name is a letter and then
// letters, digits or hyphens, and it is followed by a space, a slash or the end
// of the tag. So "<folder>", "</folder>", "<br/>" and "<a href="x">" are tags,
// while "<path/to/file>", "Map<string, number>", "a < b", "<3" and an autolink
// ("<https://example.com>", "<ana@example.com>") are not.
const HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--/g;
// A line that starts a block of its own: a list item, a heading, a quote line,
// a table row. A paragraph also ends at a blank line and at a code fence, and
// a heading or a table row is a block of that one line.
const BLOCK_START_RE = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}(?:\s|$)|>|\|)/;
const ONE_LINE_BLOCK_RE = /^\s{0,3}#{1,6}(?:\s|$)|^\s*\|/;
const SHOWN_CHARS = 80;

// `source` with every inline code span and every backslash escape replaced by
// spaces (a line break stays one), so that what a pattern finds in the result
// is outside code and an offset means the same place in `source`. A code span
// opens with a run of backticks and closes with the next run of exactly as
// many, wherever it is in the paragraph; a run with no such partner is text.
function blankCode(source) {
  const blank = (part) => part.replace(/[^\n]/g, ' ');
  let out = '';
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === '\\' && /[!-/:-@[-`{-~]/.test(source[at + 1] ?? '')) {
      out += '  ';
      at += 2;
    } else if (char !== '`') {
      out += char;
      at += 1;
    } else {
      let size = 1;
      while (source[at + size] === '`') size += 1;
      let close = -1;
      for (let probe = at + size; probe < source.length && close === -1;) {
        if (source[probe] !== '`') {
          probe += 1;
          continue;
        }
        let run = 1;
        while (source[probe + run] === '`') run += 1;
        if (run === size) close = probe;
        probe += run;
      }
      if (close === -1) {
        out += source.slice(at, at + size);
        at += size;
      } else {
        out += blank(source.slice(at, close + size));
        at = close + size;
      }
    }
  }
  return out;
}

// The paragraphs of some scanned lines, code fences left out.
function proseBlocks(items) {
  const blocks = [];
  let current = null;
  for (const item of items) {
    if (item.fenced || item.text.trim() === '') {
      current = null;
      continue;
    }
    if (current === null || BLOCK_START_RE.test(item.text)) {
      current = [];
      blocks.push(current);
    }
    current.push(item);
    if (ONE_LINE_BLOCK_RE.test(item.text)) current = null;
  }
  return blocks;
}

export function checkChangelogRawHtml(text, version) {
  const id = 'changelog-raw-html';
  if (text === null || text === undefined) return [];
  const { entries, unclosedAt } = parseChangelog(text);
  // changelog-section says a fence that never closes, and everything after it
  // would be read as code here.
  if (unclosedAt !== null) return [];
  const entry = entries.find((candidate) => candidate.kind === 'version' && candidate.version === version);
  if (!entry) return [];
  const items = scanLines(text);
  const section = [];
  for (const item of items.slice(items.findIndex((candidate) => candidate.line === entry.line) + 1)) {
    if (!item.fenced && HEADING_RE.test(item.text.trimEnd())) break;
    section.push(item);
  }
  const found = [];
  for (const block of proseBlocks(section)) {
    const prose = blankCode(block.map((item) => item.text).join('\n'));
    for (const match of prose.matchAll(HTML_TAG_RE)) {
      let offset = 0;
      let line = block[0].line;
      for (const item of block) {
        line = item.line;
        if (match.index < offset + item.text.length + 1) break;
        offset += item.text.length + 1;
      }
      const shown = match[0].replace(/\s+/g, ' ');
      found.push({ line, shown: shown.length > SHOWN_CHARS ? `${shown.slice(0, SHOWN_CHARS - 3)}...` : shown });
    }
  }
  if (found.length === 0) return [];
  const [first] = found;
  const count = found.length > 1 ? `, ${found.length} in all` : '';
  return [problem(id, `the "${entry.heading}" section of CHANGELOG.md has "${first.shown}" outside code (line ${first.line}${count}); GitHub reads it as an HTML tag (an element it does not know vanishes from the Release body, one it knows is drawn instead of shown), so put it in backticks together with the command it belongs to, as in \`cd <folder>\``)];
}

export function checkUnreleasedEmpty(text) {
  if (text === null || text === undefined) return [];
  return parseChangelog(text).entries
    .filter((entry) => entry.kind === 'unreleased' && entry.body !== '')
    .map((entry) => problem('unreleased-empty', `CHANGELOG.md still has entries under "## Unreleased" (line ${entry.line}); a release must not leave entries behind, move them into the "## X.Y.Z" section of this release`));
}

// ---------------------------------------------------------- status documents

export function checkStatusStamp(file, text, version) {
  const id = 'status-stamp';
  const { heading } = STATUS_DOCUMENTS[file];
  if (text === null || text === undefined) return [problem(id, `${file} is missing or unreadable`)];
  const stamps = [];
  for (const item of scanLines(text)) {
    if (item.fenced) continue;
    for (const match of item.text.matchAll(STAMP_RE)) stamps.push(match[1]);
  }
  const wanted = `<!-- status-reviewed: ${version} -->`;
  if (stamps.length === 0) {
    return [problem(id, `${file} has no status-reviewed comment; re-read its "## ${heading}" section against reality, fix it, and put ${wanted} right under that heading`)];
  }
  if (stamps.length > 1) {
    return [problem(id, `${file} has ${stamps.length} status-reviewed comments; it must have exactly one`)];
  }
  if (stamps[0] !== version) {
    return [problem(id, `${file} was last reviewed for ${stamps[0] === '' ? '(no version)' : quote(stamps[0])} but package.json is ${version}; re-read its "## ${heading}" section against reality, fix it, and re-stamp it with ${wanted}`)];
  }
  return [];
}

// The lines of the level-two section titled `title`, outside code fences, or
// null when the document has none.
function stageSection(text, title) {
  let found = false;
  const lines = [];
  for (const item of scanLines(text)) {
    if (!item.fenced) {
      const heading = HEADING_RE.exec(item.text.trimEnd());
      if (heading) {
        if (found) break;
        if (heading[1].length === 2 && heading[2] === title) found = true;
        continue;
      }
    }
    if (found && !item.fenced) lines.push(item.text);
  }
  return found ? lines : null;
}

export function checkStatusLatestTag(file, text, version) {
  const id = 'status-latest-tag';
  if (text === null || text === undefined) return [];
  const { heading, sentence: sentenceFor } = STATUS_DOCUMENTS[file];
  const sentence = sentenceFor(version);
  const section = stageSection(text, heading);
  if (section === null) {
    return [problem(id, `${file} has no "## ${heading}" section; it must say "${sentence}"`)];
  }
  // A line break inside the sentence is fine.
  if (!section.join(' ').replace(/\s+/g, ' ').includes(sentence)) {
    return [problem(id, `the "## ${heading}" section of ${file} does not say "${sentence}"; re-read the section against reality and fix the sentence`)];
  }
  return [];
}

export function checkInstallLiterals(file, text) {
  if (text === null || text === undefined) return [];
  const problems = [];
  for (const item of scanLines(text)) {
    if (!item.fenced || item.delimiter) continue;
    for (const pattern of LITERAL_RES) {
      const match = pattern.exec(item.text);
      if (match) {
        problems.push(problem('install-literals', `${file}:${item.line} names ${quote(match[0])} inside a code block; install snippets must resolve the latest tag themselves, not name a version or a tarball`));
      }
    }
  }
  return problems;
}

// --------------------------------------------------------------------- tag

export function checkTagVersion(tag, version) {
  const id = 'tag-version';
  const match = TAG_RE.exec(tag);
  if (!match) return [problem(id, `tag ${quote(tag)} is not "v" plus a semver version (this release is v${version})`)];
  if (match[1] !== version) {
    return [problem(id, `tag ${quote(tag)} does not match the version ${version} in package.json; tag the commit that bumped the version fields, or bump them first`)];
  }
  return [];
}

export function checkTagAnnotated(tag, info) {
  const id = 'tag-annotated';
  if (info === null || info === undefined) {
    return [problem(id, `tag ${quote(tag)} does not exist in this repository (git for-each-ref refs/tags/<tag> printed nothing); create it with git tag -a`)];
  }
  if (info.type !== 'tag') {
    return [problem(id, `tag ${quote(tag)} is lightweight (it has no message of its own); delete it and create it annotated: git tag -a ${tag} -m "brain-kit ${tag.replace(/^v/, '')}: <one-line summary of what was done>"`)];
  }
  if (info.subject.trim() === '') {
    return [problem(id, `tag ${quote(tag)} is annotated but its subject is empty; it becomes the title of the Release, recreate it with git tag -a ${tag} -m "brain-kit ${tag.replace(/^v/, '')}: <one-line summary of what was done>"`)];
  }
  return [];
}

// What git says about a tag: { type, subject } or null when there is no such
// tag. `type` is "tag" for an annotated tag and "commit" for a lightweight
// one (whose "subject" is then the commit's, which proves nothing). Only a
// plain `v` plus semver name is looked up, so a glob or a path never reaches
// git's pattern matching.
export function readTagInfo(tag, cwd) {
  if (!TAG_RE.test(tag)) return null;
  const output = execFileSync('git', ['for-each-ref', `refs/tags/${tag}`, '--format=%(objecttype)%09%(contents:subject)'], {
    cwd,
    encoding: 'utf8',
    env: withoutLocalGitVars(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = output.split('\n')[0];
  if (!line) return null;
  const tab = line.indexOf('\t');
  return { type: line.slice(0, tab), subject: line.slice(tab + 1) };
}

// ------------------------------------------------------------------- checks

// Every check over what was read, nothing else touched: `version` is the
// package.json one, `changelog` the CHANGELOG text, `docs` a map from each
// status document's path (STATUS_FILES) to its text (null or absent for a file
// that could not be read), and `tag` with `tagInfo` only when a tag is being
// judged. The order of the problems is the order of the checks.
export function checkInputs({ version, changelog, docs = {}, tag, tagInfo }) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return [problem('package-version', 'package.json has no valid "version" (expected X.Y.Z); every other check is relative to it')];
  }
  const problems = [
    ...checkChangelogSection(changelog, version),
    ...checkChangelogOrder(changelog),
    ...checkChangelogRawHtml(changelog, version),
    ...STATUS_FILES.flatMap((file) => checkStatusStamp(file, docs[file], version)),
    ...STATUS_FILES.flatMap((file) => checkStatusLatestTag(file, docs[file], version)),
    ...STATUS_FILES.flatMap((file) => checkInstallLiterals(file, docs[file])),
  ];
  if (tag !== undefined && tag !== null) {
    problems.push(...checkTagVersion(tag, version));
    // A name that is not v plus semver was denounced above and never looked up.
    if (TAG_RE.test(tag)) problems.push(...checkTagAnnotated(tag, tagInfo ?? null));
    problems.push(...checkUnreleasedEmpty(changelog));
  }
  return problems;
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function readInputs(root) {
  let version;
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    version = undefined;
  }
  const docs = {};
  for (const file of STATUS_FILES) docs[file] = readOrNull(join(root, file));
  return { version, changelog: readOrNull(join(root, 'CHANGELOG.md')), docs };
}

export function checkRepository(root, { tag } = {}) {
  const inputs = readInputs(root);
  const tagInfo = tag !== undefined && TAG_RE.test(tag) ? readTagInfo(tag, root) : null;
  return checkInputs({ ...inputs, tag, tagInfo });
}

// ------------------------------------------------------------------- notes

// The Release body: the CHANGELOG section of `version` without its heading
// line, and, when both a previous tag and a repository are given, a last
// line with the comparison link. A previous tag or repository that is not
// what its name says is refused, so nothing bends the link.
export function releaseNotes(text, version, { prev, repo } = {}) {
  if (!SEMVER_RE.test(version)) throw new Error(`version ${quote(version)} is not X.Y.Z`);
  const entry = parseChangelog(text).entries.find((candidate) => candidate.kind === 'version' && candidate.version === version);
  if (!entry || entry.body === '') throw new Error(`CHANGELOG.md has no non-empty "## ${version}" section`);
  if (prev && !TAG_RE.test(prev)) throw new Error(`the previous tag ${quote(prev)} is not "v" plus a semver version`);
  if (repo && (!REPO_RE.test(repo) || repo.split('/').some((part) => part === '.' || part === '..'))) {
    throw new Error(`the repository ${quote(repo)} is not owner/name`);
  }
  const diff = prev && repo ? `\nFull diff: https://github.com/${repo}/compare/${prev}...v${version}\n` : '';
  return `${entry.body}\n${diff}`;
}

// --------------------------------------------------------------------- CLI

const USAGE = [
  'usage: node scripts/release-notes.mjs check [--tag vX.Y.Z]',
  '       node scripts/release-notes.mjs notes --version X.Y.Z [--prev vA.B.C] [--repo owner/name]',
  '',
].join('\n');

const REPOSITORY_ROOT = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));

const stdIo = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) };

// Returns the exit code: 0 clean, 1 problems found, 2 a command that cannot
// be run (bad arguments, git unavailable).
export function runCli(argv, io = stdIo, root = REPOSITORY_ROOT) {
  const [command, ...rest] = argv;
  const options = command === 'check'
    ? { tag: { type: 'string' } }
    : command === 'notes'
      ? { version: { type: 'string' }, prev: { type: 'string' }, repo: { type: 'string' } }
      : null;
  if (options === null) {
    io.err(USAGE);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options, allowPositionals: false, strict: true }));
  } catch (error) {
    io.err(`${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    if (command === 'check') {
      const problems = checkRepository(root, { tag: values.tag });
      if (problems.length === 0) {
        io.out('release check ok\n');
        return 0;
      }
      io.out(`${problems.map(formatProblem).join('\n')}\n`);
      return 1;
    }
    if (!values.version || !SEMVER_RE.test(values.version)) {
      io.err(`--version must be X.Y.Z\n${USAGE}`);
      return 2;
    }
    const inputs = readInputs(root);
    const section = checkChangelogSection(inputs.changelog, values.version);
    if (section.length > 0) {
      io.err(`${section.map(formatProblem).join('\n')}\n`);
      return 1;
    }
    io.out(releaseNotes(inputs.changelog, values.version, { prev: values.prev, repo: values.repo }));
    return 0;
  } catch (error) {
    io.err(`release-notes: ${error.message}\n`);
    return 2;
  }
}

function isMainModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exitCode = runCli(process.argv.slice(2));
