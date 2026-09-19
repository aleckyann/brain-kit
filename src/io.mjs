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
