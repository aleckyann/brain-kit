// What a command that postponed on a dirty tree tells the person to do: the
// same two honest paths in `sync`, `curate` and `verify` (the second
// stranger's F4, and S4 of the review of G2b).
//
// `sync.dirty` was fixed first: it used to say "Commit, move or remove them",
// the opposite of the README (the file a session changed stays uncommitted
// until its pull request is merged; committed on the default branch it makes
// `sync` report "diverged" later). `curate` calls sync first and prints its
// own `curate.dirty` right under sync's ("Commit, propose or discard them"),
// and that sentence is what goes into the notification and `last-run.json`;
// `verify.dirty` said "Commit, move or remove them" too. All three now say:
// if the changes should become a pull request, propose them with
// `brain-kit propose "<summary>" --only <paths>` and do not commit them on
// the default branch; if they are yours to keep, commit them on another
// branch or stash them with `git stash -u` (the -u is what saves a NEW file;
// plain `git stash` leaves it where it is and the command postpones again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator } from '../src/lang.mjs';

const KEYS = ['sync.dirty', 'curate.dirty', 'verify.dirty'];

const EXPECTED = {
  en: {
    propose: /brain-kit propose "<summary>" --only <paths>/,
    warn: /do not commit them on the default branch: sync would later report the branches as diverged/,
    keep: /commit them on another branch or stash them \(git stash -u\)/,
    old: /Commit, propose or discard|Commit, move or remove/,
    // The only places the word may stand: the description of the tree, the
    // warning, the branch that is not the default one, and verify's own commit.
    allowed: [/are not committed/g, /do not commit them on the default branch/g, /commit them on another branch/g, /its commit must hold/g],
  },
  'pt-BR': {
    propose: /brain-kit propose "<resumo>" --only <caminhos>/,
    warn: /não faça commit delas no branch padrão, porque depois o sync recusaria, dizendo que os branches divergiram/,
    keep: /faça commit delas em outro branch ou guarde-as com git stash -u/,
    old: /Faça commit, proponha|Faça commit, mova|Commite, mova/,
    allowed: [/mudanças sem commit/g, /mudanças não commitadas/g, /não faça commit delas no branch padrão/g, /faça commit delas em outro branch/g, /o commit dele deve conter/g],
  },
};

for (const lang of ['en', 'pt-BR']) {
  const t = createTranslator(lang);
  const expected = EXPECTED[lang];

  for (const key of KEYS) {
    test(`${lang}: ${key} names the two honest paths, and the stash that really saves a new file`, () => {
      const text = t(key, { files: ['memoria/log.md'] });
      assert.match(text, expected.propose, 'propose them');
      assert.match(text, expected.warn, 'and not on the default branch, with the reason');
      assert.match(text, expected.keep, 'or keep them on another branch or in a stash -u');
      assert.doesNotMatch(text, expected.old);
      assert.doesNotMatch(text, /git stash(?! -u)/, 'never a stash that leaves a new file behind');
      assert.match(text, /memoria\/log\.md/, 'it still names the files');
      assert.doesNotMatch(text, /\{[a-z_]+\}/);
    });

    test(`${lang}: ${key} never tells anyone to commit on the default branch: every "commit" in it is the description, the warning, another branch or verify's own commit`, () => {
      let text = t(key, { files: ['memoria/log.md'] });
      for (const allowed of expected.allowed) text = text.replace(allowed, '');
      assert.doesNotMatch(text, /commit/i, text);
    });
  }

  test(`${lang}: curate.dirty still ends by saying the next round runs once the tree is clean, and starts as it did`, () => {
    const text = t('curate.dirty', { files: ['draft.md (2026-10-01T10:00:00.000Z)'] });
    assert.match(text, lang === 'en' ? /^brain-kit curate: postponed, the working tree has changes the round did not make: draft\.md \(2026-10-01T10:00:00\.000Z\)\. / : /^brain-kit curate: adiada, a árvore de trabalho tem mudanças que a rodada não fez: draft\.md \(2026-10-01T10:00:00\.000Z\)\. /);
    assert.match(text, lang === 'en' ? /and the next round runs\.$/ : /e a próxima rodada roda\.$/);
  });

  test(`${lang}: verify.dirty keeps what it was for (the commit holds the stamps and nothing else) and says to run verify again`, () => {
    const text = t('verify.dirty', { files: ['draft.md'] });
    assert.match(text, lang === 'en' ? /its commit must hold the stamps and nothing else/ : /o commit dele deve conter os carimbos e mais nada/);
    assert.match(text, lang === 'en' ? /Then run verify again\.$/ : /Depois rode o verify de novo\.$/);
  });
}
