// The privacy setting reaches the model (docs/incidents.md, 02/10/2026).
// The curate prompt of both packs no longer carries a fixed privacy
// sentence: its rule `third-party-privacy` holds `{{privacy_policy}}`,
// filled from the vault's configuration (src/privacy-policy.mjs), for
// `brain-kit prompt curate` and for the round. The round's parameters block,
// its own output, `curate --check` and `curate --dry` carry one line with the
// policy in effect, every round, so nobody is surprised by what a round left
// out. A round here runs the repository's fake `claude` (test/helpers/
// fake-claude.mjs), which records what it was handed on standard input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { CURATE_RULES, runPrompt } from '../src/commands/prompt.mjs';
import { PRIVACY_AUDIENCES, PRIVACY_LEVELS } from '../src/privacy-policy.mjs';
import { makeCurateWorld } from './helpers/curate-world.mjs';
import { makeVault } from './helpers/vault-fixture.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { OLD_WORDS, oldTemplate } from './helpers/privacy-old-rule.mjs';

const LANGS = ['pt-BR', 'en'];

function collector() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (chunk) => { out += chunk; return true; } },
      stderr: { write: (chunk) => { err += chunk; return true; } },
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

function vaultWith(lang, privacy = {}) {
  return makeVault({ files: { 'index.md': '# Index\n' }, config: { lang, privacy } });
}

// The caller's language is English: a vault's own `lang` wins whenever its
// configuration loads.
async function promptCurate(root, lang) {
  const c = collector();
  const code = await runPrompt(['curate', '--vault', root], c.io, createTranslator(lang), {
    cwd: makeTempDir('brain-kit-privacy-cwd-'), env: { ...process.env, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: makeTempDir('brain-kit-privacy-state-') },
  });
  return { code, out: c.stdout, err: c.stderr };
}

// The paragraph a rule's marker opens: up to the first blank line.
function ruleParagraph(text, rule) {
  const at = text.indexOf(`<!-- rule:${rule} -->`);
  assert.notEqual(at, -1, `no marker for ${rule}`);
  const end = text.indexOf('\n\n', at);
  return text.slice(at, end === -1 ? undefined : end);
}

// --- the template -----------------------------------------------------------------

for (const lang of LANGS) {
  test(`${lang}: the pack's privacy rule holds the placeholder, once, right under its marker, and the old fixed sentence is gone`, () => {
    const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
    assert.equal(pack.split('{{privacy_policy}}').length - 1, 1, `${lang}: the placeholder, once`);
    assert.ok(pack.includes('<!-- rule:third-party-privacy -->\n{{privacy_policy}}\n'), `${lang}: right under the marker`);
    assert.doesNotMatch(pack, OLD_WORDS[lang]);
  });
}

// --- brain-kit prompt curate ----------------------------------------------------------

for (const lang of LANGS) {
  const t = createTranslator(lang);

  test(`${lang}: prompt curate on a vault whose configuration says nothing of privacy carries the default, explicit, under the rule's marker`, async () => {
    const { code, out, err } = await promptCurate(vaultWith(lang), lang);
    assert.equal(code, EXIT.OK, out + err);
    const paragraph = ruleParagraph(out, 'third-party-privacy');
    assert.ok(paragraph.includes(t('privacy.policy_intro')), paragraph);
    assert.ok(paragraph.includes(t('privacy.policy_everyone_save')), paragraph);
    assert.ok(paragraph.includes(t('privacy.policy_no_topics')), paragraph);
    assert.doesNotMatch(out, OLD_WORDS[lang]);
    assert.doesNotMatch(out, /\{\{\w+\}\}/);
    assert.equal(out.split('<!-- rule:').length - 1, CURATE_RULES.length, 'no marker added or lost');
  });

  test(`${lang}: prompt curate with a configuration that sets each level carries each audience's sentence and the topics`, async () => {
    for (const level of PRIVACY_LEVELS) {
      for (const audience of PRIVACY_AUDIENCES) {
        const rest = PRIVACY_LEVELS.find((candidate) => candidate !== level);
        const sensitive = Object.fromEntries(PRIVACY_AUDIENCES.map((a) => [a, a === audience ? level : rest]));
        const { code, out, err } = await promptCurate(vaultWith(lang, { sensitive, never_topics: ['health', 'legal cases'] }), lang);
        assert.equal(code, EXIT.OK, out + err);
        const paragraph = ruleParagraph(out, 'third-party-privacy');
        for (const a of PRIVACY_AUDIENCES) assert.ok(paragraph.includes(t(`privacy.policy_${a}_${sensitive[a]}`)), `${lang} ${a}=${sensitive[a]}:\n${paragraph}`);
        assert.ok(paragraph.includes(t('privacy.policy_topics', { topics: ['"health"', '"legal cases"'] })), paragraph);
        assert.equal(paragraph.includes(t('privacy.policy_everyone_save')), false);
      }
    }
  });

  // Fix round 1, B1 (the review of 02/10/2026, a real model run 126 times):
  // the paragraph kept here said that someone else's schedule is decided
  // apart from the setting and that "an absence ... is never content", and
  // the model stretched it to a colleague's medical leave the owner told in a
  // meeting, leaving it out under `save` in most runs. The tested wording,
  // verbatim, says the setting covers everything recorded, whatever the
  // source, and scopes the limit to events listed from someone else's
  // calendar, never what someone says in a session, a meeting or a document.
  test(`${lang}: the paragraph after the policy says the setting covers everything recorded and scopes the calendar's limit to listed events`, async () => {
    const { out } = await promptCurate(vaultWith(lang, { sensitive: { people: 'skip' } }), lang);
    const at = out.indexOf('<!-- rule:third-party-privacy -->');
    const next = out.slice(out.indexOf('\n\n', at) + 2).split('\n\n')[0];
    const expected = {
      en: "The setting above covers everything you record, whatever the source, including what one person tells about another in a session, a meeting or a document (a colleague's medical leave, a relative's illness). Only events listed from someone else's calendar are decided apart from it: read with the authorization the configuration records, only the events they share with other people count, and one of theirs that does not count (an absence, an appointment, an errand) is never content, not even as a mention that something was left out. That limit is about events listed from their calendar, never about what someone says in a session, a meeting or a document.",
      'pt-BR': 'A configuração acima vale para tudo o que você registra, seja qual for a fonte, inclusive o que uma pessoa conta sobre outra numa sessão, numa reunião ou num documento (a licença médica de um colega, a doença de um parente). Só os eventos listados da agenda de outra pessoa são decididos à parte: lidos com a autorização que a configuração registra, só contam os eventos que ela compartilha com outras pessoas, e um evento dela que não conta (uma ausência, uma consulta, uma tarefa particular) nunca vira conteúdo, nem como menção de que algo ficou de fora. Esse limite vale para os eventos listados da agenda dela, nunca para o que alguém diz numa sessão, numa reunião ou num documento.',
    }[lang];
    assert.equal(next, expected);
    // What makes it hold, said apart so a rewording keeps it: the calendar is
    // named, and the limit never reaches what someone says.
    assert.match(next, lang === 'en' ? /\bcalendar\b/ : /\bagenda\b/);
    assert.match(next, lang === 'en'
      ? /never about what someone says in a session, a meeting or a document\.$/
      : /nunca para o que alguém diz numa sessão, numa reunião ou num documento\.$/);
    assert.match(next, lang === 'en' ? /^The setting above covers everything you record, whatever the source/ : /^A configuração acima vale para tudo o que você registra, seja qual for a fonte/);
    assert.doesNotMatch(next, lang === 'en' ? /Someone else's schedule is a different matter/ : /Os compromissos de outra pessoa são outra questão/, 'the stretched wording is gone');
  });
}

test('a vault whose configuration cannot be read gets no level in prompt curate, only what to do', async () => {
  for (const lang of LANGS) {
    const root = vaultWith(lang, { sensitive: { people: 'always' } });
    const { code, out } = await promptCurate(root, 'en');
    assert.equal(code, EXIT.OK, out);
    const paragraph = ruleParagraph(out, 'third-party-privacy');
    // The configuration does not load, so the language is the caller's.
    assert.ok(paragraph.includes(createTranslator('en')('privacy.policy_unknown')), paragraph);
    assert.doesNotMatch(paragraph, /`save`|`summary`|`skip`/);
  }
});

// --- --check -----------------------------------------------------------------------

function scratchPacks() {
  const dir = makeTempDir('brain-kit-privacy-packs-');
  cpSync(join(KIT_ROOT, 'lang'), dir, { recursive: true });
  return dir;
}

async function check(argv, { packsDir, cwd, lang = 'en' } = {}) {
  const c = collector();
  const code = await runPrompt(argv, c.io, createTranslator(lang), {
    ...(packsDir ? { packsDir } : {}), cwd: cwd ?? makeTempDir('brain-kit-privacy-cwd-'), env: { ...process.env, BRAIN_KIT_STATE_DIR: makeTempDir('brain-kit-privacy-state-') },
  });
  return { code, out: c.stdout, err: c.stderr };
}

test('{{privacy_policy}} is a placeholder the curate prompt knows; a misspelt one is still refused', async () => {
  assert.equal((await check(['--check'])).code, EXIT.OK);
  const dir = scratchPacks();
  for (const lang of LANGS) {
    const file = join(dir, lang, 'prompts', 'curate.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('{{privacy_policy}}', '{{privacy_policies}}'));
  }
  const { code, out } = await check(['--check'], { packsDir: dir });
  assert.equal(code, EXIT.FAILURE, out);
  assert.match(out, /\{\{privacy_policies\}\}/);
});

function writeOverlay(root, text) {
  mkdirSync(join(root, '.brain-kit', 'prompts'), { recursive: true });
  writeFileSync(join(root, '.brain-kit', 'prompts', 'curate.md'), text);
}

test('prompt --check warns, and still passes, about a vault prompt whose privacy rule is the old fixed text, naming the file and the fix', async () => {
  // Fix round 1, m2: the fix puts both paragraphs of the new rule in place of the old one.
  const words = {
    en: /warning: the vault's curate prompt .*curate\.md carries the privacy rule as fixed text \(<!-- rule:third-party-privacy --> without \{\{privacy_policy\}\}\): privacy\.sensitive and privacy\.never_topics never reach its rounds\. Replace the old paragraph under that marker with the two paragraphs the language pack's prompt \(.*lang[/\\]en[/\\]prompts[/\\]curate\.md\) has there, or delete the file to run the pack's prompt\./,
    'pt-BR': /aviso: o prompt de curadoria do vault .*curate\.md traz a regra de privacidade como texto fixo \(<!-- rule:third-party-privacy --> sem \{\{privacy_policy\}\}\): privacy\.sensitive e privacy\.never_topics nunca chegam às rodadas dele\. Troque o parágrafo antigo sob essa marca pelos dois parágrafos que o prompt do pacote de idioma \(.*lang[/\\]pt-BR[/\\]prompts[/\\]curate\.md\) tem ali, ou apague o arquivo para rodar o prompt do pacote\./,
  };
  for (const lang of LANGS) {
    const root = vaultWith(lang);
    writeOverlay(root, oldTemplate(lang));
    const { code, out, err } = await check(['--check', '--vault', root], { lang });
    assert.equal(code, EXIT.OK, out + err);
    assert.match(err, words[lang], `${lang}: ${err}`);
    // The pack's own prompt as the overlay: nothing to say about privacy.
    const fresh = vaultWith(lang);
    writeOverlay(fresh, readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8'));
    const clean = await check(['--check', '--vault', fresh], { lang });
    assert.equal(clean.code, EXIT.OK);
    assert.equal(clean.err, '', `${lang}: ${clean.err}`);
  }
});

// Fix round 1, P2 and m10.
test('prompt --check warns about a vault prompt that carries the placeholder beside the old fixed sentence, and about a briefing prompt without the placeholder', async () => {
  for (const lang of LANGS) {
    const both = vaultWith(lang);
    writeOverlay(both, oldTemplate(lang).replace('<!-- rule:third-party-privacy -->\n', '<!-- rule:third-party-privacy -->\n{{privacy_policy}}\n\n'));
    const r = await check(['--check', '--vault', both], { lang });
    assert.equal(r.code, EXIT.OK, r.out + r.err);
    assert.match(r.err, lang === 'en'
      ? /warning: the vault's curate prompt .*curate\.md carries \{\{privacy_policy\}\} and still the old fixed privacy sentence: the two rules contradict\./
      : /aviso: o prompt de curadoria do vault .*curate\.md traz \{\{privacy_policy\}\} e ainda a frase fixa antiga de privacidade: as duas regras se contradizem\./);

    const briefing = vaultWith(lang);
    const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'briefing.md'), 'utf8');
    mkdirSync(join(briefing, '.brain-kit', 'prompts'), { recursive: true });
    writeFileSync(join(briefing, '.brain-kit', 'prompts', 'briefing.md'), pack.replace(/\n\{\{privacy_policy\}\}\n/, '\n'));
    const b = await check(['--check', '--vault', briefing], { lang });
    assert.equal(b.code, EXIT.OK, b.out + b.err);
    assert.match(b.err, lang === 'en'
      ? /warning: the vault's briefing prompt .*briefing\.md does not use \{\{privacy_policy\}\}: privacy\.sensitive and privacy\.never_topics do not reach what the briefing records\./
      : /aviso: o prompt de briefing do vault .*briefing\.md não usa \{\{privacy_policy\}\}: privacy\.sensitive e privacy\.never_topics não chegam ao que o briefing registra\./);
    writeFileSync(join(briefing, '.brain-kit', 'prompts', 'briefing.md'), pack);
    const clean = await check(['--check', '--vault', briefing], { lang });
    assert.doesNotMatch(clean.err, /privacy_policy/, `${lang}: ${clean.err}`);
  }
});

// --- the round ---------------------------------------------------------------------------

const LINE = {
  en: 'Privacy (privacy.sensitive in brain-kit.config.json): owner=save, people=save, outsiders=save; never recorded (privacy.never_topics): none.',
  'pt-BR': 'Privacidade (privacy.sensitive no brain-kit.config.json): owner=save, people=save, outsiders=save; nunca registrar (privacy.never_topics): nenhum.',
};

test('a round hands the model the policy under its rule and the one line in its parameters, and prints that line', () => {
  const w = makeCurateWorld();
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const stdin = readFileSync(w.files.stdinFile, 'utf8');
  const t = createTranslator('en');
  const paragraph = ruleParagraph(stdin, 'third-party-privacy');
  assert.ok(paragraph.includes(t('privacy.policy_everyone_save')), paragraph);
  assert.doesNotMatch(stdin, OLD_WORDS.en);
  // The line, once in the parameters block, before the rules.
  assert.equal(stdin.split(LINE.en).length - 1, 1, stdin);
  assert.ok(stdin.indexOf(LINE.en) < stdin.indexOf('<!-- rule:read-index-first -->'), 'in the parameters block');
  // And on the round's own output, once.
  assert.equal(r.stdout.split('\n').filter((line) => line === LINE.en).length, 1, r.stdout);
});

test('a round of a vault that set limits hands the model each audience\'s level and the topics, and its line says them', () => {
  const w = makeCurateWorld({ config: (c) => { c.privacy.sensitive = { owner: 'summary', people: 'skip' }; c.privacy.never_topics = ['legal cases']; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const stdin = readFileSync(w.files.stdinFile, 'utf8');
  const t = createTranslator('en');
  const paragraph = ruleParagraph(stdin, 'third-party-privacy');
  for (const key of ['privacy.policy_owner_summary', 'privacy.policy_people_skip', 'privacy.policy_outsiders_save']) assert.ok(paragraph.includes(t(key)), `${key}:\n${paragraph}`);
  assert.ok(paragraph.includes(t('privacy.policy_topics', { topics: ['"legal cases"'] })), paragraph);
  const line = 'Privacy (privacy.sensitive in brain-kit.config.json): owner=summary, people=skip, outsiders=save; never recorded (privacy.never_topics): "legal cases".';
  assert.ok(stdin.includes(line), stdin);
  assert.ok(r.stdout.split('\n').includes(line), r.stdout);
});

test('a round speaks the vault\'s language: the policy and its line in Portuguese for a pt-BR vault', () => {
  const w = makeCurateWorld({ config: (c) => { c.lang = 'pt-BR'; } });
  const r = w.curate();
  assert.equal(r.status, EXIT.OK, r.stderr);
  const stdin = readFileSync(w.files.stdinFile, 'utf8');
  assert.ok(ruleParagraph(stdin, 'third-party-privacy').includes(createTranslator('pt-BR')('privacy.policy_everyone_save')));
  assert.ok(stdin.includes(LINE['pt-BR']), stdin);
  assert.ok(r.stdout.split('\n').includes(LINE['pt-BR']), r.stdout);
});

test('curate --dry and curate --check print the line, in the vault\'s language, and a dry run hands nothing to a model', () => {
  for (const lang of LANGS) {
    const w = makeCurateWorld({ config: (c) => { c.lang = lang; } });
    const dry = w.curate(['--dry']);
    assert.equal(dry.status, EXIT.OK, dry.stderr);
    assert.equal(dry.stdout.split('\n').filter((line) => line === LINE[lang]).length, 1, `${lang} --dry:\n${dry.stdout}`);
    const checked = w.curate(['--check']);
    assert.equal(checked.status, EXIT.OK, checked.stderr);
    assert.equal(checked.stdout.split('\n').filter((line) => line === LINE[lang]).length, 1, `${lang} --check:\n${checked.stdout}`);
    assert.equal(w.launches().length, 0, 'no model was run');
  }
});
