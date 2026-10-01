// The Node guard: the one module bin/brain-kit.mjs loads before anything else.
//
// package.json says `"node": ">=22"`, and nothing said it to a person on an
// older Node: the launcher used to import the whole CLI at once, so a Node too
// old for some syntax or built-in in src/ would die with a SyntaxError or a
// TypeError and a stack trace, before a word of the kit (the first stranger's
// m13, 01/10/2026). The launcher now imports only this file, asks it, and loads
// the CLI with a dynamic import() once the answer is "go on".
//
// THE NUMBER. MINIMUM_NODE_MAJOR is the one place the kit decides the oldest
// Node it supports: src/doctor/checks.mjs imports it instead of keeping a copy.
// It is 22, and it was measured, not planned: the whole suite ran on a real Node
// 22.22.1 and only the version policy itself failed (0.0.9). 22 is also the
// oldest Node that still receives security fixes (it leaves Maintenance LTS in
// April 2027, the date to raise this number). What a person who has to install a
// Node is sent to is another number, RECOMMENDED_NODE_MAJOR: 24, which every
// sentence calls "LTS" and nothing more (a sentence that says which release line is
// the LTS today goes stale the day the next one becomes it). CI runs the suite on 22
// and on 24, and test/node-minimum.test.mjs holds each number to every place that
// states it: package.json's `engines`, the doctor, the documents and the CI matrix.
//
// So this file has to run on a Node that cannot run the rest of the kit:
// it imports nothing, and it uses only syntax every Node that can load an
// ES module parses (plain functions, var, string concatenation; no optional
// chaining, no nullish coalescing, no private fields, no template literals).
// test/node-guard.test.mjs scans it for those, because the next edit that
// "tidies" it with newer syntax would break exactly the machines it exists for.
//
// Its two other choices repeat what the rest of the kit decides, since it
// cannot import them, and the same test holds each against the real one:
// the language of the message is src/lang.mjs's resolveLang (BRAIN_KIT_LANG,
// then LC_ALL, LC_MESSAGES and LANG; a value starting with "pt" is
// Portuguese, anything else English), and the exit code is src/exit-codes.mjs's
// USAGE.
//
// The Portuguese is written with \u escapes where it has an accent, because
// the engine's sources are ASCII (test/no-portuguese.test.mjs).
export var MINIMUM_NODE_MAJOR = 22;
export var RECOMMENDED_NODE_MAJOR = 24;
var REFUSED = 2;
var HOOK_EXIT = 0;

// The language of the message, chosen as resolveLang chooses it.
function inPortuguese(locale) {
  var env = locale !== null && typeof locale === 'object' ? locale : {};
  if (env.BRAIN_KIT_LANG === 'pt-BR') return true;
  if (env.BRAIN_KIT_LANG === 'en') return false;
  var names = ['LC_ALL', 'LC_MESSAGES', 'LANG'];
  for (var i = 0; i < names.length; i++) {
    var value = env[names[i]];
    if (typeof value !== 'string' || value === '') continue;
    return value.toLowerCase().indexOf('pt') === 0;
  }
  return false;
}

// The major of a Node version string: the digits at its start (after an
// optional "v") that are followed by a dot or by the end of the text. null for
// anything else, so a string that is no version at all is never read as one.
function majorOf(version) {
  var match = /^v?(\d+)(?:\.|$)/.exec(String(version));
  return match === null ? null : Number(match[1]);
}

// null when this Node may run the kit, and otherwise { message, exitCode }:
// one line, two sentences, for stderr, and the exit code to leave with.
//
// A version it cannot read is never a reason to refuse: only a version it can
// read, below the minimum, blocks. A hook (`hook <event>`, the entry point of
// the plugin's Stop and SessionStart hooks) is told the same thing but leaves
// with 0, because a hook that fails breaks the Claude Code session it runs in.
// `locale` is the environment (process.env, or anything with the same names).
export function checkNodeVersion(version, firstArgument, locale) {
  var major = majorOf(version);
  if (major === null || major >= MINIMUM_NODE_MAJOR) return null;
  var shown = String(version).replace(/^v/, '');
  var message = inPortuguese(locale)
    ? 'brain-kit precisa do Node ' + MINIMUM_NODE_MAJOR + ' ou mais novo; esta m\u00e1quina tem o Node ' + shown + '. Instale o Node ' + RECOMMENDED_NODE_MAJOR + ' (LTS) em https://nodejs.org e rode de novo.'
    : 'brain-kit needs Node ' + MINIMUM_NODE_MAJOR + ' or newer; this machine has Node ' + shown + '. Install Node ' + RECOMMENDED_NODE_MAJOR + ' (LTS) from https://nodejs.org and run it again.';
  return { message: message, exitCode: firstArgument === 'hook' ? HOOK_EXIT : REFUSED };
}
