// Which paths may become a permission rule the round passes to Claude Code
// (phase 3, task 1, fix round 1 of 25/09/2026). A read rule names a path
// as `Read(//<the path without its leading slash>)`, and the CLI reads
// that text twice: once to split its --allowedTools list into rules, at
// commas and spaces outside parentheses, and once as a gitignore-style
// pattern. Measured on 24/09/2026 against Claude Code 2.1.281 (ruling
// R-A2): a space and accented letters inside the parentheses name the
// exact file. Not measured, and so never emitted:
//   ( ) , \    the splitter or the rule grammar may read them as structure:
//              with a splitter that tracks "inside parentheses" as a flag,
//              the file `(a) Read (b).jsonl` turns into a bare Read, which
//              grants every file on disk;
//   * ? [ ]    a gitignore pattern reads them as wildcards and classes;
//   { }        a glob-style matcher reads them as alternatives;
//   control    a newline above all: a matcher handed the pattern as text
//   characters may split it into patterns of their own.
// A path holding one is never turned into a rule: the transcripts source
// lists its file as unreadable, machine.json refuses such a
// transcripts_dir, and src/curate/tools.mjs throws as the last line.
export const RULE_UNSAFE_CHARACTERS = Object.freeze(['*', '?', '[', ']', '{', '}', '(', ')', '\\', ',']);

// The distinct characters of `path` a rule cannot carry, in the order they
// first appear: each as itself, a control character as U+XXXX. Empty when
// the path can be named.
export function unsafeRuleCharacters(path) {
  const found = [];
  for (const ch of String(path)) {
    const code = ch.charCodeAt(0);
    let shown = null;
    if (code < 32 || code === 127) shown = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else if (RULE_UNSAFE_CHARACTERS.includes(ch)) shown = ch;
    if (shown !== null && !found.includes(shown)) found.push(shown);
  }
  return found;
}
