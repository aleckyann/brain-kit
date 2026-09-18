// The one shared code-stripping module, tested on its own before either
// ruler ever calls it. See src/markdown.mjs's own header for why this
// module exists at all: a fence rule kept independently by two rulers
// disagreed about what a fence is, and the weaker of the two copies
// blanked a whole file from one phantom fence onward. Every test here
// pairs the shape that must be blanked with the almost-identical shape
// that must survive, so a stub that blanks everything (or nothing)
// cannot pass silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCode } from '../src/markdown.mjs';

function lines(text) {
  return text.split('\n');
}

// --- fenced code: backtick, tilde, longer than three, unclosed ---------------

test('a backtick fence blanks its content and its own marker lines, but a real line right after the close survives', () => {
  const text = ['before', '```', 'inside the fence', '```', 'after'].join('\n');
  const result = lines(stripCode(text));
  assert.deepEqual(result, ['before', '', '', '', 'after']);
});

test('a tilde fence is recognised on the same terms as a backtick one', () => {
  const text = ['~~~', 'inside', '~~~', 'outside'].join('\n');
  assert.deepEqual(lines(stripCode(text)), ['', '', '', 'outside']);
});

test('a fence longer than three characters closes only on a marker at least as long, so a shorter same-character fence nested inside it is content, not a close', () => {
  const text = ['````', '```', 'still inside the four-backtick fence', '````', 'outside'].join('\n');
  assert.deepEqual(lines(stripCode(text)), ['', '', '', '', 'outside']);
});

test('a fence that never closes runs to the end of the file, blanking everything after it, rather than guessing where it might have ended', () => {
  const text = ['```', 'one', 'two', 'three'].join('\n');
  assert.deepEqual(lines(stripCode(text)), ['', '', '', '']);
});

test('a fence with an info string on its opening line is still a fence, and the info string is blanked with it', () => {
  const text = ['```js', 'code', '```'].join('\n');
  assert.deepEqual(lines(stripCode(text)), ['', '', '']);
});

// --- the critical regression: a fence-shaped line inside an indented block opens nothing ---

test('a fence-shaped line indented four spaces opens no fence at all, so a real heading-like line and a real link far below it both survive', () => {
  const text = [
    'To open a fence, type:',
    '',
    '    ```js',
    '',
    'then your code.',
    '',
    '[y](ghost.md)',
  ].join('\n');
  const result = stripCode(text);
  // the indented line itself is blanked (it is genuinely indented code),
  // but nothing AFTER it is: the whole point is that no phantom fence
  // opens and swallows the rest of the file.
  assert.ok(result.includes('[y](ghost.md)'), 'the real link after the indented example must survive');
  assert.ok(result.includes('To open a fence, type:'));
  assert.ok(result.includes('then your code.'));
});

test('a tilde fence-shaped line at four-space indentation is equally not a fence opener', () => {
  const text = ['start', '', '    ~~~', '', 'end with a [link](ghost.md)'].join('\n');
  const result = stripCode(text);
  assert.ok(result.includes('end with a [link](ghost.md)'));
});

test('a fence-shaped line indented with a literal tab opens no fence either', () => {
  const text = ['start', '', '\t```', '', 'end with a [link](ghost.md)'].join('\n');
  const result = stripCode(text);
  assert.ok(result.includes('end with a [link](ghost.md)'));
});

// --- indented code blocks: the block itself is code, and needs a blank line before it ---

test('a block indented four spaces, preceded by a blank line, is itself blanked as code', () => {
  const text = ['prose', '', '    real code here', '    more code here', 'prose again'].join('\n');
  assert.deepEqual(lines(stripCode(text)), ['prose', '', '', '', 'prose again']);
});

test('an indented line cannot interrupt a paragraph: without a preceding blank line it is ordinary text, not code', () => {
  const text = ['a paragraph', '    that merely wraps onto an indented continuation'].join('\n');
  const result = lines(stripCode(text));
  assert.equal(result[1], '    that merely wraps onto an indented continuation', 'not preceded by a blank line, so this is not code');
});

test('an indented code block continues across a blank line inside it, and still ends at the first under-indented line', () => {
  const text = ['prose', '', '    code one', '', '    code two', 'prose again, not indented'].join('\n');
  const result = lines(stripCode(text));
  assert.deepEqual(result, ['prose', '', '', '', '', 'prose again, not indented']);
});

// --- blockquotes: a fence quoted this way is still code, not prose (the review's addition) ---

test('a fenced block inside a blockquote is code, not prose: the link inside it does not survive', () => {
  const text = ['> ```', '> [x](ghost.md)', '> ```'].join('\n');
  const result = stripCode(text);
  assert.ok(!result.includes('ghost.md'), 'the quoted fence must hide its own content, exactly like an unquoted one');
});

test('a real link right after a blockquoted fence closes still survives', () => {
  const text = ['> ```', '> [x](ghost.md)', '> ```', '[real](elsewhere.md)'].join('\n');
  const result = stripCode(text);
  assert.ok(!result.includes('ghost.md'));
  assert.ok(result.includes('[real](elsewhere.md)'), 'the fence must still close, or this would blank the rest of the file too');
});

test('an ordinary blockquote with no fence inside it is left alone', () => {
  const text = '> just a quoted [link](real.md), no fence here';
  assert.ok(stripCode(text).includes('[link](real.md)'));
});

// --- inline code: single and double backtick, by run length -----------------

test('a single-backtick span hides a link-shaped example written inline', () => {
  const text = 'write it like `[ghost](nowhere.md)` in prose, or for real as [ghost](nowhere.md)';
  const result = stripCode(text);
  assert.equal(result.split('[ghost](nowhere.md)').length - 1, 1, 'exactly one real occurrence should survive');
});

test('a double-backtick span hides its contents rather than unwrapping them, even when the content itself contains a single backtick', () => {
  const text = 'see ``a `backtick` inside`` here';
  const result = stripCode(text);
  assert.ok(!result.includes('backtick'), 'the whole double-backtick span, single backtick and all, must be hidden');
  assert.ok(result.includes('see') && result.includes('here'));
});

test('a backtick run with no matching close on the line is left as plain text, not guessed at', () => {
  const text = 'a lone ` backtick with no partner';
  assert.equal(stripCode(text), text);
});

// --- line numbers are preserved: blanking, never deleting ---------------------

test('blanking a fence or a code block never changes the total number of lines', () => {
  const text = ['a', '```', 'b', 'c', '```', 'd', '    e', '    f', 'g'].join('\n');
  assert.equal(stripCode(text).split('\n').length, text.split('\n').length);
});
