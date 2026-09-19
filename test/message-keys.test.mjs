// Defends the two clauses task 8's own refactor introduced and never
// tested directly: every message key a rule module or a command can
// actually emit exists, and renders, in BOTH language packs, and the
// parameters flowing into a template match its own placeholders in
// BOTH directions.
//
// Why this could not wait for the per-branch tests already spread
// across test/rules-spec.test.mjs and test/rules-house.test.mjs to
// cover it: those tests build a fixture, run a real rule, and check the
// resulting finding's structural fields (file, line, level, check) --
// only SOME of them also render the message and check its text. A key
// deleted from both packs, or a key no test ever renders at all, is
// invisible to that style of test unless it happens to be one of the
// ones checked that way, and (per this review's own finding) four of
// them were not. Deriving the expected key set from the RULE SOURCE
// itself, via a small parser below, rather than from a hand-written
// list in this file, is the point: a key added to a rule tomorrow, with
// no corresponding lang pack entry, fails this test the day it is
// added, without anyone remembering to also update a list here.
//
// Two independent directions, both required (a call site can go wrong
// either way, and each leaves the OTHER direction's check green): a
// placeholder a pack declares that no call site ever supplies renders
// literally on screen ("{field}" left in the sentence); a parameter a
// call site passes that the pack's template never uses is silently
// dropped by interpolate(), which is at best dead code and at worst a
// sign the wrong param name was typed. This file checks both, per
// message key, by comparing two derived sets: the placeholder names
// lang.mjs's `interpolate` would substitute in the pack's own text, and
// the parameter names extracted from the actual source line that
// builds the finding or calls `t(...)`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { createTranslator, loadMessages, REFERENCE_LANG, SUPPORTED_LANGS } from '../src/lang.mjs';

// --- a small parser for one JS shape: `{ ident }` and `{ ident: expr, ... }` -------
//
// Deliberately not a full JS parser: it only has to split a flat object
// literal's top-level entries apart and read each entry's OWN key name
// (shorthand `{ index }` or explicit `{ field: fieldName }` alike),
// which is the one shape every params object in this codebase actually
// uses (checked by hand when this file was written: no params object
// nests another object or array literal). Comma-splitting tracks
// bracket depth AND backtick state, so a comma inside a call's own
// arguments (`allowed.join(', ')`) or inside a template literal's
// `${...}` never gets mistaken for the boundary between two entries.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let inBacktick = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`') inBacktick = !inBacktick;
    if (!inBacktick) {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
    }
    if (c === ',' && depth === 0 && !inBacktick) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function paramNamesFrom(objectInnerText) {
  const trimmed = objectInnerText.trim();
  if (trimmed === '') return [];
  return splitTopLevel(trimmed)
    .map((entry) => {
      const m = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|$)/.exec(entry);
      if (!m) throw new Error(`message-keys.test.mjs cannot parse this params entry: ${JSON.stringify(entry)}`);
      return m[1];
    })
    .sort();
}

// Finds the text strictly inside the `{...}` or `[...]` starting at
// `openIndex`, balanced against nested brackets of every kind and
// against backticks (so a template literal's own `${` and `}` are
// tracked as a pair, not read as real object-literal structure).
function extractBalanced(text, openIndex) {
  const open = text[openIndex];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inBacktick = false;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (c === '`') inBacktick = !inBacktick;
    if (inBacktick) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  throw new Error(`message-keys.test.mjs: unbalanced ${open} starting at index ${openIndex}`);
}

// Every `findings.push({ ..., messageKey: 'x', params: {...} })` and
// `return [{ ..., messageKey: 'x', params: {...} }]` site in a rule
// module: `params:` is always the sibling key immediately reachable
// after `messageKey:` on the same object literal (true of every site
// in src/rules/spec.mjs and src/rules/house.mjs as of this task; the
// guard below against a LATER messageKey appearing first exists so a
// future site written the other way around fails loudly here rather
// than silently pairing a key with the wrong params).
function extractRuleMessageSites(source, file) {
  const results = [];
  const keyRe = /messageKey:\s*'([^']+)'/g;
  let m;
  while ((m = keyRe.exec(source))) {
    const key = m[1];
    const afterIdx = m.index + m[0].length;
    const paramsIdx = source.indexOf('params:', afterIdx);
    assert.notEqual(paramsIdx, -1, `${file}: no params: found after messageKey '${key}'`);
    const nextKeyIdx = source.indexOf('messageKey:', afterIdx);
    assert.ok(
      nextKeyIdx === -1 || nextKeyIdx > paramsIdx,
      `${file}: params: for '${key}' was not found before the next messageKey; extractor's pairing assumption broke`,
    );
    const braceIdx = source.indexOf('{', paramsIdx);
    const names = paramNamesFrom(extractBalanced(source, braceIdx));
    results.push({ key, names, file });
  }
  return results;
}

// Every `t('literal.key')` or `t('literal.key', { ... })` call with a
// PLAIN STRING first argument, across the command and CLI layer.
// Deliberately does not match a template-literal key
// (`` t(`validate.heading_${key}`) ``, used twice in
// src/commands/validate.mjs for a bounded, already-tested enumeration
// of 'must'/'should'/'house'): this parser only reads a key it can name
// statically, and a template literal's actual value depends on a loop
// variable this file has no way to enumerate without duplicating that
// loop.
function extractTranslatorCallSites(source, file) {
  const results = [];
  const re = /\bt\('([^']+)'(?:,\s*(\{[^}]*\}))?\)/g;
  let m;
  while ((m = re.exec(source))) {
    const key = m[1];
    const names = m[2] ? paramNamesFrom(m[2].slice(1, -1)) : [];
    results.push({ key, names, file });
  }
  return results;
}

function readSrc(relPath) {
  return readFileSync(join(KIT_ROOT, relPath), 'utf8');
}

function allSites() {
  const rule = [
    ...extractRuleMessageSites(readSrc('src/rules/spec.mjs'), 'src/rules/spec.mjs'),
    ...extractRuleMessageSites(readSrc('src/rules/house.mjs'), 'src/rules/house.mjs'),
    ...extractRuleMessageSites(readSrc('src/rules/lint.mjs'), 'src/rules/lint.mjs'),
  ];
  const direct = [
    ...extractTranslatorCallSites(readSrc('src/cli.mjs'), 'src/cli.mjs'),
    ...extractTranslatorCallSites(readSrc('src/commands/hook.mjs'), 'src/commands/hook.mjs'),
    ...extractTranslatorCallSites(readSrc('src/commands/validate.mjs'), 'src/commands/validate.mjs'),
  ];
  return [...rule, ...direct];
}

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

// A floor, not the exact count: guards the extractor itself against
// silently matching nothing (a typo'd regex, or a future rewrite that
// moves `messageKey:` to a different shape this parser no longer
// recognises), the same meta-guard test/no-portuguese.test.mjs applies
// to its own file walk, for the same reason.
const MINIMUM_EXPECTED_SITES = 40;

test('extraction itself finds a real, non-trivial number of message sites across the rule modules and the command layer', () => {
  const sites = allSites();
  assert.ok(sites.length >= MINIMUM_EXPECTED_SITES, `expected at least ${MINIMUM_EXPECTED_SITES} sites, found ${sites.length}`);
  const distinctKeys = new Set(sites.map((s) => s.key));
  assert.ok(distinctKeys.size >= 30, `expected at least 30 distinct keys, found ${distinctKeys.size}`);
});

test('every message key a rule module or the command layer can emit exists in both language packs', () => {
  const en = loadMessages('en');
  const pt = loadMessages(REFERENCE_LANG);
  const sites = allSites();
  for (const { key, file } of sites) {
    assert.ok(key in en, `${file}: messageKey "${key}" is missing from lang/en/messages.json`);
    assert.ok(key in pt, `${file}: messageKey "${key}" is missing from lang/${REFERENCE_LANG}/messages.json`);
  }
});

test('every parameter a call site passes is exactly the set of placeholders its key declares, in both directions, in both packs', () => {
  const packs = { en: loadMessages('en'), [REFERENCE_LANG]: loadMessages(REFERENCE_LANG) };
  const sites = allSites();
  for (const lang of SUPPORTED_LANGS) {
    for (const { key, names, file } of sites) {
      const declared = placeholders(packs[lang][key]);
      assert.deepEqual(
        names,
        declared,
        `${file}: messageKey "${key}" supplies params [${names.join(', ')}] but lang/${lang}/messages.json declares placeholders [${declared.join(', ')}] (checked both directions: missing on either side fails here)`,
      );
    }
  }
});

// Renders every site's key through both real translators, with the
// EXACT params that site passes (built as synthetic strings, since
// interpolate() only ever calls String() on a value): this is what
// actually catches a missing key (t() throws "Unknown message key"), a
// broken template (a stray "{" that never closes), or a genuinely
// unsupplied placeholder rendering as a literal "{word}" on screen,
// none of which the previous test's set-comparison alone proves, since
// that test never calls `t` at all.
test('every message key renders successfully in both packs, with no leftover placeholder and no bare key name on screen', () => {
  const enT = createTranslator('en');
  const ptT = createTranslator(REFERENCE_LANG);
  const sites = allSites();
  assert.ok(sites.length > 0, 'the site list must not be empty for this assertion to mean anything');
  for (const { key, names, file } of sites) {
    const params = Object.fromEntries(names.map((name) => [name, `test-${name}`]));
    for (const [label, t] of [['en', enT], [REFERENCE_LANG, ptT]]) {
      let rendered;
      assert.doesNotThrow(() => {
        rendered = t(key, params);
      }, `${file}: messageKey "${key}" failed to render in ${label}`);
      assert.doesNotMatch(rendered, /\{[A-Za-z_]\w*\}/, `${file}: "${key}" in ${label} left an unfilled placeholder: ${rendered}`);
      assert.doesNotMatch(rendered, new RegExp(key.replace(/\./g, '\\.')), `${file}: "${key}" in ${label} rendered the bare key name itself: ${rendered}`);
    }
  }
});
