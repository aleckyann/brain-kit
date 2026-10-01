// The desktop application does not hand a scheduled task's prompt to the
// session as its first user message. It wraps it (measured on the first
// real briefing run, 01/10/2026): one string, an open tag with the task's
// `name` and `file`, a newline, one paragraph of the application's own
// wording, a blank line, the prompt exactly as registered, a newline and
// the closing tag. The self-trace filter compared the message's start with
// the signatures, so it never saw through the envelope, and the briefing's
// own session would have been read back as the person's work.
//
// `startsWithSignature` stays the one predicate. A message that already
// starts with a signature is dropped as before; a message that starts with
// the envelope's open tag is the kit's own when the envelope's `name`
// starts with the briefing task-id prefix (also another vault's briefing,
// whose signature this vault does not know) or when the task prompt inside
// starts with a signature. A signature anywhere else never drops a file
// (11/08/2026), and anything that does not clearly match stays in.
//
// The envelope below is rebuilt by hand from that measurement, with
// example names (Ana, example.com, /home/ana); the em dash of the
// application's wording is written as an escape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BRIEFING_TASK_PREFIX, briefingTask, briefingTaskFile, briefingTaskId, readBriefingTask } from '../src/commands/schedule.mjs';
import { BRIEFING_TASK_PREFIX as DEFINED_PREFIX } from '../src/briefing/task-id.mjs';
import { startsWithSignature } from '../src/sources/transcripts-claude-code.mjs';
import { createTranslator } from '../src/lang.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { INSIDE, PROJECT, assistant, makeWorld, paths, user, userBlocks } from './helpers/transcripts-world.mjs';
import { VAULT_ID, makeScheduleWorld } from './helpers/schedule-world.mjs';

const SIGNATURE = 'Second brain morning briefing';
const CURATOR = 'Second brain curator';
const SIGNATURES = [CURATOR, SIGNATURE];
const KIT_NAME = 'brain-kit-briefing-ana-vault-1a2b3c4d';
const OTHER_NAME = 'rtk-auto-update';
const LATER = '2026-09-23T15:00:00.000Z';

const BOILERPLATE = 'This is an automated run of a scheduled task. The user is not present to answer questions. For implementation details, execute autonomously without asking clarifying questions \u2014 make reasonable choices and note them in your output. "write" actions (e.g. MCP tools that send, post, create, update, or delete), only take them if the task file asks for that specific action. When in doubt, producing a report of what you found is the correct output.';
const COMMAND = 'Run exactly this command with Bash and follow everything it prints as this session\'s instructions: node "/home/ana/.claude/plugins/cache/example.com/brain-kit/bin/brain-kit.mjs" prompt briefing --vault "/home/ana/vault"';
const PROMPT = `${SIGNATURE}\n${COMMAND}`;
const OWN_PROMPT = 'Update the rtk tool and report which version it is now.';

// The envelope as the application writes it, in the variations the brief
// and the finding allow for: the quote character, the order of the
// attributes, the boilerplate (`null` for none), the closing tag, the line
// ends, what comes before the open tag.
function envelope({ name = KIT_NAME, prompt = PROMPT, boilerplate = BOILERPLATE, close = true, quote = '"', swap = false, eol = '\n', lead = '' } = {}) {
  const file = `/home/ana/.claude/scheduled-tasks/${name}/SKILL.md`;
  const attributes = swap ? [['file', file], ['name', name]] : [['name', name], ['file', file]];
  const open = `<scheduled-task ${attributes.map(([key, value]) => `${key}=${quote}${value}${quote}`).join(' ')}>`;
  const lines = [open, ...(boilerplate === null ? [] : [boilerplate, '']), prompt];
  if (close) lines.push('</scheduled-task>');
  return lead + lines.join('\n').replace(/\n/g, eol);
}

// The shapes the envelope can take. Each is tried three ways: a kit name
// with a prompt that is not signed (clause a alone), another name with the
// signed prompt (clause b alone), and another name with another prompt
// (neither).
const SHAPES = {
  'the measured envelope': {},
  'a different boilerplate paragraph': { boilerplate: 'Automated run. Nobody is watching.\nThe same paragraph goes on here, and mentions no signature.' },
  'no boilerplate at all': { boilerplate: null },
  'single quotes and the attributes swapped': { quote: '\'', swap: true },
  'no closing tag': { close: false },
  'CRLF line ends': { eol: '\r\n' },
  'CRLF line ends, no boilerplate': { eol: '\r\n', boilerplate: null },
  'leading whitespace and blank lines': { lead: '\n\n  \t\n' },
  'several blank lines between the paragraph and the prompt': { boilerplate: `${BOILERPLATE}\n\n  ` },
  'several blank lines, CRLF': { boilerplate: `${BOILERPLATE}\n\n  `, eol: '\r\n' },
  'single quotes, CRLF, no closing tag and leading newlines together': { quote: '\'', swap: true, eol: '\r\n', close: false, lead: '\r\n\r\n' },
};

for (const [label, shape] of Object.entries(SHAPES)) {
  test(`envelope, ${label}: the kit's task name alone makes the session the kit's own`, () => {
    assert.equal(startsWithSignature(envelope({ ...shape, name: KIT_NAME, prompt: OWN_PROMPT }), SIGNATURES), true);
  });

  test(`envelope, ${label}: the signed prompt alone makes the session the kit's own`, () => {
    assert.equal(startsWithSignature(envelope({ ...shape, name: OTHER_NAME, prompt: PROMPT }), SIGNATURES), true);
  });

  test(`envelope, ${label}: another name and another prompt is the person's own task and stays in`, () => {
    assert.equal(startsWithSignature(envelope({ ...shape, name: OTHER_NAME, prompt: OWN_PROMPT }), SIGNATURES), false);
  });
}

test('the measured envelope, in full, is the kit\'s own on both clauses at once', () => {
  const text = envelope();
  assert.ok(text.startsWith(`<scheduled-task name="${KIT_NAME}" file="/home/ana/.claude/scheduled-tasks/${KIT_NAME}/SKILL.md">\nThis is an automated run`));
  assert.ok(text.includes('\u2014'));
  assert.ok(text.endsWith('\n</scheduled-task>'));
  assert.equal(startsWithSignature(text, SIGNATURES), true);
  assert.equal(startsWithSignature(text, [SIGNATURE]), true);
  assert.equal(startsWithSignature(text, [CURATOR]), true, 'the name clause needs no signature');
  assert.equal(startsWithSignature(text, []), true, 'the name clause needs no signature');
  assert.equal(startsWithSignature(envelope({ name: OTHER_NAME }), [CURATOR]), false, 'the prompt clause needs the matching signature');
  assert.equal(startsWithSignature(envelope({ name: OTHER_NAME }), []), false);
});

test('a signature the curator is configured with, other than the briefing\'s, signs a task inside the envelope too', () => {
  assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt: `${CURATOR}\nWindow: 23/09/2026.` }), SIGNATURES), true);
});

test('the open tag takes spaces around the equals sign, other attributes before and after the name, and a ">" inside a quoted value', () => {
  const open = (attributes) => `<scheduled-task ${attributes}>\n${BOILERPLATE}\n\n${OWN_PROMPT}\n</scheduled-task>`;
  for (const attributes of [
    `name = "${KIT_NAME}"`,
    `name\t=\t'${KIT_NAME}'`,
    `cron="0 9 * * 1-5" name="${KIT_NAME}" file="/home/ana/a>b/SKILL.md"`,
    `file="/home/ana/a>b/SKILL.md" name='${KIT_NAME}' extra="it's"`,
    `title='say "hi"' name="${KIT_NAME}"`,
    `name="${KIT_NAME}"   `,
    `\n  name="${KIT_NAME}"\n  file="/home/ana/x/SKILL.md"\n`,
  ]) {
    assert.equal(startsWithSignature(open(attributes), SIGNATURES), true, attributes);
  }
});

test('the first name attribute is the task\'s name, as in any parser of tags', () => {
  const text = (attributes) => `<scheduled-task ${attributes}>\n${BOILERPLATE}\n\n${OWN_PROMPT}`;
  assert.equal(startsWithSignature(text(`name="${KIT_NAME}" name="${OTHER_NAME}"`), SIGNATURES), true);
  assert.equal(startsWithSignature(text(`name="${OTHER_NAME}" name="${KIT_NAME}"`), SIGNATURES), false);
});

test('the name clause is a prefix, on the name attribute and on nothing else', () => {
  const text = (attributes, prompt = OWN_PROMPT) => `<scheduled-task ${attributes}>\n${BOILERPLATE}\n\n${prompt}\n</scheduled-task>`;
  // In the middle of a name: a task of the person's that only mentions it.
  assert.equal(startsWithSignature(text(`name="my-${BRIEFING_TASK_PREFIX}x"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text(`name="${BRIEFING_TASK_PREFIX.slice(0, -1)}"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text(`name="${BRIEFING_TASK_PREFIX.toUpperCase()}x"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text(`name=" ${BRIEFING_TASK_PREFIX}x"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text('name=""'), SIGNATURES), false);
  // Another attribute holding the same words: the file's path carries the task id.
  assert.equal(startsWithSignature(text(`name="${OTHER_NAME}" file="/home/ana/.claude/scheduled-tasks/${KIT_NAME}/SKILL.md"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text(`id="${KIT_NAME}"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text(`xname="${KIT_NAME}"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text(`data-name="${KIT_NAME}"`), SIGNATURES), false);
  assert.equal(startsWithSignature(text(`title="name=${KIT_NAME}"`), SIGNATURES), false);
  // The prefix with nothing after it is still the prefix.
  assert.equal(startsWithSignature(text(`name="${BRIEFING_TASK_PREFIX}"`), SIGNATURES), true);
});

test('the person\'s own task in the same envelope is not the kit\'s, however it is shaped', () => {
  for (const name of [OTHER_NAME, 'weekly-report', 'brain-kit-curate-ana-vault-1a2b3c4d', 'brain-kit-briefing']) {
    assert.equal(startsWithSignature(envelope({ name, prompt: OWN_PROMPT }), SIGNATURES), false, name);
  }
});

test('the tag mentioned in the middle of a message, or after other text, is nothing', () => {
  const quoted = `<scheduled-task name="${KIT_NAME}">`;
  for (const text of [
    `Ana pastes ${quoted} and asks what it is`,
    `Ana wrote:\n${envelope()}`,
    `Ana wrote:\n\n${envelope()}`,
    `> ${envelope()}`,
    `"${envelope()}"`,
    `\`${envelope()}\``,
    `Why does this appear ${quoted}\n${BOILERPLATE}\n\n${PROMPT}`,
  ]) {
    assert.equal(startsWithSignature(text, SIGNATURES), false, text.slice(0, 40));
  }
});

test('a signature after the first paragraph of ordinary text, with no envelope, is not a signature', () => {
  for (const text of [
    `Good morning\n\n${PROMPT}`,
    `Ana notes:\n${SIGNATURE}`,
    `${BOILERPLATE}\n\n${PROMPT}`,
    `Ana says this is the task: ${SIGNATURE}`,
    `The tag is scheduled-task and the signature is ${SIGNATURE}`,
  ]) {
    assert.equal(startsWithSignature(text, SIGNATURES), false, text.slice(0, 40));
  }
});

test('a signature on a later line of an envelope whose prompt starts with other text is not a signature', () => {
  // Prompts with no blank line before the signature: judged with and without
  // the application's paragraph, and with CRLF.
  for (const prompt of [
    `Other task\n${SIGNATURE}\n${COMMAND}`,
    `\u2022 ${SIGNATURE}`,
    `Report on "${SIGNATURE}"`,
    `Other task: ${SIGNATURE}`,
  ]) {
    assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt }), SIGNATURES), false, prompt.slice(0, 30));
    assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt, boilerplate: null }), SIGNATURES), false, prompt.slice(0, 30));
    assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt, eol: '\r\n' }), SIGNATURES), false, prompt.slice(0, 30));
  }
  // Prompts that put a blank line before the signature: with the paragraph
  // in front, the prompt is what follows the FIRST blank line, so the
  // signature is still on a later line of a prompt that starts with other text.
  for (const prompt of [`Other task\n\n${SIGNATURE}\n${COMMAND}`, `Other task\n \n${PROMPT}`, `Other task\n\n\n${PROMPT}`]) {
    assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt }), SIGNATURES), false, prompt.slice(0, 30));
    assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt, eol: '\r\n' }), SIGNATURES), false, prompt.slice(0, 30));
  }
  // A signature inside the application's own paragraph, not at its start.
  assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt: OWN_PROMPT, boilerplate: `The paragraph mentions ${SIGNATURE} once.` }), SIGNATURES), false);
  // A second paragraph before the prompt: the prompt is what follows the FIRST blank line.
  assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt: PROMPT, boilerplate: `${BOILERPLATE}\n\nA second paragraph.` }), SIGNATURES), false);
  // And the signature far below a prompt that starts with other text.
  assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt: `${OWN_PROMPT}\n${'more text of the task\n'.repeat(50)}\n${SIGNATURE}` }), SIGNATURES), false);
});

test('an open tag that does not clearly match is not an envelope, whatever it holds', () => {
  const body = `\n${BOILERPLATE}\n\n${PROMPT}`;
  for (const text of [
    `<scheduled-task>${body}`,
    `<scheduled-task${body}`,
    `<scheduled-tasks name="${KIT_NAME}">${body}`,
    `<Scheduled-Task name="${KIT_NAME}">${body}`,
    `< scheduled-task name="${KIT_NAME}">${body}`,
    `<scheduled-task-x name="${KIT_NAME}">${body}`,
    `<scheduled-task name="${KIT_NAME}${body}`,
    `<scheduled-task name='${KIT_NAME}"${body}`,
    `<scheduled-task name=${KIT_NAME}>${body}`,
    `<scheduled-task name>${body}`,
    `<scheduled-task "${KIT_NAME}">${body}`,
    `<scheduled-task name="${KIT_NAME}"${body}`,
    `<scheduled-task name="${KIT_NAME}" />${body}`,
    `<scheduled-task name="${KIT_NAME}"/>${body}`,
    `<scheduled-task name="${KIT_NAME}"\n${BOILERPLATE}\n\n${PROMPT}`,
    `<scheduled-task =\"x\" name="${KIT_NAME}">${body}`,
    `<scheduled-task name="${KIT_NAME}"; rm -rf>${body}`,
    `<scheduled-task name="${KIT_NAME}"x>${body}`,
    `<scheduled-task name="${KIT_NAME}"x="y">${body}`,
    `<scheduled-task x="1"name="${KIT_NAME}">${body}`,
    `<scheduled-task x='1'name='${KIT_NAME}'>${body}`,
    `<scheduled-task name=""${KIT_NAME}">${body}`,
  ]) {
    assert.equal(startsWithSignature(text, SIGNATURES), false, text.slice(0, 60));
  }
});

test('an open tag with a bare signature right after it, or after a blank line, is read the same way', () => {
  const tag = `<scheduled-task name="${OTHER_NAME}">`;
  assert.equal(startsWithSignature(`${tag}${SIGNATURE}`, SIGNATURES), true);
  assert.equal(startsWithSignature(`${tag} ${SIGNATURE}\n${COMMAND}`, SIGNATURES), true);
  assert.equal(startsWithSignature(`${tag}\n${SIGNATURE}\n${COMMAND}`, SIGNATURES), true);
  assert.equal(startsWithSignature(`${tag}\n\n${SIGNATURE}\n${COMMAND}`, SIGNATURES), true);
  assert.equal(startsWithSignature(`${tag}\n\n\n  \n${SIGNATURE}\n${COMMAND}`, SIGNATURES), true);
  assert.equal(startsWithSignature(`${tag}\r\n\r\n${SIGNATURE}`, SIGNATURES), true);
  assert.equal(startsWithSignature(`${tag}\nOther\n${SIGNATURE}`, SIGNATURES), false);
  assert.equal(startsWithSignature(`${tag}\nOther`, SIGNATURES), false);
  assert.equal(startsWithSignature(tag, SIGNATURES), false);
  assert.equal(startsWithSignature(`${tag}\n`, SIGNATURES), false);
  assert.equal(startsWithSignature(`${tag}\n</scheduled-task>`, SIGNATURES), false);
});

test('what the predicate always did: a message that starts with a signature, trimmed, is the kit\'s own', () => {
  for (const text of [PROMPT, `  \n${PROMPT}`, `${SIGNATURE} extra words`, SIGNATURE, `${CURATOR}\nWindow: 23/09/2026.`]) {
    assert.equal(startsWithSignature(text, SIGNATURES), true, text.slice(0, 30));
  }
  for (const text of [`Good morning\n${PROMPT}`, SIGNATURE.toLowerCase(), 'Second brain', `x${SIGNATURE}`, 'Ana asks about the budget']) {
    assert.equal(startsWithSignature(text, SIGNATURES), false, text.slice(0, 30));
  }
});

test('blank signatures and what is not text never count, in the envelope as outside it', () => {
  const blank = ['', '   ', '\n', null, undefined, 7, {}, []];
  for (const text of [
    OWN_PROMPT,
    envelope({ name: OTHER_NAME, prompt: OWN_PROMPT }),
    envelope({ name: OTHER_NAME, prompt: OWN_PROMPT, boilerplate: null }),
    `<scheduled-task name="${OTHER_NAME}">`,
    `<scheduled-task name="${OTHER_NAME}">\n\n`,
    `<scheduled-task name="${OTHER_NAME}">\r\n\r\n   `,
  ]) {
    assert.equal(startsWithSignature(text, blank), false, JSON.stringify(text.slice(0, 40)));
    assert.equal(startsWithSignature(text, [...blank, SIGNATURE]), false, JSON.stringify(text.slice(0, 40)));
  }
  for (const text of [undefined, null, 0, 7, true, {}, [], [PROMPT], () => PROMPT, Symbol('x')]) {
    assert.equal(startsWithSignature(text, SIGNATURES), false, String(typeof text));
  }
  for (const text of ['', ' ', '\n\n', '\t\r\n']) assert.equal(startsWithSignature(text, SIGNATURES), false, JSON.stringify(text));
});

// ------------------------------------------------------------- a first message of 2 MB

const TWO_MB = 2 * 1024 * 1024;

function timed(run) {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

test('a first message of 2 MB with no closing tag is judged promptly and correctly, whatever its shape', () => {
  const blob = 'x'.repeat(TWO_MB);
  const lines = `${'a line of pasted text '.repeat(40)}\n`.repeat(Math.ceil(TWO_MB / 880));
  const cases = [
    ['an envelope of the person\'s own task around a blob', `<scheduled-task name="${OTHER_NAME}">\n${BOILERPLATE}\n\n${blob}`, false],
    ['a kit envelope around a blob', `<scheduled-task name="${KIT_NAME}">\n${BOILERPLATE}\n\n${blob}`, true],
    ['a signed prompt followed by a blob', `<scheduled-task name="${OTHER_NAME}">\n${BOILERPLATE}\n\n${SIGNATURE}\n${blob}`, true],
    ['a signature at the start of 2 MB', `${SIGNATURE}\n${blob}`, true],
    ['no blank line in 2 MB after the tag', `<scheduled-task name="${OTHER_NAME}">\n${blob}`, false],
    ['2 MB of lines and no blank line', `<scheduled-task name="${OTHER_NAME}">\n${lines}`, false],
    ['2 MB of blank lines after the tag, then the signature', `<scheduled-task name="${OTHER_NAME}">${'\n'.repeat(TWO_MB)}${SIGNATURE}`, false],
    ['2 MB of spaces and blank lines in the open tag', `<scheduled-task name="${OTHER_NAME}"${' \n'.repeat(TWO_MB / 2)}>\n\n${SIGNATURE}`, false],
    ['an open tag that never closes its quote', `<scheduled-task name="${blob}`, false],
    ['an open tag of attributes that never ends', `<scheduled-task ${'a="b" '.repeat(TWO_MB / 6)}`, false],
    ['an open tag of one attribute name that never ends', `<scheduled-task ${blob}`, false],
    ['an open tag of quotes', `<scheduled-task ${'\'"'.repeat(TWO_MB / 2)}`, false],
    ['an open tag of equals signs', `<scheduled-task name${'='.repeat(TWO_MB)}`, false],
    ['a name attribute 2 MB long', `<scheduled-task name="${BRIEFING_TASK_PREFIX}${blob}">\n\n${OWN_PROMPT}`, false],
    ['a mention of the tag in the middle of 2 MB', `${blob} <scheduled-task name="${KIT_NAME}">\n\n${PROMPT}`, false],
  ];
  for (const [label, text, want] of cases) {
    assert.ok(text.length >= TWO_MB / 2, label);
    const { value, ms } = timed(() => startsWithSignature(text, SIGNATURES));
    assert.equal(value, want, label);
    assert.ok(ms < 1000, `${label}: took ${Math.round(ms)} ms`);
  }
});

// ------------------------------------------------------------- the curator's own plan

function sessionWithFirstMessage(world, name, text, extra = []) {
  return world.write(PROJECT, name, [user(text, INSIDE), assistant('Good morning, Ana.', LATER), ...extra]);
}

for (const lang of ['en', 'pt-BR']) {
  test(`${lang}: the briefing's session, wrapped in the application's envelope, is dropped as the kit's own and counted`, () => {
    const world = makeWorld({ lang, extraSignatures: [] });
    const signature = world.config.briefing.signature;
    assert.notEqual(signature.trim(), '');
    sessionWithFirstMessage(world, 'briefing.jsonl', envelope({ prompt: `${signature}\n${COMMAND}` }));
    sessionWithFirstMessage(world, 'briefing-by-prompt.jsonl', envelope({ name: OTHER_NAME, prompt: `${signature}\n${COMMAND}` }));
    const human = sessionWithFirstMessage(world, 'ana.jsonl', 'Ana asks about the budget');
    const plan = world.collect();
    assert.deepEqual(paths(plan), [human]);
    assert.equal(plan.dropped.selfTrace, 2);
    assert.ok(plan.promptBlock.includes(createTranslator(lang)('sources.transcripts.dropped_self_trace', { count: 2 })), plan.promptBlock);
  });
}

test('the envelope in a message of text blocks is read the same way as in a plain string', () => {
  const world = makeWorld({ extraSignatures: [] });
  world.write(PROJECT, 'blocks.jsonl', [userBlocks([{ type: 'text', text: envelope() }], INSIDE), assistant('Good morning, Ana.', LATER)]);
  world.write(PROJECT, 'two-blocks.jsonl', [userBlocks([{ type: 'text', text: envelope({ name: OTHER_NAME, prompt: PROMPT.replace(SIGNATURE, world.config.briefing.signature) }) }, { type: 'text', text: 'a second block of text' }], INSIDE)]);
  const human = sessionWithFirstMessage(world, 'ana.jsonl', 'Ana asks about the budget');
  const plan = world.collect();
  assert.deepEqual(paths(plan), [human]);
  assert.equal(plan.dropped.selfTrace, 2);
});

test('the briefing of another vault on the same machine is dropped by the task\'s name, with its signature unknown here', () => {
  const world = makeWorld({ extraSignatures: [] });
  const other = envelope({ name: 'brain-kit-briefing-other-vault-9f8e7d6c', prompt: 'Briefing of the other vault\nRun the other vault\'s briefing.' });
  assert.equal(other.includes(world.config.briefing.signature), false);
  assert.equal(other.includes(world.config.curate.signature), false);
  sessionWithFirstMessage(world, 'other-vault.jsonl', other);
  const human = sessionWithFirstMessage(world, 'ana.jsonl', 'Ana asks about the budget');
  const plan = world.collect();
  assert.deepEqual(paths(plan), [human]);
  assert.equal(plan.dropped.selfTrace, 1);
});

test('the person\'s own scheduled task, unsigned and not the kit\'s, is read like any session of theirs', () => {
  const world = makeWorld({ extraSignatures: [] });
  const own = sessionWithFirstMessage(world, 'rtk.jsonl', envelope({ name: OTHER_NAME, prompt: OWN_PROMPT }));
  const sibling = sessionWithFirstMessage(world, 'ana.jsonl', 'Ana asks about the budget');
  const plan = world.collect();
  assert.deepEqual(paths(plan).sort(), [own, sibling].sort());
  assert.equal(plan.dropped.selfTrace, 0);
  assert.doesNotMatch(plan.promptBlock, /left out as the curator's own runs/);
});

test('only the first user message counts: an envelope later in a session of Ana\'s, or quoted in it, leaves it in', () => {
  const world = makeWorld({ extraSignatures: [] });
  const later = world.write(PROJECT, 'later.jsonl', [
    user('Ana is looking at how the briefing task is wrapped', INSIDE),
    assistant('It arrives as a tag.', LATER),
    user(envelope(), LATER),
  ]);
  const quoted = sessionWithFirstMessage(world, 'quoted.jsonl', `Ana pastes this and asks what it is:\n${envelope()}`);
  const plan = world.collect();
  assert.deepEqual(paths(plan).sort(), [later, quoted].sort());
  assert.equal(plan.dropped.selfTrace, 0);
});

test('a line the harness marks as meta does not hide the envelope: the first user message with text decides', () => {
  const world = makeWorld({ extraSignatures: [] });
  world.write(PROJECT, 'meta-first.jsonl', [user('Caveat: the messages below were generated by the user', INSIDE, { isMeta: true }), user(envelope(), LATER), assistant('Good morning, Ana.', LATER)]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), []);
  assert.equal(plan.dropped.selfTrace, 1);
});

test('the plan of the sessions that stay is what it was: the same plan with or without a dropped envelope next to them', () => {
  const build = (withEnvelope) => {
    const world = makeWorld({ extraSignatures: [] });
    sessionWithFirstMessage(world, 'ana.jsonl', 'Ana asks about the budget');
    sessionWithFirstMessage(world, 'rtk.jsonl', envelope({ name: OTHER_NAME, prompt: OWN_PROMPT }));
    if (withEnvelope) sessionWithFirstMessage(world, 'briefing.jsonl', envelope());
    // The plan with the world's scratch directory made the same in both.
    return JSON.parse(JSON.stringify(world.collect()).replaceAll(world.tmp, '<tmp>'));
  };
  const plain = build(false);
  const wrapped = build(true);
  assert.equal(plain.files.length, 2);
  assert.equal(plain.dropped.selfTrace, 0);
  assert.equal(wrapped.dropped.selfTrace, 1);
  // What differs is the count and the one line that says it.
  const sayings = (text) => text.split('\n').filter((line) => /left out as the curator's own runs/.test(line));
  assert.equal(sayings(plain.promptBlock).length, 0);
  assert.equal(sayings(wrapped.promptBlock).length, 1);
  wrapped.dropped.selfTrace = 0;
  wrapped.promptBlock = wrapped.promptBlock.split('\n').filter((line) => !sayings(line).length).join('\n');
  assert.deepEqual(wrapped, plain);
});

// ------------------------------------------------- the one literal, and the task `status` reads

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

test('the task-id prefix is defined once, in its own module, and schedule.mjs re-exports that definition', () => {
  assert.equal(BRIEFING_TASK_PREFIX, DEFINED_PREFIX);
  assert.equal(BRIEFING_TASK_PREFIX, 'brain-kit-briefing-');
  // The literal, spelled as a string, is in exactly one place in src/.
  const spelled = sourceFiles(join(KIT_ROOT, 'src')).filter((file) => /['"`]brain-kit-briefing-/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(spelled, [join(KIT_ROOT, 'src', 'briefing', 'task-id.mjs')]);
  // And both users take it from there.
  for (const file of ['src/commands/schedule.mjs', 'src/sources/transcripts-claude-code.mjs']) {
    assert.match(readFileSync(join(KIT_ROOT, file), 'utf8'), /^import \{ BRIEFING_TASK_PREFIX \} from '\.\.\/briefing\/task-id\.mjs';$/m, file);
  }
});

test('the task id the kit registers for a vault starts with the prefix the filter looks for, so the application\'s envelope for it is recognised', () => {
  const taskId = briefingTaskId(VAULT_ID);
  assert.ok(taskId.startsWith(BRIEFING_TASK_PREFIX), taskId);
  assert.equal(startsWithSignature(envelope({ name: taskId, prompt: OWN_PROMPT }), SIGNATURES), true);
});

test('schedule status and the curator agree on the task file\'s prompt, which the application does not wrap, and status\'s output is what it was', async () => {
  const world = makeScheduleWorld();
  const configFile = join(world.vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const task = briefingTask({ root: world.vault, config, vaultId: VAULT_ID, env: world.env });
  assert.equal(task.problem, undefined);
  const file = briefingTaskFile(world.env, task.taskId);
  const write = (prompt) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\nname: ${task.taskId}\ndescription: the briefing\n---\n\n${prompt}\n`);
  };

  write(task.prompt);
  const found = readBriefingTask({ root: world.vault, config, vaultId: VAULT_ID, env: world.env });
  assert.equal(found.signed, true);
  assert.equal(found.signed, startsWithSignature(task.prompt, [task.signature]));
  const ok = await world.run(['status', '--job', 'briefing']);
  const kit = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
  assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, `${world.t('schedule.briefing_status_ok', { taskId: task.taskId, file, kit })}\n`, '']);

  // The prompt the curator sees when the application wraps it is the same
  // prompt, and it drops that session: the two cannot disagree.
  assert.equal(startsWithSignature(envelope({ name: task.taskId, prompt: task.prompt }), [task.signature]), true);
  assert.equal(startsWithSignature(envelope({ name: OTHER_NAME, prompt: task.prompt }), [task.signature]), true);

  // A prompt that does not start with the signature is still unsigned for status.
  const command = 'brain-kit schedule install --job briefing';
  write(`Good morning\n${task.prompt}`);
  const unsigned = await world.run(['status', '--job', 'briefing']);
  assert.deepEqual([unsigned.status, unsigned.stdout], [1, `${world.t('schedule.briefing_status_unsigned', { taskId: task.taskId, file, signature: task.signature, command })}\n`]);
  assert.equal(readBriefingTask({ root: world.vault, config, vaultId: VAULT_ID, env: world.env }).signed, false);
});
