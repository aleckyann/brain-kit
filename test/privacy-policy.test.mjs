// What the curator records about personal and sensitive subjects is a
// setting of the kit, `privacy.sensitive` and `privacy.never_topics` in
// brain-kit.config.json, and the default is to record everything (the
// owner's decision of 02/10/2026, docs/incidents.md). One function turns the
// setting into the sentences the prompts carry (src/privacy-policy.mjs,
// renderPrivacyPolicy), and one more into the line every round prints
// (privacyLine). This file holds the setting's shape, the packs' defaults
// and every sentence: each level for each audience, in each language, by
// what it says, not only by its key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { validateConfig } from '../src/config.mjs';
import { createTranslator } from '../src/lang.mjs';
import {
  DEFAULT_PRIVACY_LEVEL, PRIVACY_AUDIENCES, PRIVACY_LEVELS, PRIVACY_PLACEHOLDER, isDefaultPrivacy, neverTopics, overlayPrivacyRule, privacyLevels,
  privacyLine, privacyLineMessage, privacyProblems, renderPrivacyPolicy,
} from '../src/privacy-policy.mjs';
import { oldTemplate } from './helpers/privacy-old-rule.mjs';

const LANGS = ['pt-BR', 'en'];
const fixture = () => JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
const packDefaults = (lang) => JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));

function withPrivacy(sensitive, neverTopicsValue) {
  const config = fixture();
  if (sensitive !== undefined) config.privacy.sensitive = sensitive;
  if (neverTopicsValue !== undefined) config.privacy.never_topics = neverTopicsValue;
  return config;
}

// --- the setting and its validation ------------------------------------------

test('the three levels and the three audiences, with save as the default', () => {
  assert.deepEqual([...PRIVACY_LEVELS], ['save', 'summary', 'skip']);
  assert.deepEqual([...PRIVACY_AUDIENCES], ['owner', 'people', 'outsiders']);
  assert.equal(DEFAULT_PRIVACY_LEVEL, 'save');
  assert.equal(PRIVACY_PLACEHOLDER, 'privacy_policy');
});

test('privacy.sensitive takes each level for each audience, and a configuration without the keys is valid', () => {
  assert.deepEqual(validateConfig(fixture()), [], 'no privacy.sensitive and no privacy.never_topics');
  for (const audience of PRIVACY_AUDIENCES) {
    for (const level of PRIVACY_LEVELS) {
      assert.deepEqual(validateConfig(withPrivacy({ [audience]: level })), [], `${audience}=${level}`);
    }
  }
  assert.deepEqual(validateConfig(withPrivacy({ owner: 'save', people: 'summary', outsiders: 'skip' }, ['health', 'legal cases'])), []);
  assert.deepEqual(validateConfig(withPrivacy({}, [])), [], 'an empty setting is the default');
});

test('a value that is not a level is refused for each audience, with a message naming the three allowed ones', () => {
  for (const audience of PRIVACY_AUDIENCES) {
    for (const bad of ['always', 'Save', 'SKIP', '', 'drop', 1, true, null]) {
      const errors = validateConfig(withPrivacy({ [audience]: bad }));
      const error = errors.find((e) => e.startsWith(`$.privacy.sensitive.${audience}`));
      assert.ok(error, `${audience}=${JSON.stringify(bad)} is refused: ${JSON.stringify(errors)}`);
      assert.equal(error, `$.privacy.sensitive.${audience}: must be one of ["save","summary","skip"]`, `the message names the three levels: ${error}`);
    }
  }
  assert.ok(validateConfig(withPrivacy({ team: 'skip' })).some((e) => e.startsWith('$.privacy.sensitive.team: unknown key')), 'an audience the kit does not know');
  assert.ok(validateConfig(withPrivacy('save')).some((e) => e.startsWith('$.privacy.sensitive: expected object')), 'not an object');
});

test('privacy.never_topics is a list of non-empty strings: a non-array, an empty string and a blank one are refused', () => {
  assert.deepEqual(validateConfig(withPrivacy(undefined, ['health'])), []);
  assert.ok(validateConfig(withPrivacy(undefined, 'health')).some((e) => e.startsWith('$.privacy.never_topics: expected array')));
  assert.ok(validateConfig(withPrivacy(undefined, { health: true })).some((e) => e.startsWith('$.privacy.never_topics: expected array')));
  for (const bad of ['', '   ', 7, null]) {
    assert.ok(validateConfig(withPrivacy(undefined, ['health', bad])).some((e) => e.startsWith('$.privacy.never_topics[1]')), JSON.stringify(bad));
  }
});

test('privacyProblems names each value the setting cannot use, by its key, and none for a valid or absent setting', () => {
  assert.deepEqual(privacyProblems(fixture()), []);
  assert.deepEqual(privacyProblems(withPrivacy({ owner: 'skip' }, ['x'])), []);
  assert.deepEqual(privacyProblems(withPrivacy({ owner: 'always', outsiders: 'skip' })), [{ kind: 'level', setting: 'privacy.sensitive.owner', value: 'always' }]);
  assert.deepEqual(privacyProblems(withPrivacy({ team: 'skip' })), [{ kind: 'audience', setting: 'privacy.sensitive.team', value: 'skip' }]);
  assert.deepEqual(privacyProblems(withPrivacy('save')), [{ kind: 'sensitive', setting: 'privacy.sensitive', value: 'save' }]);
  assert.deepEqual(privacyProblems(withPrivacy(undefined, 'health')), [{ kind: 'topics', setting: 'privacy.never_topics', value: 'health' }]);
  assert.deepEqual(privacyProblems(withPrivacy(undefined, ['health', ' '])), [{ kind: 'topic', setting: 'privacy.never_topics[1]', value: ' ' }]);
  assert.deepEqual(privacyProblems(null), []);
  assert.deepEqual(privacyProblems({}), []);
});

// --- the defaults ---------------------------------------------------------------

for (const lang of LANGS) {
  test(`${lang}: the pack's defaults save everything, about everyone, set no topic aside, and list no keyword for lint to refuse`, () => {
    const { privacy } = packDefaults(lang);
    assert.deepEqual(privacy.sensitive, { owner: 'save', people: 'save', outsiders: 'save' });
    assert.deepEqual(privacy.never_topics, []);
    // The mechanical backstop is off by default: a list of health words that
    // lint refuses on an added line would fight the default above.
    assert.deepEqual(privacy.third_party_keywords, []);
    assert.deepEqual(privacy.keyword_exempt_paths, []);
  });
}

test('a configuration without the keys, or with only some of them, reads as save for every audience left out', () => {
  assert.deepEqual(privacyLevels(fixture()), { owner: 'save', people: 'save', outsiders: 'save' });
  assert.deepEqual(privacyLevels(null), { owner: 'save', people: 'save', outsiders: 'save' });
  assert.deepEqual(privacyLevels(withPrivacy({ people: 'skip' })), { owner: 'save', people: 'skip', outsiders: 'save' });
  assert.deepEqual(neverTopics(fixture()), []);
  assert.deepEqual(neverTopics(withPrivacy(undefined, ['  legal   cases ', 'health'])), ['legal cases', 'health'], 'trimmed, inner runs of space made one');
  assert.equal(isDefaultPrivacy(fixture()), true);
  assert.equal(isDefaultPrivacy(withPrivacy({ owner: 'save', people: 'save', outsiders: 'save' }, [])), true);
  assert.equal(isDefaultPrivacy(withPrivacy({ outsiders: 'summary' })), false);
  assert.equal(isDefaultPrivacy(withPrivacy(undefined, ['health'])), false);
});

// --- the sentences ----------------------------------------------------------------

// What each level says, in each language. A pack whose sentence for one level
// carried another level's meaning would still render, key for key: these
// words are what the level means.
const LEVEL_WORDS = {
  en: {
    save: /record (what concerns (the owner|them) )?normally.*without omitting or shortening anything because a subject seems sensitive/,
    summary: /record that it came up and what was decided or agreed, without the intimate details/,
    skip: /out entirely.*without even mentioning that you left them out/,
  },
  'pt-BR': {
    save: /registre normalmente.*sem omitir nem encurtar nada porque o assunto parece sensível/,
    summary: /registre que ele apareceu e o que foi decidido ou combinado, sem os detalhes íntimos/,
    skip: /de fora por completo.*sem nem mencionar que deixou/,
  },
};

// How each audience's line opens, with its level as the configuration writes it.
const AUDIENCE_OPENING = {
  en: {
    owner: (level) => `- The owner (\`${level}\`): `,
    people: (level) => `- The people who already have a note in the vault, such as team, family and mentors (\`${level}\`): `,
    outsiders: (level) => `- Everyone else, who has no note in the vault, such as clients, prospects and strangers (\`${level}\`): `,
    everyone: (level) => `- The owner, the people who already have a note in the vault and everyone else (\`${level}\`): `,
  },
  'pt-BR': {
    owner: (level) => `- O dono (\`${level}\`): `,
    people: (level) => `- As pessoas que já têm nota no vault, como equipe, família e mentores (\`${level}\`): `,
    outsiders: (level) => `- Todas as outras pessoas, que não têm nota no vault, como clientes, potenciais clientes e desconhecidos (\`${level}\`): `,
    everyone: (level) => `- O dono, as pessoas que já têm nota no vault e todas as outras pessoas (\`${level}\`): `,
  },
};

const INTRO = {
  en: /^What you record about personal and sensitive subjects \(health, family, relationships, finances, anything intimate\) is the vault owner's choice, set in privacy\.sensitive of brain-kit\.config\.json\. Follow it exactly as the lines below say, and never apply a stricter or a looser rule of your own:$/,
  'pt-BR': /^O que você registra sobre assuntos pessoais e sensíveis \(saúde, família, relacionamentos, finanças, qualquer coisa íntima\) é escolha do dono do vault, definida em privacy\.sensitive, no brain-kit\.config\.json\. Siga exatamente o que as linhas abaixo dizem, e nunca aplique uma regra sua, nem mais rígida nem mais branda:$/,
};

function lines(text) {
  return text.split('\n');
}

function other(level) {
  return PRIVACY_LEVELS.find((candidate) => candidate !== level);
}

for (const lang of LANGS) {
  const t = createTranslator(lang);

  test(`${lang}: each audience at each level gets its own line, which says that level, beside the other audiences' lines`, () => {
    for (const audience of PRIVACY_AUDIENCES) {
      for (const level of PRIVACY_LEVELS) {
        // The other two audiences at another level, so the three lines are rendered apart.
        const sensitive = Object.fromEntries(PRIVACY_AUDIENCES.map((a) => [a, a === audience ? level : other(level)]));
        const text = renderPrivacyPolicy(withPrivacy(sensitive), t);
        const out = lines(text);
        assert.match(out[0], INTRO[lang], `${lang} ${audience}=${level}: the intro`);
        assert.equal(out.length, 5, `${lang} ${audience}=${level}: the intro, three audiences and the topics:\n${text}`);
        PRIVACY_AUDIENCES.forEach((a, index) => {
          const line = out[1 + index];
          const expectedLevel = sensitive[a];
          assert.ok(line.startsWith(AUDIENCE_OPENING[lang][a](expectedLevel)), `${lang} ${a}=${expectedLevel}: ${line}`);
          assert.equal(line, t(`privacy.policy_${a}_${expectedLevel}`), `${lang} ${a}=${expectedLevel}`);
          assert.match(line, LEVEL_WORDS[lang][expectedLevel], `${lang} ${a}=${expectedLevel} says what ${expectedLevel} means: ${line}`);
          for (const otherLevel of PRIVACY_LEVELS.filter((l) => l !== expectedLevel)) {
            assert.doesNotMatch(line, LEVEL_WORDS[lang][otherLevel], `${lang} ${a}=${expectedLevel} does not say what ${otherLevel} means`);
          }
        });
      }
    }
  });

  test(`${lang}: one level for all three audiences is one line naming the three, which says that level`, () => {
    for (const level of PRIVACY_LEVELS) {
      const text = renderPrivacyPolicy(withPrivacy({ owner: level, people: level, outsiders: level }), t);
      const out = lines(text);
      assert.equal(out.length, 3, `${lang} ${level}:\n${text}`);
      assert.ok(out[1].startsWith(AUDIENCE_OPENING[lang].everyone(level)), `${lang} ${level}: ${out[1]}`);
      assert.equal(out[1], t(`privacy.policy_everyone_${level}`));
      assert.match(out[1], LEVEL_WORDS[lang][level]);
    }
  });

  // The incident of 02/10/2026: the curator left the owner's own health and
  // family out of the log on purpose, under a rule written for other people.
  // The default now says, in so many words, to record them, about the owner
  // and about others.
  test(`${lang}: the default says explicitly to record normally, health, family, relationships, finances and anything intimate included, about the owner and about others`, () => {
    const explicit = {
      en: '- The owner, the people who already have a note in the vault and everyone else (`save`): record normally, about the owner and about others, including health, family, relationships, finances and anything intimate, without omitting or shortening anything because a subject seems sensitive.',
      'pt-BR': '- O dono, as pessoas que já têm nota no vault e todas as outras pessoas (`save`): registre normalmente, sobre o dono e sobre os outros, inclusive saúde, família, relacionamentos, finanças e qualquer coisa íntima, sem omitir nem encurtar nada porque o assunto parece sensível.',
    }[lang];
    for (const config of [fixture(), withPrivacy({ owner: 'save', people: 'save', outsiders: 'save' }, []), packDefaults(lang)]) {
      const text = renderPrivacyPolicy(config, t);
      assert.ok(lines(text).includes(explicit), `${lang}:\n${text}`);
    }
    assert.ok(!renderPrivacyPolicy(withPrivacy({ people: 'skip' }), t).includes(explicit), `${lang}: only when every audience is save`);
  });

  test(`${lang}: the topics never recorded are listed, quoted, on top of the levels; none listed is said too`, () => {
    const text = renderPrivacyPolicy(withPrivacy(undefined, ['health', 'legal cases']), t);
    const last = lines(text).at(-1);
    assert.equal(last, t('privacy.policy_topics', { topics: ['"health"', '"legal cases"'] }));
    assert.match(last, lang === 'en'
      ? /^- Whatever the lines above say, never record these subjects, about anyone \(privacy\.never_topics\): "health", "legal cases"\. Leave them out entirely, without even mentioning that you left them out\.$/
      : /^- Independentemente das linhas acima, nunca registre estes assuntos, de ninguém \(privacy\.never_topics\): "health", "legal cases"\. Deixe-os de fora por completo, sem nem mencionar que deixou\.$/);
    assert.equal(lines(renderPrivacyPolicy(fixture(), t)).at(-1), t('privacy.policy_no_topics'));
    assert.match(t('privacy.policy_no_topics'), lang === 'en' ? /privacy\.never_topics lists none/ : /privacy\.never_topics não lista nenhum/);
    // A topic is the owner's text, quoted: a line break in it stays inside its quotes.
    assert.ok(renderPrivacyPolicy(withPrivacy(undefined, ['a\nb']), t).includes('"a b"'), 'whitespace runs are one space');
  });

  test(`${lang}: a setting that cannot be read renders no level at all, only what to do`, () => {
    for (const config of [withPrivacy({ people: 'always' }), withPrivacy('save'), withPrivacy(undefined, 'health'), withPrivacy(undefined, [''])]) {
      const text = renderPrivacyPolicy(config, t);
      assert.equal(text, t('privacy.policy_unknown'));
      assert.doesNotMatch(text, /`save`|`summary`|`skip`/);
      assert.match(text, /brain-kit doctor/);
    }
  });

  test(`${lang}: the policy line is one line naming the setting, the three levels as configured and the topics`, () => {
    const line = privacyLine(fixture(), t);
    assert.equal(line.includes('\n'), false);
    assert.equal(line, lang === 'en'
      ? 'Privacy (privacy.sensitive in brain-kit.config.json): owner=save, people=save, outsiders=save; never recorded (privacy.never_topics): none.'
      : 'Privacidade (privacy.sensitive no brain-kit.config.json): owner=save, people=save, outsiders=save; nunca registrar (privacy.never_topics): nenhum.');
    const set = privacyLine(withPrivacy({ owner: 'summary', people: 'skip' }, ['health', 'legal cases']), t);
    assert.ok(set.includes('owner=summary, people=skip, outsiders=save'), set);
    assert.ok(set.endsWith(lang === 'en' ? 'never recorded (privacy.never_topics): "health", "legal cases".' : 'nunca registrar (privacy.never_topics): "health", "legal cases".'), set);
  });
}

test('the policy line as a message, for doctor: the same text once rendered, in either language', () => {
  for (const lang of LANGS) {
    const t = createTranslator(lang);
    for (const config of [fixture(), withPrivacy({ outsiders: 'skip' }, ['health'])]) {
      const message = privacyLineMessage(config);
      const topics = message.params.topics;
      const flat = { ...message.params, topics: Array.isArray(topics) ? topics : t(topics.messageKey, topics.params) };
      assert.equal(t(message.messageKey, flat), privacyLine(config, t), lang);
    }
  }
});

// --- a vault's own prompt -----------------------------------------------------------

test('a prompt of the vault\'s own carries the policy, a fixed rule (the marker without the placeholder), or no privacy rule at all', () => {
  assert.equal(overlayPrivacyRule('x\n<!-- rule:third-party-privacy -->\n{{privacy_policy}}\n'), 'policy');
  assert.equal(overlayPrivacyRule('x\n{{privacy_policy}}\n'), 'policy');
  assert.equal(overlayPrivacyRule('x\n<!-- rule:third-party-privacy -->\nNever record anything about the private life of someone other than the owner.\n'), 'fixed');
  assert.equal(overlayPrivacyRule('x\n'), 'none');
  assert.equal(overlayPrivacyRule('x {{privacy_policy }} <!-- rule:third-party-privacy -->'), 'fixed', 'only the placeholder as the kit writes it counts');
});

// Fix round 1, P2: the placeholder pasted in, and the old fixed sentence kept
// beside it, is two rules that contradict, in either language.
test('a prompt of the vault\'s own that carries the placeholder and still the old fixed sentence is both, in either language', () => {
  for (const lang of ['en', 'pt-BR']) {
    const both = oldTemplate(lang).replace('<!-- rule:third-party-privacy -->\n', '<!-- rule:third-party-privacy -->\n{{privacy_policy}}\n\n');
    assert.equal(overlayPrivacyRule(both), 'both', lang);
    assert.equal(overlayPrivacyRule(both.normalize('NFD')), 'both', `${lang}: whatever the encoding of its accents`);
    assert.equal(overlayPrivacyRule(oldTemplate(lang)), 'fixed', lang);
  }
  assert.equal(overlayPrivacyRule('{{privacy_policy}}\nNever record anything about the private life of someone other than the owner.'), 'both');
});
