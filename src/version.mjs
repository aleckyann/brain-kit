import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Absolute path of the brain-kit checkout or installed package.
export const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function kitVersion() {
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}
