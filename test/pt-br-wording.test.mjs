// Three Portuguese sentences the second stranger (a Brazilian who is not a
// developer, 01/10/2026) found wrong, kept from coming back:
//
// - the dry run said "Proporia memoria/log.md como ..., enviados para ...":
//   a participle in the plural for one file (and a participle that has to
//   agree with a list whose length the sentence cannot know);
// - the first line a session starts with said "Retrato da sessão tirado:",
//   which reads as "Session snapshot taken:" word for word;
// - the Stop hook said "0 caminho(s) que já estavam lá antes desta sessão
//   ficaram de fora: não cabe a esta sessão propô-los", a sentence that
//   reads as if it were cut short, and a clause ("não cabe a ela propô-los")
//   that no one says.
//
// The English pack read fine and is left as it is. Placeholders are the same
// as they were (test/lang.test.mjs and test/message-keys.test.mjs hold that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator, loadMessages } from '../src/lang.mjs';
import { makeProposeWorld, note } from './helpers/propose-world.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const pt = createTranslator('pt-BR');

test('the dry run names what it would propose without a participle that has to agree with the files', () => {
  const params = { remote: 'origin', program: 'gh', host: 'github.com', title: 'curadoria: Primeira captura', urls: ['git@example.com:ana/vault.git'], branch: 'curador/2026-10-01-16-04-42', base: 'main', origin: 'master' };
  for (const files of [['memoria/log.md'], ['memoria/log.md', 'pessoas/ana.md', 'projetos/kit.md']]) {
    const text = pt('propose.dry_run', { ...params, files });
    assert.doesNotMatch(text.slice(text.indexOf('Proporia')), /\benviados?\b/, `what it would propose carries no participle to get wrong: ${text}`);
    assert.match(text, /Proporia (memoria\/log\.md|memoria\/log\.md, pessoas\/ana\.md, projetos\/kit\.md) como "curadoria: Primeira captura": enviaria o branch curador\/2026-10-01-16-04-42 para git@example\.com:ana\/vault\.git e abriria um pull request contra main\./);
    assert.match(text, /O HEAD continua em master\.$/);
  }
});

test('the real dry run, in Portuguese, for one file', () => {
  const world = makeProposeWorld();
  world.write('notes/a.md', note('A'));
  const run = spawnSync(process.execPath, [BIN, 'propose', 'Primeira captura', '--only', 'notes/a.md', '--dry'], {
    cwd: world.vault, encoding: 'utf8', env: { ...world.env, BRAIN_KIT_LANG: 'pt-BR' },
  });
  assert.equal(run.status, EXIT.OK, run.stdout + run.stderr);
  assert.match(run.stdout, /Proporia notes\/a\.md como ".*": enviaria o branch .+ para .+ e abriria um pull request contra main\./);
  assert.doesNotMatch(run.stdout, /\benviados\b/);
});

test('the first line of a session says what is left out in plain words, not "Retrato da sessão tirado"', () => {
  const text = pt('hook.session_start.taken', { title: 'Caderno da Ana', count: 2 });
  assert.doesNotMatch(text, /Retrato da sessão tirado/i);
  assert.match(text, /^brain-kit: vault "Caderno da Ana"\. Ao começar esta sessão, 2 caminho\(s\) do vault já estavam alterados; esses ficam de fora, porque propô-los não é papel desta sessão\.$/);
});

test('the Stop hook says it in one sentence, for any count, with no colon that leaves it hanging', () => {
  for (const count of [0, 1, 7]) {
    const text = pt('hook.stop.block_inherited', { count });
    assert.equal(text, `${count} caminho(s) já estavam alterados antes desta sessão e ficaram de fora da lista, porque propô-los não é papel dela.`);
    assert.doesNotMatch(text, /:/);
  }
});

test('the clause nobody says, "não cabe a ela propô-los", is in no key of the Portuguese pack, and the calque is in none', () => {
  const offenders = [];
  for (const [key, value] of Object.entries(loadMessages('pt-BR'))) {
    if (/não cabe a (ela|esta sessão) propô-los/.test(value) || /Retrato da sessão tirado/.test(value)) offenders.push(key);
  }
  assert.deepEqual(offenders, []);
});

test('the sibling line for a snapshot kept across a compaction no longer says it either', () => {
  const text = pt('hook.session_start.kept', { title: 'Caderno da Ana', count: 3 });
  assert.equal(text, 'brain-kit: vault "Caderno da Ana". O retrato desta sessão foi mantido na compactação ou retomada: 3 caminho(s) já estavam alterados quando a sessão começou, e propô-los não é papel dela.');
});

test('the English pack, which read fine, is as it was', () => {
  const en = createTranslator('en');
  assert.equal(en('hook.session_start.taken', { title: 'Notes', count: 2 }), 'brain-kit: vault "Notes". Session snapshot taken: 2 path(s) were already there before this session and are not its to propose.');
  assert.equal(en('hook.stop.block_inherited', { count: 2 }), '2 path(s) that were already there before this session were left out: they are not this session\'s to propose.');
  assert.match(en('propose.dry_run', { remote: 'origin', program: 'gh', host: 'github.com', files: ['a.md'], title: 't', urls: ['u'], branch: 'b', base: 'main', origin: 'main' }), /Would propose a\.md as "t", pushed to u as b, in a pull request against main\./);
});
