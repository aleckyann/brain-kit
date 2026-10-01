// The incident-response page (docs/incident-response.md) is read once, under
// stress, by a person who has found a leaked key or someone's personal data in
// a vault. Every command, flag, path, configuration key and check id it names
// is something that person will type or open, and a name that was renamed
// since the page was written fails them at the worst moment, so this file is
// the rot guard: rename a command, a check, a key or a file the page names and
// this suite fails until the page is updated.
//
// What it reads, and from where (the source of truth for each):
//
// - the commands the CLI dispatches: the BUILTIN_COMMANDS table in src/cli.mjs;
// - the subcommands and flags of a command: its usage lines in the English
//   message pack (lang/en/messages.json, `cli.usage` and `<command>.usage`),
//   which is also what `brain-kit --help` prints;
// - the doctor check ids: CHECK_IDS in src/doctor/checks.mjs;
// - the configuration keys: schema/config.schema.json and
//   schema/machine.schema.json;
// - the files the page cites: they must exist.
//
// Two statements on the page are about what the kit does NOT do (nothing reads
// privacy.require_private_repo, and doctor has no check on a remote's
// visibility). A negative claim rots the other way round, by the feature
// arriving, so the last test here fails when either stops being true.
//
// Each checking function is also proved able to fail, against a planted
// mistake: a guard that cannot fail is worse than none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { CHECK_IDS } from '../src/doctor/checks.mjs';
import { STATE_FILES } from '../src/state.mjs';
import { LEDGER_NAME, PROPOSED_REF_PREFIX } from '../src/guards/proposed.mjs';

const PAGE = 'docs/incident-response.md';
const FENCE = '`'.repeat(3);
const GLOBAL_FLAGS = new Set(['--help', '-h', '--version', '-v', '--']);

function read(path) {
  return readFileSync(join(KIT_ROOT, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
}

const messages = readJson('lang/en/messages.json');

// ---------------------------------------------------------------- the code

// The names the CLI dispatches, read from the table in src/cli.mjs (the table
// is not exported, and exporting it for a test would change the engine).
function dispatchedCommands() {
  const source = read('src/cli.mjs');
  const table = /const BUILTIN_COMMANDS = new Map\(\[([\s\S]*?)\n\]\);/.exec(source);
  assert.ok(table, 'src/cli.mjs no longer has the BUILTIN_COMMANDS table this test reads');
  return [...table[1].matchAll(/^\s*\['([a-z][a-z-]*)',/gm)].map((match) => match[1]);
}

// A command's usage lines: its line(s) in the help (`cli.usage`) and the
// lines of its own usage message, each as the text after "brain-kit <name>".
function usageOf(command) {
  const rests = [];
  let flagText = '';
  const own = messages[`${command.replace(/-/g, '_')}.usage`];
  if (typeof own === 'string') {
    flagText += `${own}\n`;
    for (const line of own.split('\n')) {
      const match = new RegExp(`^(?:Usage:\\s+|\\s+)brain-kit ${command}(?:\\s+(.*))?$`).exec(line);
      if (match) rests.push((match[1] ?? '').split(/\s{2,}/)[0]);
    }
  }
  for (const line of messages['cli.usage'].split('\n')) {
    const match = new RegExp(`^ {2}${command}(?:\\s+(.*))?$`).exec(line);
    if (match) {
      const signature = (match[1] ?? '').split(/\s{2,}/)[0];
      rests.push(signature);
      flagText += `${signature}\n`;
    }
  }
  const subcommands = new Set();
  for (const rest of rests) {
    const first = rest.trim().split(/\s+/)[0] ?? '';
    for (const word of first.replace(/[<>[\]]/g, '').split('|')) {
      if (/^[a-z][a-z-]*$/.test(word) && word !== command) subcommands.add(word);
    }
  }
  const flags = new Set(flagText.match(/(?<![\w-])--?[A-Za-z][\w-]*/g) ?? []);
  return { known: rests.length > 0, subcommands, flags };
}

// The property names a schema declares, at any depth.
function propertyNames(node, into = new Set()) {
  if (node === null || typeof node !== 'object') return into;
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    into.add(name);
    propertyNames(child, into);
  }
  if (node.items) propertyNames(node.items, into);
  return into;
}

function configHasKey(schema, dotted) {
  let node = schema;
  for (const part of dotted.split('.')) {
    if (!node || typeof node !== 'object' || !node.properties || !Object.hasOwn(node.properties, part)) return false;
    node = node.properties[part];
  }
  return true;
}

// ---------------------------------------------------------------- the page

// Inline code spans and fenced lines, kept apart: a configuration key is
// judged where it is named in prose, a command wherever it is typed.
function codeOf(text) {
  const inline = [];
  const fenced = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(FENCE)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced.push(line.trim());
    else for (const match of line.matchAll(/`([^`]+)`/g)) inline.push(match[1]);
  }
  return { inline, fenced };
}

const STOP = new Set(['|', '||', '&&', ';', '>', '>>', '#', '2>&1']);

function clean(token) {
  return token.replace(/^[("'[]+|[)"'\],;.]+$/g, '');
}

// Every `brain-kit ...` a span holds: its command, its subcommand word (the
// next bare word) and its flags.
function mentionedCommands(spans) {
  const found = [];
  for (const span of spans) {
    const all = span.split(/\s+/).filter((token) => token !== '');
    const comment = all.indexOf('#');
    const tokens = comment === -1 ? all : all.slice(0, comment); // a shell comment is prose, not a command
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== 'brain-kit') continue;
      const args = [];
      for (let j = i + 1; j < tokens.length; j++) {
        if (STOP.has(tokens[j]) || tokens[j].endsWith(';')) break;
        if (tokens[j] === '-C') {
          j += 1;
          continue;
        }
        args.push(clean(tokens[j]));
      }
      found.push({ span, args });
    }
  }
  return found;
}

function commandProblems(spans, dispatched) {
  const problems = [];
  for (const { span, args } of mentionedCommands(spans)) {
    const [command, ...rest] = args;
    if (command === undefined || command.startsWith('-') || command.startsWith('<')) {
      if (command !== undefined && !GLOBAL_FLAGS.has(command) && !command.startsWith('<')) problems.push(`${span}: unknown top-level option ${command}`);
      continue;
    }
    if (['help', 'version'].includes(command)) continue;
    if (!dispatched.includes(command)) {
      problems.push(`${span}: "brain-kit ${command}" is not a command the CLI dispatches`);
      continue;
    }
    const usage = usageOf(command);
    if (!usage.known) continue; // internal command with no usage line: the name is all there is to check
    const word = rest[0];
    if (word !== undefined && /^[a-z][a-z-]*$/.test(word) && !usage.subcommands.has(word)) {
      problems.push(`${span}: "${command} ${word}" is not among the subcommands in its usage (${[...usage.subcommands].join(', ') || 'none'})`);
    }
    for (const arg of rest) {
      if (!arg.startsWith('-')) continue;
      const flag = arg.split('=')[0];
      if (GLOBAL_FLAGS.has(flag) || usage.flags.has(flag)) continue;
      problems.push(`${span}: "${command}" has no flag ${flag} in its usage`);
    }
    const only = rest.indexOf('--only');
    if (command === 'doctor' && only !== -1 && rest[only + 1] !== undefined) {
      for (const id of rest[only + 1].split(',')) {
        if (!CHECK_IDS.includes(id)) problems.push(`${span}: "${id}" is not a doctor check id`);
      }
    }
  }
  return problems;
}

function checkIdProblems(text) {
  const problems = [];
  for (const match of text.matchAll(/\bchecks? `([a-z][a-z-]*)`/g)) {
    if (!CHECK_IDS.includes(match[1])) problems.push(`"${match[1]}" is not a doctor check id`);
  }
  return problems;
}

// The events the round writes to its dated log: `log('<event>', ...)` in
// src/commands/curate.mjs.
function loggedEvents() {
  return new Set([...read('src/commands/curate.mjs').matchAll(/\blog\('([a-z_]+)'/g)].map((match) => match[1]));
}

function keyProblems(inline) {
  const config = readJson('schema/config.schema.json');
  const names = propertyNames(config);
  propertyNames(readJson('schema/machine.schema.json'), names);
  const events = loggedEvents();
  const problems = [];
  for (const span of inline) {
    if (/^(?:privacy|sources|lint|curate|git|briefing|vault|hooks|taxonomy|frontmatter)(?:\.[a-z_]+)+$/.test(span)) {
      if (!configHasKey(config, span)) problems.push(`${span} is not a key of schema/config.schema.json`);
    } else if (/^[a-z]+(?:_[a-z]+)+$/.test(span)) {
      if (!names.has(span) && !events.has(span)) problems.push(`${span} is neither a key of a configuration schema nor an event the round logs`);
    }
  }
  return problems;
}

// GitHub's anchor for a heading: lower case, punctuation dropped, spaces to
// hyphens.
function slugOf(heading) {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

function headingsOf(text) {
  const slugs = new Set();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(FENCE)) inFence = !inFence;
    const match = !inFence && /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (match) slugs.add(slugOf(match[1]));
  }
  return slugs;
}

const CITED = /(?<![\w./-])((?:docs|src|schema|templates|lang|bin|scripts|test)\/[^\s`)\],;'"]*)/g;

function pathProblems(text, base = KIT_ROOT) {
  const problems = [];
  for (const match of text.matchAll(CITED)) {
    const cited = match[1].replace(/[.:]+$/, '');
    if (/[<*{]/.test(cited)) continue; // a pattern, not a path
    if (!existsSync(join(base, cited))) problems.push(`${cited} does not exist`);
  }
  return problems;
}

function linkProblems(text, pageDir, ownSlugs) {
  const problems = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    const [file, fragment] = target.split('#');
    let slugs = ownSlugs;
    if (file !== '') {
      const resolved = resolve(pageDir, file);
      if (!existsSync(resolved)) {
        problems.push(`link ${target}: ${file} does not exist`);
        continue;
      }
      slugs = fragment === undefined || !resolved.endsWith('.md') ? null : headingsOf(readFileSync(resolved, 'utf8'));
    }
    if (fragment !== undefined && slugs !== null && !slugs.has(fragment)) problems.push(`link ${target}: no such heading`);
  }
  return problems;
}

// ----------------------------------------------------------------- the tests

test('the page exists, is listed in package.json files, and SECURITY.md points to it', () => {
  assert.ok(existsSync(join(KIT_ROOT, PAGE)), `${PAGE} is missing`);
  const pkg = readJson('package.json');
  assert.ok(pkg.files.includes(PAGE), `package.json files does not list ${PAGE}, and SECURITY.md (which ships) links to it`);
  assert.ok(read('SECURITY.md').includes('docs/incident-response.md'), 'SECURITY.md does not point to the incident-response page');
});

test('the page is pure ASCII, with no em dash and no tab', () => {
  const bytes = readFileSync(join(KIT_ROOT, PAGE));
  const bad = bytes.findIndex((byte) => byte > 127 || byte === 9);
  assert.equal(bad, -1, `byte ${bad} of ${PAGE} is not plain ASCII (an em dash, an accent, a curly quote or a tab)`);
});

test('the nine sections are there, in the order a person under stress needs them', () => {
  const headings = [...read(PAGE).matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => [Number(match[1]), match[2]]);
  assert.deepEqual(headings.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const words = ['first minutes', 'secret is in a commit', 'checks', 'personal data', 'public', 'curator did something', 'pull request', 'flaw in the kit', 'After the incident'];
  headings.forEach(([n, title], index) => assert.ok(title.includes(words[index]), `section ${n} is "${title}", expected it to be about "${words[index]}"`));
});

test('the rule of the first minutes puts rotation before the rewrite and the rewrite before telling people', () => {
  const text = read(PAGE);
  const section = text.slice(text.indexOf('## 1. '), text.indexOf('## 2. '));
  const rotate = section.indexOf('Rotate or revoke');
  const rewrite = section.indexOf('Rewrite the history');
  const tell = section.indexOf('Tell people');
  assert.ok(rotate !== -1 && rewrite !== -1 && tell !== -1, 'section 1 lost one of its three steps');
  assert.ok(rotate < rewrite && rewrite < tell, 'section 1 no longer says: rotate, then rewrite, then tell');
});

test('every brain-kit command the page types is dispatched, with a subcommand and flags its usage lists', () => {
  const dispatched = dispatchedCommands();
  for (const name of ['lint', 'doctor', 'schedule', 'watermark', 'machine', 'update', 'propose']) {
    assert.ok(dispatched.includes(name), `precondition: the dispatch table lost ${name}`);
  }
  const { inline, fenced } = codeOf(read(PAGE));
  const mentioned = mentionedCommands([...inline, ...fenced]);
  assert.ok(mentioned.length >= 10, `precondition: only ${mentioned.length} brain-kit commands found on the page`);
  assert.deepEqual(commandProblems([...inline, ...fenced], dispatched), []);
});

test('every doctor check id, configuration key, path and link the page names exists', () => {
  const text = read(PAGE);
  const { inline } = codeOf(text);
  assert.deepEqual(checkIdProblems(text), []);
  assert.deepEqual(keyProblems(inline), []);
  assert.deepEqual(pathProblems(text), []);
  assert.deepEqual(linkProblems(text, join(KIT_ROOT, 'docs'), headingsOf(text)), []);
  const keys = inline.filter((span) => /^(?:privacy|sources|lint)\./.test(span));
  assert.ok(keys.length >= 6, `precondition: only ${keys.length} configuration keys found on the page`);
});

test('the names the code owns are the ones the page writes', () => {
  const text = read(PAGE);
  assert.ok(text.includes(PROPOSED_REF_PREFIX), `the page does not name ${PROPOSED_REF_PREFIX}`);
  assert.ok(text.includes(STATE_FILES.LAST_RUN), `the page does not name ${STATE_FILES.LAST_RUN}`);
  assert.ok(text.includes(`${STATE_FILES.LOG_DIR}/`), `the page does not name ${STATE_FILES.LOG_DIR}/`);
  assert.ok(text.includes(LEDGER_NAME) || !text.includes('ledger'), `the page names the ledger without its file name ${LEDGER_NAME}`);
  assert.ok(read('src/commands/curate.mjs').includes('.stream.jsonl'), 'the kept stream is no longer a .stream.jsonl file');
  assert.ok(text.includes('.stream.jsonl'), 'the page does not name the kept stream file');
});

test('the two things the page says the kit does not check are still true', () => {
  const text = read(PAGE);
  assert.ok(text.includes('privacy.require_private_repo'), 'the page no longer says anything about privacy.require_private_repo; drop this guard with the sentence');
  const readers = readdirSync(join(KIT_ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => readFileSync(file, 'utf8').includes('require_private_repo'));
  assert.deepEqual(readers, [], 'src/ now reads privacy.require_private_repo: rewrite section 5 of the incident-response page, which says nothing does');
  const visibility = CHECK_IDS.filter((id) => /visib|private|public/.test(id));
  assert.deepEqual(visibility, [], 'doctor now has a check on repository visibility: rewrite section 5 of the incident-response page, which says it has none');
});

// ------------------------------------------- the guard's own self-check

test('self-check: a command that is not dispatched, a stray subcommand, a stray flag and a stray check id are each reported', () => {
  const dispatched = dispatchedCommands();
  assert.deepEqual(commandProblems(['brain-kit schedule uninstall', 'brain-kit -C "<vault>" watermark reopen transcripts 2026-09-20', 'brain-kit doctor --only hooks-path,config-valid'], dispatched), []);
  assert.equal(commandProblems(['brain-kit frobnicate'], dispatched).length, 1);
  assert.equal(commandProblems(['brain-kit schedule remove'], dispatched).length, 1);
  assert.equal(commandProblems(['brain-kit lint secrets'], dispatched).length, 1);
  assert.equal(commandProblems(['brain-kit lint --nope'], dispatched).length, 1);
  assert.equal(commandProblems(['brain-kit doctor --only no-such-check'], dispatched).length, 1);
  assert.equal(commandProblems(['brain-kit watermark reopen transcripts # brain-kit nonsense'], dispatched).length, 0, 'a shell comment is not a command');
});

test('self-check: a stray key, check id, path and link are each reported, and the right ones are not', () => {
  assert.deepEqual(keyProblems(['privacy.third_party_keywords', 'sources.calendar.enabled', 'log_retention_days', 'keep_stream', 'model_result', 'last-run.json']), []);
  assert.equal(keyProblems(['privacy.no_such_key']).length, 1);
  assert.equal(keyProblems(['no_such_machine_key']).length, 1);
  assert.deepEqual(checkIdProblems('the check `hooks-path` and the checks `config-valid`'), []);
  assert.equal(checkIdProblems('the check `no-such-check`').length, 1);
  assert.deepEqual(pathProblems('see docs/security.md and `src/cli.mjs` and test/incidents/ and test/incidents/YYYY-MM-DD-<slug>.test.mjs.'), []);
  assert.equal(pathProblems('see docs/no-such-page.md.').length, 1);
  const slugs = headingsOf('# Title\n\n## 2. A secret is in a commit\n');
  assert.deepEqual(linkProblems('[x](#2-a-secret-is-in-a-commit) [y](security.md) [z](https://example.com/a)', join(KIT_ROOT, 'docs'), slugs), []);
  assert.equal(linkProblems('[x](#no-such-heading)', join(KIT_ROOT, 'docs'), slugs).length, 1);
  assert.equal(linkProblems('[y](no-such-page.md)', join(KIT_ROOT, 'docs'), slugs).length, 1);
  assert.equal(linkProblems('[y](security.md#no-such-heading)', join(KIT_ROOT, 'docs'), slugs).length, 1);
  assert.equal(dirname(join(KIT_ROOT, PAGE)), join(KIT_ROOT, 'docs'));
});
