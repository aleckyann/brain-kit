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
// Tokens are estimated here, never counted (no tokenizer ships with the
// kit, and no test calls a model): CHARS_PER_TOKEN is a deliberately
// pessimistic 2 characters per token over what Read returns, numbers
// included. Claude's tokenizer averages close to 4 characters per token on
// English prose and about 3 on Portuguese, accents included, so 2 counts
// every such text at about half to two thirds of its real length per
// token, and also holds for the paths, numbers and identifiers a working
// session quotes. Only text with no words at all (a pasted base64 or hex
// blob) tokenizes worse; a digest cuts each message at 1 800 characters,
// so such a blob is one bounded line, never the whole digest.
import { readFileSync, statSync } from 'node:fs';

export const READ_MAX_BYTES = 256 * 1024;
export const READ_MAX_TOKENS = 25000;
export const READ_DEFAULT_LINES = 2000;
export const CHARS_PER_TOKEN = 2;
// `cat -n`: the line number right-aligned in six columns, then a tab.
export const LINE_PREFIX_CHARS = 7;

function numbered(lines, start) {
  return lines.map((line, index) => `${String(start + index).padStart(6)}\t${line}`).join('\n');
}

export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// The lines of a text file, as Read counts them: a final newline ends the
// last line, it does not start another.
export function linesOf(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
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
  const tokens = estimateTokens(shown);
  if (tokens > READ_MAX_TOKENS) {
    return {
      isError: true,
      content: `File content (${tokens} tokens) exceeds maximum allowed tokens (${READ_MAX_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
      text: null,
    };
  }
  return { isError: false, content: shown, text };
}
