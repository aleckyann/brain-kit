// What the curator records about personal and sensitive subjects (health,
// family, relationships, finances, anything intimate): a setting of the kit,
// in the vault's brain-kit.config.json, and by default everything is recorded.
//
//   "privacy": {
//     "sensitive": { "owner": "save", "people": "save", "outsiders": "save" },
//     "never_topics": []
//   }
//
// `owner` is what concerns the vault's owner, `people` the people who already
// have a note in the vault (team, family, mentors), `outsiders` everyone else
// (clients, prospects, strangers). Each takes one of three levels, written in
// English in either language: `save` (record normally, nothing left out or
// shortened because a subject seems sensitive), `summary` (record that the
// subject came up and what was decided or agreed, without the intimate
// details) and `skip` (leave it out entirely, without saying so).
// `never_topics` lists subjects never recorded for anyone, on top of the
// levels. A key left out reads as its default, so a configuration written
// before the setting existed records everything.
//
// Why a setting, and why that default (docs/incidents.md, 02/10/2026): the
// curate prompt used to carry one fixed sentence forbidding the private life
// of "someone other than the owner", and the model stretched it to the owner,
// leaving the owner's own health and family out of the log on purpose. The
// owner decided that what the curator keeps is the kit's setting, never a
// patch for one vault, that a vault must be able to hold personal and
// sensitive information, the owner's and other people's, and that the
// default is to keep everything; a person who wants limits sets them.
//
// Mechanism in code, policy in the prompt: this module turns the setting into
// sentences in the vault's language (renderPrivacyPolicy), which the prompts
// carry through the placeholder `{{privacy_policy}}`, and into the one line
// every round, `curate --dry` and `doctor` print (privacyLine). Nothing here
// checks what a model wrote against the levels: the policy is an instruction,
// not a guarantee, and `privacy.third_party_keywords` stays the optional
// mechanical backstop (src/rules/privacy-keywords.mjs).

export const PRIVACY_LEVELS = Object.freeze(['save', 'summary', 'skip']);
export const PRIVACY_AUDIENCES = Object.freeze(['owner', 'people', 'outsiders']);
export const DEFAULT_PRIVACY_LEVEL = 'save';

// The placeholder a prompt or a skill body carries the policy by, and the
// contract marker of the rule it sits under in the curate prompt.
export const PRIVACY_PLACEHOLDER = 'privacy_policy';
export const PRIVACY_RULE = 'third-party-privacy';

export const SENSITIVE_SETTING = 'privacy.sensitive';
export const TOPICS_SETTING = 'privacy.never_topics';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sensitiveOf(config) {
  return isObject(config?.privacy) ? config.privacy.sensitive : undefined;
}

// The level of each audience: the configured one, or the default when the key
// is left out. A value that is not a level reads as null, and so does every
// audience when `privacy.sensitive` is not an object: privacyProblems names
// it, and no policy is rendered from it.
export function privacyLevels(config) {
  const sensitive = sensitiveOf(config);
  return Object.fromEntries(PRIVACY_AUDIENCES.map((audience) => {
    if (sensitive === undefined) return [audience, DEFAULT_PRIVACY_LEVEL];
    if (!isObject(sensitive)) return [audience, null];
    const value = sensitive[audience];
    if (value === undefined) return [audience, DEFAULT_PRIVACY_LEVEL];
    return [audience, PRIVACY_LEVELS.includes(value) ? value : null];
  }));
}

function isTopic(value) {
  return typeof value === 'string' && /\S/.test(value);
}

// The subjects never recorded for anyone, each trimmed and with every run of
// whitespace inside it made one space, so a topic is always one line; [] when
// there is none. null when the setting is not a list of non-blank strings
// (privacyProblems names it).
export function neverTopics(config) {
  const listed = isObject(config?.privacy) ? config.privacy.never_topics : undefined;
  if (listed === undefined) return [];
  if (!Array.isArray(listed) || !listed.every(isTopic)) return null;
  return listed.map((topic) => topic.trim().replace(/\s+/g, ' '));
}

// True when the setting is the default: every audience at save, and no topic
// set aside.
export function isDefaultPrivacy(config) {
  const levels = privacyLevels(config);
  const topics = neverTopics(config);
  return PRIVACY_AUDIENCES.every((audience) => levels[audience] === DEFAULT_PRIVACY_LEVEL) && Array.isArray(topics) && topics.length === 0;
}

// Every value of the setting the kit cannot use, as { kind, setting, value }:
// `sensitive` (not an object), `level` (not one of the three), `audience` (a
// key that names no audience), `topics` (not a list) and `topic` (an entry that
// is not a non-blank string). The schema refuses the same values; this list is
// what `doctor` says in the person's language.
export function privacyProblems(config) {
  const problems = [];
  const sensitive = sensitiveOf(config);
  if (sensitive !== undefined && !isObject(sensitive)) {
    problems.push({ kind: 'sensitive', setting: SENSITIVE_SETTING, value: sensitive });
  } else if (isObject(sensitive)) {
    for (const audience of PRIVACY_AUDIENCES) {
      const value = sensitive[audience];
      if (value !== undefined && !PRIVACY_LEVELS.includes(value)) problems.push({ kind: 'level', setting: `${SENSITIVE_SETTING}.${audience}`, value });
    }
    for (const key of Object.keys(sensitive)) {
      if (!PRIVACY_AUDIENCES.includes(key)) problems.push({ kind: 'audience', setting: `${SENSITIVE_SETTING}.${key}`, value: sensitive[key] });
    }
  }
  const listed = isObject(config?.privacy) ? config.privacy.never_topics : undefined;
  if (listed !== undefined && !Array.isArray(listed)) {
    problems.push({ kind: 'topics', setting: TOPICS_SETTING, value: listed });
  } else if (Array.isArray(listed)) {
    listed.forEach((topic, index) => {
      if (!isTopic(topic)) problems.push({ kind: 'topic', setting: `${TOPICS_SETTING}[${index}]`, value: topic });
    });
  }
  return problems;
}

// One sentence per audience and level, and one for the three audiences at
// the same level. Each key is written out, so test/message-keys.test.mjs
// finds every one of them in both packs.
const SENTENCES = Object.freeze({
  owner: Object.freeze({
    save: (t) => t('privacy.policy_owner_save'),
    summary: (t) => t('privacy.policy_owner_summary'),
    skip: (t) => t('privacy.policy_owner_skip'),
  }),
  people: Object.freeze({
    save: (t) => t('privacy.policy_people_save'),
    summary: (t) => t('privacy.policy_people_summary'),
    skip: (t) => t('privacy.policy_people_skip'),
  }),
  outsiders: Object.freeze({
    save: (t) => t('privacy.policy_outsiders_save'),
    summary: (t) => t('privacy.policy_outsiders_summary'),
    skip: (t) => t('privacy.policy_outsiders_skip'),
  }),
  everyone: Object.freeze({
    save: (t) => t('privacy.policy_everyone_save'),
    summary: (t) => t('privacy.policy_everyone_summary'),
    skip: (t) => t('privacy.policy_everyone_skip'),
  }),
});

// A topic as the owner wrote it, in straight double quotes (a JSON string), so
// it reads as their text and a comma inside it never splits it.
function quoted(topics) {
  return topics.map((topic) => JSON.stringify(topic));
}

function readable(levels, topics) {
  return PRIVACY_AUDIENCES.every((audience) => levels[audience] !== null) && topics !== null;
}

// The policy as the model reads it, in `t`'s language: one sentence saying
// whose choice it is and to follow it exactly, then one line per audience
// with its level (one line for the three when they share it), then the topics
// set aside or a line saying there is none. No blank line inside, so it stays
// one paragraph under the rule's marker. A setting that cannot be read
// renders no level at all, only what to do about it.
export function renderPrivacyPolicy(config, t) {
  const levels = privacyLevels(config);
  const topics = neverTopics(config);
  if (!readable(levels, topics)) return t('privacy.policy_unknown');
  const lines = [t('privacy.policy_intro')];
  const shared = new Set(PRIVACY_AUDIENCES.map((audience) => levels[audience]));
  if (shared.size === 1) lines.push(SENTENCES.everyone[levels.owner](t));
  else for (const audience of PRIVACY_AUDIENCES) lines.push(SENTENCES[audience][levels[audience]](t));
  lines.push(topics.length > 0 ? t('privacy.policy_topics', { topics: quoted(topics) }) : t('privacy.policy_no_topics'));
  return lines.join('\n');
}

// The effective policy in one line, as `doctor` reports it: a message and its
// parameters, the topics either the quoted list or the message for none.
export function privacyLineMessage(config) {
  const levels = privacyLevels(config);
  const topics = neverTopics(config);
  const none = { messageKey: 'privacy.line_no_topics', params: {} };
  const listed = Array.isArray(topics) && topics.length > 0 ? quoted(topics) : none;
  return { messageKey: 'privacy.line', params: { owner: levels.owner, people: levels.people, outsiders: levels.outsiders, topics: listed } };
}

// The same line, rendered in `t`'s language: what the round's parameters
// block, its output, `curate --check` and `curate --dry` print. A setting that
// cannot be read is said as such, never as a level it does not hold.
export function privacyLine(config, t) {
  const levels = privacyLevels(config);
  const topics = neverTopics(config);
  if (!readable(levels, topics)) return t('privacy.policy_unknown');
  return t('privacy.line', {
    owner: levels.owner, people: levels.people, outsiders: levels.outsiders,
    topics: topics.length > 0 ? quoted(topics) : t('privacy.line_no_topics'),
  });
}

// Whether a prompt the vault wrote itself carries the policy: 'policy' when it
// holds the placeholder as the kit writes it, 'fixed' when it holds the rule's
// marker without it (a copy of the template of before 02/10/2026, or an edit
// of one, whose privacy rule is fixed text the setting never reaches), 'none'
// when it holds neither.
export function overlayPrivacyRule(text) {
  if (text.includes(`{{${PRIVACY_PLACEHOLDER}}}`)) return 'policy';
  return text.includes(`<!-- rule:${PRIVACY_RULE} -->`) ? 'fixed' : 'none';
}
