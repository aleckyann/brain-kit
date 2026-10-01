// An unknown command (the second stranger's F13 and the first one's m16).
//
// `brain-kit doctr` printed "unknown command" and then twenty-five to thirty
// lines of usage, with no word about the command next to it. It now prints
// the sentence, a suggestion when a known command is close, and one line that
// points to `brain-kit --help`: exit code 2 as before. A person who runs
// `brain-kit` with no command, or with --help, still gets the full usage.
//
// The suggestion is computed against the command table the CLI really runs
// (src/cli.mjs), never against a list copied beside it, and it only ever
// prints a name: nothing it suggests is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { BUILTIN_COMMANDS, UNLISTED_COMMANDS, main } from '../src/cli.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { allowedEdits, closestNames, editDistance } from '../src/suggest.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const PUBLIC = [...BUILTIN_COMMANDS.keys()].filter((name) => !UNLISTED_COMMANDS.has(name));

function kit(argv, lang = 'en') {
  const base = makeTempDir('brain-kit-dym-');
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: base, encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: lang, HOME: base, BRAIN_KIT_STATE_DIR: join(base, 'state') },
  });
}

const linesOf = (text) => text.split('\n').filter((line) => line !== '');

// --- the sentence, the suggestion, the pointer -------------------------------------

for (const lang of ['en', 'pt-BR']) {
  const t = createTranslator(lang);

  test(`${lang}: a typo of a command prints the unknown-command sentence, the suggestion and the pointer, and no usage; exit 2`, () => {
    const r = kit(['doctr'], lang);
    assert.equal(r.status, EXIT.USAGE);
    assert.equal(r.stdout, '');
    assert.deepEqual(linesOf(r.stderr), [
      t('cli.unknown_command', { command: 'doctr' }),
      t('cli.did_you_mean', { suggestions: ['doctor'] }),
      t('cli.see_help'),
    ]);
    assert.match(r.stderr, /doctor/);
    assert.match(r.stderr, /brain-kit --help/);
    assert.doesNotMatch(r.stderr, /\{[a-z_]+\}/);
    assert.ok(linesOf(r.stderr).length <= 3, 'three lines, not the whole usage');
  });

  test(`${lang}: a word that is far from every command gets the sentence and the pointer, and no suggestion`, () => {
    for (const word of ['xyzzy', 'frobnicate', 'banana', 'deploy']) {
      const r = kit([word], lang);
      assert.equal(r.status, EXIT.USAGE, word);
      assert.deepEqual(linesOf(r.stderr), [t('cli.unknown_command', { command: word }), t('cli.see_help')], word);
    }
  });

  test(`${lang}: with no command, --help, -h and help the full usage is printed on stdout, exit 0`, () => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const r = kit(argv, lang);
      assert.equal(r.status, EXIT.OK, argv.join(' '));
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, `${t('cli.usage', { version: kitVersion() })}\n`, argv.join(' '));
      assert.ok(linesOf(r.stdout).length > 20, 'the full usage');
    }
  });
}

test('the usual typos of the usual commands are met with the right name', () => {
  for (const [typed, expected] of [['doctr', 'doctor'], ['propse', 'propose'], ['sinc', 'sync'], ['valdate', 'validate'], ['lnt', 'lint'], ['verfy', 'verify'], ['machin', 'machine']]) {
    const r = kit([typed]);
    assert.equal(r.status, EXIT.USAGE, typed);
    assert.ok(r.stderr.includes(createTranslator('en')('cli.did_you_mean', { suggestions: [expected] })), `${typed}: ${r.stderr}`);
  }
});

test('a prefix of exactly one command is enough, however far it is by edit distance; a prefix of two is not', () => {
  const t = createTranslator('en');
  for (const [typed, expected] of [['quest', 'questions'], ['water', 'watermark'], ['sched', 'schedule'], ['pre', 'preflight']]) {
    const r = kit([typed]);
    assert.ok(r.stderr.includes(t('cli.did_you_mean', { suggestions: [expected] })), `${typed}: ${r.stderr}`);
  }
  // "pro" begins propose and prompt, and is far from both.
  const ambiguous = kit(['pro']);
  assert.doesNotMatch(ambiguous.stderr, /Did you mean/);
  assert.deepEqual(linesOf(ambiguous.stderr), [t('cli.unknown_command', { command: 'pro' }), t('cli.see_help')]);
});

test('a command the CLI runs but its usage does not list is never suggested', () => {
  const t = createTranslator('en');
  for (const typed of ['push', 'scan', 'push-gat', 'scan-blob']) {
    const r = kit([typed]);
    assert.equal(r.status, EXIT.USAGE, typed);
    assert.doesNotMatch(r.stderr, /push-gate|scan-blobs/, typed);
    assert.deepEqual(linesOf(r.stderr), [t('cli.unknown_command', { command: typed }), t('cli.see_help')], typed);
  }
});

test('the unlisted commands are exactly the ones the usage leaves out, and every other command of the table is in it, in both languages', () => {
  for (const lang of ['en', 'pt-BR']) {
    const usage = createTranslator(lang)('cli.usage', { version: '0.0.0' });
    for (const name of BUILTIN_COMMANDS.keys()) {
      const listed = new RegExp(`^  ${name} `, 'm').test(usage);
      assert.equal(listed, !UNLISTED_COMMANDS.has(name), `${lang}: ${name} ${listed ? 'is' : 'is not'} in the usage`);
    }
  }
});

test('any single-letter slip of any listed command names that command among the suggestions', () => {
  // Deletion of one letter, a substituted letter, an inserted letter: the
  // command must be among the names suggested (a slip can sit as close to
  // another command: "int" is a letter from both init and lint).
  const slips = [];
  for (const name of PUBLIC) {
    if (name.length < 4) continue;
    slips.push([name.slice(0, 2) + name.slice(3), name]);
    slips.push([`${name.slice(0, 1)}x${name.slice(2)}`, name]);
    slips.push([`${name.slice(0, 3)}q${name.slice(3)}`, name]);
  }
  assert.ok(slips.length >= 3 * (PUBLIC.length - 2), 'the table is walked');
  for (const [typed, name] of slips) {
    assert.ok(closestNames(typed, PUBLIC).includes(name), `${typed} -> ${name}`);
  }
});

// --- computed against the table that runs, and nothing is run -------------------------

// main() reads the language from the process environment: pin it for the
// in-process runs below, and give the previous value back.
async function inEnglish(run) {
  const before = process.env.BRAIN_KIT_LANG;
  process.env.BRAIN_KIT_LANG = 'en';
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.BRAIN_KIT_LANG;
    else process.env.BRAIN_KIT_LANG = before;
  }
}

function fakeIo() {
  let stdout = '';
  let stderr = '';
  return { io: { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } }, stdout: () => stdout, stderr: () => stderr };
}

test('the candidates are the keys of the table main() is given, and the suggested command is not run', () => inEnglish(async () => {
  const ran = [];
  const commands = new Map([
    ['frobnicate', async () => { ran.push('frobnicate'); return EXIT.OK; }],
    ['doctor', async () => { ran.push('doctor'); return EXIT.OK; }],
    ['scan-blobs', async () => { ran.push('scan-blobs'); return EXIT.OK; }],
  ]);
  const f = fakeIo();
  const code = await main(['frobnicat'], f.io, { commands });
  assert.equal(code, EXIT.USAGE);
  assert.equal(f.stdout(), '');
  assert.equal(linesOf(f.stderr())[1], createTranslator('en')('cli.did_you_mean', { suggestions: ['frobnicate'] }));
  assert.deepEqual(ran, [], 'a suggestion is a sentence, never a command');
  const g = fakeIo();
  assert.equal(await main(['doctr'], g.io, { commands }), EXIT.USAGE);
  assert.match(g.stderr(), /doctor/, 'a name the real table does not hold would not be here');
  const h = fakeIo();
  assert.equal(await main(['scan-blob'], h.io, { commands }), EXIT.USAGE);
  assert.doesNotMatch(h.stderr(), /Did you mean/, 'an unlisted command stays out of the suggestions');
  assert.deepEqual(ran, []);
}));

test('a command that exists still runs, and -C still reaches the unknown-command path', () => inEnglish(async () => {
  const ran = [];
  const commands = new Map([['doctor', async () => { ran.push('doctor'); return EXIT.OK; }]]);
  assert.equal(await main(['doctor'], fakeIo().io, { commands }), EXIT.OK);
  assert.deepEqual(ran, ['doctor']);
  const base = makeTempDir('brain-kit-dym-c-');
  const f = fakeIo();
  assert.equal(await main(['-C', base, 'doctr'], f.io, { commands }), EXIT.USAGE);
  assert.match(f.stderr(), /Did you mean: doctor\?/);
  assert.deepEqual(ran, ['doctor']);
}));

// --- the algorithm -----------------------------------------------------------------

test('editDistance counts insertions, deletions and substitutions', () => {
  assert.equal(editDistance('doctor', 'doctor'), 0);
  assert.equal(editDistance('doctr', 'doctor'), 1);
  assert.equal(editDistance('sinc', 'sync'), 1);
  assert.equal(editDistance('lint', 'init'), 2);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('allowedEdits: none for one or two letters, one for three, two from four on', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 12].map(allowedEdits), [0, 0, 1, 2, 2, 2]);
});

test('closestNames: near by two edits or less, a unique prefix, ties kept, case ignored, nothing for empty input', () => {
  const names = ['init', 'lint', 'sync', 'schedule', 'propose', 'prompt', 'doctor'];
  assert.deepEqual(closestNames('doctr', names), ['doctor']);
  assert.deepEqual(closestNames('DOCTOR', names), ['doctor'], 'case is not a difference');
  assert.deepEqual(closestNames('syn', names), ['sync'], 'a unique prefix');
  assert.deepEqual(closestNames('s', names), [], 'a prefix of two is no suggestion, and s is three edits from sync');
  assert.deepEqual(closestNames('int', names), ['init', 'lint'], 'a tie at one edit keeps both, in table order');
  assert.deepEqual(closestNames('lnit', names), ['init'], 'the nearest only: init is one edit, lint two');
  assert.deepEqual(closestNames('lnt', names), ['lint'], 'a word of three letters may be one edit away');
  assert.deepEqual(closestNames('sin', names), [], 'and not two: sin is two edits from sync');
  assert.deepEqual(closestNames('ni', ['init']), [], 'two letters are judged by their beginning alone');
  assert.deepEqual(closestNames('oo', ['hook']), [], 'oo is not a slip of hook');
  assert.deepEqual(closestNames('in', names), ['init'], 'a beginning is enough');
  assert.deepEqual(closestNames('xyzzy', names), []);
  assert.deepEqual(closestNames('abcdef', names), [], 'three edits is too far');
  assert.deepEqual(closestNames('', names), []);
  assert.deepEqual(closestNames('doctor', []), []);
});
