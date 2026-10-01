// examples/minimal-vault is a small fictional vault that lives in the
// repository so a person can see what a vault looks like without running
// `init`. It was built with the kit's own `init` (its README gives the
// command) and then written to by hand.
//
// An example that nobody checks rots: a rule or a template changes, and the
// folder keeps showing a vault the kit would now refuse. This file is what
// stops that. It copies the folder to a scratch directory, runs the real
// CLI over the copy, and fails with the finding when the example is no
// longer valid. It also holds the folder to what an example must never
// carry: a faked human confirmation (`verified`), a path or an address that
// belongs to a real machine or a real person, a git directory, or any file
// from the state directory that `init` keeps outside a vault.
//
// The fictional owner is Ana and every address is on example.com, per the
// repository's standing rule against real names in anything public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { CLEAN_ENV, git } from './helpers/git-repo.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const EXAMPLE = join(KIT_ROOT, 'examples', 'minimal-vault');

// The two actors a note in the example may carry. Every note Ana "wrote"
// (the person, organization, project and decision, the pending tables, her
// identity) is human:ana. A note exactly as `init` wrote it keeps the actor
// `init` stamped, which the example's own CONVENTIONS.md documents; stamping
// those human:ana would claim a person wrote text that a program did, and
// would no longer match the checksums in .brain-kit/manifest.json.
const OWNER = 'human:ana';
const INIT_ACTOR = 'process:brain-kit-init';
const COLLECTIONS = Object.freeze(['people', 'organizations', 'projects', 'decisions']);

// Files `init` keeps outside a vault, in the state directory, or that exist
// only in a real clone. None of them belongs in an example.
const STATE_FILES = Object.freeze(['machine.json', 'watermark.json', 'last-run.json', 'questions.log']);

function requireExample() {
  assert.ok(existsSync(EXAMPLE) && statSync(EXAMPLE).isDirectory(), `examples/minimal-vault is missing from the repository (${EXAMPLE})`);
}

// Every entry under `root`, dot-files included, as { path, rel, stat } with
// lstat, so a symbolic link is seen as one and never followed.
function walk(root) {
  const out = [];
  (function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      out.push({ path, rel: relative(root, path).split(sep).join('/'), name: entry.name, stat });
      if (stat.isDirectory()) visit(path);
    }
  })(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function files(root = EXAMPLE) {
  return walk(root).filter((entry) => entry.stat.isFile());
}

function markdown(root = EXAMPLE) {
  return files(root).filter((entry) => entry.name.endsWith('.md'));
}

// The notes the kit reads: the markdown files outside the dot-directories
// (`.brain-kit/` holds the pull request template, which is not a note) and
// outside `validate.ignore_paths`, which lists this example's README.
function notes(root = EXAMPLE) {
  return markdown(root).filter((entry) => entry.rel !== 'README.md' && !entry.rel.split('/').some((part) => part.startsWith('.')));
}

function read(entry) {
  return readFileSync(entry.path, 'utf8');
}

// The frontmatter block of a note as an array of lines, or null when the
// file does not start with one. Only what these tests need: the top-level
// keys and the `by` under `generated`.
function frontmatterLines(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end === -1 ? null : text.slice(4, end).split('\n');
}

function generatedBy(lines) {
  const at = lines.findIndex((line) => /^generated:\s*$/.test(line));
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length && /^\s+/.test(lines[i]); i++) {
    const match = /^\s+by:\s*(.+?)\s*$/.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

// A copy of the example in a scratch directory that is a git repository,
// because `lint` asks git which files the vault publishes. A throwaway
// identity and no inherited GIT_* variables, as test/helpers/git-repo.mjs.
function scratchCopy() {
  requireExample();
  const root = join(makeTempDir('brain-kit-example-'), 'vault');
  cpSync(EXAMPLE, root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  return root;
}

function stateDir() {
  return makeTempDir('brain-kit-example-state-');
}

function cli(args, { cwd, state }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...CLEAN_ENV, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: state },
  });
}

// --- the kit accepts it -------------------------------------------------------

test('the example passes validate with no finding of any kind', () => {
  const vault = scratchCopy();
  const result = cli(['validate', '--json'], { cwd: vault, state: stateDir() });
  assert.equal(result.status, EXIT.OK, `validate failed:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings, [], `validate found something in the example:\n${JSON.stringify(report.findings, null, 2)}`);
  assert.deepEqual(report.counts, { must: 0, should: 0, house: 0, unexpected: 0, warnings: 0 });
  // A validate that read nothing would pass too: it read every note.
  const count = notes(vault).length;
  assert.equal(report.fileSet.notes, count, 'validate did not read every markdown note of the example');
  assert.ok(count >= 20, `the example holds only ${count} notes`);
});

test('the example passes lint over every file, with no error and no warning', () => {
  const vault = scratchCopy();
  const result = cli(['lint', '--base', 'all', '--json'], { cwd: vault, state: stateDir() });
  assert.equal(result.status, EXIT.OK, `lint failed:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings, [], `lint found something in the example:\n${JSON.stringify(report.findings, null, 2)}`);
  assert.equal(report.counts.error, 0);
  assert.equal(report.counts.warn, 0);
  assert.equal(report.counts.skipped, 0, 'a lint rule was skipped');
  assert.equal(report.scope.base, 'all');
  assert.equal(report.fileSet.source, 'git', 'lint did not read the vault through git');
  assert.equal(report.scope.files, notes(vault).length, 'lint did not read every markdown note of the example');
  assert.equal(report.secrets.ran, true);
});

test('the commands the README gives work as written, from the repository root', () => {
  requireExample();
  const readme = readFileSync(join(EXAMPLE, 'README.md'), 'utf8');
  for (const args of [['validate'], ['lint', '--base', 'all']]) {
    const command = `brain-kit -C examples/minimal-vault ${args.join(' ')}`;
    assert.ok(readme.includes(`${command}\n`), `the README does not give "${command}"`);
    const result = cli(['-C', 'examples/minimal-vault', ...args, '--json'], { cwd: KIT_ROOT, state: stateDir() });
    assert.equal(result.status, EXIT.OK, `"${command}" failed:\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout).findings, [], `"${command}" found something`);
  }
});

test('the example\'s configuration is Ana\'s, keeps every connector module off, and still forbids the em dash', () => {
  requireExample();
  const config = JSON.parse(readFileSync(join(EXAMPLE, 'brain-kit.config.json'), 'utf8'));
  assert.equal(config.owner.handle, 'ana');
  assert.equal(config.owner.email, 'ana@example.com');
  assert.equal(config.actors.human, OWNER);
  assert.equal(config.vault.repo, null, 'the example names a GitHub repository');
  assert.equal(config.curate.enabled, false);
  assert.deepEqual(config.curate.sources.required, [], 'a source is required, so a round would need a connector');
  assert.equal(config.sources.calendar.enabled, false);
  assert.equal(config.sources.meeting_notes.enabled, false);
  assert.equal(config.briefing.enabled, false);
  // The file spells the character as a JSON escape; it must read back as the character.
  assert.deepEqual(config.lint.style.forbidden_chars, ['\u2014']);
});

// --- what an example must never claim ----------------------------------------

test('no note carries verified: a human confirmation is not faked', () => {
  requireExample();
  const checked = [];
  for (const entry of markdown()) {
    const lines = frontmatterLines(read(entry));
    if (lines === null) continue;
    checked.push(entry.rel);
    const verified = lines.filter((line) => /^verified\s*:/.test(line));
    assert.deepEqual(verified, [], `${entry.rel} carries verified in its frontmatter`);
  }
  assert.ok(checked.length >= 15, `only ${checked.length} notes with frontmatter were read`);
});

test('every note is attributed to human:ana, or to the init that wrote it, and the content notes are Ana\'s', () => {
  requireExample();
  const seen = new Map();
  for (const entry of notes()) {
    if (entry.name === 'index.md') continue; // an index has no frontmatter, but the root's okf_version
    const lines = frontmatterLines(read(entry));
    if (lines === null) continue; // the log: no frontmatter
    const by = generatedBy(lines);
    assert.ok(by !== null, `${entry.rel} has no generated.by`);
    // A template is copied to make a note, and says so: its actor is the
    // placeholder to be replaced.
    if (entry.rel.startsWith('templates/')) {
      assert.equal(by, '<actor>', `${entry.rel} is a template and must keep the placeholder actor`);
      continue;
    }
    assert.ok(by === OWNER || by === INIT_ACTOR, `${entry.rel} is attributed to ${by}, not ${OWNER}`);
    seen.set(entry.rel, by);
  }
  for (const dir of COLLECTIONS) {
    const notes = [...seen.keys()].filter((rel) => rel.startsWith(`${dir}/`));
    assert.ok(notes.length >= 1, `the example has no note under ${dir}/`);
    for (const rel of notes) assert.equal(seen.get(rel), OWNER, `${rel} must be Ana's`);
  }
  assert.equal(seen.get('pending/follow-ups.md'), OWNER);
  assert.equal(seen.get('pending/promises.md'), OWNER);
  assert.ok([...seen.values()].includes(INIT_ACTOR), 'no note is left as init wrote it: the example is not made by init any more');
});

test('the example shows the vault\'s habits: dated log entries with the pack\'s markers, an open dated pending item, a sourced and footnoted claim', () => {
  requireExample();
  const config = JSON.parse(readFileSync(join(EXAMPLE, 'brain-kit.config.json'), 'utf8'));
  const markers = Object.values(config.taxonomy.log_markers);
  const log = readFileSync(join(EXAMPLE, config.taxonomy.log), 'utf8');
  const headings = [...log.matchAll(/^## (\d{4}-\d{2}-\d{2})$/gm)].map((match) => match[1]);
  assert.ok(headings.length >= 2 && headings.length <= 3, `the log has ${headings.length} dated headings`);
  assert.deepEqual([...headings].sort().reverse(), headings, 'the log is not most recent first');
  const entries = [...log.matchAll(/^\*\*([^*]+)\*\* /gm)].map((match) => match[1]);
  assert.ok(entries.length >= 2, 'the log has fewer than two entries');
  for (const marker of entries) assert.ok(markers.includes(marker), `log marker ${marker} is not one of ${markers.join(', ')}`);

  const followups = readFileSync(join(EXAMPLE, config.taxonomy.files.followups), 'utf8');
  const open = followups.split(config.taxonomy.columns.followups.labels.open_heading)[1].split('\n## ')[0];
  const rows = open.split('\n').filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line));
  assert.ok(rows.length >= 1, 'no open follow-up with a date');

  const org = readFileSync(join(EXAMPLE, 'organizations', 'example-studio.md'), 'utf8');
  assert.match(org, /^sources:\n(?:  - .*\n(?:    .*\n)*)+/m, 'the organization note has no sources');
  assert.match(org, /[a-z.]\[\^site\]/, 'a claim carries no footnote');
  assert.match(org, /^\[\^site\]: /m, 'the footnote is not defined');
});

// --- nothing from a real machine or a real person -----------------------------

test('the example holds no git directory, no state file and no symbolic link', () => {
  requireExample();
  const entries = walk(EXAMPLE);
  assert.ok(entries.length >= 30, `the example holds only ${entries.length} entries`);
  const gitEntries = entries.filter((entry) => entry.name === '.git');
  assert.deepEqual(gitEntries.map((entry) => entry.rel), [], 'the example carries a .git entry');
  const state = entries.filter((entry) => STATE_FILES.includes(entry.name));
  assert.deepEqual(state.map((entry) => entry.rel), [], 'the example carries a file from the state directory');
  const links = entries.filter((entry) => entry.stat.isSymbolicLink());
  assert.deepEqual(links.map((entry) => entry.rel), [], 'the example carries a symbolic link');
});

// A path that names a real machine: the roots of a home or a system
// directory, a Windows drive, a file: URL, or a home written with a tilde.
// `/memory/log.md`-style paths are not matched: they are resolved from the
// vault root, which `sources[].resource` is defined to do.
const ABSOLUTE_PATH = /(?:^|[\s"'`(=:[,])(?:\/(?:home|Users|tmp|var|root|etc|opt|mnt|usr|srv|run|media|private|Volumes)\/|~\/|[A-Za-z]:[\\/]|file:\/\/)/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

test('the example holds no absolute path and no e-mail address outside example.com', () => {
  requireExample();
  let filesRead = 0;
  for (const entry of files()) {
    const buffer = readFileSync(entry.path);
    assert.ok(!buffer.includes(0), `${entry.rel} is binary`);
    const text = buffer.toString('utf8');
    filesRead += 1;
    text.split('\n').forEach((line, index) => {
      assert.doesNotMatch(line, ABSOLUTE_PATH, `${entry.rel}:${index + 1} holds an absolute path: ${line.trim()}`);
    });
    for (const address of text.match(EMAIL) ?? []) {
      assert.match(address, /@example\.com$/i, `${entry.rel} holds an address outside example.com: ${address}`);
    }
  }
  assert.ok(filesRead >= 30, `only ${filesRead} files were read`);
});

// --- links and sources resolve ------------------------------------------------

function withoutCode(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

test('every link and every sources resource of the example resolves to a file inside it', () => {
  requireExample();
  const root = resolve(EXAMPLE);
  const inside = (path) => path === root || path.startsWith(`${root}${sep}`);
  let links = 0;
  for (const entry of markdown()) {
    const text = read(entry);
    const body = withoutCode(text);
    for (const match of body.matchAll(/(?<!!)\[(?:[^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:)/.test(target) || target.startsWith('#')) continue;
      links += 1;
      assert.ok(target !== '' && !target.startsWith('/'), `${entry.rel}: the link "${target}" is empty or starts with a slash`);
      const path = resolve(dirname(entry.path), decodeURIComponent(target.split('#')[0].split('?')[0]));
      assert.ok(inside(path), `${entry.rel}: the link "${target}" leaves the example`);
      assert.ok(existsSync(path) && statSync(path).isFile(), `${entry.rel}: the link "${target}" resolves to no file`);
    }
    const lines = frontmatterLines(text);
    if (lines === null) continue;
    for (const line of lines) {
      const match = /^\s+(?:- )?resource:\s*(\S+)\s*$/.exec(line);
      if (!match) continue;
      const resource = match[1];
      if (/^https:\/\/example\.com(?:\/|$)/.test(resource)) continue;
      assert.ok(resource.startsWith('/'), `${entry.rel}: the source "${resource}" is neither a vault path nor an example.com address`);
      const path = resolve(root, `.${resource}`);
      assert.ok(inside(path) && existsSync(path) && statSync(path).isFile(), `${entry.rel}: the source "${resource}" resolves to no file`);
    }
  }
  assert.ok(links >= 20, `only ${links} links were checked`);
});

// --- not shipped --------------------------------------------------------------

test('the example is not in the npm package', () => {
  requireExample();
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files.filter((entry) => /^\.?\/?(?:examples|\.)(?:\/|$)/.test(entry)), [], 'package.json files names the examples folder');
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const paths = report.files.map((file) => file.path);
  assert.ok(paths.includes('src/leak.mjs'), 'npm pack did not list the engine');
  assert.deepEqual(paths.filter((path) => path.startsWith('examples/')), [], 'npm pack would ship the example');
});
