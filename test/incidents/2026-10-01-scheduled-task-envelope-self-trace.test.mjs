// docs/incidents.md, 01/10/2026: the first real briefing run on the desktop
// application. The self-trace filter drops the kit's own sessions so the
// curator never reads a briefing back as the person's own words (what a
// briefing records it proposes itself), and it recognized a session by its
// first user message STARTING with a signature. The application does not
// hand a scheduled task's prompt to the session as it is: the first user
// message is one string, an envelope (an open tag with the task's `name` and
// `file`, one paragraph in the application's own wording, a blank line, the
// prompt as registered, the closing tag). It did not start with the
// signature, the session was kept, and the next round would have captured
// the briefing's own questions and summaries as new facts of the person's
// day. Every test until then wrapped nothing: the prompt was always the
// message's first line.
//
// The rule: the filter looks through the envelope, by the task's name (the
// kit's `brain-kit-briefing-` prefix, so another vault's briefing on the
// same machine goes too) or by the prompt inside it, and nowhere else: a
// signature further into the message, or the person's own task in the same
// envelope, still stays in (11/08/2026).
//
// Replayed with the measured envelope, built by hand with example names
// (Ana, example.com, /home/ana), in a vault of the shipped pt-BR pack, as
// the real run was: through the transcripts plan, and through the dry run
// of a round (`curate --dry`), which plans the same files the round would
// hand the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { signaturesOf } from '../../src/sources/transcripts-claude-code.mjs';
import { makeCurateWorld, PROJECT as CURATE_PROJECT, utcDay } from '../helpers/curate-world.mjs';
import { INSIDE, PROJECT, assistant, defaultConfig, makeWorld, paths, user } from '../helpers/transcripts-world.mjs';

const TASK_ID = 'brain-kit-briefing-ana-vault-1a2b3c4d';
const BOILERPLATE = 'This is an automated run of a scheduled task. The user is not present to answer questions. For implementation details, execute autonomously without asking clarifying questions \u2014 make reasonable choices and note them in your output. "write" actions (e.g. MCP tools that send, post, create, update, or delete), only take them if the task file asks for that specific action. When in doubt, producing a report of what you found is the correct output.';
const COMMAND = 'node "/home/ana/.claude/plugins/cache/example.com/brain-kit/bin/brain-kit.mjs" prompt briefing --vault "/home/ana/vault"';

// The first user message of the real run: the pt-BR task prompt (the
// signature, then the run line in the vault's language) inside the
// application's envelope.
function measured(signature) {
  const prompt = `${signature}\n${createTranslator('pt-BR')('schedule.briefing_run_line', { command: COMMAND })}`;
  return `<scheduled-task name="${TASK_ID}" file="/home/ana/.claude/scheduled-tasks/${TASK_ID}/SKILL.md">\n${BOILERPLATE}\n\n${prompt}\n</scheduled-task>`;
}

test('the finding: the measured envelope does not start with a signature, so the filter that only looked at the start kept the briefing\'s own session', () => {
  const config = defaultConfig('pt-BR');
  const signature = config.briefing.signature;
  assert.equal(signature, 'Briefing matinal do segundo c\u00e9rebro');
  const first = measured(signature);
  assert.ok(first.startsWith('<scheduled-task name="'));
  assert.ok(first.includes(`\n\n${signature}\n`), 'the prompt is inside, after the paragraph');
  // The filter before the change: the trimmed message starts with a signature.
  assert.equal(signaturesOf(config).some((sig) => first.trim().startsWith(sig)), false);
});

test('pt-BR: the briefing session of the real run is dropped as the kit\'s own, counted, and the person\'s own session next to it stays', () => {
  const world = makeWorld({ lang: 'pt-BR', extraSignatures: [] });
  const first = measured(world.config.briefing.signature);
  assert.equal(world.config.briefing.signature, 'Briefing matinal do segundo c\u00e9rebro');
  world.write(PROJECT, 'briefing.jsonl', [user(first, INSIDE, { origin: { kind: 'human' } }), assistant('Bom dia, Ana.', '2026-09-23T15:00:00.000Z')]);
  const human = world.write(PROJECT, 'ana.jsonl', [user('Ana pergunta sobre o or\u00e7amento', INSIDE)]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), [human]);
  assert.equal(plan.dropped.selfTrace, 1);
  assert.ok(plan.promptBlock.includes(createTranslator('pt-BR')('sources.transcripts.dropped_self_trace', { count: 1 })), plan.promptBlock);
});

test('a dry run of the round, after the first scheduled run, plans the person\'s session and not the briefing\'s', () => {
  const w = makeCurateWorld({ config: (c) => { c.lang = 'pt-BR'; c.briefing.signature = defaultConfig('pt-BR').briefing.signature; } });
  const at = `${utcDay(-1)}T13:00:00.000Z`;
  const briefing = join(w.projects, CURATE_PROJECT, 'bbbbbbbb-1111-4222-8333-444444444444.jsonl');
  writeFileSync(briefing, `${[user(measured(w.config.briefing.signature), at, { origin: { kind: 'human' } }), assistant('Bom dia, Ana.', at)].map((line) => JSON.stringify(line)).join('\n')}\n`);

  const r = w.curate(['--dry']);
  assert.equal(r.status, EXIT.OK, r.stderr);
  // The world's own transcript (aaaaaaaa) is the only file in the plan; the
  // briefing's (bbbbbbbb) is left out, and no digest is named for it.
  assert.match(r.stdout, /Fonte transcripts: 1 arquivo\(s\) na janela/);
  assert.match(r.stdout, /01-aaaaaaaa\.txt/);
  assert.doesNotMatch(r.stdout, /bbbbbbbb/);
});
