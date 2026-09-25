// The privacy rule's third clause: a line a change adds holds none of the
// words privacy.third_party_keywords lists (src/rules/privacy-keywords.mjs
// for the matching, src/rules/lint.mjs "--- privacy" for which lines are
// asked). docs/incidents.md, "Undated: a colleague's medical appointment was
// in the calendar window": someone else's health or private life is never
// content, and this is where `brain-kit lint`, and so `propose`, refuses it.
//
// Three layers, each where its clause can be observed: the rule through
// runLintRules with a hand-built scope (which lines count as added is the
// scope's answer, and the rule must only read it); the matching itself (a
// whole phrase, case folded, accents significant); and `brain-kit lint`
// against a real repository, where the scope comes from git exactly as
// `propose` gets it.
//
// Example data: Ana and Bruno, example.com. Accented strings live only in
// this file (src/ is pure ASCII); a decomposed form is built at run time
// with String.prototype.normalize, never typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { walkVault } from '../src/vault.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { LINT_RULES, runLintRules } from '../src/rules/lint.mjs';
import { firstKeyword, keywordMatchers } from '../src/rules/privacy-keywords.mjs';
import { makeReadFile, makeScanFile } from '../src/commands/validate.mjs';
import { buildSecretScan, runLint } from '../src/commands/lint.mjs';
import { makeVault, writeVaultFile } from './helpers/vault-fixture.mjs';
import { git } from './helpers/git-repo.mjs';

function packDefaults(lang) {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

const EN = packDefaults('en').privacy.third_party_keywords;
const PT = packDefaults('pt-BR').privacy.third_party_keywords;

// "Every line of every file is in scope", the scope contract's `null`:
// the `all` base, or a file git has never seen.
const EVERY_LINE = { files: null, addedLines: () => null };

// A scope whose added lines are given per file; a file it does not name
// added nothing (an empty set), like a tracked file a diff left alone.
function scopeFor(linesByFile) {
  return {
    files: Object.keys(linesByFile),
    addedLines(relPath) {
      const value = linesByFile[relPath];
      if (value === undefined) return new Set();
      return value === null ? null : new Set(value);
    },
  };
}

// A scope that must never be asked: the proof that a rule with nothing to
// look for does not reach git at all.
const NEVER_ASKED = {
  files: [],
  addedLines(relPath) {
    throw new Error(`the scope was asked about ${relPath}`);
  },
};

// The { files, context } src/commands/lint.mjs hands the ruler, built from
// a real vault on disk (makeVault: the example configuration with `config`
// merged over it, so lint.privacy is "error" unless a test says otherwise).
function lintArgs(files, config) {
  const root = makeVault({ files: { 'index.md': '# Index\n', ...files }, config });
  const loaded = loadConfig(root);
  const all = walkVault(root, loaded, { all: true });
  const walked = walkVault(root, loaded, { all: true, dotEntries: true });
  const context = {
    root,
    config: loaded,
    all: new Set(all),
    readFile: makeReadFile(root),
    scanFile: makeScanFile(root),
    secretScan: buildSecretScan(root, loaded, { listing: { listed: null }, walked }),
  };
  return { files: all.filter((path) => path.endsWith('.md')), context };
}

function keywordFindings({ files, config = { privacy: { third_party_keywords: EN } }, scope = EVERY_LINE }) {
  const { files: markdown, context } = lintArgs(files, config);
  return runLintRules(markdown, context, scope).filter((f) => f.id === 'privacy' && f.check === 'third-party-keyword');
}

function located(findings) {
  return findings.map((f) => [f.file, f.line, f.params.keyword]);
}

const WEEK = '# Week\n\nMonday: planning.\nBruno is on sick leave until Friday.\n';

// --- which lines are judged ---------------------------------------------------------

test('a keyword on a line the change added is a finding naming the file, the line and the keyword, at the severity lint.privacy resolves to', () => {
  const findings = keywordFindings({ files: { 'notes/week.md': WEEK }, scope: scopeFor({ 'notes/week.md': [4] }) });
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.deepEqual(
    { file: finding.file, line: finding.line, severity: finding.severity, messageKey: finding.messageKey, params: finding.params, defect: finding.defect },
    { file: 'notes/week.md', line: 4, severity: 'error', messageKey: 'lint.privacy.third_party_keyword', params: { keyword: 'sick leave' }, defect: false },
  );
  assert.match(createTranslator('en')(finding.messageKey, finding.params), /"sick leave"/);
});

test('the same keyword on a line the change did not add is no finding, and neither is a file the change did not touch', () => {
  assert.deepEqual(keywordFindings({ files: { 'notes/week.md': WEEK }, scope: scopeFor({ 'notes/week.md': [3] }) }), []);
  assert.deepEqual(keywordFindings({ files: { 'notes/week.md': WEEK }, scope: scopeFor({}) }), []);
});

test('with no restriction in the scope (--base all, or a file git has never seen) every line is judged, exactly the lines style judges', () => {
  assert.deepEqual(located(keywordFindings({ files: { 'notes/week.md': WEEK } })), [['notes/week.md', 4, 'sick leave']]);
  assert.deepEqual(located(keywordFindings({ files: { 'notes/week.md': WEEK }, scope: scopeFor({ 'notes/week.md': null }) })), [['notes/week.md', 4, 'sick leave']]);
});

test('frontmatter and code are lines like any other: a keyword there is still on the page', () => {
  const note = '---\ntype: note\ntitle: Pregnancy leave planning\n---\n\n`sick leave`\n\n```\ntherapy session\n```\n';
  assert.deepEqual(located(keywordFindings({ files: { 'notes/plan.md': note } })), [
    ['notes/plan.md', 3, 'pregnancy'],
    ['notes/plan.md', 6, 'sick leave'],
    ['notes/plan.md', 9, 'therapy session'],
  ]);
});

test('one finding per line: the keyword that starts first, and on a tie the one listed first', () => {
  const files = { 'notes/a.md': '# A\n\nPregnancy news, then a sick leave.\n' };
  assert.deepEqual(located(keywordFindings({ files })), [['notes/a.md', 3, 'pregnancy']], 'sick leave is listed before pregnancy, but starts later on the line');
  const tie = { privacy: { third_party_keywords: ['medical', 'medical exam'] } };
  assert.deepEqual(located(keywordFindings({ files: { 'notes/a.md': '# A\n\nA medical exam.\n' }, config: tie })), [['notes/a.md', 3, 'medical']]);
  const reversed = { privacy: { third_party_keywords: ['medical exam', 'medical'] } };
  assert.deepEqual(located(keywordFindings({ files: { 'notes/a.md': '# A\n\nA medical exam.\n' }, config: reversed })), [['notes/a.md', 3, 'medical exam']]);
});

// --- how a keyword matches -----------------------------------------------------------

test('a keyword inside a longer word is not the keyword; punctuation, a space, an underscore or the edge of the line bounds it', () => {
  const matchers = keywordMatchers({ privacy: { third_party_keywords: EN } });
  for (const line of ['teleconsultations were booked', 'nonpregnancy', 'pregnancy2', '2pregnancy', 'sick leaves', 'homesick leave']) {
    assert.equal(firstKeyword(line, matchers), null, line);
  }
  for (const [line, keyword] of [
    ['pregnancy', 'pregnancy'],
    ['(pregnancy)', 'pregnancy'],
    ['"sick leave".', 'sick leave'],
    ['pregnancy_notes', 'pregnancy'],
    ['a teleconsultation-free week', 'teleconsultation'],
  ]) {
    assert.equal(firstKeyword(line, matchers), keyword, line);
  }
});

test('the boundary is any letter or digit in any script, not only ASCII ones: an accented letter glued to a keyword makes a longer word', () => {
  const matchers = keywordMatchers({ privacy: { third_party_keywords: PT } });
  for (const line of ['égravidez', 'gravidezá', 'teleconsultas marcadas', 'préinternação']) {
    assert.equal(firstKeyword(line, matchers), null, line);
  }
  assert.equal(firstKeyword('pré-internação', matchers), 'internação');
});

test('case is folded, accented capitals included', () => {
  const en = keywordMatchers({ privacy: { third_party_keywords: EN } });
  assert.equal(firstKeyword('SICK LEAVE', en), 'sick leave');
  assert.equal(firstKeyword('Doctor\'s Appointment at 3', en), 'doctor\'s appointment');
  const pt = keywordMatchers({ privacy: { third_party_keywords: PT } });
  assert.equal(firstKeyword('CONSULTA MÉDICA', pt), 'consulta médica');
  assert.equal(firstKeyword('Internação do Bruno', pt), 'internação');
  assert.equal(firstKeyword('SESSÃO DE TERAPIA', pt), 'sessão de terapia');
});

test('accents are significant: a keyword without its accent does not match an accented line, and the reverse', () => {
  const pt = keywordMatchers({ privacy: { third_party_keywords: PT } });
  assert.equal(firstKeyword('consulta medica', pt), null);
  assert.equal(firstKeyword('internacao', pt), null);
  assert.equal(firstKeyword('licenca medica', pt), null);
  const stripped = keywordMatchers({ privacy: { third_party_keywords: ['consulta medica', 'internacao'] } });
  assert.equal(firstKeyword('consulta médica', stripped), null);
  assert.equal(firstKeyword('internação', stripped), null);
});

test('an accent is the letter a person reads, not its encoding: a decomposed line matches a composed keyword, and the reverse', () => {
  const composed = keywordMatchers({ privacy: { third_party_keywords: ['consulta médica'] } });
  const decomposedLine = 'Bruno: consulta médica'.normalize('NFD');
  assert.notEqual(decomposedLine, 'Bruno: consulta médica', 'the line really is decomposed');
  assert.equal(firstKeyword(decomposedLine, composed), 'consulta médica');
  const decomposedKeyword = 'consulta médica'.normalize('NFD');
  const decomposed = keywordMatchers({ privacy: { third_party_keywords: [decomposedKeyword] } });
  assert.equal(firstKeyword('Bruno: consulta médica', decomposed), decomposedKeyword);
});

test('a keyword is literal text: a character a regular expression would read as syntax means itself', () => {
  const matchers = keywordMatchers({ privacy: { third_party_keywords: ['check-up (annual)', 'a.b'] } });
  assert.equal(firstKeyword('the check-up (annual) is Monday', matchers), 'check-up (annual)');
  assert.equal(firstKeyword('check-up annual', matchers), null);
  assert.equal(firstKeyword('axb', matchers), null);
});

// --- what is exempt, and what is not -------------------------------------------------

test('a note under privacy.keyword_exempt_paths is not judged; an entry is a directory or a file, matched on a path boundary', () => {
  const line = '# Me\n\nMy own medical exam on Monday.\n';
  const config = { privacy: { third_party_keywords: EN, keyword_exempt_paths: ['journal', 'private/', 'notes/health.md'] } };
  const files = {
    'journal/me.md': line,
    'journal/2026/week.md': line,
    'journal-old/me.md': line,
    'private/me.md': line,
    'notes/health.md': line,
    'notes/healthy.md': line,
  };
  assert.deepEqual(located(keywordFindings({ files, config })), [
    ['journal-old/me.md', 3, 'medical exam'],
    ['notes/healthy.md', 3, 'medical exam'],
  ]);
});

test('an exempt entry that is not a string is ignored, never a crash, and the others still exempt', () => {
  const privacyRule = LINT_RULES.find((rule) => rule.id === 'privacy');
  const { files, context } = lintArgs({ 'notes/week.md': WEEK, 'people/bruno.md': '# Bruno\n\nOn sick leave.\n' }, {});
  const config = { ...context.config, privacy: { ...context.config.privacy, third_party_keywords: EN, keyword_exempt_paths: [42, null, 'notes/'] } };
  assert.deepEqual(located(privacyRule.check(files, { ...context, config }, EVERY_LINE)), [['people/bruno.md', 3, 'sick leave']]);
});

test('a confidential directory is no exemption, and the clause runs when no directory is confidential at all', () => {
  const files = { 'people/bruno.md': '# Bruno\n\nOn sick leave this week.\n' };
  assert.deepEqual(located(keywordFindings({ files })), [['people/bruno.md', 3, 'sick leave']]);
  const noBoundary = { privacy: { third_party_keywords: EN, confidential_dirs: [] } };
  assert.deepEqual(located(keywordFindings({ files, config: noBoundary })), [['people/bruno.md', 3, 'sick leave']]);
});

test('lint.privacy decides the severity: warn reports a warning, off never runs the rule', () => {
  const files = { 'notes/week.md': WEEK };
  const warn = keywordFindings({ files, config: { lint: { privacy: 'warn' }, privacy: { third_party_keywords: EN } } });
  assert.deepEqual(warn.map((f) => f.severity), ['warn']);
  assert.deepEqual(keywordFindings({ files, config: { lint: { privacy: 'off' }, privacy: { third_party_keywords: EN } } }), []);
});

test('no keyword listed, the key absent or every entry blank, means nothing is looked for and the scope is never asked', () => {
  const privacyRule = LINT_RULES.find((rule) => rule.id === 'privacy');
  const { files, context } = lintArgs({ 'notes/week.md': WEEK }, {});
  assert.equal(context.config.privacy.third_party_keywords, undefined, 'the example configuration lists no keyword');
  assert.deepEqual(privacyRule.check(files, context, NEVER_ASKED), []);
  for (const listed of [[], ['', '   ', 42, null]]) {
    const config = { ...context.config, privacy: { ...context.config.privacy, third_party_keywords: listed } };
    assert.deepEqual(privacyRule.check(files, { ...context, config }, NEVER_ASKED), [], JSON.stringify(listed));
  }
});

// --- the packs' defaults ----------------------------------------------------------------

test('both packs ship their own keywords, verbatim, and no exempt path', () => {
  assert.deepEqual(EN, ['medical appointment', 'doctor\'s appointment', 'sick leave', 'teleconsultation', 'therapy session', 'medical exam', 'hospital stay', 'pregnancy']);
  assert.deepEqual(PT, ['consulta médica', 'atestado médico', 'licença médica', 'teleconsulta', 'sessão de terapia', 'exame médico', 'internação', 'gravidez']);
  for (const lang of ['en', 'pt-BR']) {
    assert.deepEqual(packDefaults(lang).privacy.keyword_exempt_paths, [], lang);
    for (const keyword of packDefaults(lang).privacy.third_party_keywords) assert.equal(keyword, keyword.normalize('NFC'), `${lang}: "${keyword}" is stored composed`);
  }
});

test('in a vault configured with its own pack, every keyword fails an added line; without its accents a pt-BR keyword does not', () => {
  for (const [lang, keywords] of [['en', EN], ['pt-BR', PT]]) {
    const defaults = packDefaults(lang).privacy;
    const config = { lang, privacy: { third_party_keywords: defaults.third_party_keywords, keyword_exempt_paths: defaults.keyword_exempt_paths } };
    const files = {};
    keywords.forEach((keyword, i) => {
      files[`notes/k${i}.md`] = `# K${i}\n\nBruno: ${keyword}, Friday.\n`;
    });
    const added = Object.fromEntries(Object.keys(files).map((file) => [file, [3]]));
    assert.deepEqual(located(keywordFindings({ files, config, scope: scopeFor(added) })), keywords.map((keyword, i) => [`notes/k${i}.md`, 3, keyword]), lang);
  }
  const ptConfig = { lang: 'pt-BR', privacy: { third_party_keywords: PT } };
  const accented = PT.filter((keyword) => keyword !== keyword.normalize('NFD').replace(/\p{M}/gu, ''));
  assert.ok(accented.length >= 6, 'most pt-BR keywords carry an accent');
  const files = {};
  accented.forEach((keyword, i) => {
    files[`notes/s${i}.md`] = `# S${i}\n\nBruno: ${keyword.normalize('NFD').replace(/\p{M}/gu, '')}, sexta.\n`;
  });
  assert.deepEqual(keywordFindings({ files, config: ptConfig }), []);
});

// --- through `brain-kit lint`, the scope drawn by git -------------------------------------

function captureIo() {
  let stdout = '';
  let stderr = '';
  return { io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } }, stdout: () => stdout, stderr: () => stderr };
}

async function lintJson(root, base) {
  const out = captureIo();
  const code = await runLint([root, '--base', base, '--json'], out.io, createTranslator('en'), walkVault);
  const report = JSON.parse(out.stdout());
  return { code, keywords: located(report.findings.filter((f) => f.id === 'privacy' && f.check === 'third-party-keyword')) };
}

// A vault that is a git repository with one commit holding `files`.
function committedVault(files, config) {
  const root = makeVault({ files: { 'index.md': '# Index\n\n[Notes](notes/)\n', 'notes/index.md': '# Notes\n', ...files }, config });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

test('lint against a repository: only the line a change adds fails; the same keyword committed earlier fails only --base all, which judges every line', async () => {
  const config = { privacy: { third_party_keywords: EN } };
  const root = committedVault({ 'notes/week.md': WEEK }, config);
  appendFileSync(join(root, 'notes', 'week.md'), 'Tuesday: review with Ana.\n');
  assert.deepEqual(await lintJson(root, 'worktree'), { code: EXIT.OK, keywords: [] });
  assert.deepEqual(await lintJson(root, 'all'), { code: EXIT.FAILURE, keywords: [['notes/week.md', 4, 'sick leave']] });

  appendFileSync(join(root, 'notes', 'week.md'), 'Wednesday: Bruno has a therapy session.\n');
  assert.deepEqual(await lintJson(root, 'worktree'), { code: EXIT.FAILURE, keywords: [['notes/week.md', 6, 'therapy session']] });
  assert.deepEqual((await lintJson(root, 'auto')).keywords, [['notes/week.md', 6, 'therapy session']]);
});

test('lint against a repository: a new note in an exempt path passes, the same note elsewhere fails', async () => {
  const config = { privacy: { third_party_keywords: EN, keyword_exempt_paths: ['notes/me/'] } };
  const root = committedVault({}, config);
  const body = '# Me\n\nMy own hospital stay, for my records.\n';
  writeVaultFile(root, 'notes/me/health.md', body);
  git(root, ['add', '-A']);
  assert.deepEqual(await lintJson(root, 'worktree'), { code: EXIT.OK, keywords: [] });
  writeVaultFile(root, 'notes/them.md', body);
  git(root, ['add', '-A']);
  assert.deepEqual(await lintJson(root, 'worktree'), { code: EXIT.FAILURE, keywords: [['notes/them.md', 3, 'hospital stay']] });
});
