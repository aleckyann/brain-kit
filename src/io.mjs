import { Buffer, isUtf8 } from 'node:buffer';

// The one well-formed UTF-8 sequence of two, three or four bytes, exactly as
// the Unicode standard's own table of well-formed byte sequences draws it
// (no overlong form, no encoded surrogate, nothing above U+10FFFF), written
// against a latin1 string, where one character is one byte.
const UTF8_MULTIBYTE_SEQUENCE = /[\xC2-\xDF][\x80-\xBF]|\xE0[\xA0-\xBF][\x80-\xBF]|[\xE1-\xEC\xEE\xEF][\x80-\xBF]{2}|\xED[\x80-\x9F][\x80-\xBF]|\xF0[\x90-\xBF][\x80-\xBF]{2}|[\xF1-\xF3][\x80-\xBF]{3}|\xF4[\x80-\x8F][\x80-\xBF]{2}/g;

// Turns bytes into the text a scanner reads and a pattern is matched
// against. THE ONE DECODING, shared by everything that puts bytes in front
// of src/leak.mjs's scanner or reads the patterns it applies: the file
// contents the `secrets` lint rule reads, every channel of the maintainer's
// push gate (src/commands/scan-blobs.mjs), the personal pattern file, and
// the vault's own configuration, which is where `privacy.secret_patterns`
// lives. Content and patterns decoded two different ways is the defect this
// exists to remove: content used to be decoded one byte per character
// (latin1) while patterns were read as UTF-8, so a pattern written the
// ordinary way with an accented letter compiled to one code point where the
// content held two, and matched nothing, anywhere, in silence.
//
// UTF-8 where the bytes are UTF-8, and each byte that is not part of a
// well-formed UTF-8 sequence as its own latin1 character, so this can never
// throw and never drops a byte (it never produces U+FFFD, which is what
// `toString('utf8')` puts where a byte it cannot decode used to be, and
// which no pattern can match).
//
// PER SEQUENCE, NOT PER FILE, and that is the point, not a detail. Falling
// back to latin1 for the WHOLE input whenever any byte of it is invalid
// would reopen the exact hole above for any file that is mostly text with
// one stray byte in it (a PDF, a spreadsheet, a log with one corrupt line,
// a commit message with one byte from another encoding): every accented
// name in it would decode two characters wide again. Decoded sequence by
// sequence, the name still reads as the name. A file written in latin1 all
// the way through still reads correctly too, because a latin1 accented
// letter followed by an ordinary letter is not a well-formed UTF-8 sequence
// and so stays itself.
//
// Valid UTF-8 takes the fast native path. A byte-order mark is kept, not
// stripped: this is a scanner's reading, and the markdown reader's
// conveniences (src/commands/validate.mjs, makeReadFile) are not its job.
export function decodeBytes(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isUtf8(buffer)) return buffer.toString('utf8');
  return buffer.toString('latin1').replace(UTF8_MULTIBYTE_SEQUENCE, (sequence) => Buffer.from(sequence, 'latin1').toString('utf8'));
}

// The same decoding, for text a caller already holds one byte per character
// (a latin1 string straight from git or from standard input, which is how
// the push gate keeps byte offsets and exact comparisons exact). It decodes
// the bytes that string stands for, never the string's own characters.
export function decodeLatin1Text(latin1) {
  return decodeBytes(Buffer.from(latin1, 'latin1'));
}

// Read all of stdin. Resolves to '' when stdin is a TTY or closed.
//
// The encoding is a parameter, not a constant, because one caller needs
// bytes rather than text: `brain-kit scan-blobs` reads file paths that git
// produced, and git paths are bytes, not necessarily valid UTF-8. Decoding
// those as 'utf8' turns any byte sequence that is not valid UTF-8 into a
// replacement character, which silently changes the value; 'latin1' maps
// every byte 0-255 to the code point of the same value, so the string that
// arrives is the bytes that were sent. Callers that only need text (and the
// one that only needs stdin drained) keep the 'utf8' default.
export function readStdin(stream, { encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) return resolve('');
    let data = '';
    stream.setEncoding(encoding);
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}
