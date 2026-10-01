// The release gate: every tag carries its specification (the CHANGELOG
// section of its version, published as the GitHub Release body), and the
// documentation cannot fall behind a release (the READMEs' Status section
// is re-read and re-stamped whenever the version moves).
//
// Why a gate and not a habit: until 0.0.6 the newest tag was lightweight
// (no message), no GitHub Release existed, and nothing related the version
// in package.json to the CHANGELOG or to the READMEs, so the READMEs still
// described the stage of 0.0.2 four releases later. The checks live in
// scripts/release-notes.mjs (maintainer tooling, not shipped). This file
// tests the parser and every check against hand-built fixtures, tests the
// release workflow's text and its publishing step (against a fake `gh`),
// and runs the checks, without a tag, over this repository's own files, so
// the gate runs on every `npm test` and on every push in CI.
//
// The live test fails an ordinary feature commit never: it fails on a
// version bump that left the CHANGELOG heading, the READMEs' stamp or the
// READMEs' latest-tag sentence behind, and on a CHANGELOG or README that
// was broken. Tests here never call the real `gh` or `claude` and never
// touch the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { CLEAN_ENV, git, makeRepo, write } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import * as rn from '../scripts/release-notes.mjs';

const V = '0.0.7';
const FENCE = '`'.repeat(3);
const SCRIPT_PATH = join(KIT_ROOT, 'scripts', 'release-notes.mjs');
const WORKFLOW_PATH = join(KIT_ROOT, '.github', 'workflows', 'release.yml');

// ---------------------------------------------------------------- fixtures

function changelog({ unreleased = null, sections } = {}) {
  const list = sections ?? [
    [V, ' (tagged `v0.0.7`, not on npm)', '- Did the thing.'],
    ['0.0.6', ' (tagged `v0.0.6`, not on npm)', '- Older.'],
    ['0.0.1', ' (published on npm on 18/09/2026)', '- First.'],
  ];
  const parts = ['# Changelog', ''];
  if (unreleased !== null) parts.push('## Unreleased', '', ...(unreleased === '' ? [] : [unreleased, '']));
  for (const [version, suffix, body] of list) parts.push(`## ${version}${suffix}`, '', body, '');
  return parts.join('\n');
}

function readmeEn({
  version = V,
  stamp = `<!-- status-reviewed: ${version} -->`,
  sentence = `The latest tag is \`v${version}\`.`,
  intro = 'Older work lives in v0.0.5 and in second-brain-kit-0.0.5.tgz, mentioned outside any fence.',
  install = 'git clone https://example.com/second-brain-kit.git\nTAG=$(git describe --tags --abbrev=0)\n',
  heading = '## Status',
  after = '',
} = {}) {
  return [
    '# brain-kit', '', intro, '',
    '## Install', '', `${FENCE}bash`, `${install}${FENCE}`, '',
    heading, '', stamp, '',
    '| Phase | State |', '|---|---|', '| 0 | done |', '',
    `${sentence} Every version from 0.0.2 on is a git tag only.`, '',
    '## Security', '', 'Text.', after, '',
  ].join('\n');
}

function readmePt({
  version = V,
  stamp = `<!-- status-reviewed: ${version} -->`,
  sentence = `A tag mais recente é a \`v${version}\`.`,
  intro = 'Trabalho antigo na v0.0.5, fora de qualquer bloco de código.',
  install = 'git clone https://example.com/second-brain-kit.git\nTAG=$(git describe --tags --abbrev=0)\n',
  heading = '## Status',
  after = '',
} = {}) {
  return [
    '# brain-kit', '', intro, '',
    '## Instalação', '', `${FENCE}bash`, `${install}${FENCE}`, '',
    heading, '', stamp, '',
    '| Fase | Estado |', '|---|---|', '| 0 | concluída |', '',
    `${sentence} Toda versão a partir da 0.0.2 é só uma tag do git.`, '',
    '## Segurança', '', 'Texto.', after, '',
  ].join('\n');
}

function inputs(over = {}) {
  return {
    version: V,
    changelog: changelog(),
    readmes: { 'README.md': readmeEn(), 'README.pt-BR.md': readmePt() },
    ...over,
  };
}

function readmesFor(version) {
  return { 'README.md': readmeEn({ version }), 'README.pt-BR.md': readmePt({ version }) };
}

const ids = (problems) => problems.map((problem) => problem.id);
const shown = (problems) => problems.map(rn.formatProblem).join('\n');

function onlyId(problems, id) {
  assert.deepEqual(ids(problems), [id], shown(problems));
  return problems[0];
}

// ---------------------------------------------------------------- the parser

test('the CHANGELOG parser reads version headings with and without a suffix, and the Unreleased heading', () => {
  const parsed = rn.parseChangelog(changelog({ unreleased: '- Pending.' }));
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.kind, entry.version ?? null]),
    [['unreleased', null], ['version', V], ['version', '0.0.6'], ['version', '0.0.1']],
  );
  const first = parsed.entries[1];
  assert.equal(first.heading, '## 0.0.7 (tagged `v0.0.7`, not on npm)');
  assert.equal(first.body, '- Did the thing.');
  // A bare heading, no suffix, is a version heading too.
  assert.deepEqual(rn.parseChangelog('## 1.2.3\n\n- x\n').entries.map((e) => e.version), ['1.2.3']);
  // Trailing blanks on a heading line do not stop it being one; `##x` and `###` are not level-two headings.
  assert.deepEqual(rn.parseChangelog('## 1.2.3 \t \n\n- x\n\n##1.2.2\n\n### 1.2.1\n').entries.map((e) => e.version), ['1.2.3']);
  assert.equal(rn.parseChangelog('## Unreleased  \n\n- x\n').entries[0].kind, 'unreleased');
});

test('the CHANGELOG parser ignores headings inside fenced code blocks, of either fence character and any longer closing fence', () => {
  const text = [
    '## 0.0.7', '', 'Example:', '', `${FENCE}md`, '## 0.0.99 (inside a fence)', FENCE, '',
    '~~~', '## 0.0.98', '~~~~~', '',
    '`'.repeat(4), FENCE, '## 0.0.97 still inside the four-backtick fence', '`'.repeat(4), '',
    '## 0.0.6', '', '- Older.', '',
  ].join('\n');
  const parsed = rn.parseChangelog(text);
  assert.deepEqual(parsed.entries.map((entry) => entry.version), [V, '0.0.6']);
  // The fenced lines belong to the section body.
  assert.ok(parsed.entries[0].body.includes('## 0.0.99 (inside a fence)'));
  assert.ok(parsed.entries[0].body.includes('## 0.0.97 still inside'));
});

test('the CHANGELOG parser: third-level headings stay in the section, an indented line is no heading, CRLF is read', () => {
  const text = ['## 0.0.7', '', '### Sub heading', '', '- item', '    ## 0.0.99 indented four spaces', '', '## 0.0.6', '', '- Older.', ''].join('\r\n');
  const parsed = rn.parseChangelog(text);
  assert.deepEqual(parsed.entries.map((entry) => entry.version), [V, '0.0.6']);
  assert.ok(parsed.entries[0].body.includes('### Sub heading'));
  assert.ok(parsed.entries[0].body.includes('## 0.0.99 indented four spaces'));
  assert.ok(!parsed.entries[0].body.includes('\r'));
});

test('a level-two heading that is neither a version nor Unreleased ends the section above it and is no entry', () => {
  const parsed = rn.parseChangelog('## 0.0.7\n\n- a\n\n## Notes\n\n- not part of 0.0.7\n\n## 0.0.6\n\n- b\n');
  assert.deepEqual(parsed.entries.map((entry) => entry.version), [V, '0.0.6']);
  assert.equal(parsed.entries[0].body, '- a');
});

test('compareSemver orders numerically, not as text, and puts a prerelease below its release', () => {
  assert.ok(rn.compareSemver('0.0.10', '0.0.9') > 0);
  assert.ok(rn.compareSemver('0.1.0', '0.0.99') > 0);
  assert.ok(rn.compareSemver('1.0.0', '0.99.99') > 0);
  assert.equal(rn.compareSemver('0.0.7', '0.0.7'), 0);
  assert.ok(rn.compareSemver('0.1.0', '0.1.0-rc.1') > 0);
  assert.ok(rn.compareSemver('0.1.0-rc.2', '0.1.0-rc.10') < 0);
  assert.ok(rn.compareSemver('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(rn.compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
});

// ------------------------------------------------------------ the clean case

test('a clean repository passes every check, with and without a tag', () => {
  assert.deepEqual(rn.checkInputs(inputs()), []);
  // Entries under Unreleased are the normal state between releases.
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '- Pending work.' }) })), []);
  const tagged = inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: { type: 'tag', subject: 'brain-kit 0.0.7: did the thing' } });
  assert.deepEqual(rn.checkInputs(tagged), []);
});

// -------------------------------------------------------- changelog-section

test('changelog-section: the version heading is missing', () => {
  const problem = onlyId(rn.checkInputs(inputs({ changelog: changelog({ sections: [['0.0.6', '', '- Older.']] }) })), 'changelog-section');
  assert.match(problem.message, /## 0\.0\.7/);
});

test('changelog-section: a heading that only shares a prefix with the version does not count', () => {
  onlyId(rn.checkInputs(inputs({ changelog: changelog({ sections: [['0.0.70', '', '- Other.'], ['0.0.6', '', '- Older.']] }) })), 'changelog-section');
});

test('changelog-section: the heading exists only inside a code fence', () => {
  const text = ['# Changelog', '', '## 0.0.6', '', FENCE, '## 0.0.7', '- not a section', FENCE, ''].join('\n');
  onlyId(rn.checkInputs(inputs({ changelog: text })), 'changelog-section');
});

test('changelog-section: a section with only blank lines is empty', () => {
  const text = ['# Changelog', '', '## 0.0.7 (tagged `v0.0.7`, not on npm)', '', '   ', '\t', '', '## 0.0.6', '', '- Older.', ''].join('\n');
  const problem = onlyId(rn.checkInputs(inputs({ changelog: text })), 'changelog-section');
  assert.match(problem.message, /empty/);
});

test('changelog-section: a section that is the last one in the file and empty is empty', () => {
  const text = ['# Changelog', '', '## 0.0.7', ''].join('\n');
  onlyId(rn.checkInputs(inputs({ changelog: text })), 'changelog-section');
});

test('changelog-section: a section with a single non-blank line is enough', () => {
  const text = ['# Changelog', '', '## 0.0.7', '', 'Did it.', ''].join('\n');
  assert.deepEqual(rn.checkInputs(inputs({ changelog: text })), []);
});

test('changelog-section: a CHANGELOG that ends inside an unclosed code fence says so, not "no heading"', () => {
  // The fence opens above the version heading, so every heading after it is hidden.
  const hidden = ['# Changelog', '', '## Unreleased', '', FENCE + 'md', '- an example that never ends', '', '## 0.0.7', '', '- a', ''].join('\n');
  const problem = onlyId(rn.checkInputs(inputs({ changelog: hidden })), 'changelog-section');
  assert.match(problem.message, /unclosed code fence/);
  assert.match(problem.message, /line 5/);
  assert.doesNotMatch(problem.message, /rename/);
  // The heading is found but a fence opened in its section never closes: still said, once.
  const inside = ['# Changelog', '', '## 0.0.7', '', '- a', '', '~~~', 'text', ''].join('\n');
  const again = onlyId(rn.checkInputs(inputs({ changelog: inside })), 'changelog-section');
  assert.match(again.message, /unclosed code fence/);
  assert.match(again.message, /line 7/);
  // A closed fence is no problem.
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog({ sections: [[V, '', `${FENCE}\ncode\n${FENCE}`]] }) })), []);
});

test('changelog-section: the body may hold sub-headings and fenced headings and still counts as one section', () => {
  const body = ['### Part one', '', '- a', '', `${FENCE}md`, '## not a heading', FENCE].join('\n');
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog({ sections: [[V, '', body], ['0.0.6', '', '- Older.']] }) })), []);
});

test('changelog-section: the body may be 120000 characters and not one more (the Release body limit on GitHub is 125000)', () => {
  assert.equal(rn.MAX_BODY_CHARS, 120000);
  const at = changelog({ sections: [[V, '', 'x'.repeat(rn.MAX_BODY_CHARS)], ['0.0.6', '', '- Older.']] });
  assert.deepEqual(rn.checkInputs(inputs({ changelog: at })), []);
  const over = changelog({ sections: [[V, '', 'x'.repeat(rn.MAX_BODY_CHARS + 1)], ['0.0.6', '', '- Older.']] });
  const problem = onlyId(rn.checkInputs(inputs({ changelog: over })), 'changelog-section');
  assert.match(problem.message, /120001/);
  assert.match(problem.message, /125000/);
});

test('changelog-section: a version that appears twice is denounced here and in changelog-order', () => {
  const text = changelog({ sections: [[V, '', '- One.'], [V, '', '- Two.'], ['0.0.6', '', '- Older.']] });
  const problems = rn.checkInputs(inputs({ changelog: text }));
  assert.deepEqual(ids(problems), ['changelog-section', 'changelog-order'], shown(problems));
});

test('changelog-section: a missing CHANGELOG is a problem, not a crash', () => {
  const problems = rn.checkInputs(inputs({ changelog: null }));
  assert.ok(ids(problems).includes('changelog-section'), shown(problems));
});

test('changelog-section: no valid version in package.json is a problem, not a crash', () => {
  const problems = rn.checkInputs(inputs({ version: undefined }));
  assert.ok(problems.length > 0 && problems.every((p) => p.id === 'package-version'), shown(problems));
});

// ---------------------------------------------------------- changelog-order

test('changelog-order: Unreleased below a version heading', () => {
  const text = ['# Changelog', '', '## 0.0.7', '', '- a', '', '## Unreleased', '', '- b', '', '## 0.0.6', '', '- c', ''].join('\n');
  const problem = onlyId(rn.checkInputs(inputs({ changelog: text })), 'changelog-order');
  assert.match(problem.message, /Unreleased/);
});

test('changelog-order: Unreleased twice', () => {
  const text = ['# Changelog', '', '## Unreleased', '', '- a', '', '## Unreleased', '', '- b', '', '## 0.0.7', '', '- c', ''].join('\n');
  onlyId(rn.checkInputs(inputs({ changelog: text })), 'changelog-order');
});

test('changelog-order: a version that appears twice (an older one, so changelog-section stays out of it)', () => {
  const text = changelog({ sections: [[V, '', '- a'], ['0.0.6', '', '- b'], ['0.0.6', '', '- c']] });
  const problem = onlyId(rn.checkInputs(inputs({ changelog: text })), 'changelog-order');
  assert.match(problem.message, /0\.0\.6 appears twice/);
});

test('changelog-order: headings in ascending order', () => {
  const text = changelog({ sections: [['0.0.6', '', '- a'], [V, '', '- b']] });
  onlyId(rn.checkInputs(inputs({ changelog: text })), 'changelog-order');
});

test('changelog-order: a level-two heading above the first version that is not exactly "## Unreleased" is refused, so its entries cannot slip past unreleased-empty', () => {
  for (const heading of ['## Unreleased (next)', '## [Unreleased]', '## Unreleased:', '## Notes']) {
    const text = ['# Changelog', '', heading, '', '- Left behind.', '', '## 0.0.7', '', '- a', '', '## 0.0.6', '', '- b', ''].join('\n');
    const info = { type: 'tag', subject: 'brain-kit 0.0.7: x' };
    // With and without a tag: it is the only problem, and it names the heading and its line.
    for (const extra of [{}, { tag: 'v0.0.7', tagInfo: info }]) {
      const problem = onlyId(rn.checkInputs(inputs({ changelog: text, ...extra })), 'changelog-order');
      assert.ok(problem.message.includes(heading), `${heading}: ${problem.message}`);
      assert.match(problem.message, /line 3/);
    }
  }
  // The plain heading, with entries, is the normal state and stays clean.
  const plain = ['# Changelog', '', '## Unreleased', '', '- Pending.', '', '## 0.0.7', '', '- a', ''].join('\n');
  assert.deepEqual(rn.checkInputs(inputs({ changelog: plain })), []);
});

test('changelog-order: 0.0.10 sits above 0.0.9 (numeric order), and a prerelease sits below its release', () => {
  const text = changelog({ sections: [['0.0.10', '', '- a'], ['0.0.9', '', '- b'], ['0.0.9-rc.1', '', '- c']] });
  assert.deepEqual(rn.checkInputs(inputs({ version: '0.0.10', changelog: text, readmes: readmesFor('0.0.10') })), []);
  const upside = changelog({ sections: [['0.0.9', '', '- b'], ['0.0.10', '', '- a']] });
  onlyId(rn.checkInputs(inputs({ version: '0.0.10', changelog: upside, readmes: readmesFor('0.0.10') })), 'changelog-order');
});

// ------------------------------------------------------------- status-stamp

test('status-stamp: a README without the stamp, and the message names the file', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ stamp: 'No stamp here.' }), 'README.pt-BR.md': readmePt() } })), 'status-stamp');
  assert.match(problem.message, /README\.md/);
  assert.match(problem.message, /no status-reviewed comment/);
  assert.doesNotMatch(problem.message, /README\.pt-BR\.md/);
});

test('status-stamp: the Portuguese README is checked on its own', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn(), 'README.pt-BR.md': readmePt({ stamp: '' }) } })), 'status-stamp');
  assert.match(problem.message, /README\.pt-BR\.md/);
});

test('status-stamp: a stamp that holds another version (the forcing function of a version bump)', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ stamp: '<!-- status-reviewed: 0.0.6 -->' }), 'README.pt-BR.md': readmePt() } })), 'status-stamp');
  assert.match(problem.message, /0\.0\.6/);
  assert.match(problem.message, /0\.0\.7/);
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn(), 'README.pt-BR.md': readmePt({ stamp: '<!-- status-reviewed: 0.0.6 -->' }) } })), 'status-stamp');
});

test('status-stamp: a stamp with no version is a stamp with the wrong version', () => {
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ stamp: '<!-- status-reviewed: -->' }), 'README.pt-BR.md': readmePt() } })), 'status-stamp');
});

test('status-stamp: two stamps, even both right, are a problem', () => {
  const two = '<!-- status-reviewed: 0.0.7 -->\n\n<!-- status-reviewed: 0.0.7 -->';
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn(), 'README.pt-BR.md': readmePt({ stamp: two }) } })), 'status-stamp');
  assert.match(problem.message, /README\.pt-BR\.md/);
  assert.match(problem.message, /exactly one/);
});

test('status-stamp: a stamp shown inside a code fence is documentation, not a stamp', () => {
  const example = `${FENCE}html\n<!-- status-reviewed: 0.0.1 -->\n${FENCE}`;
  assert.deepEqual(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ after: example }), 'README.pt-BR.md': readmePt() } })), []);
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ stamp: example }), 'README.pt-BR.md': readmePt() } })), 'status-stamp');
});

test('status-stamp: a README that cannot be read is a problem, not a crash', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': null, 'README.pt-BR.md': readmePt() } })), 'status-stamp');
  assert.match(problem.message, /README\.md/);
});

// -------------------------------------------------------- status-latest-tag

test('status-latest-tag: a stale tag in the English README', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ sentence: 'The latest tag is `v0.0.6`.' }), 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
  assert.match(problem.message, /README\.md/);
  assert.match(problem.message, /v0\.0\.7/);
});

test('status-latest-tag: a stale tag in the Portuguese README', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn(), 'README.pt-BR.md': readmePt({ sentence: 'A tag mais recente é a `v0.0.6`.' }) } })), 'status-latest-tag');
  assert.match(problem.message, /README\.pt-BR\.md/);
});

test('status-latest-tag: each README needs its own language sentence', () => {
  // The English sentence in the Portuguese README (and the other way round) is not the sentence.
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn(), 'README.pt-BR.md': readmePt({ sentence: 'The latest tag is `v0.0.7`.' }) } })), 'status-latest-tag');
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ sentence: 'A tag mais recente é a `v0.0.7`.' }), 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
});

test('status-latest-tag: a line break inside the sentence is tolerated', () => {
  const en = readmeEn({ sentence: 'The latest tag\nis `v0.0.7`.' });
  const en2 = readmeEn({ sentence: 'The latest\ntag is\n`v0.0.7`.' });
  const pt = readmePt({ sentence: 'A tag mais recente\né a `v0.0.7`.' });
  // An indented continuation line (a list item) and a doubled space are whitespace too.
  const indented = readmeEn({ sentence: '- The latest tag\n  is  `v0.0.7`.' });
  assert.deepEqual(rn.checkInputs(inputs({ readmes: { 'README.md': indented, 'README.pt-BR.md': readmePt() } })), []);
  assert.deepEqual(rn.checkInputs(inputs({ readmes: { 'README.md': en, 'README.pt-BR.md': pt } })), []);
  assert.deepEqual(rn.checkInputs(inputs({ readmes: { 'README.md': en2, 'README.pt-BR.md': readmePt() } })), []);
});

test('status-latest-tag: a sentence that names no tag or a longer version is not the sentence', () => {
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ sentence: 'The latest tag is `v0.0.70`.' }), 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ sentence: 'The latest tag is 0.0.7.' }), 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
});

test('status-latest-tag: the sentence must sit in the Status section, not elsewhere in the README', () => {
  // Only before the Status heading.
  const before = readmeEn({ sentence: 'Nothing about tags.', intro: 'The latest tag is `v0.0.7`.' });
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': before, 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
  // Only after the next heading.
  const after = readmeEn({ sentence: 'Nothing about tags.', after: 'The latest tag is `v0.0.7`.' });
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': after, 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
});

test('status-latest-tag: a README with no Status section', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ heading: '## Progress' }), 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
  assert.match(problem.message, /Status/);
});

test('status-latest-tag: a Status heading inside a code fence is no heading', () => {
  const text = [FENCE, '## Status', 'Nothing.', FENCE, '', 'The latest tag is `v0.0.7`.', '', '<!-- status-reviewed: 0.0.7 -->', ''].join('\n');
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': text, 'README.pt-BR.md': readmePt() } })), 'status-latest-tag');
});

// ---------------------------------------------------------- install-literals

test('install-literals: a literal tag inside a fence, and the message names file and line', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn({ install: 'git checkout v0.0.6\n' }), 'README.pt-BR.md': readmePt() } })), 'install-literals');
  assert.match(problem.message, /README\.md:/);
  assert.match(problem.message, /v0\.0\.6/);
});

test('install-literals: a literal tarball name inside a fence, in the Portuguese README', () => {
  const problem = onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': readmeEn(), 'README.pt-BR.md': readmePt({ install: 'npm install ./second-brain-kit-0.0.6.tgz\n' }) } })), 'install-literals');
  assert.match(problem.message, /README\.pt-BR\.md:/);
});

test('install-literals: the same literals outside a fence are allowed (the fixture intro and the Status prose carry them)', () => {
  // readmeEn's intro names v0.0.5 and a tarball, and its Status sentence names v0.0.7, all outside fences.
  assert.deepEqual(rn.checkInputs(inputs()), []);
});

test('install-literals: a tilde fence is a fence, and a literal after the closing fence is outside it', () => {
  const tilde = readmeEn({ intro: ['~~~', 'git checkout v0.0.6', '~~~'].join('\n') });
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': tilde, 'README.pt-BR.md': readmePt() } })), 'install-literals');
  const closed = readmeEn({ intro: [FENCE, 'echo hello', FENCE, 'Back to prose with v0.0.6.'].join('\n') });
  assert.deepEqual(rn.checkInputs(inputs({ readmes: { 'README.md': closed, 'README.pt-BR.md': readmePt() } })), []);
});

test('install-literals: a fence of four backticks holding a three-backtick line stays open until a four-backtick line', () => {
  const nested = readmeEn({ intro: ['`'.repeat(4), FENCE, 'git checkout v0.0.6', FENCE, '`'.repeat(4)].join('\n') });
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': nested, 'README.pt-BR.md': readmePt() } })), 'install-literals');
});

test('install-literals: triple backticks in the middle of a line, or opening and closing on one line, open no fence', () => {
  const middle = readmeEn({ intro: `Use ${FENCE}x${FENCE} inline.\nThen prose with v0.0.6 right after.` });
  assert.deepEqual(rn.checkInputs(inputs({ readmes: { 'README.md': middle, 'README.pt-BR.md': readmePt() } })), []);
  const whole = readmeEn({ intro: `${FENCE}x${FENCE} is inline code.\nThen prose with v0.0.6 right after.` });
  assert.deepEqual(rn.checkInputs(inputs({ readmes: { 'README.md': whole, 'README.pt-BR.md': readmePt() } })), []);
});

test('install-literals: a fence indented inside a list item is still a fence', () => {
  const listed = readmeEn({ intro: ['- step one:', '', `   ${FENCE}bash`, '   git checkout v0.0.6', `   ${FENCE}`].join('\n') });
  onlyId(rn.checkInputs(inputs({ readmes: { 'README.md': listed, 'README.pt-BR.md': readmePt() } })), 'install-literals');
});

// ----------------------------------------------------------- tag-version

test('tag-version: the tag is v plus the package version', () => {
  assert.deepEqual(rn.checkTagVersion('v0.0.7', V), []);
});

test('tag-version: a tag without the v, with another version, or that is no version at all', () => {
  const withoutV = onlyId(rn.checkTagVersion('0.0.7', V), 'tag-version');
  assert.match(withoutV.message, /v0\.0\.7/);
  onlyId(rn.checkTagVersion('v0.0.8', V), 'tag-version');
  onlyId(rn.checkTagVersion('v0.0.70', V), 'tag-version');
  onlyId(rn.checkTagVersion('release-7', V), 'tag-version');
  onlyId(rn.checkTagVersion('v1', V), 'tag-version');
  onlyId(rn.checkTagVersion('', V), 'tag-version');
});

test('tag-version: through checkInputs, with a clean tag object', () => {
  const info = { type: 'tag', subject: 'brain-kit 0.0.7: did the thing' };
  const problems = rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.8', tagInfo: info }));
  assert.deepEqual(ids(problems), ['tag-version'], shown(problems));
});

test('a hostile tag name is echoed on one line and never reaches git', () => {
  const hostile = 'v0.0.7\n::set-output name=x::y';
  const problems = rn.checkTagVersion(hostile, V);
  onlyId(problems, 'tag-version');
  assert.equal(rn.formatProblem(problems[0]).includes('\n'), false);
});

// ---------------------------------------------------------- tag-annotated

function tagRepo() {
  const root = makeRepo({ 'a.txt': 'a\n' }, 'brain-kit-tags-');
  return root;
}

function tagCmd(root, args) {
  return git(root, ['-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', 'tag', ...args]);
}

test('tag-annotated: a lightweight tag is refused (its "subject" is the commit message, which proves nothing)', () => {
  const root = tagRepo();
  tagCmd(root, ['v0.0.7']);
  const info = rn.readTagInfo('v0.0.7', root);
  assert.equal(info.type, 'commit');
  const problem = onlyId(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: info })), 'tag-annotated');
  assert.match(problem.message, /lightweight/);
  assert.match(problem.message, /git tag -a/);
});

test('tag-annotated: an annotated tag with a subject passes, and the subject is read as one line', () => {
  const root = tagRepo();
  tagCmd(root, ['-a', 'v0.0.7', '-m', 'brain-kit 0.0.7: did\nthe thing', '-m', 'A second paragraph.']);
  const info = rn.readTagInfo('v0.0.7', root);
  assert.deepEqual(info, { type: 'tag', subject: 'brain-kit 0.0.7: did the thing' });
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: info })), []);
});

test('tag-annotated: an annotated tag whose subject is empty is refused', () => {
  const root = tagRepo();
  tagCmd(root, ['-a', 'v0.0.7', '-m', '']);
  const info = rn.readTagInfo('v0.0.7', root);
  assert.deepEqual(info, { type: 'tag', subject: '' });
  const problem = onlyId(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: info })), 'tag-annotated');
  assert.match(problem.message, /subject/);
  // Blanks alone are empty too.
  onlyId(rn.checkTagAnnotated('v0.0.7', { type: 'tag', subject: '   ' }), 'tag-annotated');
});

test('tag-annotated: a tag that does not exist in the repository is refused', () => {
  const root = tagRepo();
  assert.equal(rn.readTagInfo('v0.0.7', root), null);
  const problem = onlyId(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: null })), 'tag-annotated');
  assert.match(problem.message, /v0\.0\.7/);
});

test('tag-annotated: readTagInfo asks git only about a plain v-plus-semver name, so a glob finds nothing', () => {
  const root = tagRepo();
  tagCmd(root, ['-a', 'v0.0.7', '-m', 'brain-kit 0.0.7: x']);
  assert.equal(rn.readTagInfo('v*', root), null);
  assert.equal(rn.readTagInfo('v0.0.*', root), null);
  assert.equal(rn.readTagInfo('refs/tags/v0.0.7', root), null);
  assert.equal(rn.readTagInfo('v0.0.7', root).type, 'tag');
});

test('tag-annotated: the answer is about the repository asked, whatever GIT_DIR the caller carries', () => {
  const root = tagRepo();
  tagCmd(root, ['-a', 'v0.0.7', '-m', 'brain-kit 0.0.7: x']);
  const other = tagRepo();
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other, '.git');
  try {
    assert.equal(rn.readTagInfo('v0.0.7', root).type, 'tag');
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

// -------------------------------------------------------- unreleased-empty

test('unreleased-empty: entries left under Unreleased when a tag is checked', () => {
  const problems = rn.checkInputs(inputs({ changelog: changelog({ unreleased: '- Left behind.' }), tag: 'v0.0.7', tagInfo: { type: 'tag', subject: 'brain-kit 0.0.7: x' } }));
  const problem = onlyId(problems, 'unreleased-empty');
  assert.match(problem.message, /Unreleased/);
});

test('unreleased-empty: an Unreleased heading with no entries, or none at all, passes a tag check', () => {
  const info = { type: 'tag', subject: 'brain-kit 0.0.7: x' };
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: info })), []);
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog(), tag: 'v0.0.7', tagInfo: info })), []);
});

test('unreleased-empty: only with a tag, so an ordinary commit with Unreleased entries stays green', () => {
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '- Pending.' }) })), []);
});

// ------------------------------------------------------------- the notes

test('releaseNotes: the section without its heading line, then the diff link when previous tag and repository are given', () => {
  const text = changelog({ unreleased: '- Pending.', sections: [[V, ' (tagged `v0.0.7`, not on npm)', '### Part\n\n- Did it.\n- Did more.'], ['0.0.6', '', '- Older.']] });
  assert.equal(rn.releaseNotes(text, V, {}), '### Part\n\n- Did it.\n- Did more.\n');
  assert.equal(
    rn.releaseNotes(text, V, { prev: 'v0.0.6', repo: 'ana/brain-kit' }),
    '### Part\n\n- Did it.\n- Did more.\n\nFull diff: https://github.com/ana/brain-kit/compare/v0.0.6...v0.0.7\n',
  );
  // Either half alone adds nothing, and an empty previous tag (the first release) is no previous tag.
  assert.equal(rn.releaseNotes(text, V, { prev: 'v0.0.6' }), '### Part\n\n- Did it.\n- Did more.\n');
  assert.equal(rn.releaseNotes(text, V, { repo: 'ana/brain-kit' }), '### Part\n\n- Did it.\n- Did more.\n');
  assert.equal(rn.releaseNotes(text, V, { prev: '', repo: 'ana/brain-kit' }), '### Part\n\n- Did it.\n- Did more.\n');
});

test('releaseNotes: blank lines around the section are trimmed, those inside stay', () => {
  const text = '# Changelog\n\n## 0.0.7\n\n\n- a\n\n\n- b\n\n\n## 0.0.6\n\n- c\n';
  assert.equal(rn.releaseNotes(text, V, {}), '- a\n\n\n- b\n');
});

test('releaseNotes: a section that is missing is an error, never an empty body', () => {
  assert.throws(() => rn.releaseNotes(changelog(), '9.9.9', {}), /9\.9\.9/);
});

test('releaseNotes: a previous tag or repository that would bend the link is refused', () => {
  assert.throws(() => rn.releaseNotes(changelog(), V, { prev: 'v0.0.6 evil', repo: 'ana/brain-kit' }), /previous tag/);
  assert.throws(() => rn.releaseNotes(changelog(), V, { prev: 'v0.0.6', repo: 'ana/brain kit' }), /repository/);
  assert.throws(() => rn.releaseNotes(changelog(), V, { prev: 'v0.0.6', repo: 'ana/brain-kit/extra' }), /repository/);
  assert.throws(() => rn.releaseNotes(changelog(), V, { prev: 'v0.0.6', repo: 'ana/../brain-kit' }), /repository/);
});

// ------------------------------------------------------------------- the CLI

const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

// A repository with the script copied in (the script finds the repository
// from its own location) and src/ linked so its one import resolves.
function scratch({ version = V, changelogText = changelog(), en = readmeEn(), pt = readmePt() } = {}) {
  const root = makeRepo({
    'package.json': `${JSON.stringify({ name: 'second-brain-kit', version }, null, 2)}\n`,
    'CHANGELOG.md': changelogText,
    'README.md': en,
    'README.pt-BR.md': pt,
    'scripts/release-notes.mjs': SCRIPT_SOURCE,
  }, 'brain-kit-release-');
  symlinkSync(join(KIT_ROOT, 'src'), join(root, 'src'));
  return root;
}

function cli(root, args) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'release-notes.mjs'), ...args], { cwd: root, encoding: 'utf8', env: CLEAN_ENV });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('cli check: a clean repository prints "release check ok" and exits 0', () => {
  const root = scratch();
  const result = cli(root, ['check']);
  assert.deepEqual(result, { status: 0, stdout: 'release check ok\n', stderr: '' });
});

test('cli check: one line per problem, each starting with its check id, and exit 1', () => {
  const root = scratch({ en: readmeEn({ stamp: '<!-- status-reviewed: 0.0.6 -->', sentence: 'The latest tag is `v0.0.6`.' }) });
  const result = cli(root, ['check']);
  assert.equal(result.status, 1);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2, result.stdout);
  assert.match(lines[0], /^status-stamp: /);
  assert.match(lines[1], /^status-latest-tag: /);
  assert.doesNotMatch(result.stdout, /release check ok/);
});

test('cli check --tag: a lightweight tag fails, an annotated one passes', () => {
  const root = scratch();
  tagCmd(root, ['v0.0.7']);
  const light = cli(root, ['check', '--tag', 'v0.0.7']);
  assert.equal(light.status, 1);
  assert.match(light.stdout, /^tag-annotated: /m);
  tagCmd(root, ['-d', 'v0.0.7']);
  tagCmd(root, ['-a', 'v0.0.7', '-m', 'brain-kit 0.0.7: did the thing']);
  assert.deepEqual(cli(root, ['check', '--tag', 'v0.0.7']), { status: 0, stdout: 'release check ok\n', stderr: '' });
});

test('cli check --tag: a hostile tag name is data, and a tag of another version is refused', () => {
  const root = scratch();
  const canary = join(root, 'canary');
  const hostile = cli(root, ['check', '--tag', `v0.0.7$(touch ${canary})`]);
  assert.equal(hostile.status, 1);
  assert.match(hostile.stdout, /^tag-version: /m);
  assert.equal(existsSync(canary), false);
  tagCmd(root, ['-a', 'v0.0.8', '-m', 'brain-kit 0.0.8: other']);
  assert.match(cli(root, ['check', '--tag', 'v0.0.8']).stdout, /^tag-version: /m);
});

test('cli check --tag: entries left under Unreleased fail the tag check', () => {
  const root = scratch({ changelogText: changelog({ unreleased: '- Left behind.' }) });
  tagCmd(root, ['-a', 'v0.0.7', '-m', 'brain-kit 0.0.7: x']);
  const result = cli(root, ['check', '--tag', 'v0.0.7']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^unreleased-empty: /m);
  assert.equal(cli(root, ['check']).status, 0);
});

test('cli notes: the section as the Release body, with the diff line when asked', () => {
  const root = scratch();
  const plain = cli(root, ['notes', '--version', V]);
  assert.deepEqual(plain, { status: 0, stdout: '- Did the thing.\n', stderr: '' });
  const full = cli(root, ['notes', '--version', V, '--prev', 'v0.0.6', '--repo', 'ana/brain-kit']);
  assert.equal(full.stdout, '- Did the thing.\n\nFull diff: https://github.com/ana/brain-kit/compare/v0.0.6...v0.0.7\n');
  // The workflow passes an empty previous tag for the very first release.
  const first = cli(root, ['notes', '--version', V, '--prev', '', '--repo', 'ana/brain-kit']);
  assert.deepEqual(first, { status: 0, stdout: '- Did the thing.\n', stderr: '' });
});

test('cli notes: a missing section fails with the check id on stderr and nothing on stdout', () => {
  const root = scratch();
  const result = cli(root, ['notes', '--version', '9.9.9']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^changelog-section: /);
});

test('cli: usage errors exit 2 and say what is wrong on stderr, nothing on stdout', () => {
  const root = scratch();
  for (const args of [[], ['frobnicate'], ['notes'], ['notes', '--version', 'x'], ['notes', '--version', V, '--repo', 'a b/c'], ['check', '--tag'], ['check', '--nope']]) {
    const result = cli(root, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '', `${args.join(' ')}: nothing said on stderr`);
  }
});

// -------------------------------------------------------------------- live

test('LIVE: this repository passes the release checks (no tag), so the gate runs on every npm test and in CI', () => {
  const found = rn.checkRepository(KIT_ROOT);
  assert.deepEqual(found, [], `the release checks found problems:\n${shown(found)}`);
});

test('LIVE: the live run read real files, so a pass is not an empty pass', () => {
  const read = rn.readInputs(KIT_ROOT);
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));
  assert.equal(read.version, pkg.version);
  assert.ok(read.changelog.includes(`## ${pkg.version}`), 'CHANGELOG.md was not read');
  for (const name of ['README.md', 'README.pt-BR.md']) {
    assert.ok(read.readmes[name].includes(`<!-- status-reviewed: ${pkg.version} -->`), `${name} was not read or carries no stamp`);
    assert.ok(read.readmes[name].includes('## Status'), `${name} has no Status section`);
  }
});

test('LIVE: the script, run as a command over this repository, prints "release check ok"', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, 'check'], { cwd: KIT_ROOT, encoding: 'utf8', env: CLEAN_ENV });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, 'release check ok\n');
});

test('LIVE: the real CHANGELOG yields a Release body for the current version', () => {
  const read = rn.readInputs(KIT_ROOT);
  const body = rn.releaseNotes(read.changelog, read.version, {});
  assert.ok(body.length > 40 && body.length <= rn.MAX_BODY_CHARS + 1, `body of ${body.length} characters`);
  assert.ok(!body.startsWith('## '), 'the body must not begin with the version heading');
});

// ------------------------------------------------------------ the workflow

const WORKFLOW = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : '';

function stripComment(line) {
  return line.replace(/(^|\s)#.*$/, '').trimEnd();
}

// The lines under a top-level key, trimmed, comments and blanks dropped.
function topBlock(text, key) {
  const out = [];
  let inside = false;
  for (const raw of text.split('\n')) {
    if (/^\S/.test(raw) && !raw.startsWith('#')) {
      inside = raw.startsWith(`${key}:`);
      const rest = inside ? stripComment(raw.slice(key.length + 1)).trim() : '';
      if (rest) out.push(rest);
      continue;
    }
    if (inside) {
      const line = stripComment(raw).trim();
      if (line) out.push(line);
    }
  }
  return out;
}

// Every `run:` value in a workflow: the text on its line, or the block
// under `run: |` / `run: >` (every following line indented deeper than the
// key). `line` is the 1-based line of the `run:` key.
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(?:- )?run:[ \t]*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (/^[|>][+-]?\d*$/.test(rest)) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() !== '' && lines[j].length - lines[j].trimStart().length <= indent) break;
        body.push(lines[j]);
      }
      blocks.push({ line: i + 1, text: body.join('\n') });
      i = j - 1;
    } else {
      blocks.push({ line: i + 1, text: rest });
    }
  }
  return blocks;
}

test('the workflow helpers: a widened trigger, a wider permission and an expression inside run are all visible', () => {
  const ok = ['name: R', 'on:', '  push:', '    tags:', "      - 'v*'", 'permissions:', '  contents: write', 'jobs:', '  j:', '    steps:', '      - run: echo hi', ''].join('\n');
  assert.deepEqual(topBlock(ok, 'on'), ['push:', 'tags:', "- 'v*'"]);
  assert.deepEqual(topBlock(ok, 'permissions'), ['contents: write']);
  const widened = ok.replace("    tags:\n      - 'v*'\n", '');
  assert.notDeepEqual(topBlock(widened, 'on'), ['push:', 'tags:', "- 'v*'"]);
  const inline = `${ok}      - run: echo \${{ github.ref_name }}\n`;
  const block = `${ok}      - run: |\n          echo "\${{ github.ref_name }}"\n          echo two\n      - name: env step\n        env:\n          TAG: \${{ github.ref_name }}\n        run: echo "$TAG"\n`;
  assert.deepEqual(runBlocks(inline).filter((b) => b.text.includes('${{')).length, 1);
  const found = runBlocks(block);
  assert.equal(found.length, 3);
  assert.deepEqual(found.map((b) => b.text.includes('${{')), [false, true, false]);
});

test('the Release workflow runs only on the push of a v* tag', () => {
  assert.ok(WORKFLOW.length > 0, '.github/workflows/release.yml is missing');
  assert.deepEqual(topBlock(WORKFLOW, 'on'), ['push:', 'tags:', "- 'v*'"]);
});

test('the Release workflow asks for contents: write and nothing else, at the top and in the job', () => {
  assert.deepEqual(topBlock(WORKFLOW, 'permissions'), ['contents: write']);
  assert.equal((WORKFLOW.match(/^\s*permissions:/gm) ?? []).length, 1, 'permissions must be declared once, at the top');
});

test('the Release workflow never puts an expression inside a run block (the tag and the token come through env)', () => {
  const blocks = runBlocks(WORKFLOW);
  assert.ok(blocks.length >= 2, `expected at least two run blocks, found ${blocks.length}`);
  const bad = blocks.filter((block) => block.text.includes('${{'));
  assert.deepEqual(bad.map((block) => block.line), [], 'a ${{ }} expression sits inside a run block');
  assert.match(WORKFLOW, /TAG: \$\{\{ github\.ref_name \}\}/);
  assert.match(WORKFLOW, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

// The steps of a workflow, each as its own text (a step starts at a line with a dash at the step indent).
function workflowSteps(text) {
  return text.split(/^(?=      - )/m).filter((chunk) => chunk.startsWith('      - '));
}

const FETCH_TAG = 'git fetch --force --no-tags origin "+refs/tags/$TAG:refs/tags/$TAG"';

// On a tag push, actions/checkout fetches the tags in full (the annotated tag
// object arrives), finds that the tag does not point at the pushed commit,
// and then runs a second fetch of `+<sha>:refs/tags/<tag>`, which rewrites
// the tag as a lightweight one (upstream actions/checkout#290). Every real
// release would then be refused by tag-annotated. The workflow fetches the
// tag object again before the check.
test('the Release workflow fetches the annotated tag object again, after checkout and before the check, with TAG through env', () => {
  const checkout = WORKFLOW.indexOf('actions/checkout@v5');
  const fetch = WORKFLOW.indexOf(FETCH_TAG);
  const check = WORKFLOW.indexOf('release-notes.mjs check --tag "$TAG"');
  assert.ok(fetch >= 0, `no run block holds ${FETCH_TAG}`);
  assert.ok(checkout >= 0 && checkout < fetch && fetch < check, 'order must be checkout, fetch of the tag, check');
  const step = workflowSteps(WORKFLOW).find((candidate) => candidate.includes(FETCH_TAG));
  assert.ok(step.includes('env:\n          TAG: ${{ github.ref_name }}\n'), 'TAG must come through env');
  const block = runBlocks(WORKFLOW).find((candidate) => candidate.text.includes('git fetch'));
  assert.equal(block.text, FETCH_TAG, 'the step runs exactly the fetch, with no expression in its text');
});

test('checkout flattens an annotated tag into a lightweight one, and the workflow step restores it (real git, local origin)', () => {
  const base = realpathSync(makeTempDir('brain-kit-flatten-'));
  git(base, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
  git(base, ['init', '-q', '-b', 'main', 'work']);
  const work = join(base, 'work');
  write(work, 'a.txt', 'a\n');
  git(work, ['add', 'a.txt']);
  git(work, ['-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'the commit subject']);
  tagCmd(work, ['-a', 'v0.0.7', '-m', 'brain-kit 0.0.7: did the thing']);
  git(work, ['remote', 'add', 'origin', join(base, 'origin.git')]);
  git(work, ['push', '-q', 'origin', 'main', '--tags']);
  git(base, ['clone', '-q', 'origin.git', 'clone']);
  const clone = join(base, 'clone');
  const info = () => git(clone, ['for-each-ref', 'refs/tags/v0.0.7', '--format=%(objecttype)%09%(contents:subject)']).trim();
  assert.equal(info(), 'tag\tbrain-kit 0.0.7: did the thing', 'precondition: a clone carries the annotated tag');
  // What actions/checkout does after the full fetch of the tags.
  const sha = git(clone, ['rev-parse', 'HEAD']).trim();
  git(clone, ['tag', '-d', 'v0.0.7']);
  git(clone, ['fetch', '-q', '--no-tags', 'origin', `+${sha}:refs/tags/v0.0.7`]);
  assert.equal(info(), 'commit\tthe commit subject', 'the flattening fetch must reproduce the lightweight tag');
  const flat = rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: rn.readTagInfo('v0.0.7', clone) }));
  assert.deepEqual(ids(flat), ['tag-annotated'], 'the gate refuses the flattened tag');
  // The workflow step, run as written.
  const block = runBlocks(WORKFLOW).find((candidate) => candidate.text.includes('git fetch'));
  const cure = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', block.text], { cwd: clone, encoding: 'utf8', env: { ...CLEAN_ENV, TAG: 'v0.0.7' } });
  assert.equal(cure.status, 0, cure.stderr);
  assert.equal(info(), 'tag\tbrain-kit 0.0.7: did the thing', 'the step must restore the annotated tag and its subject');
  assert.deepEqual(rn.checkInputs(inputs({ changelog: changelog({ unreleased: '' }), tag: 'v0.0.7', tagInfo: rn.readTagInfo('v0.0.7', clone) })), []);
});

test('the Release workflow: full-history checkout, Node 24, the check before the Release, create with --verify-tag, edit when it exists', () => {
  assert.match(WORKFLOW, /actions\/checkout@v5/);
  assert.match(WORKFLOW, /fetch-depth: 0/);
  assert.match(WORKFLOW, /actions\/setup-node@v5/);
  assert.match(WORKFLOW, /node-version: '24'/);
  const ci = readFileSync(join(KIT_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /actions\/checkout@v5/);
  assert.match(ci, /actions\/setup-node@v5/);
  const check = WORKFLOW.indexOf('release-notes.mjs check --tag "$TAG"');
  const notes = WORKFLOW.indexOf('release-notes.mjs notes');
  const create = WORKFLOW.indexOf('gh release create');
  assert.ok(check >= 0 && notes > check && create > notes, 'order must be check, notes, create');
  assert.match(WORKFLOW, /gh release create "\$TAG" --title="\$TITLE" --notes-file "\$NOTES" --verify-tag/);
  assert.match(WORKFLOW, /gh release edit "\$TAG" --title="\$TITLE" --notes-file "\$NOTES" --verify-tag/);
  // Only a three-part version tag can be the previous one, so `v1` or `v2.0` never reaches --prev.
  assert.match(WORKFLOW, /git describe --tags --abbrev=0 --match 'v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*' "\$TAG\^"/);
  assert.doesNotMatch(WORKFLOW, /gh release upload|upload-artifact/, 'nothing is attached to the Release');
});

// The publishing step, run for real in bash against a fake `gh` that
// records its arguments, in a repository with two tags.
function publishStep() {
  const block = runBlocks(WORKFLOW).find((candidate) => candidate.text.includes('gh release create'));
  assert.ok(block, 'no run block holds `gh release create`');
  const lines = block.text.split('\n');
  const indent = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indent)).join('\n');
}

// `previous` false is the very first release (no earlier tag); `nearerTags`
// are tags that sit between v0.0.6 and the release and are not versions.
function runPublish({ subject, tag = 'v0.0.7', exists = false, previous = true, nearerTags = [] }) {
  const root = scratch();
  if (previous) tagCmd(root, ['-a', 'v0.0.6', '-m', 'brain-kit 0.0.6: the previous one']);
  if (nearerTags.length > 0) {
    write(root, 'middle.txt', 'middle\n');
    git(root, ['add', 'middle.txt']);
    git(root, ['-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'middle']);
    for (const name of nearerTags) tagCmd(root, ['-a', name, '-m', `not a version: ${name}`]);
  }
  write(root, 'later.txt', 'later\n');
  git(root, ['add', 'later.txt']);
  git(root, ['-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'later']);
  tagCmd(root, ['-a', tag, '-m', subject]);
  const bin = join(makeTempDir('brain-kit-fakegh-'), 'bin');
  mkdirSync(bin);
  const log = join(dirname(bin), 'gh.log');
  const fake = [
    "const fs = require('node:fs');",
    'const argv = process.argv.slice(2);',
    'const entry = { argv };',
    "const at = argv.indexOf('--notes-file');",
    "if (at >= 0) entry.notes = fs.readFileSync(argv[at + 1], 'utf8');",
    "fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(entry) + '\\n');",
    "if (argv[0] === 'release' && argv[1] === 'view') process.exit(process.env.FAKE_GH_EXISTS === '1' ? 0 : 1);",
    '',
  ].join('\n');
  writeFileSync(join(bin, 'gh.cjs'), fake);
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\nexec node "$(dirname "$0")/gh.cjs" "$@"\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const script = join(dirname(bin), 'step.sh');
  writeFileSync(script, publishStep());
  const runnerTemp = join(dirname(bin), 'runner');
  mkdirSync(runnerTemp);
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...CLEAN_ENV, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, TAG: tag, REPO: 'ana/brain-kit', GH_TOKEN: 'not-a-token', RUNNER_TEMP: runnerTemp, FAKE_GH_LOG: log, FAKE_GH_EXISTS: exists ? '1' : '0' },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { root, result, calls, runnerTemp };
}

test('the publishing step creates the Release with the annotated subject as title, the CHANGELOG section as notes and the diff link', () => {
  const { result, calls, runnerTemp } = runPublish({ subject: 'brain-kit 0.0.7: did the thing' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.deepEqual(calls[0].argv, ['release', 'view', 'v0.0.7']);
  const norm = calls[1].argv.map((arg) => (arg.startsWith(runnerTemp) ? '<notes>' : arg));
  assert.deepEqual(norm, ['release', 'create', 'v0.0.7', '--title=brain-kit 0.0.7: did the thing', '--notes-file', '<notes>', '--verify-tag']);
  assert.equal(calls[1].notes, '- Did the thing.\n\nFull diff: https://github.com/ana/brain-kit/compare/v0.0.6...v0.0.7\n');
});

test('the publishing step is idempotent: a Release that already exists is edited with the same arguments', () => {
  const { result, calls, runnerTemp } = runPublish({ subject: 'brain-kit 0.0.7: did the thing', exists: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.length, 2, JSON.stringify(calls));
  const norm = calls[1].argv.map((arg) => (arg.startsWith(runnerTemp) ? '<notes>' : arg));
  assert.deepEqual(norm, ['release', 'edit', 'v0.0.7', '--title=brain-kit 0.0.7: did the thing', '--notes-file', '<notes>', '--verify-tag']);
});

test('the publishing step passes a tag subject full of quotes, substitutions and newlines as data', () => {
  const dir = makeTempDir('brain-kit-canary-');
  const canary = join(dir, 'canary');
  const subject = `brain-kit 0.0.7: "quoted" 'single' $(touch ${canary}) \`touch ${canary}\` ; touch ${canary} #\nsecond line \${HOME} $TAG`;
  const { result, calls } = runPublish({ subject });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(canary), false, 'the tag subject was run as a command');
  const expected = `brain-kit 0.0.7: "quoted" 'single' $(touch ${canary}) \`touch ${canary}\` ; touch ${canary} # second line \${HOME} $TAG`;
  const create = calls.find((call) => call.argv[1] === 'create');
  assert.equal(create.argv.filter((arg) => arg.startsWith('--title')).join('|'), `--title=${expected}`);
});

test('the publishing step keeps a subject that starts with a dash inside the --title argument, on create and on edit', () => {
  const subject = '--notes injected -R other/repo --verify-tag';
  for (const exists of [false, true]) {
    const { result, calls } = runPublish({ subject, exists });
    assert.equal(result.status, 0, result.stderr);
    const call = calls.find((candidate) => candidate.argv[1] === (exists ? 'edit' : 'create'));
    assert.equal(call.argv.filter((arg) => arg === '-R' || arg === '--notes' || arg === 'other/repo').length, 0, 'the subject was split into arguments');
    assert.deepEqual(call.argv.filter((arg) => arg.startsWith('--title')), [`--title=${subject}`]);
  }
});

test('the publishing step publishes the very first release: no previous tag, a Release body with no diff line', () => {
  const { result, calls } = runPublish({ subject: 'brain-kit 0.0.7: the first one', previous: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map((call) => call.argv[1]), ['view', 'create']);
  assert.equal(calls[1].notes, '- Did the thing.\n');
  assert.doesNotMatch(calls[1].notes, /Full diff/);
});

test('the publishing step takes as previous tag only a three-part version tag, never v1 or v2.0 sitting nearer', () => {
  const { result, calls } = runPublish({ subject: 'brain-kit 0.0.7: x', nearerTags: ['v1', 'v2.0'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls[1].notes, '- Did the thing.\n\nFull diff: https://github.com/ana/brain-kit/compare/v0.0.6...v0.0.7\n');
});

test('the publishing step passes a hostile tag name as data too', () => {
  const tag = 'v0.0.7$(touch${IFS}canary)';
  const probe = spawnSync('git', ['check-ref-format', `refs/tags/${tag}`], { env: CLEAN_ENV });
  assert.equal(probe.status, 0, 'git must accept the hostile name for this test to mean anything');
  const { root } = runPublish({ subject: 'brain-kit 0.0.7: x', tag });
  assert.equal(existsSync(join(root, 'canary')), false, 'the tag name was run as a command');
});

// ------------------------------------------------------------ what ships

test('the script is maintainer tooling: not in package.json files, not in the tarball, ASCII only, argv arrays only', () => {
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.files.some((entry) => entry.startsWith('scripts') || entry === 'docs/releasing.md' || entry === 'docs/' || entry === 'docs'), 'scripts/ or docs/releasing.md is listed in files');
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const parsed = JSON.parse(packed.stdout);
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const paths = report.files.map((file) => file.path);
  assert.ok(paths.includes('CHANGELOG.md'), 'precondition: the tarball lists the CHANGELOG');
  assert.deepEqual(paths.filter((path) => path.startsWith('scripts/') || path === 'docs/releasing.md' || path.startsWith('.github/')), []);
  const bytes = readFileSync(SCRIPT_PATH);
  assert.ok(bytes.every((byte) => byte < 128), 'scripts/release-notes.mjs holds a non-ASCII byte');
  const source = bytes.toString('utf8');
  // The only thing taken from child_process is execFileSync (argument arrays), and no call sets a shell.
  const fromChildProcess = /^import \{([^}]*)\} from 'node:child_process';$/m.exec(source);
  assert.ok(fromChildProcess, 'the script does not import from node:child_process');
  assert.deepEqual(fromChildProcess[1].split(',').map((name) => name.trim()), ['execFileSync']);
  assert.ok(!/shell\s*:/.test(source), 'a call sets the shell option');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(imports.every((spec) => spec.startsWith('node:') || spec.startsWith('../src/')), `unexpected import: ${imports.join(', ')}`);
});
