// The transcripts source (src/sources/transcripts-claude-code.mjs) and the
// source interface (src/sources/index.mjs), against a fake transcripts
// tree built in a temporary directory. The three incidents this source
// carries have their own files under test/incidents/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSource } from '../src/sources/index.mjs';
import { transcriptsSource, SAMPLE_BYTES } from '../src/sources/transcripts-claude-code.mjs';
import {
  FROM, TO, NOW, INSIDE, WEEKS_AGO, PROJECT, OTHER_PROJECT,
  assistant, customTitle, lastPrompt, makeWorld, mode, paths, system, toolResult, user,
} from './helpers/transcripts-world.mjs';

test('the transcripts source implements the source interface', () => {
  assert.deepEqual(validateSource(transcriptsSource), []);
  assert.equal(transcriptsSource.id, 'transcripts');
  assert.equal(transcriptsSource.kind, 'local');
  assert.equal(transcriptsSource.required, true);
});

test('validateSource names every missing or wrong member', () => {
  assert.deepEqual(validateSource(null), ['source: must be an object']);
  const errors = validateSource({ id: 'Bad Id', kind: 'remote', required: 'yes', collect: 1 });
  assert.equal(errors.length, 5, errors.join('\n'));
  assert.ok(errors.some((e) => e.startsWith('source.id')));
  assert.ok(errors.some((e) => e.startsWith('source.kind')));
  assert.ok(errors.some((e) => e.startsWith('source.required')));
  assert.ok(errors.some((e) => e.startsWith('source.collect')));
  assert.ok(errors.some((e) => e.startsWith('source.readEvidence')));
});

test('only the projects named in include_projects are read, by exact name', () => {
  const world = makeWorld({ include: [PROJECT] });
  const kept = world.write(PROJECT, 'a.jsonl', [user('Ana asks about the plan', INSIDE)]);
  world.write(OTHER_PROJECT, 'b.jsonl', [user('Ana writes code', INSIDE)]);
  world.write(`${PROJECT}-old`, 'c.jsonl', [user('prefix of the listed name', INSIDE)]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), [kept]);
  assert.equal(plan.files[0].project, PROJECT);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.misconfigured, false);
});

test('an empty include_projects reads nothing, is misconfigured and says so', () => {
  const world = makeWorld({ include: [] });
  world.write(PROJECT, 'a.jsonl', [user('Ana asks', INSIDE)]);
  const plan = world.collect();
  assert.deepEqual(plan.files, []);
  assert.equal(plan.misconfigured, true);
  assert.deepEqual(plan.problems.map((p) => p.code), ['no_projects']);
  assert.match(plan.promptBlock, /include_projects/);
});

test('a missing transcripts directory is misconfigured and named in the prompt block', () => {
  const world = makeWorld({ missingRoot: true });
  const plan = world.collect();
  assert.equal(plan.misconfigured, true);
  assert.deepEqual(plan.problems.map((p) => p.code), ['root_missing']);
  assert.ok(plan.promptBlock.includes(world.root), plan.promptBlock);
});

test('a listed project that is missing is a problem; misconfigured only when every listed project is missing', () => {
  const partial = makeWorld({ include: [PROJECT, '-home-ana-gone'] });
  partial.write(PROJECT, 'a.jsonl', [user('Ana asks', INSIDE)]);
  const plan = partial.collect();
  assert.equal(plan.misconfigured, false);
  assert.deepEqual(plan.problems, [{ code: 'project_missing', detail: '-home-ana-gone' }]);
  assert.equal(plan.files.length, 1);
  assert.match(plan.promptBlock, /-home-ana-gone/);

  const none = makeWorld({ include: ['-home-ana-gone', '-home-ana-lost'] });
  const empty = none.collect();
  assert.equal(empty.misconfigured, true);
  assert.deepEqual(empty.problems.map((p) => p.code), ['project_missing', 'project_missing']);
});

test('firstAt and lastAt are the earliest and latest message timestamps inside the window', () => {
  const world = makeWorld();
  world.write(PROJECT, 'a.jsonl', [
    user('Ana opened this long ago', '2026-09-22T20:00:00.000Z'),
    user('Ana is back', '2026-09-23T10:00:00.000Z'),
    assistant('answer', '2026-09-23T10:00:05.000Z'),
    system('2026-09-23T21:15:00.000Z'),
    user('after the window', '2026-09-24T04:00:00.000Z'),
  ]);
  const [file] = world.collect().files;
  assert.equal(file.firstAt, '2026-09-23T10:00:00.000Z');
  assert.equal(file.lastAt, '2026-09-23T21:15:00.000Z');
});

test('the window is [from, to): a message at from is in, a message at to is out', () => {
  const world = makeWorld();
  const atFrom = world.write(PROJECT, 'at-from.jsonl', [user('first second of the day', FROM.toISOString())]);
  world.write(PROJECT, 'at-to.jsonl', [user('first second of the next day', TO.toISOString())]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), [atFrom]);
  assert.equal(plan.dropped.outOfWindow, 1);
});

test('timestamps are compared as instants, whatever offset they are written with', () => {
  const world = makeWorld();
  const file = world.write(PROJECT, 'a.jsonl', [user('written with an offset', '2026-09-23T01:30:00-03:00')]);
  world.write(PROJECT, 'b.jsonl', [user('before the window', '2026-09-22T23:59:00-03:00')]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), [file]);
  assert.equal(plan.files[0].firstAt, '2026-09-23T04:30:00.000Z');
});

test('lines without a timestamp, malformed lines and unknown types are skipped, not fatal', () => {
  const world = makeWorld();
  const file = world.write(PROJECT, 'a.jsonl', [
    customTitle(),
    '{"type":"user","message":{"role":"user","content":"cut in half',
    'not json at all',
    { type: 'queue-operation', operation: 'enqueue', timestamp: INSIDE, sessionId: 'x' },
    { type: 'some-future-type', timestamp: '2026-09-23T23:00:00.000Z' },
    user('Ana asks', INSIDE),
    lastPrompt(),
    mode(),
  ]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), [file]);
  assert.equal(plan.files[0].lastAt, INSIDE, 'a line of an unknown type does not count as a message');
});

test('a file with no parseable message timestamp is unreadable and listed, never silently dropped', () => {
  const world = makeWorld();
  const bad = world.write(PROJECT, 'bad.jsonl', ['garbage', customTitle(), lastPrompt()]);
  const plan = world.collect();
  assert.deepEqual(plan.files, []);
  assert.equal(plan.dropped.unreadable, 1);
  assert.equal(plan.unreadable.length, 1);
  assert.equal(plan.unreadable[0].path, bad);
  assert.equal(plan.unreadable[0].project, PROJECT);
  assert.ok(plan.promptBlock.includes(bad), plan.promptBlock);
});

test('a file that cannot be opened is unreadable and listed', { skip: process.getuid?.() === 0 ? 'root reads any file' : false }, () => {
  const world = makeWorld();
  const locked = world.write(PROJECT, 'locked.jsonl', [user('Ana asks', INSIDE)]);
  chmodSync(locked, 0o000);
  try {
    const plan = world.collect();
    assert.equal(plan.dropped.unreadable, 1);
    assert.equal(plan.unreadable[0].path, locked);
    assert.ok(plan.promptBlock.includes(locked));
  } finally {
    chmodSync(locked, 0o644);
  }
});

test('exclude_path_patterns drops by substring of the path; an empty pattern excludes nothing', () => {
  const world = makeWorld({ include: [PROJECT, '-tmp-probe'], exclude: ['/-tmp-', ''] });
  const kept = world.write(PROJECT, 'a.jsonl', [user('Ana asks', INSIDE)]);
  world.write('-tmp-probe', 'b.jsonl', [user('a throwaway run', INSIDE)]);
  const plan = world.collect();
  assert.deepEqual(paths(plan), [kept]);
  assert.equal(plan.dropped.excludedPath, 1);
});

test('only .jsonl files directly inside a project directory are candidates', () => {
  const world = makeWorld();
  const kept = world.write(PROJECT, 'a.jsonl', [user('Ana asks', INSIDE)]);
  world.write(PROJECT, 'notes.txt', [user('not a transcript', INSIDE)]);
  const nested = join(world.root, PROJECT, 'a', 'subagents');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'agent-1.jsonl'), `${JSON.stringify(user('a subagent prompt', INSIDE))}\n`);
  assert.deepEqual(paths(world.collect()), [kept]);
});

test('sampleFrom is where the last 64 KB begin, 0 for a smaller file, and sampleLine is the first whole line from there', () => {
  const world = makeWorld();
  world.write(PROJECT, 'small.jsonl', [user('Ana asks', INSIDE)]);
  const filler = 'x'.repeat(1000);
  const lines = [user('Ana starts', INSIDE)];
  for (let i = 0; i < 200; i += 1) lines.push(assistant(`${filler} ${i}`, INSIDE));
  world.write(PROJECT, 'big.jsonl', lines);
  const plan = world.collect();
  const small = plan.files.find((f) => f.path.endsWith('small.jsonl'));
  const big = plan.files.find((f) => f.path.endsWith('big.jsonl'));
  assert.equal(SAMPLE_BYTES, 64 * 1024);
  assert.equal(small.sampleFrom, 0);
  assert.equal(small.sampleLine, 1);
  assert.ok(big.bytes > SAMPLE_BYTES);
  assert.equal(big.sampleFrom, big.bytes - SAMPLE_BYTES);
  // Every line of the fixture has the same length give or take the index,
  // so the line holding sampleFrom is computable from the line lengths.
  const lengths = lines.map((l) => Buffer.byteLength(`${JSON.stringify(l)}\n`));
  let offset = 0;
  let line = 1;
  while (offset < big.sampleFrom) {
    offset += lengths[line - 1];
    line += 1;
  }
  assert.equal(big.sampleLine, line);
});

test('the prompt block lists each file with project, window span, size and sample offset, and only non-zero counters', () => {
  const world = makeWorld({ exclude: ['/skip-'] });
  const file = world.write(PROJECT, 'a.jsonl', [user('Ana asks', '2026-09-23T10:00:00.000Z'), assistant('ok', '2026-09-23T11:00:00.000Z')]);
  world.write(PROJECT, 'old.jsonl', [user('long ago', WEEKS_AGO)]);
  const plan = world.collect();
  const line = plan.promptBlock.split('\n').find((l) => l.includes(file));
  assert.ok(line, plan.promptBlock);
  assert.ok(line.includes(PROJECT));
  assert.ok(line.includes('2026-09-23T10:00:00.000Z'));
  assert.ok(line.includes('2026-09-23T11:00:00.000Z'));
  assert.ok(line.includes(String(plan.files[0].bytes)));
  assert.ok(line.includes(`byte ${plan.files[0].sampleFrom}`));
  assert.match(plan.promptBlock, /1 transcripts? left out because no message falls inside the window/);
  assert.doesNotMatch(plan.promptBlock, /cap of/);
  assert.doesNotMatch(plan.promptBlock, /exclude_path_patterns/);
  assert.doesNotMatch(plan.promptBlock, /own runs/);
  assert.match(plan.promptBlock, /never the whole file/);
});

test('an empty window says so in the prompt block', () => {
  const world = makeWorld();
  world.write(PROJECT, 'old.jsonl', [user('long ago', WEEKS_AGO)]);
  const plan = world.collect();
  assert.deepEqual(plan.files, []);
  assert.equal(plan.misconfigured, false);
  assert.match(plan.promptBlock, /No transcript has a message inside the window/);
});

test('the prompt block renders in pt-BR with no placeholder left', () => {
  const world = makeWorld({ lang: 'pt-BR', include: [PROJECT, '-home-ana-gone'], cap: 1 });
  world.write(PROJECT, 'a.jsonl', [user('Ana pergunta', INSIDE)]);
  world.write(PROJECT, 'b.jsonl', [user('Ana pergunta de novo', '2026-09-23T15:00:00.000Z')]);
  world.write(PROJECT, 'bad.jsonl', ['lixo']);
  const plan = world.collect();
  assert.doesNotMatch(plan.promptBlock, /\{[A-Za-z_]\w*\}/);
  assert.match(plan.promptBlock, /teto de 1/);
  assert.match(plan.promptBlock, /-home-ana-gone/);
});

function record(reads) {
  const toolUses = [];
  const toolResults = [];
  reads.forEach(({ path, isError = false, name = 'Read' }, index) => {
    const id = `toolu_${index}`;
    toolUses.push({ id, name, input: { file_path: path } });
    toolResults.push({ toolUseId: id, isError });
  });
  return { toolUses, toolResults };
}

test('readEvidence counts a kept file as read only by a successful Read of exactly its path', () => {
  const world = makeWorld();
  const a = world.write(PROJECT, 'a.jsonl', [user('Ana asks', INSIDE)]);
  const b = world.write(PROJECT, 'b.jsonl', [user('Ana asks again', INSIDE)]);
  const plan = world.collect();
  assert.deepEqual(transcriptsSource.readEvidence(record([]), plan), { read: 0, expected: 2, ok: false });
  assert.deepEqual(transcriptsSource.readEvidence(record([{ path: a, isError: true }]), plan), { read: 0, expected: 2, ok: false });
  assert.deepEqual(transcriptsSource.readEvidence(record([{ path: `${a}.bak` }]), plan), { read: 0, expected: 2, ok: false });
  assert.deepEqual(transcriptsSource.readEvidence(record([{ path: a, name: 'Grep' }]), plan), { read: 0, expected: 2, ok: false });
  assert.deepEqual(transcriptsSource.readEvidence(record([{ path: a }, { path: a }]), plan), { read: 1, expected: 2, ok: true });
  assert.deepEqual(transcriptsSource.readEvidence(record([{ path: a }, { path: b }]), plan), { read: 2, expected: 2, ok: true });
});

test('readEvidence is ok with nothing read when the plan kept no file', () => {
  const world = makeWorld();
  const plan = world.collect();
  assert.deepEqual(transcriptsSource.readEvidence(record([]), plan), { read: 0, expected: 0, ok: true });
});

test('the default root is ~/.claude/projects, and a ~/ root is expanded', () => {
  const world = makeWorld();
  const home = world.tmp;
  const file = world.write(PROJECT, 'a.jsonl', [user('Ana asks', INSIDE)]);
  const plan = transcriptsSource.collect({
    window: { from: FROM, to: TO }, config: world.config, machine: { transcripts_dir: '~/projects' }, now: NOW, home,
  });
  assert.deepEqual(paths(plan), [file]);
  const fallback = transcriptsSource.collect({ window: { from: FROM, to: TO }, config: world.config, machine: {}, now: NOW, home });
  assert.equal(fallback.root, join(home, '.claude', 'projects'));
  assert.deepEqual(fallback.problems.map((p) => p.code), ['root_missing']);
});
