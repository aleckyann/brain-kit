// The privacy rule's third clause: a line a change adds holds none of the
// words privacy.third_party_keywords lists (src/rules/privacy-keywords.mjs
// for the matching, src/rules/lint.mjs "--- privacy" for which lines are
// asked). docs/incidents.md, "Undated: a colleague's medical appointment was
// in the calendar window": someone else's health or private life is never
// content, and this is where `brain-kit lint`, and so `propose`, refuses it.
//
// Three layers, each where its clause can be observed: the rule through
// runLintRules with a hand-built scope (which lines count as added, and
// their text, is the scope's answer, and the rule must only read it); the
// matching itself (a whole phrase, case folded, accents significant, a
// carriage return read as a space); and `brain-kit lint` against a real
// repository, where the scope comes from git exactly as `propose` gets it.
//
// Fix round 1: a run over the whole vault (the `all` base) judges no line
// and says so in one line of its report; the text judged is the text git
// reports for each added line.
//
// Example data: Ana and Bruno, example.com. Accented strings live only in
// this file (src/ is pure ASCII); a decomposed form is built at run time
// with String.prototype.normalize, never typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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
const T_EN = createTranslator('en');
const NOT_CHECKED_EN = T_EN('lint.privacy_keywords_not_checked');

// The `all` base: the whole vault, with no change to judge (`files` null,
// as src/git.mjs changedPaths answers for that base alone).
const WHOLE_VAULT = { files: null, addedLines: () => null, addedText: () => null };

// A scope that must never be asked: the proof that the clause reaches
// neither git nor a file when it has nothing to look for or nothing to
// judge. `files` is given per test.
function neverAsked(files) {
  const refuse = (relPath) => {
    throw new Error(`the scope was asked about ${relPath}`);
  };
  return { files, addedLines: refuse, addedText: refuse };
}

// A narrowed scope standing in for git, built against the vault on disk.
// `added` maps a file to the line numbers a change added, their text read
// from the file (what git reports for a file with no lone carriage
// return), or to null (a file git has never seen: every line counts); a
// file it does not name added nothing. `added` null: every file is new to
// git.
function scopeFor(root, added) {
  const entriesOf = (relPath) => {
    if (added === null) return null;
    const value = added[relPath];
    if (value === undefined) return [];
    if (value === null) return null;
    const lines = readFileSync(join(root, relPath), 'utf8').split('\n');
    return value.map((line) => ({ line, text: lines[line - 1] }));
  };
  return {
    files: added === null ? [] : Object.keys(added),
    addedLines: (relPath) => {
      const entries = entriesOf(relPath);
      return entries === null ? null : new Set(entries.map((entry) => entry.line));
    },
    addedText: entriesOf,
  };
}

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
  return { root, files: all.filter((path) => path.endsWith('.md')), context };
}

// The keyword findings of one run, after checking the privacy rule ran to
// its end: a crash is caught by runLintRules and would otherwise read as
// "no keyword".
function keywordFindings({ files, config = { privacy: { third_party_keywords: EN } }, added = null, scope = null }) {
  const { root, files: markdown, context } = lintArgs(files, config);
  const findings = runLintRules(markdown, context, scope ?? scopeFor(root, added));
  assert.deepEqual(findings.filter((f) => f.id === 'privacy' && f.defect), [], 'the privacy rule ran to its end');
  return findings.filter((f) => f.id === 'privacy' && f.check === 'third-party-keyword');
}

function located(findings) {
  return findings.map((f) => [f.file, f.line, f.params.keyword]);
}

const WEEK = '# Week\n\nMonday: planning.\nBruno is on sick leave until Friday.\n';

// --- which lines are judged ---------------------------------------------------------

test('a keyword on a line the change added is a finding naming the file, the line and the keyword, at the severity lint.privacy resolves to', () => {
  const findings = keywordFindings({ files: { 'notes/week.md': WEEK }, added: { 'notes/week.md': [4] } });
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.deepEqual(
    { file: finding.file, line: finding.line, severity: finding.severity, messageKey: finding.messageKey, params: finding.params, defect: finding.defect },
    { file: 'notes/week.md', line: 4, severity: 'error', messageKey: 'lint.privacy.third_party_keyword', params: { keyword: 'sick leave' }, defect: false },
  );
  assert.match(T_EN(finding.messageKey, finding.params), /"sick leave"/);
});

test('the same keyword on a line the change did not add is no finding, and neither is a file the change did not touch', () => {
  assert.deepEqual(keywordFindings({ files: { 'notes/week.md': WEEK }, added: { 'notes/week.md': [3] } }), []);
  assert.deepEqual(keywordFindings({ files: { 'notes/week.md': WEEK }, added: {} }), []);
});

test('a file git has never seen is new: every line of it is judged', () => {
  assert.deepEqual(located(keywordFindings({ files: { 'notes/week.md': WEEK }, added: { 'notes/week.md': null } })), [['notes/week.md', 4, 'sick leave']]);
  assert.deepEqual(located(keywordFindings({ files: { 'notes/week.md': WEEK } })), [['notes/week.md', 4, 'sick leave']]);
});

test('a run over the whole vault (the all base) judges no line at all, and never asks the scope about one', () => {
  assert.deepEqual(keywordFindings({ files: { 'notes/week.md': WEEK }, scope: WHOLE_VAULT }), []);
  const privacyRule = LINT_RULES.find((rule) => rule.id === 'privacy');
  const { files, context } = lintArgs({ 'notes/week.md': WEEK }, { privacy: { third_party_keywords: EN } });
  assert.deepEqual(privacyRule.check(files, context, neverAsked(null)), []);
});

test('the text judged is the text the scope reports for the added line, not the file read back at that number', () => {
  const privacyRule = LINT_RULES.find((rule) => rule.id === 'privacy');
  const { root, files, context } = lintArgs({ 'notes/week.md': WEEK }, { privacy: { third_party_keywords: EN } });
  const only = (text, line) => (relPath) => (relPath === 'notes/week.md' ? [{ line, text }] : []);
  const reported = { ...scopeFor(root, { 'notes/week.md': [4] }), addedText: only('Tuesday: review with Ana.', 4) };
  assert.deepEqual(privacyRule.check(files, context, reported), []);
  const other = { ...scopeFor(root, { 'notes/week.md': [3] }), addedText: only('Bruno: sick leave.', 3) };
  assert.deepEqual(located(privacyRule.check(files, context, other)), [['notes/week.md', 3, 'sick leave']]);
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

test('a carriage return is read as a space: it bounds a word and never splits a phrase', () => {
  const matchers = keywordMatchers({ privacy: { third_party_keywords: EN } });
  assert.equal(firstKeyword('Bruno: sick\rleave until Friday', matchers), 'sick leave');
  assert.equal(firstKeyword('From the calendar:\rpregnancy', matchers), 'pregnancy');
  assert.equal(firstKeyword('Bruno: sick leave\r', matchers), 'sick leave');
  assert.equal(firstKeyword('Bruno:\rhas\rsick\rleave', matchers), 'sick leave', 'every carriage return, not only the first');
  assert.equal(firstKeyword('sick\r\nleave', matchers), null, 'a line feed is not part of a line; only a carriage return is read as a space');
});

// Every character a regular expression reads as syntax, each in a keyword
// matched literally beside a look-alike that would match (or a keyword
// that would not compile) if that one character were left unescaped.
test('a keyword is literal text: every character a regular expression would read as syntax means itself', () => {
  const cases = [
    ['a.b', 'the a.b form', 'the axb form'],
    ['m* test', 'an m* test here', 'an mm test here'],
    ['c++ clinic', 'the c++ clinic', 'the cc clinic'],
    ['k? scan', 'a k? scan', 'a k scan'],
    ['^start', 'the ^start mark', 'start here'],
    ['end$', 'the end$ mark', 'the end'],
    ['x{2}', 'code x{2} here', 'code xx here'],
    ['(annual) check-up', 'the (annual) check-up', 'the annual check-up'],
    ['q|r', 'the q|r pair', 'the q alone'],
    ['[x] rehab', 'the [x] rehab', 'the x rehab'],
    ['back\\slash', 'a back\\slash here', 'a back lash here'],
  ];
  const matchers = keywordMatchers({ privacy: { third_party_keywords: cases.map(([keyword]) => keyword) } });
  for (const [keyword, literal, lookalike] of cases) {
    assert.equal(firstKeyword(literal, matchers), keyword, literal);
    assert.equal(firstKeyword(lookalike, matchers), null, lookalike);
  }
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
  const { root, files, context } = lintArgs({ 'notes/week.md': WEEK, 'people/bruno.md': '# Bruno\n\nOn sick leave.\n' }, {});
  const config = { ...context.config, privacy: { ...context.config.privacy, third_party_keywords: EN, keyword_exempt_paths: [42, null, 'notes/'] } };
  assert.deepEqual(located(privacyRule.check(files, { ...context, config }, scopeFor(root, null))), [['people/bruno.md', 3, 'sick leave']]);
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
  assert.deepEqual(privacyRule.check(files, context, neverAsked([])), []);
  for (const listed of [[], ['', '   ', 42, null]]) {
    const config = { ...context.config, privacy: { ...context.config.privacy, third_party_keywords: listed } };
    assert.deepEqual(privacyRule.check(files, { ...context, config }, neverAsked([])), [], JSON.stringify(listed));
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
    assert.deepEqual(located(keywordFindings({ files, config, added })), keywords.map((keyword, i) => [`notes/k${i}.md`, 3, keyword]), lang);
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

// One run through the command, in JSON and in text: the exit code, the
// keyword findings as [file, line, keyword], the envelope's privacyKeywords
// and whether the text report says keywords were not checked.
async function lintRun(root, args) {
  const json = captureIo();
  const code = await runLint([root, ...args, '--json'], json.io, T_EN, walkVault);
  const report = JSON.parse(json.stdout());
  const text = captureIo();
  assert.equal(await runLint([root, ...args], text.io, T_EN, walkVault), code, 'the text and the JSON run agree on the exit code');
  return {
    code,
    keywords: located(report.findings.filter((f) => f.id === 'privacy' && f.check === 'third-party-keyword')),
    privacyKeywords: report.privacyKeywords,
    saysNotChecked: text.stdout().includes(`${NOT_CHECKED_EN}\n`),
  };
}

// A vault that is a git repository with one commit holding `files`.
function committedVault(files, config) {
  const root = makeVault({ files: { 'index.md': '# Index\n\n[Notes](notes/)\n', 'notes/index.md': '# Notes\n', ...files }, config });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

test('lint against a repository: only the line a change adds fails; a keyword committed earlier fails no base, and --base all says keywords were not checked', async () => {
  const config = { privacy: { third_party_keywords: EN } };
  const root = committedVault({ 'notes/week.md': WEEK }, config);
  assert.deepEqual(await lintRun(root, []), { code: EXIT.OK, keywords: [], privacyKeywords: { checked: false }, saysNotChecked: true }, 'auto on a clean default branch is the whole vault');

  appendFileSync(join(root, 'notes', 'week.md'), 'Tuesday: review with Ana.\n');
  assert.deepEqual(await lintRun(root, ['--base', 'worktree']), { code: EXIT.OK, keywords: [], privacyKeywords: { checked: true }, saysNotChecked: false });
  assert.deepEqual(await lintRun(root, ['--base', 'all']), { code: EXIT.OK, keywords: [], privacyKeywords: { checked: false }, saysNotChecked: true });

  appendFileSync(join(root, 'notes', 'week.md'), 'Wednesday: Bruno has a therapy session.\n');
  assert.deepEqual(await lintRun(root, ['--base', 'worktree']), { code: EXIT.FAILURE, keywords: [['notes/week.md', 6, 'therapy session']], privacyKeywords: { checked: true }, saysNotChecked: false });
  assert.deepEqual((await lintRun(root, [])).keywords, [['notes/week.md', 6, 'therapy session']]);
  assert.deepEqual(await lintRun(root, ['--base', 'all']), { code: EXIT.OK, keywords: [], privacyKeywords: { checked: false }, saysNotChecked: true });
});

test('the not-checked line is said only when the clause was in play: never with no keyword configured, with the rule off, or with --rule leaving it out', async () => {
  const none = committedVault({ 'notes/week.md': WEEK }, {});
  assert.deepEqual(await lintRun(none, ['--base', 'all']), { code: EXIT.OK, keywords: [], privacyKeywords: null, saysNotChecked: false });
  const off = committedVault({ 'notes/week.md': WEEK }, { lint: { privacy: 'off' }, privacy: { third_party_keywords: EN } });
  assert.deepEqual(await lintRun(off, ['--base', 'all']), { code: EXIT.OK, keywords: [], privacyKeywords: null, saysNotChecked: false });
  const left = committedVault({ 'notes/week.md': WEEK }, { privacy: { third_party_keywords: EN } });
  assert.deepEqual(await lintRun(left, ['--base', 'all', '--rule', 'tables']), { code: EXIT.OK, keywords: [], privacyKeywords: null, saysNotChecked: false });
  assert.equal((await lintRun(left, ['--base', 'all', '--rule', 'privacy'])).saysNotChecked, true);
});

test('lint against a repository: a new note in an exempt path passes, the same note elsewhere fails, staged or never seen by git', async () => {
  const config = { privacy: { third_party_keywords: EN, keyword_exempt_paths: ['notes/me/'] } };
  const root = committedVault({}, config);
  const body = '# Me\n\nMy own hospital stay, for my records.\n';
  writeVaultFile(root, 'notes/me/health.md', body);
  git(root, ['add', '-A']);
  assert.deepEqual((await lintRun(root, ['--base', 'worktree'])).keywords, []);
  writeVaultFile(root, 'notes/them.md', body);
  const untracked = await lintRun(root, ['--base', 'worktree']);
  assert.deepEqual([untracked.code, untracked.keywords], [EXIT.FAILURE, [['notes/them.md', 3, 'hospital stay']]], 'a note git has never seen is judged whole');
  git(root, ['add', '-A']);
  const staged = await lintRun(root, ['--base', 'worktree']);
  assert.deepEqual([staged.code, staged.keywords], [EXIT.FAILURE, [['notes/them.md', 3, 'hospital stay']]]);
});

// `--base worktree` lists no untracked file among its changed paths, and a
// note git has never seen is still a change: an empty list of changed
// paths is not the `all` base.
test('lint against a repository: a new note that is the only change under --base worktree is judged whole', async () => {
  const root = committedVault({}, { privacy: { third_party_keywords: EN } });
  writeVaultFile(root, 'notes/new.md', '# New\n\nBruno is on sick leave until Friday.\n');
  const run = await lintRun(root, ['--base', 'worktree']);
  assert.deepEqual([run.code, run.keywords, run.privacyKeywords], [EXIT.FAILURE, [['notes/new.md', 3, 'sick leave']], { checked: true }]);
});

// A lone carriage return ends a line for the markdown reader and not for
// git. The clause judges the text git reports for the added line, so a
// lone CR earlier in the file cannot move it onto the wrong line, and one
// inside the added line cannot split a phrase.
test('lint against a repository: a lone carriage return anywhere in the note cannot hide a keyword on the line a change adds', async () => {
  const config = { privacy: { third_party_keywords: EN } };
  const root = committedVault({ 'notes/cal.md': '# Calendar\n\nFrom the calendar:\rWeekly planning\n' }, config);
  appendFileSync(join(root, 'notes', 'cal.md'), 'Bruno: sick leave until Friday.\n');
  assert.deepEqual((await lintRun(root, ['--base', 'worktree'])).keywords, [['notes/cal.md', 4, 'sick leave']], 'git counts the line with the lone CR as one line');

  const second = committedVault({ 'notes/cal.md': '# Calendar\n\nWeekly planning.\n' }, config);
  appendFileSync(join(second, 'notes', 'cal.md'), 'From the calendar:\rpregnancy leave for Bruno\n');
  assert.deepEqual((await lintRun(second, ['--base', 'worktree'])).keywords, [['notes/cal.md', 4, 'pregnancy']]);

  const third = committedVault({ 'notes/cal.md': '# Calendar\n\nWeekly planning.\r\nNothing else.\r\n' }, config);
  writeFileSync(join(third, 'notes', 'cal.md'), '# Calendar\n\nWeekly planning.\r\nNothing else.\r\nBruno: sick\rleave, Friday.\r\n');
  assert.deepEqual((await lintRun(third, ['--base', 'worktree'])).keywords, [['notes/cal.md', 5, 'sick leave']]);
});
