// Completing a language's default configuration with a person's answers.
//
// lang/<code>/config.defaults.json is a configuration with every key the
// schema requires, except that the fields only a person can supply are
// left as placeholder tokens (PLACEHOLDERS below). This module is the ONE
// merge from those defaults to a real configuration: the skeleton test
// (test/skeleton.test.mjs) proves each language's skeleton valid through
// it, and `init` consumes it rather than writing a second merge, because
// two merges of the same defaults are two chances to disagree about what
// a new vault's configuration is.
//
// Pure: the defaults object is never mutated, nothing is read from disk,
// and the result is not schema-validated here. Its caller validates it
// with validateConfig (src/config.mjs), the one place this project
// decides what a valid configuration is.
//
// What this function DOES refuse, by throwing, is the two ways a
// completed configuration can pass that validation while being wrong,
// which the schema cannot see:
//
// - A placeholder left in place. "<owner-name>" is a perfectly valid
//   owner name to the schema, so a defaults file that gains a new
//   placeholder this function does not fill would otherwise produce a
//   vault owned, in writing, by "<owner-name>", and a command that exits
//   zero saying nothing about it. Every string of the result is checked
//   for every token after filling.
// - An answer for another language. The defaults were picked BY language;
//   answers declaring a different one mean the caller loaded the wrong
//   file, and a configuration that validates while describing a
//   different vault than the one being created is worse than an error.
//
// A required answer that is not a string also throws: `handle` is
// composed into `actors.human`, and "human:" followed by a missing
// handle's string form would satisfy the schema's own actor pattern.

export const PLACEHOLDERS = Object.freeze({
  ownerName: '<owner-name>',
  ownerHandle: '<owner-handle>',
  ownerEmail: '<owner-email>',
  vaultTitle: '<vault-title>',
  vaultRepo: '<vault-repo>',
  vaultTimezone: '<vault-timezone>',
});

const REQUIRED_ANSWERS = Object.freeze(['lang', 'name', 'handle', 'title', 'timezone']);

// An optional answer a person skipped arrives as undefined, null or an
// empty string (pressing enter at a prompt); all three mean "none", which
// the schema spells null. Null passes through as itself.
function optional(value) {
  return value === undefined || value === '' ? null : value;
}

function findPlaceholders(value, path, found) {
  if (typeof value === 'string') {
    for (const token of Object.values(PLACEHOLDERS)) {
      if (value.includes(token)) found.push(`${path}: ${token}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findPlaceholders(item, `${path}[${index}]`, found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, sub] of Object.entries(value)) findPlaceholders(sub, `${path}.${key}`, found);
  }
  return found;
}

// `options.kitVersion`, when given, replaces the defaults' own fixed
// kit_version. `init` passes kitVersion() (src/version.mjs) so a new
// vault records the kit that actually made it; it is a parameter rather
// than a read of package.json here so this function stays pure.
export function completeDefaults(defaults, answers, { kitVersion } = {}) {
  if (kitVersion !== undefined && typeof kitVersion !== 'string') {
    throw new TypeError('completeDefaults: kitVersion must be a string');
  }
  for (const key of REQUIRED_ANSWERS) {
    if (typeof answers?.[key] !== 'string') {
      throw new TypeError(`completeDefaults: answer "${key}" must be a string`);
    }
  }
  if (answers.lang !== defaults.lang) {
    throw new Error(`completeDefaults: answers are for "${answers.lang}" but the defaults are for "${defaults.lang}"`);
  }

  const email = optional(answers.email);
  const config = structuredClone(defaults);
  if (kitVersion !== undefined) config.kit_version = kitVersion;

  config.owner.name = answers.name;
  config.owner.handle = answers.handle;
  config.owner.email = email;
  config.vault.title = answers.title;
  config.vault.repo = optional(answers.repo);
  config.vault.timezone = answers.timezone;
  config.actors.human = `human:${answers.handle}`;
  // The agent's commit name carries a suffix in the vault's own language
  // ("(curator)" in English, its translation in Portuguese), so the
  // defaults hold the whole name with the title token in it and only the
  // token is replaced. A function, not a replacement string, so a "$&" in
  // a person's title stays literal.
  config.git.agent_identity.name = config.git.agent_identity.name.replace(PLACEHOLDERS.vaultTitle, () => answers.title);
  // sources.calendar.calendars stays the defaults' empty list, whatever the
  // e-mail: the calendar source is opt in (decision D6 of the phase 3 plan),
  // and turning it on moves the round into connector mode, which a person
  // chooses by naming the calendars to read.
  config.briefing.calendar_id = email;

  const left = findPlaceholders(config, '$', []);
  if (left.length > 0) {
    throw new Error(`completeDefaults: placeholders left unfilled:\n  ${left.join('\n  ')}`);
  }
  return config;
}
