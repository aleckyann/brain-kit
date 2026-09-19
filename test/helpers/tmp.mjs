// One place that creates a temporary directory for a test, and removes it
// when the process ends.
//
// Why this exists rather than each test calling mkdtempSync itself: it did,
// and every call leaked. A machine running this suite through one slice
// accumulated more than twenty-four thousand directories and 2.7 GB, two
// implementers independently reported flakiness that traced back to it, and
// a reviewer's temporary filesystem filled MID-MUTATION-PASS and produced
// four false results, two of which were real survivors it then missed. A
// test helper that leaks eventually decides whether a run passes, and a
// suite whose answer depends on how many times it has run before is not
// evidence for anything.
//
// The removal is best effort by design. It runs on `exit`, which admits
// only synchronous work, and it swallows a failure to remove a directory a
// test deliberately made unreadable, because a cleanup that can fail a
// passing run is worse than one that occasionally leaves a directory
// behind. A run killed by a signal this handler never sees still leaks.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const created = [];
let registered = false;

export function makeTempDir(prefix) {
  if (!registered) {
    registered = true;
    process.on('exit', () => {
      for (const dir of created) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Deliberate: see the header.
        }
      }
    });
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
