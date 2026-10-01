#!/usr/bin/env node
// The launcher imports only the Node guard, statically, and asks it before
// anything else: on a Node older than package.json's `engines` the CLI below
// may fail to run, or fail somewhere inside src/ with an error nobody can act
// on, and importing it first is what left a person without a sentence saying
// so (src/node-guard.mjs). The CLI is loaded by a dynamic import(), and only
// once the guard has let the Node through.
//
// The whole path after the guard is awaited at the top level, as it was before
// the guard existed, and that is not style. A main() whose promise never
// settles lets the event loop empty with the await still pending, and Node then
// ends the process with exit code 13 ("unsettled top-level await"). The
// pre-push hook reads exit 0 of validate, lint and push-gate as a pass, and a
// scheduled round's exit 0 is a success to its timer, so a promise chain here
// (which ends that same process with 0, in silence) would fail open.
// test/node-guard.test.mjs holds the exit codes against the launcher that came
// before the guard. Top-level await needs Node 14.8, as that launcher did.
import { checkNodeVersion } from '../src/node-guard.mjs';

const refusal = checkNodeVersion(process.versions.node, process.argv[2], process.env);
if (refusal !== null) {
  process.stderr.write(refusal.message + '\n');
  process.exitCode = refusal.exitCode;
} else {
  const { main } = await import('../src/cli.mjs');
  process.exitCode = await main(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
