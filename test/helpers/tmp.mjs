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
//
// WHAT THE TEMPORARY DIRECTORY'S FILE SYSTEM REFUSES. A probe, for the
// tests whose subject needs a file name that some file systems cannot
// hold. A test skips on what the probe finds on this machine, never on the
// name of the platform: ext4 holds any byte in a name, APFS (macOS)
// refuses a name that is not valid UTF-8, and a Linux machine can mount
// the second kind as a Mac can the first.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';

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

let nonUtf8Refusal;

// false when the temporary directory's file system takes a file name that
// is not valid UTF-8 ("caf" and the single byte 0xe9, Latin-1), and
// otherwise the reason it refused, for a test's skip message. Only the
// refusals that mean "this name cannot exist here" count; anything else
// (a full disk, a permission) is raised, so a machine in trouble never
// reads as one that skips.
export function nonUtf8NameRefusal() {
  if (nonUtf8Refusal === undefined) {
    const dir = makeTempDir('brain-kit-probe-bytes-');
    const name = Buffer.concat([Buffer.from(`${dir}/caf`), Buffer.from([0xe9])]);
    try {
      writeFileSync(name, '');
      rmSync(name);
      nonUtf8Refusal = false;
    } catch (error) {
      if (error.code !== 'EILSEQ' && error.code !== 'EINVAL') throw error;
      nonUtf8Refusal = `the file system of the temporary directory refuses a file name that is not valid UTF-8 (${error.code})`;
    }
  }
  return nonUtf8Refusal;
}
