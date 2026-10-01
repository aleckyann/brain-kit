// What Claude Code's Read tool refuses, for the fake claude and for the
// tests that prove a digest is always readable whole. Measured on
// 01/10/2026, the first real round on a real vault (docs/incidents.md):
// a whole file over 256 KB is refused ("File content (512KB) exceeds
// maximum allowed size (256KB)"), and so is a slice over 25 000 tokens,
// even of 15 lines of a transcript whose lines are enormous ("File content
// (50403 tokens) exceeds maximum allowed tokens (25000)"). Without a
// limit it reads 2 000 lines, and it numbers every line it returns, the way
// `cat -n` does (six columns and a tab).
//
// Tokens are never estimated here (fix round 1, ruling R-D1): the real
// tool counts them with the real tokenizer, which no test can call. What
// is certain is that every token covers at least one byte, so a numbered
// output of at most READ_MAX_TOKENS UTF-8 bytes is one the real tool always
// accepts, whatever its script. The fake refuses anything bigger: it
// accepts only what the real tool is sure to accept.
import { readFileSync, statSync } from 'node:fs';

export const READ_MAX_BYTES = 256 * 1024;
export const READ_MAX_TOKENS = 25000;
export const READ_DEFAULT_LINES = 2000;

// The lines of a text file, as Read counts them: a final newline ends the
// last line, it does not start another.
export function linesOf(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// What Read prints for these lines from line `start` on: each behind its
// number in six columns and a tab, one per line.
export function numbered(lines, start = 1) {
  return lines.map((line, index) => `${String(start + index).padStart(6)}\t${line}`).join('\n');
}

// The UTF-8 bytes of what Read prints for a whole file's text: the most
// tokens that output can be.
export function printedBytes(text) {
  return Buffer.byteLength(numbered(linesOf(text)));
}

// One Read, as Claude Code answers it: { isError, content, text }, `text`
// being the file's own text when the read worked.
export function emulateRead(input) {
  const path = input?.file_path;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { isError: true, content: 'File does not exist.', text: null };
  }
  if (!stat.isFile()) return { isError: true, content: 'EISDIR: illegal operation on a directory, read', text: null };
  const sliced = input.offset !== undefined || input.limit !== undefined;
  if (!sliced && stat.size > READ_MAX_BYTES) {
    return {
      isError: true,
      content: `File content (${Math.round(stat.size / 1024)}KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      text: null,
    };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { isError: true, content: `${error.code}: could not read ${path}`, text: null };
  }
  const start = Math.max(1, Number(input.offset ?? 1));
  const limit = Number(input.limit ?? READ_DEFAULT_LINES);
  const shown = numbered(linesOf(text).slice(start - 1, start - 1 + limit), start);
  const bytes = Buffer.byteLength(shown);
  if (bytes > READ_MAX_TOKENS) {
    return {
      isError: true,
      // The real tool's words, with the bytes in place of the tokens it
      // would count: the most they can be.
      content: `File content (${bytes} tokens) exceeds maximum allowed tokens (${READ_MAX_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      text: null,
    };
  }
  return { isError: false, content: shown, text };
}
