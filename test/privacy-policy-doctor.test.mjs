// `brain-kit doctor`'s check privacy-policy (02/10/2026): what the curator
// records about personal and sensitive subjects, in one line, ok whatever the
// levels are; a value the setting cannot use fails, in the person's language,
// naming the allowed ones; and a vault's own curate prompt the setting never
// reaches (a copy of the template of before the setting, whose privacy rule
// is fixed text, or one with no privacy rule at all) warns, naming the file
// and the fix. The old text is this suite's synthetic copy
// (test/helpers/privacy-old-rule.mjs), never a real vault's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { runDoctor } from '../src/commands/doctor.mjs';
import { CHECK_IDS } from '../src/doctor/checks.mjs';
import { privacyLine } from '../src/privacy-policy.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { oldTemplate } from './helpers/privacy-old-rule.mjs';

const LANGS = ['pt-BR', 'en'];

function vaultWith(lang, privacy = {}, overlay = null) {
  const root = makeVault({ files: { 'index.md': '# Index\n' }, config: { lang, privacy } });
  if (overlay !== null) {
    mkdirSync(join(root, '.brain-kit', 'prompts'), { recursive: true });
    writeFileSync(join(root, '.brain-kit', 'prompts', 'curate.md'), overlay);
  }
  return root;
}

async function doctor(root, { json = true } = {}) {
  let out = '';
  let err = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } };
  const env = { ...process.env, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: makeTempDir('brain-kit-privacy-doctor-state-') };
  const code = await runDoctor([...(json ? ['--json'] : []), '--only', 'privacy-policy', root], io, createTranslator('en'), { env, cwd: root });
  return { code, out, err, report: json && out ? JSON.parse(out) : null };
}

function results(report) {
  return report.checks.filter((c) => c.id === 'privacy-policy');
}

test('privacy-policy is a check of the table, before privacy-keywords', () => {
  assert.ok(CHECK_IDS.includes('privacy-policy'));
  assert.equal(CHECK_IDS.indexOf('privacy-policy') + 1, CHECK_IDS.indexOf('privacy-keywords'));
});

for (const lang of LANGS) {
  const t = createTranslator(lang);

  test(`${lang}: ok names the policy in effect in one line, the default and any other, in the vault's language`, async () => {
    for (const privacy of [{}, { sensitive: { owner: 'save', people: 'summary', outsiders: 'skip' }, never_topics: ['health', 'legal cases'] }]) {
      const root = vaultWith(lang, privacy);
      const { code, report } = await doctor(root);
      assert.equal(code, EXIT.OK);
      const [c] = results(report);
      assert.equal(c.status, 'ok', JSON.stringify(c));
      assert.equal(c.messageKey, 'doctor.privacy_policy.ok');
      const config = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
      assert.equal(c.message, privacyLine(config, t), lang);
      assert.equal(c.message.includes('\n'), false);
    }
  });

  test(`${lang}: a level the kit does not know fails, saying in the vault's language which ones it takes`, async () => {
    const { code, report } = await doctor(vaultWith(lang, { sensitive: { people: 'always' } }));
    assert.equal(code, EXIT.FAILURE);
    const [c] = results(report);
    assert.equal(c.status, 'fail', JSON.stringify(c));
    assert.equal(c.messageKey, 'doctor.privacy_policy.bad_level');
    assert.match(c.message, lang === 'en'
      ? /^privacy\.sensitive\.people in brain-kit\.config\.json is "always", which is not a level: use one of save, summary, skip\./
      : /^privacy\.sensitive\.people em brain-kit\.config\.json é "always", que não é um nível: use um destes: save, summary, skip\./);
  });

  test(`${lang}: an audience the kit does not know, a setting that is not an object and a topic list that is not one fail too`, async () => {
    const cases = [
      [{ sensitive: { team: 'skip' } }, 'doctor.privacy_policy.bad_audience', /privacy\.sensitive\.team/],
      [{ sensitive: 'save' }, 'doctor.privacy_policy.bad_sensitive', /^privacy\.sensitive (in|em) brain-kit\.config\.json/],
      [{ never_topics: 'health' }, 'doctor.privacy_policy.bad_topics', /^privacy\.never_topics (in|em) brain-kit\.config\.json/],
      [{ never_topics: ['health', '  '] }, 'doctor.privacy_policy.bad_topics', /^privacy\.never_topics\[1\] (in|em) brain-kit\.config\.json/],
    ];
    for (const [privacy, messageKey, words] of cases) {
      const { code, report } = await doctor(vaultWith(lang, privacy));
      assert.equal(code, EXIT.FAILURE, JSON.stringify(privacy));
      const [c] = results(report);
      assert.equal(c.status, 'fail');
      assert.equal(c.messageKey, messageKey, JSON.stringify(privacy));
      assert.match(c.message, words);
    }
  });

  test(`${lang}: a vault prompt whose privacy rule is the old fixed text warns, naming the file, that the setting does not apply, and how to take the new rule`, async () => {
    const root = vaultWith(lang, {}, oldTemplate(lang));
    const { code, report } = await doctor(root);
    assert.equal(code, EXIT.OK, 'a warning, never a failure');
    const [c] = results(report);
    assert.equal(c.status, 'warn', JSON.stringify(c));
    assert.equal(c.messageKey, 'doctor.privacy_policy.overlay_fixed');
    const file = join(root, '.brain-kit', 'prompts', 'curate.md');
    const template = join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md');
    assert.ok(c.message.includes(file), c.message);
    assert.ok(c.message.includes(template), c.message);
    assert.ok(c.message.includes('<!-- rule:third-party-privacy -->') && c.message.includes('{{privacy_policy}}'), c.message);
    assert.match(c.message, lang === 'en'
      ? /privacy\.sensitive and privacy\.never_topics do not apply to its rounds\. To take the new rule, copy the paragraph under that marker from the language pack's prompt/
      : /privacy\.sensitive e privacy\.never_topics não valem para as rodadas dele\. Para adotar a regra nova, copie para ele o parágrafo dessa marca no prompt do pacote de idioma/);
    assert.match(c.message, lang === 'en' ? /brain-kit update never rewrites this file/ : /o brain-kit update nunca reescreve este arquivo/);
  });

  test(`${lang}: a vault prompt with no privacy rule at all warns too, and one that carries the placeholder is ok`, async () => {
    const none = await doctor(vaultWith(lang, {}, '{{signature}}\n\nA prompt of the vault\'s own.\n'));
    const [warned] = results(none.report);
    assert.equal(warned.status, 'warn');
    assert.equal(warned.messageKey, 'doctor.privacy_policy.overlay_without');
    const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
    const current = await doctor(vaultWith(lang, {}, pack));
    const [ok] = results(current.report);
    assert.equal(ok.status, 'ok', JSON.stringify(ok));
  });
}

test('the text report shows the warning line, and --only lists the ok line with the policy', async () => {
  const warned = await doctor(vaultWith('en', {}, oldTemplate('en')), { json: false });
  assert.match(warned.out, /privacy-policy {2}.*carries the privacy rule as fixed text/);
  const ok = await doctor(vaultWith('en'), { json: false });
  assert.match(ok.out, /privacy-policy {2}Privacy \(privacy\.sensitive in brain-kit\.config\.json\): owner=save, people=save, outsiders=save/, '--only lists the line it names');
});
