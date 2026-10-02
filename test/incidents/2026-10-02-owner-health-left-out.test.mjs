// docs/incidents.md, 02/10/2026: the curator left the owner's own health out
// of the log, on purpose. Curating a one to one meeting, a round on the kit
// left the owner's own health and family topics out, and wrote that it had
// done so on purpose. The curate prompt's rule `third-party-privacy` forbade
// the private life of "someone other than the owner", and the model stretched
// it to the owner: the prompt said nothing of the owner's own, and the silence
// left the judgment to the model. The rule: what the curator records is a
// setting of the kit, and the default records everything, said in so many
// words. Where it lives: privacy.sensitive and privacy.never_topics, rendered
// into the rule by src/privacy-policy.mjs, and doctor's privacy-policy for a
// vault whose own prompt kept the old fixed sentence.
//
// Replayed through the real binary on a vault the real init made, in each
// language: what the round's prompt says about the owner's own health, and
// what doctor says about a vault that still holds the old rule. The old text
// is the suite's synthetic copy (test/helpers/privacy-old-rule.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { CLEAN_ENV } from '../helpers/git-repo.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';
import { OLD_WORDS, oldTemplate } from '../helpers/privacy-old-rule.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

// What the rule must say, in the paragraph its marker opens: the owner's own
// health and family are recorded, like anyone else's, with nothing shortened.
const SAYS = {
  en: [/about the owner and about others/, /including health, family, relationships, finances and anything intimate/, /without omitting or shortening anything because a subject seems sensitive/, /never apply a stricter or a looser rule of your own/],
  'pt-BR': [/sobre o dono e sobre os outros/, /inclusive saúde, família, relacionamentos, finanças e qualquer coisa íntima/, /sem omitir nem encurtar nada porque o assunto parece sensível/, /nunca aplique uma regra sua, nem mais rígida nem mais branda/],
};

function vault(lang) {
  const base = makeTempDir('brain-kit-incident-owner-health-');
  const root = join(base, 'vault');
  const env = { ...CLEAN_ENV, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: join(base, 'state'), HOME: join(base, 'home'), USER: 'ana', LOGNAME: 'ana', TZ: 'UTC' };
  mkdirSync(env.HOME);
  const made = spawnSync(process.execPath, [BIN, 'init', root, '--yes', '--lang', lang], { cwd: base, encoding: 'utf8', env });
  assert.equal(made.status, EXIT.OK, made.stdout + made.stderr);
  return { root, kit: (argv) => spawnSync(process.execPath, [BIN, ...argv], { cwd: root, encoding: 'utf8', env }) };
}

function privacyParagraph(text) {
  const at = text.indexOf('<!-- rule:third-party-privacy -->');
  assert.notEqual(at, -1);
  return text.slice(at, text.indexOf('\n\n', at));
}

for (const lang of ['pt-BR', 'en']) {
  test(`${lang}: the round's prompt tells the model to record the owner's own health and family normally, and no longer carries the rule it stretched`, () => {
    const { kit } = vault(lang);
    const r = kit(['prompt', 'curate']);
    assert.equal(r.status, EXIT.OK, r.stderr);
    const paragraph = privacyParagraph(r.stdout);
    for (const pattern of SAYS[lang]) assert.match(paragraph, pattern, `${lang}: ${pattern}`);
    assert.doesNotMatch(r.stdout, OLD_WORDS[lang]);
  });

  test(`${lang}: a vault whose own prompt still holds the old rule is told so by doctor, with the file and the fix`, () => {
    const { root, kit } = vault(lang);
    mkdirSync(join(root, '.brain-kit', 'prompts'), { recursive: true });
    writeFileSync(join(root, '.brain-kit', 'prompts', 'curate.md'), oldTemplate(lang));
    const r = kit(['doctor', '--only', 'privacy-policy', '--json']);
    const [line] = JSON.parse(r.stdout).checks;
    assert.equal(line.status, 'warn');
    assert.equal(line.messageKey, 'doctor.privacy_policy.overlay_fixed');
    assert.ok(line.message.includes(join(root, '.brain-kit', 'prompts', 'curate.md')), line.message);
  });
}
