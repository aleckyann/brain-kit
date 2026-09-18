// Read all of stdin as UTF-8. Resolves to '' when stdin is a TTY or closed.
export function readStdin(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) return resolve('');
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}
