// What a vault the real `init` makes says about privacy (02/10/2026): its
// configuration carries privacy.sensitive at save for all three audiences, no
// topic set aside and no keyword for lint to refuse, and its checks stay the
// one clean line init prints for a clean vault: with no keyword listed, lint's
// keyword clause is not in play, so a whole-vault run adds no line about it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { CLEAN_ENV } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

const ANSWERS = {
  en: { lang: 'en', name: 'Ana', handle: 'ana', title: "Ana's brain", repo: null, private: true, timezone: 'UTC', email: null },
  'pt-BR': { lang: 'pt-BR', name: 'Ana', handle: 'ana', title: 'O cérebro da Ana', repo: null, private: true, timezone: 'UTC', email: null },
};

function init(lang) {
  const base = makeTempDir('brain-kit-privacy-init-');
  const vault = join(base, 'vault');
  const home = join(base, 'home');
  mkdirSync(home);
  const env = { ...CLEAN_ENV, BRAIN_KIT_LANG: lang, BRAIN_KIT_STATE_DIR: join(base, 'state'), HOME: home, TZ: 'UTC' };
  const answers = join(base, 'answers.json');
  writeFileSync(answers, JSON.stringify(ANSWERS[lang]));
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--from-answers', answers], { cwd: base, encoding: 'utf8', env });
  const kit = (argv) => spawnSync(process.execPath, [BIN, ...argv], { cwd: vault, encoding: 'utf8', env });
  return { r, vault, kit };
}

for (const lang of ['pt-BR', 'en']) {
  const t = createTranslator(lang);

  test(`${lang}: init writes the privacy keys with the default, and lists no keyword`, () => {
    const { r, vault } = init(lang);
    assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
    const { privacy } = JSON.parse(readFileSync(join(vault, 'brain-kit.config.json'), 'utf8'));
    assert.deepEqual(privacy.sensitive, { owner: 'save', people: 'save', outsiders: 'save' });
    assert.deepEqual(privacy.never_topics, []);
    assert.deepEqual(privacy.third_party_keywords, []);
  });

  test(`${lang}: with no keyword listed, init still prints its one clean line, and lint over the whole vault adds no line about keywords`, () => {
    const { r, kit } = init(lang);
    assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
    assert.equal(r.stdout.split(`${t('init.checks_clean')}\n`).length - 1, 1, r.stdout);
    assert.equal(r.stdout.includes(t('lint.privacy_keywords_not_checked')), false);
    const text = kit(['lint', '--base', 'all']);
    assert.equal(text.status, EXIT.OK, text.stdout + text.stderr);
    assert.equal(text.stdout.includes(t('lint.privacy_keywords_not_checked')), false, text.stdout);
    assert.ok(text.stdout.trimEnd().endsWith(t('lint.verdict_clean')), text.stdout);
    const json = JSON.parse(kit(['lint', '--base', 'all', '--json']).stdout);
    assert.equal(json.privacyKeywords, null, 'the keyword clause is not in play');
    assert.equal(json.counts.skipped, 0, 'and no rule is skipped');
  });
}
