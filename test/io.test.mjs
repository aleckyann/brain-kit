// src/io.mjs's decodeBytes: the one decoding every scanner in this project
// and every pattern source shares (final fix round 2). Content used to be
// decoded one byte per character while patterns were read as UTF-8, so a
// pattern holding an accented letter, written the ordinary way, matched
// nothing at all. These tests pin what the decoding is, byte by byte, and
// the one property that makes it safe on real files: it decodes SEQUENCE
// by sequence, so a single stray byte cannot turn every accented word in a
// file back into mojibake.
//
// Every non-ASCII character below is written as an escape, so this file
// stays ASCII.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeBytes, decodeLatin1Text } from '../src/io.mjs';

const bytes = (...values) => Buffer.from(values);

test('valid UTF-8 decodes exactly as UTF-8, accents, a byte-order mark and a four-byte character included', () => {
  const text = '\uFEFFreuni\u00E3o, caf\u00E9, \u20AC and \u{1F600}';
  assert.equal(decodeBytes(Buffer.from(text, 'utf8')), text);
});

test('a latin1 file decodes as the letters it holds, because a latin1 accent beside an ordinary letter is not UTF-8', () => {
  // "caf" + 0xE9 is "cafe" with an acute accent in latin1.
  assert.equal(decodeBytes(Buffer.from('caf\u00E9 cr\u00E8me', 'latin1')), 'caf\u00E9 cr\u00E8me');
});

test('decoding is per sequence, not per file: one stray byte does not turn the UTF-8 around it into mojibake', () => {
  // The adversarial shape of the defect this function removes: a file that
  // is UTF-8 all the way through but for one byte. Falling back to latin1
  // for the whole file would read the accented word as two characters per
  // letter, and an ordinarily written pattern for it would miss.
  const input = Buffer.concat([Buffer.from('a reuni\u00E3o secreta ', 'utf8'), bytes(0xff), Buffer.from(' ends here', 'utf8')]);
  assert.equal(decodeBytes(input), 'a reuni\u00E3o secreta \u00FF ends here');
});

test('every byte that is not part of a well-formed UTF-8 sequence is itself, never a replacement character, and is never dropped', () => {
  const cases = [
    [[0x80], '\u0080'], // a lone continuation byte
    [[0xc0, 0x80], '\u00C0\u0080'], // an overlong encoding of NUL
    [[0xc1, 0xbf], '\u00C1\u00BF'], // overlong
    [[0xe0, 0x80, 0x80], '\u00E0\u0080\u0080'], // overlong three-byte form
    [[0xed, 0xa0, 0x80], '\u00ED\u00A0\u0080'], // an encoded surrogate
    [[0xf0, 0x80, 0x80, 0x80], '\u00F0\u0080\u0080\u0080'], // overlong four-byte form
    [[0xf4, 0x90, 0x80, 0x80], '\u00F4\u0090\u0080\u0080'], // above U+10FFFF
    [[0xf5, 0x80, 0x80, 0x80], '\u00F5\u0080\u0080\u0080'], // a byte UTF-8 never uses
    [[0xe2, 0x82], '\u00E2\u0082'], // a sequence cut short at the end
    [[0xc3, 0x41], '\u00C3A'], // a lead byte followed by an ordinary letter
  ];
  for (const [input, expected] of cases) {
    const decoded = decodeBytes(Buffer.from(input));
    assert.equal(decoded, expected, `bytes ${Buffer.from(input).toString('hex')}`);
    assert.ok(!decoded.includes('\uFFFD'), `bytes ${Buffer.from(input).toString('hex')} produced a replacement character`);
  }
});

test('every form of well-formed UTF-8 at its own edges decodes to its code point, beside a stray byte that forces the slow path', () => {
  const cases = [
    [[0xc2, 0x80], '\u0080'],
    [[0xdf, 0xbf], '\u07FF'],
    [[0xe0, 0xa0, 0x80], '\u0800'],
    [[0xe1, 0x80, 0x80], '\u1000'],
    [[0xec, 0xbf, 0xbf], '\uCFFF'],
    [[0xed, 0x80, 0x80], '\uD000'],
    [[0xed, 0x9f, 0xbf], '\uD7FF'],
    [[0xee, 0x80, 0x80], '\uE000'],
    [[0xef, 0xbf, 0xbf], '\uFFFF'],
    [[0xf0, 0x90, 0x80, 0x80], '\u{10000}'],
    [[0xf1, 0x80, 0x80, 0x80], '\u{40000}'],
    [[0xf3, 0xbf, 0xbf, 0xbf], '\u{fffff}'],
    [[0xf4, 0x80, 0x80, 0x80], '\u{100000}'],
    [[0xf4, 0x8f, 0xbf, 0xbf], '\u{10ffff}'],
  ];
  for (const [input, expected] of cases) {
    // The trailing 0xFF makes the whole input invalid UTF-8, so this
    // exercises the per-sequence path rather than the native fast path.
    const decoded = decodeBytes(Buffer.from([...input, 0xff]));
    assert.equal(decoded, `${expected}\u00FF`, `bytes ${Buffer.from(input).toString('hex')}`);
  }
});

test('decoding never throws, keeps ASCII as ASCII, and never produces a replacement character, on arbitrary bytes', () => {
  for (let i = 0; i < 300; i += 1) {
    const input = randomBytes(1 + (i % 97));
    const decoded = decodeBytes(input);
    assert.ok(!decoded.includes('\uFFFD'));
    for (let at = 0; at < input.length; at += 1) {
      if (input[at] < 0x80 && (at === 0 || input[at - 1] < 0x80)) {
        assert.ok(decoded.includes(String.fromCharCode(input[at])));
      }
    }
  }
});

test('a Uint8Array decodes exactly like the Buffer holding the same bytes', () => {
  const buffer = Buffer.concat([Buffer.from('caf\u00E9 ', 'utf8'), bytes(0xff)]);
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  assert.equal(decodeBytes(view), decodeBytes(buffer));
});

test('decodeLatin1Text decodes the bytes a latin1 string stands for, never the string\'s own characters', () => {
  const raw = Buffer.concat([Buffer.from('reuni\u00E3o ', 'utf8'), bytes(0xff)]);
  assert.equal(decodeLatin1Text(raw.toString('latin1')), decodeBytes(raw));
  assert.equal(decodeLatin1Text(raw.toString('latin1')), 'reuni\u00E3o \u00FF');
});
