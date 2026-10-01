// One number: the oldest Node the kit supports (0.0.9, task G4).
//
// It was 24 by a plan decision nobody had measured. A real Node 22.22.1 ran the
// whole suite and only the doctor's own version policy failed, so the floor is 22,
// and CI runs the suite on 22 and on 24. That number is stated in many places, in
// different words and two languages: package.json's `engines`, the guard in front
// of the launcher, the doctor's check, the sentence each of them prints, both
// READMEs (the box at the top, the requirements, the line about the engine),
// CONTRIBUTING.md, docs/testing.md, the setup skill and the evals that grade it,
// and the CI matrix. A change of the floor that reaches some of them and not the
// others leaves a kit whose documents promise a Node its guard refuses, or whose
// CI never runs the Node it supports.
//
// So ONE test reads the number from every one of those places and fails, naming
// the places, when they differ. The guard and the doctor are read by what they DO
// (the lowest Node each accepts, and the minimum each says it wants), not only by a
// constant they export: a copy of the number kept by one of them under another
// name, or compared with another operator, differs here the day it stops being
// equal to the other. The sources are listed by hand on purpose: dropping one has
// to be an edit of this file, visible in a review.
//
// The Node the kit RECOMMENDS (24, written "LTS" and nothing more) is a second number
// with sources of its own, held the same way by a second test. A third forbids any
// sentence from saying which release line is the LTS today (that goes stale the day
// the next one becomes it), and a fourth pins the CI wiring that makes a matrix entry
// a run of the suite and not only an install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { MINIMUM_NODE_MAJOR, RECOMMENDED_NODE_MAJOR, checkNodeVersion } from '../src/node-guard.mjs';
import { MACHINE_CHECKS, buildContext, runChecks } from '../src/doctor/checks.mjs';
import { renderMessage } from '../src/commands/doctor.mjs';
import { createTranslator } from '../src/lang.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const read = (path) => readFileSync(join(KIT_ROOT, path), 'utf8');

// The first capture group of the first match of `pattern` in `text`, as a number.
// A line break inside a sentence is a space: the documents are wrapped by hand.
function numberIn(text, pattern, where) {
  const match = pattern.exec(text.replace(/\s+/g, ' '));
  assert.ok(match, `${where}: nothing matching ${pattern} (the sentence that states this number moved or was reworded: update this test with it)`);
  return Number(match[1]);
}

// The text between a line and the next level-two heading (no README section read
// here holds a code block).
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `no "${heading}" heading`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
}

// Every text file that could state a minimum, other than the places that are history
// or evidence: the changelog (it records what each version said), the tests, and the
// phase plans (docs/superpowers, not shipped).
const SWEPT_EXTENSIONS = ['.md', '.json', '.mjs', '.sh', '.yml'];
const NOT_SWEPT = new Set(['.git', 'node_modules', 'test', '.superpowers', 'superpowers', 'CHANGELOG.md', 'package-lock.json']);
function sweptFiles(dir = '') {
  const files = [];
  for (const entry of readdirSync(join(KIT_ROOT, dir), { withFileTypes: true })) {
    if (NOT_SWEPT.has(entry.name)) continue;
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sweptFiles(path));
    else if (SWEPT_EXTENSIONS.some((extension) => path.endsWith(extension))) files.push(path);
  }
  return files;
}

// A sentence that makes some Node the minimum, in either language: "Node 24 or newer",
// "Node.js 22 ou mais novo", "Node 24 and above", "Node 24+", "Node.js >= 22",
// "at least Node 24", "pelo menos o Node 24". A sentence worded some other way is not
// seen, which is why the places above are also listed by hand.
const STATES_A_MINIMUM = [
  /Node(?:\.js)? v?(\d+) (?:or|and|ou|e) (?:newer|later|higher|above|mais novo|mais recente|superior|posterior|maior)/g,
  /Node(?:\.js)? (?:>=|\u2265) ?v?(\d+)/g,
  /Node(?:\.js)? v?(\d+)\+/g,
  /(?:at least|minimum of|pelo menos|no m\u00ednimo|no minimo) (?:the )?(?:o )?Node(?:\.js)? v?(\d+)/gi,
];

// The README's "start here" box and everything before the first section, read as
// prose (the box is a blockquote, and its lines break inside sentences).
const opening = (text) => text.slice(0, text.indexOf('\n## ')).split('\n').map((line) => line.replace(/^>\s?/, '')).join('\n');

// The doctor's node-version check, run for real on a context that reads no vault,
// with a `node` on PATH that answers `--version` with `onPath` (null: no node at
// all). The running Node's version is the one injected.
function doctorSays(version, onPath = null) {
  const bin = makeTempDir('brain-kit-node-minimum-');
  if (onPath !== null) {
    const file = join(bin, 'node');
    writeFileSync(file, `#!/bin/sh\necho v${onPath}\n`);
    chmodSync(file, 0o755);
  }
  const ctx = buildContext({ root: bin, hasVault: false, env: { PATH: bin }, nodeVersion: version });
  const [result] = runChecks(ctx, ['node-version'], MACHINE_CHECKS);
  return result;
}

const FAR_ABOVE = '999.0.0';

// The guard's refusal of a Node too old to say anything about, in the language of `locale`.
const guardSentence = (locale) => checkNodeVersion('1.0.0', 'doctor', locale).message;

// The doctor's two results that carry a sentence about the Node: the one for the Node
// running it and the one for the node on PATH.
function doctorSentences() {
  const tooOld = doctorSays('1.0.0');
  assert.equal(tooOld.messageKey, 'doctor.node_version.too_old');
  const onPathTooOld = doctorSays(FAR_ABOVE, '1.0.0');
  assert.equal(onPathTooOld.messageKey, 'doctor.node_version.path_too_old');
  return { tooOld, onPathTooOld };
}

const isTooOld = (result) => result.messageKey === 'doctor.node_version.too_old' || result.messageKey === 'doctor.node_version.path_too_old';

// The lowest major `accepts` takes, found by asking it about each major in turn.
function lowestAccepted(accepts) {
  for (let major = 1; major <= 200; major += 1) if (accepts(major)) return major;
  return assert.fail('nothing up to Node 200 is accepted');
}

// The oldest entry of the CI test job's Node axis, and the step wiring around it.
function ciTestJob() {
  const lines = read('.github/workflows/ci.yml').split('\n');
  const start = lines.indexOf('  test:');
  assert.notEqual(start, -1, 'no "test" job in ci.yml');
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^ {0,2}[^\s#]/.test(line));
  return rest.slice(0, next === -1 ? rest.length : next).join('\n');
}

function nodeAxis(job) {
  const match = /^\s+node:\s*\[([^\]]*)\]/m.exec(job);
  assert.ok(match, 'the test job has no `node: [...]` axis in its matrix');
  const values = match[1].split(',').map((entry) => Number(entry.trim().replace(/^['"]|['"]$/g, '')));
  assert.ok(values.length > 0 && values.every(Number.isInteger), `the node axis is not a list of majors: ${match[1]}`);
  return values;
}

test('every place that states the minimum Node states the same one', () => {
  const found = [];
  const add = (where, value) => found.push({ where, value });

  // --- package.json, and the guard in front of the launcher
  const engines = JSON.parse(read('package.json')).engines.node;
  add('package.json engines.node', numberIn(engines, /^>=(\d+)$/, 'package.json engines.node'));
  add('src/node-guard.mjs MINIMUM_NODE_MAJOR', MINIMUM_NODE_MAJOR);
  add('the lowest Node the guard lets through', lowestAccepted((major) => checkNodeVersion(`${major}.0.0`, 'doctor', {}) === null));
  add('the guard\'s sentence (English)', numberIn(guardSentence({}), /needs Node (\d+) or newer/, 'the guard\'s English sentence'));
  add('the guard\'s sentence (Portuguese)', numberIn(guardSentence({ LANG: 'pt_BR.UTF-8' }), /precisa do Node (\d+) ou mais novo/, 'the guard\'s Portuguese sentence'));

  // --- the doctor's node-version check: the Node running it, and the node on PATH
  add('doctor: the lowest Node it accepts', lowestAccepted((major) => !isTooOld(doctorSays(`${major}.0.0`))));
  // A Node far above any floor is the one injected, so that only the node on PATH is judged.
  add('doctor: the lowest node on PATH it accepts', lowestAccepted((major) => !isTooOld(doctorSays(FAR_ABOVE, `${major}.0.0`))));
  const { tooOld, onPathTooOld } = doctorSentences();
  add('doctor: the minimum it passes to its sentence', tooOld.params.minimum);
  add('doctor: the minimum it passes to its PATH sentence', onPathTooOld.params.minimum);
  for (const [language, pattern] of [['en', /needs Node (\d+) or newer/], ['pt-BR', /precisa do Node (\d+) ou mais novo/]]) {
    const t = createTranslator(language);
    add(`doctor's sentence (${language})`, numberIn(renderMessage(t, tooOld.messageKey, tooOld.params), pattern, `the doctor's sentence (${language})`));
    add(`doctor's PATH sentence (${language})`, numberIn(renderMessage(t, onPathTooOld.messageKey, onPathTooOld.params), pattern, `the doctor's PATH sentence (${language})`));
  }

  // --- the documents a person reads
  for (const [file, requirements, named, engine] of [
    ['README.md', '## Requirements', /Node\.js (\d+) or newer/, /runs on Node\.js (\d+) and \d+/],
    ['README.pt-BR.md', '## Requisitos', /Node\.js (\d+) ou mais novo/, /roda no Node\.js (\d+) e no \d+/],
  ]) {
    const text = read(file);
    add(`${file}, the "start here" box`, numberIn(opening(text), named, `${file}, the box`));
    add(`${file}, the requirements`, numberIn(section(text, requirements), named, `${file}, the requirements`));
    add(`${file}, the line about the engine`, numberIn(text, engine, `${file}, the line about the engine`));
  }
  add('CONTRIBUTING.md', numberIn(read('CONTRIBUTING.md'), /Node\.js >= (\d+)/, 'CONTRIBUTING.md'));
  add('docs/testing.md', numberIn(read('docs/testing.md'), /needs Node (\d+) or newer/, 'docs/testing.md'));

  // --- the setup skill and the evals that grade it
  add('lang/en/skills/setup.md', numberIn(read('lang/en/skills/setup.md'), /It must be (\d+) or newer/, 'the English setup skill'));
  add('lang/pt-BR/skills/setup.md', numberIn(read('lang/pt-BR/skills/setup.md'), /Precisa ser (\d+) ou mais novo/, 'the Portuguese setup skill'));
  add('evals/setup-en graders/criteria.md', numberIn(read('evals/setup-en/graders/criteria.md'), /check Node (\d+) or newer/, 'the English setup eval'));
  add('evals/setup-pt-BR graders/criteria.md', numberIn(read('evals/setup-pt-BR/graders/criteria.md'), /conferir Node (\d+) ou mais novo/, 'the Portuguese setup eval'));

  // --- anywhere else: a sentence nobody listed above that makes some Node the
  // minimum is a stray copy of the number, and it must agree too
  for (const file of sweptFiles()) {
    const text = read(file).replace(/\s+/g, ' ');
    for (const pattern of STATES_A_MINIMUM) {
      for (const match of text.matchAll(pattern)) add(`${file}: "${match[0]}"`, Number(match[1]));
    }
  }

  // --- CI: the oldest Node the test job runs the suite on
  add('.github/workflows/ci.yml, the lowest Node of the test matrix', Math.min(...nodeAxis(ciTestJob())));

  const distinct = [...new Set(found.map((entry) => entry.value))];
  const table = found.map((entry) => `  ${String(entry.value).padStart(3)}  ${entry.where}`).join('\n');
  assert.equal(distinct.length, 1, `the minimum Node is not the same everywhere it is stated:\n${table}`);
  assert.ok(Number.isInteger(distinct[0]) && distinct[0] >= 1, `not a major: ${distinct[0]}`);
});

// A number written right before "LTS" ("Node 24 (LTS)", "24 LTS") recommends that Node.
const RECOMMENDS_A_NODE = /\b(\d+) \(?LTS\b/g;

// A claim about WHICH release line is the LTS today. It is true when it is written and
// false the day the next line becomes the LTS, so no sentence makes it: "LTS" and a number.
const SAYS_WHICH_LINE_IS_LTS = /\b(?:current|latest|newest|active)\s+LTS\b|\bLTS\s+(?:atual|mais\s+recente)\b/gi;

test('every place that recommends a Node recommends the same one, and it is newer than the minimum', () => {
  const found = [];
  const add = (where, value) => found.push({ where, value });

  // --- the guard in front of the launcher
  add('src/node-guard.mjs RECOMMENDED_NODE_MAJOR', RECOMMENDED_NODE_MAJOR);
  add('the guard\'s sentence (English)', numberIn(guardSentence({}), /Install Node (\d+) \(LTS\)/, 'the guard\'s English sentence'));
  add('the guard\'s sentence (Portuguese)', numberIn(guardSentence({ LANG: 'pt_BR.UTF-8' }), /Instale o Node (\d+) \(LTS\)/, 'the guard\'s Portuguese sentence'));

  // --- the doctor: its two sentences, in both languages
  const { tooOld, onPathTooOld } = doctorSentences();
  for (const [language, pattern] of [['en', /[Ii]nstall Node (\d+) \(LTS\)/], ['pt-BR', /[Ii]nstale o Node (\d+) \(LTS\)/]]) {
    const t = createTranslator(language);
    add(`doctor's sentence (${language})`, numberIn(renderMessage(t, tooOld.messageKey, tooOld.params), pattern, `the doctor's sentence (${language})`));
    add(`doctor's PATH sentence (${language})`, numberIn(renderMessage(t, onPathTooOld.messageKey, onPathTooOld.params), pattern, `the doctor's PATH sentence (${language})`));
  }

  // --- the documents a person reads: the box, the requirements and the line about the engine
  // (it names the two Nodes CI runs; the second is the recommended one)
  for (const [file, requirements, recommended, engine] of [
    ['README.md', '## Requirements', /Node\.js \d+ or newer \((\d+) LTS is recommended\)/, /runs on Node\.js \d+ and (\d+)/],
    ['README.pt-BR.md', '## Requisitos', /Node\.js \d+ ou mais novo \(o (\d+) LTS \u00e9 o recomendado\)/, /roda no Node\.js \d+ e no (\d+)/],
  ]) {
    const text = read(file);
    add(`${file}, the "start here" box`, numberIn(opening(text), recommended, `${file}, the box`));
    add(`${file}, the requirements`, numberIn(section(text, requirements), recommended, `${file}, the requirements`));
    add(`${file}, the line about the engine`, numberIn(text, engine, `${file}, the line about the engine`));
  }
  add('CONTRIBUTING.md', numberIn(read('CONTRIBUTING.md'), /\((\d+) LTS is the one to develop on/, 'CONTRIBUTING.md'));

  // --- the setup skill, which tells the agent where to send a person whose Node is too old
  add('lang/en/skills/setup.md', numberIn(read('lang/en/skills/setup.md'), /install Node (\d+) \(LTS\)/, 'the English setup skill'));
  add('lang/pt-BR/skills/setup.md', numberIn(read('lang/pt-BR/skills/setup.md'), /instalar o Node (\d+) \(LTS\)/, 'the Portuguese setup skill'));

  // --- anywhere else: a number written right before "LTS" is a recommendation too
  for (const file of sweptFiles()) {
    const text = read(file).replace(/\s+/g, ' ');
    for (const match of text.matchAll(RECOMMENDS_A_NODE)) add(`${file}: "${match[0]}"`, Number(match[1]));
  }

  const distinct = [...new Set(found.map((entry) => entry.value))];
  const table = found.map((entry) => `  ${String(entry.value).padStart(3)}  ${entry.where}`).join('\n');
  assert.equal(distinct.length, 1, `the recommended Node is not the same everywhere it is recommended:\n${table}`);
  assert.ok(distinct[0] > MINIMUM_NODE_MAJOR, `the recommended Node (${distinct[0]}) must be newer than the minimum (${MINIMUM_NODE_MAJOR})`);
});

test('no sentence says which release line is the LTS today: the recommendation is "LTS" and a number', () => {
  const stale = [];
  const sentences = [guardSentence({}), guardSentence({ LANG: 'pt_BR.UTF-8' })];
  const { tooOld, onPathTooOld } = doctorSentences();
  for (const language of ['en', 'pt-BR']) {
    // (the path of the fake node is a temporary directory, which can be called anything)
    for (const result of [tooOld, onPathTooOld]) sentences.push(renderMessage(createTranslator(language), result.messageKey, { ...result.params, bin: 'node' }));
  }
  for (const sentence of sentences) if ([...sentence.matchAll(SAYS_WHICH_LINE_IS_LTS)].length > 0) stale.push(`a sentence the person reads: "${sentence}"`);
  for (const file of sweptFiles()) {
    const text = read(file).replace(/\s+/g, ' ');
    for (const match of text.matchAll(SAYS_WHICH_LINE_IS_LTS)) stale.push(`${file}: "${match[0]}"`);
  }
  assert.deepEqual(stale, [], 'these go stale when the next release line becomes the LTS; say "LTS" and the number only');
});

// A matrix entry that is only installed is not tested. The Node that setup-node
// puts on PATH is the Node `npm test` (`node --test`) runs with, so the axis has to
// be what setup-node installs, in the same job and before the suite starts.
test('CI runs the suite, not only an install, on every Node of its matrix: the minimum and the recommended one', () => {
  const job = ciTestJob();
  const axis = nodeAxis(job);
  assert.ok(axis.includes(MINIMUM_NODE_MAJOR), `the matrix must run the minimum itself (${MINIMUM_NODE_MAJOR}): ${axis}`);
  assert.ok(axis.includes(RECOMMENDED_NODE_MAJOR), `and the recommended one (${RECOMMENDED_NODE_MAJOR}), the Node a person is told to install: ${axis}`);
  assert.equal(new Set(axis).size, axis.length, 'a Node listed twice runs twice');
  assert.match(job, /fail-fast:\s*false/, 'one Node failing must not hide the other');
  assert.match(job, /^\s+os:\s*\[[^\]]+\]/m, 'the OS axis is still there');
  const setup = /uses:\s*actions\/setup-node@v5\s*\n\s*with:\s*\n\s*node-version:\s*(.+)/.exec(job);
  assert.ok(setup, 'the test job installs Node with actions/setup-node');
  assert.equal(setup[1].trim().replace(/^['"]|['"]$/g, ''), '${{ matrix.node }}', 'the Node installed is the matrix axis, not a fixed number');
  const name = /^\s+name:\s*(.+)$/m.exec(job);
  assert.ok(name && name[1].includes('matrix.os') && name[1].includes('matrix.node'), `the job name must show both axes, so every check is unique and readable: ${name && name[1]}`);
  const installed = job.indexOf('actions/setup-node');
  const tests = job.indexOf('run: npm test');
  assert.ok(installed !== -1 && tests !== -1 && installed < tests, '`npm test` runs after the Node is installed, in the same job');
  // The scripts entry that `npm test` runs is node itself, from PATH.
  assert.match(JSON.parse(read('package.json')).scripts.test, /^node --test\b/);
});
