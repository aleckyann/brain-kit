#!/usr/bin/env node
// The launcher imports only the Node guard, statically, and asks it before
// anything else: on a Node older than package.json's `engines` the CLI below
// cannot even be parsed, and importing it first is what used to end in a
// SyntaxError and a stack trace instead of a sentence (src/node-guard.mjs).
// The CLI is loaded by a dynamic import(), and only once the guard has let the
// Node through. This file is written for the Node it must refuse as much as
// for the one it serves: no top-level await, no optional chaining.
import { checkNodeVersion } from '../src/node-guard.mjs';

var refusal = checkNodeVersion(process.versions.node, process.argv[2], process.env);
if (refusal !== null) {
  process.stderr.write(refusal.message + '\n');
  process.exitCode = refusal.exitCode;
} else {
  import('../src/cli.mjs')
    .then(function (cli) {
      return cli.main(process.argv.slice(2), {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });
    })
    .then(function (code) {
      process.exitCode = code;
    });
}
