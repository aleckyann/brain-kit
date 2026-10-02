import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Absolute path of the brain-kit checkout or installed package.
export const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readPackage() {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));
}

export function kitVersion() {
  return readPackage().version;
}

// Where the documents of a package open in a browser: the GitHub repository
// its package.json names, in any form npm accepts (an object with a url, a
// git+https or ssh address, or the github: shorthand), at the tag of its
// version, so a link a person follows shows the text of the kit they run.
// null when the package names no GitHub repository or no version.
export function docsUrlFor(pkg) {
  const field = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
  const text = String(field ?? '');
  const match = /^github:([\w.-]+)\/([\w.-]+?)$/.exec(text)
    ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text);
  if (!match || typeof pkg?.version !== 'string') return null;
  return `https://github.com/${match[1]}/${match[2]}/blob/v${pkg.version}`;
}

// The same for this kit; a copy that names no GitHub repository points at its
// own folder, where the package ships the same documents.
export function kitDocsUrl() {
  return docsUrlFor(readPackage()) ?? KIT_ROOT;
}
