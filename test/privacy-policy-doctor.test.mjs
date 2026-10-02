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
import { LEGACY_PACK_KEYWORDS } from '../src/rules/privacy-keywords.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { oldTemplate } from './helpers/privacy-old-rule.mjs';
import { LEGACY_KEYWORDS } from './helpers/privacy-keywords.mjs';

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
    // Fix round 1, m2: the new rule is two paragraphs under the marker, and the
    // fix says to put both in place of the old one, never to copy only the first.
    assert.match(c.message, lang === 'en'
      ? /privacy\.sensitive and privacy\.never_topics do not apply to its rounds\. To take the new rule, replace the old paragraph under that marker with the two paragraphs the language pack's prompt, .*curate\.md, has there/
      : /privacy\.sensitive e privacy\.never_topics não valem para as rodadas dele\. Para adotar a regra nova, troque o parágrafo antigo sob essa marca pelos dois parágrafos que o prompt do pacote de idioma, .*curate\.md, tem ali/);
    assert.match(c.message, lang === 'en' ? /brain-kit update never rewrites this file/ : /o brain-kit update nunca reescreve este arquivo/);
  });

  test(`${lang}: a vault prompt with no privacy rule at all warns too, and one that carries the placeholder is ok`, async () => {
    const none = await doctor(vaultWith(lang, {}, '{{signature}}\n\nA prompt of the vault\'s own.\n'));
    const [warned] = results(none.report);
    assert.equal(warned.status, 'warn');
    assert.equal(warned.messageKey, 'doctor.privacy_policy.overlay_without');
    assert.match(warned.message, lang === 'en' ? /its marker and the two paragraphs under it/ : /a marca dela e os dois parágrafos sob ela/);
    const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
    const current = await doctor(vaultWith(lang, {}, pack));
    const [ok] = results(current.report);
    assert.equal(ok.status, 'ok', JSON.stringify(ok));
  });

  // Fix round 1, P2: the placeholder pasted in beside the old fixed sentence.
  test(`${lang}: a vault prompt that carries the placeholder and still the old fixed sentence warns that the two contradict`, async () => {
    const both = oldTemplate(lang).replace('<!-- rule:third-party-privacy -->\n', '<!-- rule:third-party-privacy -->\n{{privacy_policy}}\n\n');
    const { code, report } = await doctor(vaultWith(lang, {}, both));
    assert.equal(code, EXIT.OK);
    const [c] = results(report);
    assert.equal(c.status, 'warn', JSON.stringify(c));
    assert.equal(c.messageKey, 'doctor.privacy_policy.overlay_both');
    assert.match(c.message, lang === 'en' ? /the two rules contradict/ : /as duas regras se contradizem/);
    assert.ok(c.message.includes(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md')), c.message);
  });

  // Fix round 1, m10: the briefing's own prompt, held to the same placeholder.
  test(`${lang}: a vault briefing prompt without the placeholder warns, naming it and the pack's briefing prompt; one with it is ok`, async () => {
    const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'briefing.md'), 'utf8');
    const root = vaultWith(lang);
    mkdirSync(join(root, '.brain-kit', 'prompts'), { recursive: true });
    const file = join(root, '.brain-kit', 'prompts', 'briefing.md');
    writeFileSync(file, pack.replace(/\n\{\{privacy_policy\}\}\n/, '\n'));
    const { code, report } = await doctor(root);
    assert.equal(code, EXIT.OK);
    const [c] = results(report);
    assert.equal(c.status, 'warn', JSON.stringify(c));
    assert.equal(c.messageKey, 'doctor.privacy_policy.briefing_overlay_without');
    assert.ok(c.message.includes(file), c.message);
    assert.ok(c.message.includes(join(KIT_ROOT, 'lang', lang, 'prompts', 'briefing.md')), c.message);
    assert.match(c.message, lang === 'en' ? /do not reach what its briefings record/ : /não chegam ao que os briefings dele registram/);
    writeFileSync(file, pack);
    const [ok] = results((await doctor(root)).report);
    assert.equal(ok.status, 'ok', JSON.stringify(ok));
  });
}

test('the curate prompt and the briefing prompt of a vault are each a line of their own when both miss the policy', async () => {
  const root = vaultWith('en', {}, oldTemplate('en'));
  writeFileSync(join(root, '.brain-kit', 'prompts', 'briefing.md'), '{{signature}}\n\n{{blocks}}\n');
  const { report } = await doctor(root);
  assert.deepEqual(results(report).map((c) => c.messageKey), ['doctor.privacy_policy.overlay_fixed', 'doctor.privacy_policy.briefing_overlay_without']);
});

test('the text report shows the warning line, and --only lists the ok line with the policy', async () => {
  const warned = await doctor(vaultWith('en', {}, oldTemplate('en')), { json: false });
  assert.match(warned.out, /privacy-policy {2}.*carries the privacy rule as fixed text/);
  const ok = await doctor(vaultWith('en'), { json: false });
  assert.match(ok.out, /privacy-policy {2}Privacy \(privacy\.sensitive in brain-kit\.config\.json\): owner=save, people=save, outsiders=save/, '--only lists the line it names');
});

// --- privacy-keywords and the list init wrote before 02/10/2026 (fix round 1, M1) ---
//
// Every vault init or adopt made until 02/10/2026 lists the eight phrases its
// pack shipped, and the person never wrote them: under the new default, a round told to
// record a health subject normally cannot propose the line, since lint refuses
// it. So privacy-keywords warns while the list is still exactly a pack's (as a
// set) and any audience is at save; an edited list is the person's choice.

async function keywords(root) {
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  const env = { ...process.env, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: makeTempDir('brain-kit-privacy-doctor-state-') };
  const code = await runDoctor(['--json', '--only', 'privacy-keywords', root], io, createTranslator('en'), { env, cwd: root });
  const [line] = JSON.parse(out).checks;
  return { code, line };
}

// The lists as a person reads them, accents and all: the single source in src
// spells them with escapes, since src stays ASCII.
const SHIPPED = {
  en: ['medical appointment', 'doctor\'s appointment', 'sick leave', 'teleconsultation', 'therapy session', 'medical exam', 'hospital stay', 'pregnancy'],
  'pt-BR': ['consulta médica', 'atestado médico', 'licença médica', 'teleconsulta', 'sessão de terapia', 'exame médico', 'internação', 'gravidez'],
};

test('the lists the packs shipped until 02/10/2026 have one source, in src, and it holds them as a person reads them', () => {
  assert.deepEqual(LEGACY_PACK_KEYWORDS, SHIPPED);
  assert.deepEqual(LEGACY_KEYWORDS, SHIPPED, 'the test helper is that source, not a copy');
});

for (const lang of LANGS) {
  test(`${lang}: the list a pack shipped, still in the vault while an audience is at save, warns, naming the phrases and the two ways out`, async () => {
    // The same phrases whatever the encoding of their accents (a list typed
    // again on a system that writes them decomposed is still the pack's).
    const decomposed = SHIPPED[lang].map((phrase) => phrase.normalize('NFD'));
    if (lang === 'pt-BR') assert.notDeepEqual(decomposed, SHIPPED[lang], 'the Portuguese phrases do change when decomposed');
    for (const listed of [SHIPPED[lang], [...SHIPPED[lang]].reverse(), [...SHIPPED[lang], SHIPPED[lang][0]], decomposed]) {
      const { code, line } = await keywords(vaultWith(lang, { third_party_keywords: listed }));
      assert.equal(code, EXIT.OK, 'a warning, never a failure');
      assert.equal(line.status, 'warn', JSON.stringify(line));
      assert.equal(line.messageKey, 'doctor.privacy_keywords.legacy');
      for (const phrase of SHIPPED[lang]) assert.ok(line.message.includes(`"${phrase}"`), `${lang}: ${phrase}: ${line.message}`);
      assert.match(line.message, lang === 'en'
        ? /^privacy\.third_party_keywords in brain-kit\.config\.json is still exactly the list of 8 phrases the language pack shipped until 02\/10\/2026, which init and adopt wrote into every vault they made: .*Clear the list \(\[\]\) for the default to hold, or edit it to keep a list of your own; an edited list is a choice, and this check says nothing of it\.$/
        : /^privacy\.third_party_keywords em brain-kit\.config\.json ainda é exatamente a lista das 8 expressões que o pacote de idioma trazia até 02\/10\/2026, que o init e o adopt escreviam em todo vault que criavam: .*Esvazie a lista \(\[\]\) para o padrão valer, ou edite-a para manter uma lista sua; uma lista editada é uma escolha, e esta verificação não fala dela\.$/);
    }
    // Any audience at save is enough: the owner's own health is the incident.
    const owner = await keywords(vaultWith(lang, { third_party_keywords: SHIPPED[lang], sensitive: { owner: 'save', people: 'skip', outsiders: 'skip' } }));
    assert.equal(owner.line.status, 'warn');
  });

  test(`${lang}: a list the person changed in any way, or one kept with no audience at save, is ok with its count`, async () => {
    const changed = [
      SHIPPED[lang].slice(1),
      [...SHIPPED[lang], 'parental leave'],
      [...SHIPPED[lang].slice(1), `${SHIPPED[lang][0]}s`],
    ];
    for (const listed of changed) {
      const { line } = await keywords(vaultWith(lang, { third_party_keywords: listed }));
      assert.equal(line.status, 'ok', JSON.stringify(listed));
      assert.equal(line.messageKey, 'doctor.privacy_keywords.ok');
      assert.equal(line.params.count, new Set(listed).size);
    }
    const chosen = await keywords(vaultWith(lang, { third_party_keywords: SHIPPED[lang], sensitive: { owner: 'summary', people: 'skip', outsiders: 'skip' } }));
    assert.equal(chosen.line.status, 'ok', 'no audience at save: the list agrees with the limits set');
  });
}
