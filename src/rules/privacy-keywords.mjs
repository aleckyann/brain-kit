// Third-party keywords: the one question the privacy rule's third clause
// asks of a line of text (src/rules/lint.mjs, "--- privacy"). Does the line
// hold one of the words the vault's configuration lists in
// `privacy.third_party_keywords`? Which lines are asked (the lines a change
// added, as the scope reports them, and none at all in a run over the
// whole vault) and what an answer becomes (a finding at the severity
// `lint.privacy` resolves to) stay with the rule, so this module knows
// nothing about git, scope or severity; `privacy.keyword_exempt_paths` is
// read here too, so both of the clause's settings are read in one place.
//
// docs/incidents.md, "Undated: a colleague's medical appointment was in the
// calendar window": someone else's health or private life is never content.
// The words are the vault's own, from its language pack's defaults, which
// init writes; a configuration that lists none is asked about none.
//
// How a keyword matches, each choice pinned by
// test/rules-privacy-keywords.test.mjs:
//
// - As a whole phrase. The character on either side of it, when there is
//   one, is not a Unicode letter or digit (\p{L}, \p{N}), so a keyword
//   inside a longer word, a plural included, is not the keyword, while a
//   space, punctuation, an underscore or the edge of the line bounds it.
//   JavaScript's \b is not used: it knows only ASCII letters, so an accented
//   letter glued to a keyword would read as a boundary, and it reads an
//   underscore as a letter.
// - Case-insensitively, with Unicode case folding (the `i` and `u` flags
//   together), so a capital accented letter matches its small form, and a
//   calendar title's capitalised first word matches.
// - With accents significant. Case folding never removes an accent, so a
//   keyword written with one does not match the same word written without
//   it, and the reverse. The keyword and the line are both brought to the
//   composed form (NFC) first: an accent is a property of the letter a
//   person reads, not of which of the two encodings Unicode allows for it
//   reached the file. Without that, a letter stored as its base letter
//   plus a combining accent would never match its composed keyword.
// - Literally. Every character a regular expression would read as syntax
//   is escaped, so a configured "(" or "." means that character.
// - With every carriage return read as a space (fix round 1). A line
//   reaches this module as git reports it, and git ends a line at a line
//   feed only, so a CR can sit inside one: the CR of a CRLF a caller did
//   not strip, or a lone CR left by an old editor. Read as a space it
//   bounds a word as any whitespace does, and it cannot split a phrase in
//   two ("sick", CR, "leave" is the phrase "sick leave").
// - With typographic apostrophes read as the straight one, and every run
//   of whitespace inside the line (a no-break space, a tab, two spaces)
//   read as one space,
//   in the keyword and in the line alike (review M3 of task 6): an editor
//   that curls "doctor's" or a line wrapped with two spaces writes the same
//   phrase a person reads.
//
// A listed entry that is not a string, or is blank, is dropped rather than
// compiled: an empty phrase bounded on both sides matches almost every
// line. The schema refuses a blank keyword and one padded with spaces; this
// module does not trust that it was asked.
import { isUnderPath } from '../vault.mjs';

const REGEXP_SYNTAX = /[.*+?^${}()|[\]\\]/g;
const CARRIAGE_RETURN = /\r/g;
// The left and right single quotation marks and the modifier letter
// apostrophe, built from their code points so this file stays ASCII.
const APOSTROPHES = new RegExp(`[${[0x2018, 0x2019, 0x02bc].map((code) => String.fromCharCode(code)).join('')}]`, 'g');
// A line feed is not whitespace inside a line: it ends one.
const WHITESPACE_RUN = /[^\S\n]+/gu;

// The text a keyword is looked for in, and looked for as: composed (NFC),
// its typographic apostrophes straight, each whitespace run one space.
function comparable(text) {
  return text.normalize('NFC').replace(APOSTROPHES, "'").replace(WHITESPACE_RUN, ' ');
}
const NOT_AFTER_WORD = '(?<![\\p{L}\\p{N}])';
const NOT_BEFORE_WORD = '(?![\\p{L}\\p{N}])';

function literal(text) {
  return text.replace(REGEXP_SYNTAX, '\\$&');
}

// The configured keywords, each beside the expression that finds it, in
// the order the configuration lists them; [] when it lists none usable.
export function keywordMatchers(config) {
  const listed = config?.privacy?.third_party_keywords;
  if (!Array.isArray(listed)) return [];
  return listed
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((keyword) => ({
      keyword,
      pattern: new RegExp(`${NOT_AFTER_WORD}${literal(comparable(keyword))}${NOT_BEFORE_WORD}`, 'iu'),
    }));
}

// The keyword `line` holds, as configured: the one that starts first
// reading left to right, and on a tie the one listed first, so a line is
// named once and always the same way. null when it holds none.
export function firstKeyword(line, matchers) {
  const text = comparable(line.replace(CARRIAGE_RETURN, ' '));
  let found = null;
  let foundAt = Infinity;
  for (const { keyword, pattern } of matchers) {
    const match = pattern.exec(text);
    if (match !== null && match.index < foundAt) {
      found = keyword;
      foundAt = match.index;
    }
  }
  return found;
}

// The configured exempt paths, each a vault path of a file or a directory.
// A non-string entry is dropped (isUnderPath would throw on it); an empty
// one needs no filter, since isUnderPath matches nothing against it.
export function keywordExemptPaths(config) {
  const listed = config?.privacy?.keyword_exempt_paths;
  return Array.isArray(listed) ? listed.filter((entry) => typeof entry === 'string') : [];
}

// Whether `file` is, or lies under, one of `exemptPaths`: a path boundary
// (src/vault.mjs isUnderPath), so "journal" exempts "journal/x.md" and not
// "journal-old/x.md".
export function isKeywordExempt(file, exemptPaths) {
  return exemptPaths.some((entry) => isUnderPath(file, entry));
}
