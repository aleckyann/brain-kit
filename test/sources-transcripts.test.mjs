// The transcripts source (src/sources/transcripts-claude-code.mjs) and the
// source interface (src/sources/index.mjs), against a fake transcripts
// tree built in a temporary directory. The three incidents this source
// carries have their own files under test/incidents/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineValueErrors } from '../src/config.mjs';
import { validateSource } from '../src/sources/index.mjs';
import { transcriptsSource, DEFAULT_LIMITS, SAMPLE_BYTES } from '../src/sources/transcripts-claude-code.mjs';
import {
  FROM, TO, NOW, INSIDE, WEEKS_AGO, PROJECT, OTHER_PROJECT,
  assistant, customTitle, lastPrompt, makeWorld, mode, paths, system, toolResult, user, userBlocks,
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

// The line that holds byte `offset`: 1 + the newlines strictly before it,
// counted on the file's own bytes.
function lineHolding(file, offset) {
  const bytes = readFileSync(file);
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (bytes[i] === 0x0a) line += 1;
  return line;
}

function lineCount(file) {
  const bytes = readFileSync(file);
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return bytes.length && bytes[bytes.length - 1] !== 0x0a ? count + 1 : count;
}

test('sampleFrom is where the last 64 KB begin, 0 for a smaller file, and sampleLine is the line that holds that byte', () => {
  const world = makeWorld();
  world.write(PROJECT, 'small.jsonl', [user('Ana asks', INSIDE)]);
  const filler = 'x'.repeat(1000);
  const lines = [user('Ana starts', INSIDE)];
  for (let i = 0; i < 200; i += 1) lines.push(assistant(`${filler} ${i}`, INSIDE));
  const bigPath = world.write(PROJECT, 'big.jsonl', lines);
  const plan = world.collect();
  const small = plan.files.find((f) => f.path.endsWith('small.jsonl'));
  const big = plan.files.find((f) => f.path.endsWith('big.jsonl'));
  assert.equal(SAMPLE_BYTES, 64 * 1024);
  assert.equal(small.sampleFrom, 0);
  assert.equal(small.sampleLine, 1);
  assert.ok(big.bytes > SAMPLE_BYTES);
  assert.equal(big.sampleFrom, big.bytes - SAMPLE_BYTES);
  assert.equal(big.sampleLine, lineHolding(bigPath, big.sampleFrom));
  // The byte is inside a line, not at its start, in this fixture: the
  // line that holds it is the one before the first line starting after it.
  const starts = [0];
  for (const l of lines) starts.push(starts[starts.length - 1] + Buffer.byteLength(`${JSON.stringify(l)}\n`));
  assert.ok(starts[big.sampleLine - 1] <= big.sampleFrom && big.sampleFrom < starts[big.sampleLine]);
});

test('a last line longer than 64 KB: sampleLine is that last line, never past the end of the file', () => {
  const world = makeWorld();
  const file = world.write(PROJECT, 'tail.jsonl', [
    user('Ana asks for the report', INSIDE),
    assistant('reading', INSIDE),
    userBlocks([{ type: 'tool_result', tool_use_id: 'toolu_fake_2', content: 'y'.repeat(100 * 1024) }], INSIDE),
  ]);
  const [kept] = world.collect().files;
  assert.ok(kept.sampleFrom > 0);
  assert.equal(lineCount(file), 3);
  assert.equal(kept.sampleLine, 3);
});

// An assistant line whose JSON text, newline included, is exactly `total` bytes.
function lineOfBytes(total, timestamp) {
  const probe = JSON.stringify(assistant('', timestamp));
  const text = 'p'.repeat(total - 1 - Buffer.byteLength(probe));
  const line = JSON.stringify({ ...JSON.parse(probe), message: { role: 'assistant', content: [{ type: 'text', text }] } });
  assert.equal(Buffer.byteLength(line) + 1, total);
  return line;
}

test('sampleLine at the exact edges: sampleFrom on the first byte of a line, and on the newline that ends the line before', () => {
  const world = makeWorld();
  const head = user('Ana asks', INSIDE);
  const atStart = world.write(PROJECT, 'at-start.jsonl', [head, lineOfBytes(SAMPLE_BYTES, INSIDE)]);
  const onNewline = world.write(PROJECT, 'on-newline.jsonl', [head, lineOfBytes(SAMPLE_BYTES - 1, INSIDE)]);
  const plan = world.collect();
  const start = plan.files.find((f) => f.path === atStart);
  const newline = plan.files.find((f) => f.path === onNewline);
  const headBytes = Buffer.byteLength(`${JSON.stringify(head)}\n`);
  assert.equal(start.sampleFrom, headBytes);
  assert.equal(start.sampleLine, 2);
  assert.equal(newline.sampleFrom, headBytes - 1);
  assert.equal(newline.sampleLine, 1);
});

test('a file that is one line longer than 64 KB has sampleLine 1, with or without a final newline', () => {
  const world = makeWorld();
  const one = world.write(PROJECT, 'one.jsonl', [user(`Ana pastes ${'z'.repeat(80 * 1024)}`, INSIDE)]);
  const bare = join(world.root, PROJECT, 'bare.jsonl');
  writeFileSync(bare, JSON.stringify(user(`Ana pastes ${'z'.repeat(80 * 1024)}`, INSIDE)));
  const plan = world.collect();
  for (const path of [one, bare]) {
    const file = plan.files.find((f) => f.path === path);
    assert.ok(file, path);
    assert.ok(file.sampleFrom > 0);
    assert.equal(file.sampleLine, 1);
  }
});

test('a scan in tiny chunks gives the same plan as the default, across multi-byte characters and a split signature', () => {
  const world = makeWorld({ extraSignatures: ['Revisão ação'] });
  world.write(PROJECT, 'round.jsonl', [user('Second brain curator: janela de avaliação', INSIDE), assistant('lendo', INSIDE)]);
  world.write(PROJECT, 'accented-round.jsonl', [user('Revisão ação da manhã', INSIDE)]);
  const filler = 'ç'.repeat(700);
  const lines = [user('Ana começa a sessão', '2026-09-23T09:00:00.000Z')];
  for (let i = 0; i < 120; i += 1) lines.push(assistant(`${filler} ${i}`, `2026-09-23T10:${String(i % 60).padStart(2, '0')}:00.000Z`));
  lines.push(user('Ana termina', '2026-09-23T20:00:00.000Z'));
  world.write(PROJECT, 'accents.jsonl', lines);
  const expected = world.collect();
  for (const chunkBytes of [1, 7, 4093]) {
    const plan = transcriptsSource.collect({
      window: { from: FROM, to: TO }, config: world.config, machine: world.machine, now: NOW,
      limits: { chunkBytes, maxLineChars: DEFAULT_LIMITS.maxLineChars },
    });
    assert.deepEqual(plan.files, expected.files, `chunkBytes ${chunkBytes}`);
    assert.deepEqual(plan.dropped, expected.dropped, `chunkBytes ${chunkBytes}`);
  }
  assert.equal(expected.dropped.selfTrace, 2);
  assert.equal(expected.files[0].firstAt, '2026-09-23T09:00:00.000Z');
  assert.equal(expected.files[0].lastAt, '2026-09-23T20:00:00.000Z');
});

test('a line longer than maxLineChars is skipped like a malformed one, and the next line is still read', () => {
  const world = makeWorld();
  world.write(PROJECT, 'a.jsonl', [
    user('Ana asks', '2026-09-23T09:00:00.000Z'),
    assistant('w'.repeat(5000), '2026-09-23T21:00:00.000Z'),
    assistant('short', '2026-09-23T12:00:00.000Z'),
  ]);
  const plan = transcriptsSource.collect({
    window: { from: FROM, to: TO }, config: world.config, machine: world.machine, now: NOW,
    limits: { chunkBytes: 64, maxLineChars: 1000 },
  });
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].firstAt, '2026-09-23T09:00:00.000Z');
  assert.equal(plan.files[0].lastAt, '2026-09-23T12:00:00.000Z');
});

test('the rest of an overlong line is never read as a line of its own, even when it is valid JSON', () => {
  const world = makeWorld();
  // 1024 bytes of padding are 16 chunks of 64: the carry passes 1000
  // characters exactly where the JSON begins, so only the skip flag keeps
  // that JSON (a message at 21:00) out.
  const tail = JSON.stringify(assistant('hidden', '2026-09-23T21:00:00.000Z'));
  world.write(PROJECT, 'a.jsonl', [
    `${'w'.repeat(1024)}${tail}`,
    user('Ana asks', '2026-09-23T09:00:00.000Z'),
    assistant('short', '2026-09-23T12:00:00.000Z'),
  ]);
  const plan = transcriptsSource.collect({
    window: { from: FROM, to: TO }, config: world.config, machine: world.machine, now: NOW,
    limits: { chunkBytes: 64, maxLineChars: 1000 },
  });
  assert.equal(plan.files[0].lastAt, '2026-09-23T12:00:00.000Z');
});

test('a read error while scanning lists the file as unreadable and never throws out of collect', () => {
  const world = makeWorld();
  const broken = world.write(PROJECT, 'broken.jsonl', [user('Ana asks', INSIDE)]);
  const fine = world.write(PROJECT, 'fine.jsonl', [user('Ana asks again', INSIDE)]);
  const opened = new Map();
  const io = {
    openSync: (path, flags) => {
      const fd = openSync(path, flags);
      opened.set(fd, path);
      return fd;
    },
    closeSync,
    readSync: (fd, ...rest) => {
      if (opened.get(fd) === broken) {
        const error = new Error('Cannot create a string longer than 0x1fffffe8 characters');
        error.code = 'ERR_STRING_TOO_LONG';
        throw error;
      }
      return readSync(fd, ...rest);
    },
  };
  let plan;
  assert.doesNotThrow(() => {
    plan = transcriptsSource.collect({ window: { from: FROM, to: TO }, config: world.config, machine: world.machine, now: NOW, io });
  });
  assert.deepEqual(paths(plan), [fine]);
  assert.deepEqual(plan.unreadable.map((u) => u.path), [broken]);
  assert.equal(plan.dropped.unreadable, 1);
  assert.ok(plan.promptBlock.includes(broken));
});

test('an unlistable project or transcripts directory is a problem, never an exception', { skip: process.getuid?.() === 0 ? 'root lists any directory' : false }, () => {
  const world = makeWorld({ include: [PROJECT, OTHER_PROJECT] });
  const kept = world.write(PROJECT, 'a.jsonl', [user('Ana asks', INSIDE)]);
  world.write(OTHER_PROJECT, 'b.jsonl', [user('Ana codes', INSIDE)]);
  const locked = join(world.root, OTHER_PROJECT);
  chmodSync(locked, 0o000);
  try {
    const plan = world.collect();
    assert.deepEqual(paths(plan), [kept]);
    assert.deepEqual(plan.problems, [{ code: 'project_unreadable', detail: OTHER_PROJECT }]);
    assert.equal(plan.misconfigured, false);
    assert.match(plan.promptBlock, /could not be listed/);
  } finally {
    chmodSync(locked, 0o755);
  }
  chmodSync(world.root, 0o300);
  try {
    const plan = world.collect();
    assert.deepEqual(plan.problems.map((p) => p.code), ['root_unreadable']);
    assert.equal(plan.misconfigured, true);
    assert.ok(plan.promptBlock.includes(world.root));
  } finally {
    chmodSync(world.root, 0o755);
  }
});

test('a relative transcripts_dir is refused by the machine check; absolute and ~/ pass', () => {
  assert.deepEqual(machineValueErrors({ transcripts_dir: 'projects' }), ['$.transcripts_dir: must be an absolute directory or start with ~/']);
  assert.deepEqual(machineValueErrors({ transcripts_dir: './projects' }).length, 1);
  assert.deepEqual(machineValueErrors({ transcripts_dir: '/home/ana/.claude/projects' }), []);
  assert.deepEqual(machineValueErrors({ transcripts_dir: '~/.claude/projects' }), []);
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
  assert.match(plan.promptBlock, /Every time here is UTC/);
  assert.doesNotMatch(plan.promptBlock, /not opened/);
});

test('each kept file carries its session, the first 8 characters of its file name, at the start of its prompt line', () => {
  const world = makeWorld({ lang: 'pt-BR' });
  const uuid = world.write(PROJECT, '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b.jsonl', [user('Ana asks', INSIDE)]);
  const short = world.write(PROJECT, 'abc.jsonl', [user('Ana asks again', '2026-09-23T15:00:00.000Z')]);
  const plan = world.collect();
  const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f]));
  assert.equal(byPath[uuid].session, '3f2a9c1e');
  assert.equal(byPath[short].session, 'abc');
  const lines = plan.promptBlock.split('\n');
  assert.ok(lines.some((l) => l.startsWith(`session 3f2a9c1e: ${uuid} `)), plan.promptBlock);
  assert.ok(lines.some((l) => l.startsWith(`session abc: ${short} `)), plan.promptBlock);
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
