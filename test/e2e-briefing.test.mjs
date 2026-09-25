// The one test that runs the morning briefing for real: the real `claude`,
// a real model, a real (small) cost, the plugin loaded from this checkout.
// Opt-in only, with BRAIN_KIT_E2E_BRIEFING=1, and never in CI:
//
//   BRAIN_KIT_E2E_BRIEFING=1 node --test test/e2e-briefing.test.mjs
//
// BRAIN_KIT_E2E_LANG names the vault's language pack (`en` by default, or
// `pt-BR`): the vault is made in it, and the request is written in it.
//
// The world is test/helpers/briefing-world.mjs's, built in a scratch
// directory that is NOT removed when the test ends, so the session can be
// read afterwards (the path is printed): a vault made by `brain-kit init
// --yes`, committed, with its pending table seeded with one overdue item,
// one due today and one with no date; its log seeded with three recent days
// and, far below them, an old day holding a unique marker; the question
// queue seeded with one question asked on three earlier days, so it is
// escalated; a bare remote the vault pushes to; a fake `gh` first on PATH
// that records every call (it lists no open pull request and records the
// one `propose` opens instead of opening it); and a state directory.
// Before any model is paid for, the kit's own `preflight`, `validate` and
// `lint` must see that world as seeded.
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
// use of the login does; and `doctor`, which the skill body names for its
// failure path and the session may run, looks for the briefing task under
// the person's real ~/.claude/scheduled-tasks (a file named after the
// scratch vault's id, which does not exist; nothing is written there). No
// budget, turn or time limit is set.
//
// The request asks for the briefing and answers its questions in advance
// (the escalated one gets an answer, any other none), since nobody is there
// to answer in a `-p` session.
//
// What a passing run proves (the phase 4 criterion): the model invoked the
// briefing skill, and its `!` lines ran the kit's real render (the queue
// counts the seeded question as asked on the day of the run, which only
// `prompt briefing` itself does); every default block's heading appears in
// the reply as a heading, in order; the escalated question comes first
// among the questions; the queue changed through the kit's own command (a
// question added, or the answered one marked); exactly one `pr create`,
// against the default branch, from `propose --only` naming every file it
// changed, or none when nothing was recorded; no tool the model called named
// a path in `briefing.never_read`; and the old log section's marker never
// came back to the model in a tool result (the log is read by its headings
// and its most recent sections, never whole).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_ROOT } from '../src/version.mjs';
import { addDays, localDay } from '../src/guards/watermark.mjs';
import { normalizeQuestion } from '../src/briefing/questions.mjs';
import { inNeverRead } from '../src/briefing/pending.mjs';
import { disallowedTools, kitCommand, kitCommandIn } from '../src/curate/tools.mjs';
import { BIN, TZ, WORLD, buildBriefingWorld, run } from './helpers/briefing-world.mjs';

const ENABLED = process.env.BRAIN_KIT_E2E_BRIEFING === '1';
const LANG = process.env.BRAIN_KIT_E2E_LANG || 'en';
const FAKE_CLAUDE = fileURLToPath(new URL('./helpers/fake-claude.mjs', import.meta.url));
const MODEL = 'sonnet';
// The kit's own subcommands the session may run: the ones the briefing and
// the skill body name, and the read-only ones a model reaches for.
const KIT_SUBCOMMANDS = Object.freeze(['questions', 'validate', 'lint', 'propose', 'doctor', 'preflight']);

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

function must(r, what) {
  assert.equal(r.status, 0, `${what} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function jsonLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

// Every string anywhere inside `value`.
function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

// Every day from `from` to `to`, both included (YYYY-MM-DD): the days a
// session that may cross midnight can call today.
function daysBetween(from, to) {
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

// The words of a shell command line, quotes removed, split into the
// commands it chains (`&&`, `||`, `;`, `|`), each a list of words. Enough
// for what a model types; not a shell.
function shellCommands(line) {
  const commands = [[]];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(&&|\|\||[;|])|([^\s"';|&]+)/g)) {
    if (m[3] !== undefined) commands.push([]);
    else commands.at(-1).push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[4]));
  }
  return commands.filter((words) => words.length > 0);
}

// A line of the reply read as a heading: its leading markup (`#`, `*`,
// `>`, `-`, a number and its dot or bracket) stripped, then normalised the
// way the queue normalises text.
function headingText(line) {
  return normalizeQuestion(line.replace(/^[\s#>*_\-\d.)]+/, ''));
}

test('the real briefing skill against a throwaway vault gives every block in order, asks the escalated question first, records through the kit and never reads a never_read path', {
  skip: ENABLED ? false : 'set BRAIN_KIT_E2E_BRIEFING=1 to run the real briefing (real claude, real cost)',
}, (t) => {
  const claude = findOnPath('claude');
  assert.ok(claude, 'BRAIN_KIT_E2E_BRIEFING=1 needs the real claude on PATH');
  assert.notEqual(claude, FAKE_CLAUDE, 'this test runs the real claude, never the fake');
  assert.ok(Object.hasOwn(WORLD, LANG), `BRAIN_KIT_E2E_LANG must be en or pt-BR, not ${LANG}`);

  const w = buildBriefingWorld({ lang: LANG });
  const { base, vault, remote, env, config, world, seededId, normalized, marker, kit } = w;
  t.diagnostic(`scratch: ${base}`);
  console.log(`e2e briefing: scratch ${base}`);
  const streamFile = join(base, 'session.stream.jsonl');
  const stderrFile = join(base, 'session.stderr.log');
  const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', LANG, 'config.defaults.json'), 'utf8'));
  const messages = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', LANG, 'messages.json'), 'utf8'));

  // The seeded world, as the kit sees it, before any model is paid for. The
  // kit's own today is the first day of the run.
  const facts = JSON.parse(must(kit(['preflight', vault, '--json']), 'brain-kit preflight --json'));
  assert.equal(facts.today, w.today, 'the day changed while the world was built; run again');
  assert.equal(facts.pending.overdue.length, 1, JSON.stringify(facts.pending));
  assert.equal(facts.pending.today.length, 1, JSON.stringify(facts.pending));
  assert.equal(facts.pending.undated.length, 1, JSON.stringify(facts.pending));
  assert.deepEqual(facts.questions.escalated.map((q) => q.id), [seededId], JSON.stringify(facts.questions));
  assert.deepEqual(facts.openPullRequests, { ok: true, reason: null, detail: null, items: [] });
  must(kit(['validate', vault]), 'brain-kit validate');
  must(kit(['lint', vault, '--base', 'all']), 'brain-kit lint --base all');
  const firstDay = facts.today;

  // The session, as the person opens it in the vault.
  const kitPath = kitCommand();
  const allowed = [
    'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)', 'Skill',
    ...KIT_SUBCOMMANDS.flatMap((sub) => [`Bash(${kitPath} ${sub}:*)`, `Bash(node ${kitPath} ${sub}:*)`]),
    // The briefing names every kit command with the vault (`-C "<vault>"`,
    // final review of phase 4, C2), so the allowlist names that form too.
    ...KIT_SUBCOMMANDS.flatMap((sub) => [`Bash(${kitCommandIn(vault)} ${sub}:*)`, `Bash(node ${kitCommandIn(vault)} ${sub}:*)`]),
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
  // A session with no time limit may cross midnight in the vault's zone:
  // any day from the first to now is "today" for what it recorded.
  const runDays = daysBetween(firstDay, localDay(new Date(), TZ));

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

  // Its `!` lines ran the kit's real render: only `prompt briefing` itself
  // counts a placed question as asked, once per day. Whether the stream
  // also carries the rendered text is a detail of the CLI's output format,
  // not of the product, so it is reported, not asserted.
  const queueAfter = jsonLines(w.queue);
  const seededAfter = queueAfter.find((q) => q.id === seededId);
  assert.ok(seededAfter, `the seeded question is still in the queue: ${JSON.stringify(queueAfter)}`);
  const askedToday = seededAfter.askedOn.filter((day) => runDays.includes(day));
  assert.equal(askedToday.length, 1, `the real render did not count the seeded question once on ${runDays.join(' or ')}: ${JSON.stringify(seededAfter)}`);
  const handed = events.filter((e) => e.type !== 'assistant').flatMap((e) => stringsIn(e));
  t.diagnostic(`the stream carries the rendered briefing: ${handed.some((s) => s.includes('<!-- rule:facts-from-kit -->'))}`);

  // Every default block's heading, as a heading of the reply, in order.
  const replyLines = reply.split('\n');
  const headingAt = {};
  let from = 0;
  for (const id of defaults.briefing.blocks) {
    const title = normalizeQuestion(messages[`briefing.title_${id}`]);
    const at = replyLines.findIndex((line, i) => i >= from && headingText(line).startsWith(title));
    assert.ok(at !== -1, `no line of the reply after line ${from} starts with the heading of ${id} ("${messages[`briefing.title_${id}`]}"):\n${reply}`);
    headingAt[id] = at;
    from = at + 1;
  }

  // The escalated question comes first among the questions.
  const afterQuestions = normalizeQuestion(replyLines.slice(headingAt.questions).join('\n'));
  const found = [afterQuestions.indexOf(normalized), afterQuestions.indexOf(normalizeQuestion(seededId))].filter((at) => at !== -1);
  assert.ok(found.length > 0, `the escalated question (${seededId}) is not asked in the questions block:\n${reply}`);
  const escalatedAt = Math.min(...found);
  for (const other of queueAfter.filter((q) => q.id !== seededId && typeof q.text === 'string')) {
    const at = afterQuestions.indexOf(normalizeQuestion(other.text));
    if (at !== -1) assert.ok(escalatedAt < at, `"${other.text}" was asked before the escalated question:\n${reply}`);
  }

  // The queue changed through the kit's own command.
  const commands = toolUses.filter((u) => u.name === 'Bash' && typeof u.input?.command === 'string').map((u) => u.input.command);
  const answered = seededAfter.status === 'answered' && runDays.includes(seededAfter.answeredOn)
    && commands.some((c) => /\bquestions\s+answer\b/.test(c) && c.includes(seededId));
  const added = queueAfter.some((q) => q.id !== seededId && runDays.includes(q.createdOn))
    && commands.some((c) => /\bquestions\s+add\b/.test(c));
  assert.ok(answered || added, `neither questions add nor questions answer changed the queue: commands ${JSON.stringify(commands)}, queue ${JSON.stringify(queueAfter)}`);
  // A question is marked answered only after the propose that records its
  // answer (final review of phase 4, I1).
  if (answered) {
    const answerAt = commands.findIndex((c) => /\bquestions\s+answer\b/.test(c) && c.includes(seededId));
    const proposeAt = commands.findIndex((c) => /\bpropose\b/.test(c) && /--only/.test(c));
    assert.ok(proposeAt !== -1 && proposeAt < answerAt, `questions answer ran before any propose: ${JSON.stringify(commands)}`);
  }

  // Exactly one pull request, against the default branch, from `propose
  // --only` naming every file it changed; or none, with nothing recorded.
  const isKit = (words) => words[0] === BIN || (words[0] === 'node' && words[1] === BIN);
  // The words after the kit's path, its global `-C <dir>` options skipped.
  const kitArgs = (words) => {
    let rest = words.slice(words[0] === 'node' ? 2 : 1);
    while (rest[0] === '-C') rest = rest.slice(2);
    return rest;
  };
  const proposals = commands.flatMap(shellCommands).filter((words) => isKit(words) && kitArgs(words)[0] === 'propose');
  for (const words of proposals) {
    assert.ok(words.includes('--only'), `a propose without --only: ${words.join(' ')}`);
    assert.ok(!words.includes('--all'), `a propose with --all: ${words.join(' ')}`);
  }
  const calls = existsSync(w.ghLog) ? jsonLines(w.ghLog) : [];
  const creates = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(creates.length <= 1, `more than one pull request: ${JSON.stringify(creates)}`);
  if (creates.length === 1) {
    const create = creates[0];
    assert.equal(create.args[create.args.indexOf('--base') + 1], 'main');
    const branch = create.args[create.args.indexOf('--head') + 1];
    assert.ok(proposals.length > 0, `a pull request no propose command opened: ${JSON.stringify(commands)}`);
    const named = new Set();
    for (const words of proposals) {
      for (const word of words.slice(words.indexOf('--only') + 1)) {
        if (word.startsWith('--')) break;
        named.add(word.replace(/^\.\//, ''));
      }
    }
    const changed = must(run('git', ['diff', '--name-only', 'main', branch], { cwd: remote, env }), `git diff main ${branch}`).split('\n').filter(Boolean);
    assert.ok(changed.length > 0, `the branch ${branch} changes nothing`);
    for (const path of changed) assert.ok(named.has(path), `${path} is on ${branch} but no --only named it: ${JSON.stringify([...named])}`);
    console.log(`e2e briefing: pull request from ${branch}, changing ${JSON.stringify(changed)}`);
  } else {
    assert.equal(must(run('git', ['status', '--porcelain'], { cwd: vault, env }), 'git status').trim(), '', 'no pull request, yet the vault holds changes');
    assert.deepEqual(must(run('git', ['branch', '--format=%(refname:short)'], { cwd: remote, env }), 'git branch').split('\n').filter(Boolean), ['main']);
    console.log('e2e briefing: no pull request, nothing recorded');
  }

  // No tool the model called named a path in never_read. The entries that
  // close a path: a Read or an Edit of it, a Glob naming it, a Grep rooted in
  // it or searching over it with no filter, and a word of a shell command
  // (the kit's own commands aside: they are the kit, not the model reading)
  // that resolves to it. A filtered glob or grep from an ancestor is only
  // reported: it reads no content of the path.
  const neverRead = config.briefing.never_read.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  const closed = neverRead.filter((entry) => !entry.includes('#'));
  const closedTargets = closed.map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, ''));
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
      if (covers(vaultRel(input.file_path ?? input.notebook_path))) violations.push(shown);
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
    } else if (use.name === 'Bash' && typeof input.command === 'string') {
      for (const words of shellCommands(input.command)) {
        if (isKit(words)) continue;
        if (words.some((word) => covers(vaultRel(word.replace(/[*?].*$/, ''))))) violations.push(shown);
      }
    }
  }
  if (listings.length > 0) t.diagnostic(`tool uses that list or search from an ancestor of a never_read path, with a filter: ${JSON.stringify(listings)}`);
  assert.deepEqual(violations, [], `tool uses that reached a never_read path (${JSON.stringify(neverRead)})`);

  // The log is never read whole (its never_read entry with "#"): the marker
  // of its old section, far below the recent ones, never came back to the
  // model in a tool result.
  const results = events
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => e.message.content.filter((block) => block?.type === 'tool_result'));
  const leaked = results.filter((block) => stringsIn(block).some((s) => s.includes(marker)));
  assert.deepEqual(leaked.map((block) => block.tool_use_id), [], `the old log section's marker ${marker} reached the model: the log was read whole`);
});
