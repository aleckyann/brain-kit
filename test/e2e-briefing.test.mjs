// The one test that runs the morning briefing for real: the real `claude`,
// a real model, a real (small) cost, the plugin loaded from this checkout.
// Opt-in only, with BRAIN_KIT_E2E_BRIEFING=1, and never in CI:
//
//   BRAIN_KIT_E2E_BRIEFING=1 node --test test/e2e-briefing.test.mjs
//
// BRAIN_KIT_E2E_LANG names the vault's language pack (`en` by default, or
// `pt-BR`): the vault is made in it, and the request is written in it.
//
// Everything is built in a scratch directory that is NOT removed when the
// test ends, so the session can be read afterwards (the path is printed): a
// vault made by `brain-kit init --yes`, committed, with its pending table
// seeded with one overdue item, one due today and one with no date; the
// question queue seeded with one question asked on three earlier days, so
// it is escalated; a bare remote the vault pushes to; a fake `gh` first on
// PATH that records every call (it lists no open pull request and records
// the one `propose` opens instead of opening it); and a state directory.
//
// HOME stays the person's own, because the real claude's login lives
// there. What keeps the person's own Claude Code out is the round's
// isolation, minus what would switch the plugin off: no settings file of
// any kind (`--setting-sources ''`, so no hook, allow rule or plugin of
// theirs), no MCP server (`--strict-mcp-config`), no memory or global
// instructions (the two CLAUDE_CODE_DISABLE_* switches), no session written
// to ~/.claude/projects (`--no-session-persistence`), and `dontAsk` with an
// allowlist of the vault and the kit's own commands. `--plugin-dir` loads
// this checkout as the plugin, and its `briefing` skill must be picked from
// a request that asks for the morning briefing. The real CLI still updates
// the person's own ~/.claude.json for the scratch working directory, as any
// use of the login does. No budget, turn or time limit is set.
//
// The request asks for the briefing and answers its questions in advance
// (the escalated one gets an answer, any other none), since nobody is there
// to answer in a `-p` session.
//
// What a passing run proves (the phase 4 criterion): the model invoked the
// briefing skill, and the skill's two `!` lines ran (the stream carries the
// rendered skill body and the rendered briefing, and the queue counts the
// seeded question as asked today, which only the real render does); every
// default block's heading appears in the reply, in order; the escalated
// question comes first among the questions; the queue changed through the
// kit's own command (a question added, or the answered one marked); exactly
// one `pr create`, against the default branch, from `propose --only` naming
// every file it changed, or none when nothing was recorded; and no path in
// `briefing.never_read` was read by any tool the model called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../src/version.mjs';
import { withoutLocalGitVars } from '../src/git-env.mjs';
import { addDays, localDay } from '../src/guards/watermark.mjs';
import { normalizeQuestion, questionId } from '../src/briefing/questions.mjs';
import { inNeverRead } from '../src/briefing/pending.mjs';
import { disallowedTools, kitCommand } from '../src/curate/tools.mjs';

const ENABLED = process.env.BRAIN_KIT_E2E_BRIEFING === '1';
const LANG = process.env.BRAIN_KIT_E2E_LANG || 'en';
const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const FAKE_CLAUDE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const MODEL = 'sonnet';
const TZ = 'UTC';
// The kit's own subcommands the session may run: the ones the briefing and
// the skill body name, and the read-only ones a model reaches for.
const KIT_SUBCOMMANDS = Object.freeze(['questions', 'validate', 'lint', 'propose', 'doctor', 'preflight']);

// What the vault holds and what the person says, in the vault's language.
const WORLD = Object.freeze({
  en: {
    question: 'Should the reading group keep meeting on Thursdays?',
    overdue: 'Send Ana the reading list',
    dueToday: 'Book the room for the reading group',
    undated: 'Choose the next book',
    undatedCell: 'when the group decides',
    request: [
      'Good morning. Give me my morning briefing from this vault.',
      'I will not be here to answer while you give it, so here are my answers in advance.',
      'If you ask whether the reading group should keep meeting on Thursdays: yes, it stays on Thursdays, because the library room is free that evening.',
      'I have no answer to any other question today: leave it open for another day.',
      'When the briefing is done, record what my answer teaches the vault, as the briefing says.',
    ].join(' '),
  },
  'pt-BR': {
    question: 'O grupo de leitura deve continuar se reunindo às quintas?',
    overdue: 'Mandar para a Ana a lista de leituras',
    dueToday: 'Reservar a sala para o grupo de leitura',
    undated: 'Escolher o próximo livro',
    undatedCell: 'quando o grupo decidir',
    request: [
      'Bom dia. Me dê o meu briefing matinal deste vault.',
      'Não vou estar aqui para responder enquanto você o apresenta, então seguem as minhas respostas adiantadas.',
      'Se você perguntar se o grupo de leitura deve continuar se reunindo às quintas: sim, continua às quintas, porque a sala da biblioteca fica livre nessa noite.',
      'Não tenho resposta para nenhuma outra pergunta hoje: deixe-as abertas para outro dia.',
      'Quando o briefing terminar, registre o que a minha resposta ensina ao vault, como o briefing manda.',
    ].join(' '),
  },
});

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

// Records every call as one JSON line. `api` (the preflight's listing of
// the open pull requests) lists none; `pr create` succeeds and `pr view`
// answers only for a head a `pr create` named, as the real gh would.
function fakeGh(log) {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(log, JSON.stringify({ args }) + '\\n');
const url = 'https://example.invalid/ana/reading/pull/1';
if (args[0] === 'api') process.exit(0);
if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('Creating pull request\\n' + url + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const created = before.filter((e) => e.args[0] === 'pr' && e.args[1] === 'create' && e.args[e.args.indexOf('--head') + 1] === args[2]).at(-1);
  if (!created) { process.stderr.write('no pull requests found for branch "' + args[2] + '"\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ baseRefName: created.args[created.args.indexOf('--base') + 1], headRefName: args[2], url }) + '\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unexpected call\\n');
process.exit(2);
`;
}

function run(program, args, { cwd, env, input } = {}) {
  return spawnSync(program, args, { cwd, env, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

function must(r, what) {
  assert.equal(r.status, 0, `${what} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function jsonLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

function dmy(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

// Every string anywhere inside `value`.
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True when a shell command names `target` (a vault-relative folder or
// file) as a path of its own: relative, or under an absolute vault path.
function commandMentions(command, target) {
  return new RegExp(`(?:^|[\\s"'=(/])${escapeRegExp(target)}(?:/|$|[\\s"')])`).test(command);
}

// The values after `--only` in a propose command line, unquoted.
function onlyPaths(command) {
  const at = command.indexOf('--only');
  if (at === -1) return [];
  const out = [];
  for (const token of command.slice(at + '--only'.length).match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
    if (token.startsWith('--')) break;
    out.push(token.replace(/^["']|["']$/g, '').replace(/^\.\//, ''));
  }
  return out;
}

test('the real briefing skill against a throwaway vault gives every block in order, asks the escalated question first, records through the kit and never reads a never_read path', {
  skip: ENABLED ? false : 'set BRAIN_KIT_E2E_BRIEFING=1 to run the real briefing (real claude, real cost)',
}, (t) => {
  const claude = findOnPath('claude');
  assert.ok(claude, 'BRAIN_KIT_E2E_BRIEFING=1 needs the real claude on PATH');
  assert.notEqual(claude, FAKE_CLAUDE, 'this test runs the real claude, never the fake');
  assert.ok(Object.hasOwn(WORLD, LANG), `BRAIN_KIT_E2E_LANG must be en or pt-BR, not ${LANG}`);
  const world = WORLD[LANG];

  const base = mkdtempSync(join(tmpdir(), 'brain-kit-e2e-briefing-'));
  t.diagnostic(`scratch: ${base}`);
  console.log(`e2e briefing: scratch ${base}`);
  const vault = join(base, 'vault');
  const remote = join(base, 'remote.git');
  const state = join(base, 'state');
  const fakebin = join(base, 'fakebin');
  const ghLog = join(base, 'gh-calls.jsonl');
  const gitconfig = join(base, 'gitconfig');
  const streamFile = join(base, 'session.stream.jsonl');
  const stderrFile = join(base, 'session.stderr.log');
  mkdirSync(fakebin);
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(fakebin, 'gh'), fakeGh(ghLog));
  chmodSync(join(fakebin, 'gh'), 0o755);
  // The vault's push gate runs `brain-kit` from PATH: this checkout's own.
  symlinkSync(BIN, join(fakebin, 'brain-kit'));
  writeFileSync(gitconfig, '[user]\n\tname = Ana\n\temail = ana@example.invalid\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');

  const env = {
    ...withoutLocalGitVars(process.env),
    PATH: `${fakebin}${delimiter}${process.env.PATH ?? ''}`,
    BRAIN_KIT_STATE_DIR: state,
    BRAIN_KIT_LANG: LANG,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const kit = (args, options = {}) => run(process.execPath, [BIN, ...args], { cwd: base, env, ...options });
  const git = (cwd, args) => must(run('git', args, { cwd, env }), `git ${args.join(' ')}`);

  // The vault, in the language asked for, its zone fixed so "today" is known.
  must(kit(['init', vault, '--yes', '--lang', LANG]), 'brain-kit init --yes');
  const configFile = join(vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.vault.timezone = TZ;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const today = localDay(new Date(), TZ);
  const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', LANG, 'config.defaults.json'), 'utf8'));
  const messages = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', LANG, 'messages.json'), 'utf8'));

  // The pending table: one overdue item, one due today, one with no date,
  // written under the open heading of the first table briefing.pending reads.
  const pending = config.briefing.pending[0];
  const tablePath = config.taxonomy.files[pending.file];
  const heading = config.taxonomy.columns[pending.file].labels[pending.heading];
  const header = config.taxonomy.columns[pending.file].columns;
  const dateAt = header.indexOf(pending.date_column);
  const whatAt = header.indexOf(pending.what_column);
  assert.ok(dateAt !== -1 && whatAt !== -1, `the pack's ${pending.file} columns hold ${pending.date_column} and ${pending.what_column}`);
  const row = (what, deadline) => `| ${header.map((_, i) => (i === whatAt ? what : i === dateAt ? deadline : i === 0 ? dmy(addDays(today, -10)) : '-')).join(' | ')} |`;
  const rows = [row(world.overdue, dmy(addDays(today, -3))), row(world.dueToday, dmy(today)), row(world.undated, world.undatedCell)];
  const tableFile = join(vault, tablePath);
  const lines = readFileSync(tableFile, 'utf8').split('\n');
  const headingAt = lines.findIndex((line) => line.trim() === heading.trim());
  const separatorAt = lines.findIndex((line, i) => i > headingAt && /^\|(?:\s*-+\s*\|)+$/.test(line.trim()));
  assert.ok(headingAt !== -1 && separatorAt !== -1, `${tablePath} has a table under ${heading}`);
  lines.splice(separatorAt + 1, 0, ...rows);
  writeFileSync(tableFile, lines.join('\n'));

  // The queue: one open question, asked on three earlier days (the pack's
  // question_escalate_after is 3), created well inside question_max_age_days.
  const machine = JSON.parse(readFileSync(join(state, 'machine.json'), 'utf8'));
  const queueFile = machine.paths?.questions_log ?? join(state, 'questions.log');
  const normalized = normalizeQuestion(world.question);
  const seededId = questionId(normalized);
  writeFileSync(queueFile, `${JSON.stringify({
    id: seededId, text: world.question, normalized, createdOn: addDays(today, -6),
    askedOn: [addDays(today, -5), addDays(today, -4), addDays(today, -3)],
    status: 'open', answeredOn: null, archivedOn: null, archivedReason: null,
  })}\n`, { mode: 0o600 });

  // Committed, on a bare remote.
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(vault, ['add', '-A']);
  git(vault, ['commit', '-q', '-m', 'A new vault']);
  git(vault, ['remote', 'add', 'origin', remote]);
  git(vault, ['push', '-q', '-u', 'origin', 'main']);
  git(vault, ['remote', 'set-head', 'origin', '--auto']);

  // The seeded world, as the kit computes it, before any model is paid for.
  const facts = JSON.parse(must(kit(['preflight', vault, '--json']), 'brain-kit preflight --json'));
  assert.equal(facts.today, today);
  assert.equal(facts.pending.overdue.length, 1, JSON.stringify(facts.pending));
  assert.equal(facts.pending.today.length, 1, JSON.stringify(facts.pending));
  assert.equal(facts.pending.undated.length, 1, JSON.stringify(facts.pending));
  assert.deepEqual(facts.questions.escalated.map((q) => q.id), [seededId], JSON.stringify(facts.questions));
  assert.deepEqual(facts.openPullRequests, { ok: true, reason: null, detail: null, items: [] });
  // The skill body the first `!` line prints, to find in the stream.
  const body = must(kit(['prompt', 'skill', 'briefing', '--vault', vault]), 'brain-kit prompt skill briefing');
  const bodyLine = body.split('\n').reduce((longest, line) => (line.length > longest.length ? line : longest), '').trim();
  assert.ok(bodyLine.length > 40, `a distinctive line of the skill body: ${JSON.stringify(bodyLine)}`);
  const firstBlockHeading = `### 1. ${messages['briefing.title_sources']} (sources)`;

  // The session, as the person opens it in the vault.
  const kitPath = kitCommand();
  const allowed = [
    'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)', 'Skill',
    ...KIT_SUBCOMMANDS.flatMap((sub) => [`Bash(${kitPath} ${sub}:*)`, `Bash(node ${kitPath} ${sub}:*)`]),
  ];
  const argv = [
    '-p', '--verbose', '--output-format', 'stream-json',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
    '--plugin-dir', KIT_ROOT, '--model', MODEL,
    '--allowedTools', ...allowed,
    '--disallowedTools', ...disallowedTools(),
    '--',
  ];
  const out = openSync(streamFile, 'w', 0o600);
  const err = openSync(stderrFile, 'w', 0o600);
  let session;
  try {
    session = spawnSync(claude, argv, {
      cwd: vault,
      env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
      input: world.request,
      stdio: ['pipe', out, err],
    });
  } finally {
    closeSync(out);
    closeSync(err);
  }

  const events = jsonLines(streamFile);
  const result = events.findLast((e) => e.type === 'result') ?? null;
  const assistantBlocks = events
    .filter((e) => e.type === 'assistant' && Array.isArray(e.message?.content))
    .flatMap((e) => e.message.content);
  const toolUses = assistantBlocks.filter((b) => b.type === 'tool_use');
  const texts = assistantBlocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  const reply = texts.length > 0 ? texts.join('\n\n') : String(result?.result ?? '');
  const summary = `exit ${session.status}, cost ${result?.total_cost_usd} USD, ${result?.num_turns} turn(s), tools ${JSON.stringify(toolUses.map((u) => u.name))}, stream ${streamFile}`;
  t.diagnostic(summary);
  console.log(`e2e briefing: ${summary}`);
  assert.equal(session.status, 0, `claude exited ${session.status}\n${readFileSync(stderrFile, 'utf8')}\n${JSON.stringify(result)}`);
  assert.ok(result !== null && result.is_error !== true, JSON.stringify(result));

  // The model invoked the briefing skill.
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
  const skillUse = toolUses.find((u) => u.name === 'Skill'
    && stringsIn(u.input).some((value) => /(?:^|:)briefing$/.test(value.trim())));
  assert.ok(skillUse, `no Skill tool use for the briefing: ${JSON.stringify(toolUses.map((u) => ({ name: u.name, input: u.input })))}; init plugins ${JSON.stringify(init.plugins)}, skills ${JSON.stringify(init.skills ?? init.slash_commands)}`);

  // Its two `!` lines ran: the rendered skill body and the rendered
  // briefing reached the model, and the real render counted the seeded
  // question as asked today (only `prompt briefing` itself does that).
  const queueAfter = jsonLines(queueFile);
  const seededAfter = queueAfter.find((q) => q.id === seededId);
  assert.ok(seededAfter, `the seeded question is still in the queue: ${JSON.stringify(queueAfter)}`);
  const renderedByKit = seededAfter.askedOn.includes(today);
  const handed = events.filter((e) => e.type !== 'assistant').flatMap((e) => stringsIn(e));
  const where = `stream events: ${JSON.stringify(events.map((e) => `${e.type}${e.subtype ? `/${e.subtype}` : ''}`))}; queue counts today: ${renderedByKit}`;
  assert.ok(handed.some((s) => s.includes(bodyLine)), `the rendered skill body is not in the stream (${JSON.stringify(bodyLine)}); ${where}`);
  assert.ok(handed.some((s) => s.includes('<!-- rule:facts-from-kit -->') && s.includes(firstBlockHeading)), `the rendered briefing is not in the stream; ${where}`);
  assert.ok(renderedByKit, `the seeded question was not counted as asked on ${today}: ${JSON.stringify(seededAfter)}`);
  assert.equal(seededAfter.askedOn.filter((day) => day === today).length, 1, JSON.stringify(seededAfter));

  // Every default block's heading, in the reply, in order.
  const normalizedReply = normalizeQuestion(reply);
  const positions = [];
  let from = 0;
  for (const id of defaults.briefing.blocks) {
    const title = normalizeQuestion(messages[`briefing.title_${id}`]);
    const at = normalizedReply.indexOf(title, from);
    assert.ok(at !== -1, `the heading of ${id} ("${messages[`briefing.title_${id}`]}") is not in the reply after the ones before it (${JSON.stringify(positions)}):\n${reply}`);
    positions.push({ id, at });
    from = at + title.length;
  }

  // The escalated question comes first among the questions.
  const questionsAt = positions.find((p) => p.id === 'questions').at;
  const afterQuestions = normalizedReply.slice(questionsAt);
  const found = [afterQuestions.indexOf(normalized), afterQuestions.indexOf(normalizeQuestion(seededId))].filter((at) => at !== -1);
  assert.ok(found.length > 0, `the escalated question (${seededId}) is not asked in the questions block:\n${reply}`);
  const escalatedAt = Math.min(...found);
  for (const other of queueAfter.filter((q) => q.id !== seededId && typeof q.text === 'string')) {
    const at = afterQuestions.indexOf(normalizeQuestion(other.text));
    if (at !== -1) assert.ok(escalatedAt < at, `"${other.text}" was asked before the escalated question:\n${reply}`);
  }

  // The queue changed through the kit's own command.
  const commands = toolUses.filter((u) => u.name === 'Bash' && typeof u.input?.command === 'string').map((u) => u.input.command);
  const answered = seededAfter.status === 'answered' && seededAfter.answeredOn === today
    && commands.some((c) => /\bquestions\s+answer\b/.test(c) && c.includes(seededId));
  const added = queueAfter.some((q) => q.id !== seededId && q.createdOn === today)
    && commands.some((c) => /\bquestions\s+add\b/.test(c));
  assert.ok(answered || added, `neither questions add nor questions answer changed the queue: commands ${JSON.stringify(commands)}, queue ${JSON.stringify(queueAfter)}`);

  // Exactly one pull request, against the default branch, from `propose
  // --only` naming every file it changed; or none, with nothing recorded.
  const proposals = commands.filter((c) => /\bpropose\b/.test(c) && c.includes('bin/brain-kit.mjs'));
  for (const c of proposals) {
    assert.ok(c.includes('--only'), `a propose without --only: ${c}`);
    assert.ok(!/\s--all\b/.test(c), `a propose with --all: ${c}`);
  }
  const calls = existsSync(ghLog) ? jsonLines(ghLog) : [];
  const creates = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(creates.length <= 1, `more than one pull request: ${JSON.stringify(creates)}`);
  if (creates.length === 1) {
    const create = creates[0];
    assert.equal(create.args[create.args.indexOf('--base') + 1], 'main');
    const branch = create.args[create.args.indexOf('--head') + 1];
    assert.ok(proposals.length > 0, `a pull request no propose command opened: ${JSON.stringify(commands)}`);
    const named = new Set(proposals.flatMap(onlyPaths));
    const changed = must(run('git', ['diff', '--name-only', 'main', branch], { cwd: remote, env }), `git diff main ${branch}`).split('\n').filter(Boolean);
    assert.ok(changed.length > 0, `the branch ${branch} changes nothing`);
    for (const path of changed) assert.ok(named.has(path), `${path} is on ${branch} but no --only named it: ${JSON.stringify([...named])}`);
    console.log(`e2e briefing: pull request from ${branch}, changing ${JSON.stringify(changed)}`);
  } else {
    assert.equal(must(run('git', ['status', '--porcelain'], { cwd: vault, env }), 'git status').trim(), '', 'no pull request, yet the vault holds changes');
    assert.deepEqual(must(run('git', ['branch', '--format=%(refname:short)'], { cwd: remote, env }), 'git branch').split('\n').filter(Boolean), ['main']);
    console.log('e2e briefing: no pull request, nothing recorded');
  }

  // No path in never_read was read by any tool the model called. An entry
  // with a fragment (the log, "#full") forbids reading that file whole: a
  // Read of it without a limit. A glob that merely lists from an ancestor
  // is reported, not failed: it reads no content.
  const neverRead = config.briefing.never_read.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  const closed = neverRead.filter((entry) => !entry.includes('#'));
  const closedTargets = closed.map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, ''));
  const wholeOnly = neverRead.filter((entry) => entry.includes('#')).map((entry) => entry.slice(0, entry.indexOf('#')).replace(/^\.\//, ''));
  const roots = [...new Set([vault, realpathSync(vault)])];
  const vaultRel = (path) => {
    if (typeof path !== 'string' || path === '') return null;
    for (const root of roots) {
      const rel = relative(root, isAbsolute(path) ? path : resolve(vault, path));
      if (rel === '') return '';
      if (!rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
    }
    return null;
  };
  const covers = (rel) => rel !== null && rel !== '' && inNeverRead(rel, closed);
  const ancestorOfClosed = (rel) => rel !== null && closedTargets.some((target) => rel === '' || target.startsWith(`${rel}/`));
  const violations = [];
  const listings = [];
  for (const use of toolUses) {
    const input = use.input ?? {};
    const shown = `${use.name} ${JSON.stringify(input)}`;
    if (use.name === 'Read' || use.name === 'Edit' || use.name === 'NotebookEdit') {
      const rel = vaultRel(input.file_path ?? input.notebook_path);
      if (covers(rel)) violations.push(shown);
      if (use.name === 'Read' && rel !== null && wholeOnly.includes(rel) && input.limit === undefined) violations.push(`${shown} (read whole)`);
    } else if (use.name === 'Glob') {
      const rel = vaultRel(input.path ?? vault);
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      const patternRel = isAbsolute(pattern) ? vaultRel(pattern) : [rel, pattern.replace(/^\.\//, '')].filter((part) => part !== null && part !== '').join('/');
      if (covers(rel) || closedTargets.some((target) => patternRel === target || (patternRel ?? '').startsWith(`${target}/`))) violations.push(shown);
      else if (ancestorOfClosed(rel)) listings.push(shown);
    } else if (use.name === 'Grep') {
      const rel = vaultRel(input.path ?? vault);
      if (covers(rel)) violations.push(shown);
      else if (ancestorOfClosed(rel) && input.glob === undefined && input.type === undefined) violations.push(`${shown} (searches a never_read path)`);
      else if (ancestorOfClosed(rel)) listings.push(shown);
    } else if (use.name === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (closedTargets.some((target) => commandMentions(command, target))) violations.push(shown);
    }
  }
  if (listings.length > 0) t.diagnostic(`tool uses that list or search from an ancestor of a never_read path, with a filter: ${JSON.stringify(listings)}`);
  assert.deepEqual(violations, [], `tool uses that reached a never_read path (${JSON.stringify(neverRead)})`);
});
