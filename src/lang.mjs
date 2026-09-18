import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from './version.mjs';

// pt-BR is the reference pack: it is the language the original vault runs in
// and the one every message was tested against. en mirrors it key for key.
export const REFERENCE_LANG = 'pt-BR';
export const SUPPORTED_LANGS = Object.freeze(['pt-BR', 'en']);

const cache = new Map();

export function loadMessages(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) {
    throw new Error(`Unsupported language "${lang}" (supported: ${SUPPORTED_LANGS.join(', ')})`);
  }
  if (!cache.has(lang)) {
    cache.set(lang, JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'messages.json'), 'utf8')));
  }
  return cache.get(lang);
}

export function interpolate(text, vars = {}) {
  return text.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

// createTranslator(lang, { warn, packs })
//   warn:  receives one string the first time a key falls back to the reference pack
//   packs: optional { [lang]: messages } used instead of the files on disk (tests)
export function createTranslator(lang = REFERENCE_LANG, { warn = () => {}, packs = null } = {}) {
  const load = (l) => (packs ? packs[l] : loadMessages(l));
  const reference = load(REFERENCE_LANG);
  let primary = reference;
  let warned = false;
  if (lang !== REFERENCE_LANG) {
    if (SUPPORTED_LANGS.includes(lang) && (!packs || packs[lang])) {
      primary = load(lang);
    } else {
      warned = true;
      warn(interpolate(reference['lang.fallback_warning'], { key: '*', lang, reference: REFERENCE_LANG }));
    }
  }
  return function t(key, vars = {}) {
    let text = primary[key];
    if (text === undefined) {
      text = reference[key];
      if (text === undefined) throw new Error(`Unknown message key "${key}"`);
      if (!warned) {
        warned = true;
        warn(interpolate(reference['lang.fallback_warning'], { key, lang, reference: REFERENCE_LANG }));
      }
    }
    return interpolate(text, vars);
  };
}
