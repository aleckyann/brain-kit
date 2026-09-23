// A separate process that watches the lock's name as fast as it can, and
// counts every look that finds nothing there. A reclaim that replaces the
// lock by rename leaves the name occupied at every instant; one that
// deletes and then creates leaves a gap, and a gap is exactly where a
// second writer gets in. No seam in the lock can show that gap, because it
// lies between two system calls; a second process looking at the same time
// can.
//
// Configured through one JSON argument: { lockPath, readyFile, stopFile }.
// Writes readyFile once it is looking, stops once stopFile exists, and
// prints one JSON line: { looks, gaps }.
import { existsSync, lstatSync, writeFileSync } from 'node:fs';

// `node --test` runs every file under test/, this one included, with no
// argument: then there is nothing to do.
if (process.argv[2] === undefined) process.exit(0);

const { lockPath, readyFile, stopFile } = JSON.parse(process.argv[2]);
const deadline = Date.now() + 30000;
let looks = 0;
let gaps = 0;
writeFileSync(readyFile, '');
for (;;) {
  try {
    lstatSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    gaps += 1;
  }
  looks += 1;
  if (looks % 256 === 0 && (existsSync(stopFile) || Date.now() > deadline)) break;
}
process.stdout.write(`${JSON.stringify({ looks, gaps })}\n`);
