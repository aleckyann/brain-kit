# brain-kit Phase 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `brain-kit` repository as an npm package that is also a Claude Code plugin and marketplace, with the CLI router, language packs, config schemas, the maintainer's anti-leak pre-push gate, CI, the public design docs, and a reserved `0.0.1` on npm.

**Architecture:** One repository serves three roles with the same files (npm package via `package.json#bin`, Claude Code plugin via `.claude-plugin/plugin.json` + `hooks/`, marketplace via `.claude-plugin/marketplace.json`). A single executable `bin/brain-kit.mjs` routes to `src/commands/*`. The engine is plain Node 24 ESM with zero runtime dependencies. Phase 0 ships only the skeleton, contracts (exit codes, schemas, language packs) and safety gates; the vault logic lands in Phase 1.

**Tech Stack:** Node.js >= 24 (ESM, `node:test`, `node:child_process`), bash (pre-push hook, hook wrapper), GitHub Actions, npm registry, Claude Code CLI 2.1.270+ (`claude plugin validate --strict`, `claude --plugin-dir`).

**Spec:** the approved design lives (privately, on the maintainer's machine) at `/home/aleck/.claude/plans/ultracode-ao-mostrar-o-hazy-rain.md`. The public, scrubbed rationale is produced by Task 9 of this plan (`docs/rationale.md`, `docs/incidents.md`).

## Global Constraints

- Node `>=24`, ESM only (`.mjs`), `"type": "module"`. `dependencies` and `devDependencies` stay empty; a test enforces it.
- Never build shell command strings: use `execFileSync`/`spawnSync` with argument arrays.
- No household data anywhere in this repository: no company name, no colleague or client names, no real e-mail addresses. Example data uses the fictional owner "Ana" and `@example.com`. The maintainer's own name "Aleck Yann" and handle `aleckyann` are public author metadata and are allowed.
- Code, identifiers, docs, commit messages: English. `lang/pt-BR` is the reference message pack; `lang/en` mirrors it key for key. pt-BR values contain no em dash (U+2014) and no emoji.
- Exit codes are fixed: `0` ok, `1` failure, `2` usage or not inside a vault, `3` degraded, `4` required source unread, `69` unavailable (network/connector), `75` postponed (tempfail).
- Phase 0 hooks are silent no-ops (consume stdin, print nothing, exit 0). Anything else would block every Claude Code session with the plugin enabled.
- Commits: conventional prefix (`chore:`, `feat:`, `test:`, `docs:`, `ci:`), body optional, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- The pre-push gate (Task 6) must be active before the first `git push` (Task 11).
- Work happens in `/home/aleck/Área de trabalho/brain-kit`. Run commands from that directory.

---

### Task 1: Repository skeleton

**Files:**
- Create: `package.json`
- Create: `LICENSE`
- Create: `.gitignore`

**Interfaces:**
- Produces: `package.json#version` (read by `src/version.mjs` in Task 3 and by the manifest tests in Task 7), `package.json#bin.brain-kit = ./bin/brain-kit.mjs`.

- [ ] **Step 1: Initialize git**

```bash
cd "/home/aleck/Área de trabalho/brain-kit"
git init -q -b main
git config user.name "Aleck Yann"
git config user.email "aleckyann@gmail.com"
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "brain-kit",
  "version": "0.0.1",
  "description": "Second brain kit: an OKF markdown vault curated by AI agents through pull requests, packaged as an npm CLI and a Claude Code plugin",
  "type": "module",
  "license": "MIT",
  "author": "Aleck Yann",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/aleckyann/brain-kit.git"
  },
  "homepage": "https://github.com/aleckyann/brain-kit#readme",
  "bugs": "https://github.com/aleckyann/brain-kit/issues",
  "keywords": [
    "second-brain",
    "okf",
    "open-knowledge-format",
    "llm-wiki",
    "knowledge-base",
    "markdown",
    "claude-code",
    "claude-code-plugin"
  ],
  "bin": {
    "brain-kit": "./bin/brain-kit.mjs"
  },
  "engines": {
    "node": ">=24"
  },
  "files": [
    "bin/",
    "src/",
    "lang/",
    "schema/",
    "templates/",
    "vendor/",
    "skills/",
    "agents/",
    "hooks/",
    ".claude-plugin/",
    "docs/",
    "README.md",
    "README.pt-BR.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md"
  ],
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

- [ ] **Step 3: Write `LICENSE`** (MIT, verbatim text with this header line)

```
MIT License

Copyright (c) 2026 Aleck Yann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Write `.gitignore`**

```
# Installed packages: the engine has zero runtime dependencies on purpose.
node_modules/
# No lockfile: a lockfile in the plugin root would make Claude Code run
# `npm ci` when it caches the plugin, for nothing.
package-lock.json
# npm pack output
*.tgz
# OS noise
.DS_Store
```

- [ ] **Step 5: Verify and commit**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json ok')"`
Expected: `package.json ok`

```bash
git add package.json LICENSE .gitignore
git commit -q -m "chore: scaffold brain-kit package" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Language packs and translator

**Files:**
- Create: `src/version.mjs`
- Create: `src/lang.mjs`
- Create: `lang/pt-BR/messages.json`
- Create: `lang/en/messages.json`
- Test: `test/lang.test.mjs`

**Interfaces:**
- Produces: `KIT_ROOT` (absolute path of the repo) and `kitVersion()` from `src/version.mjs`; `createTranslator(lang, { warn, packs })` returning `t(key, vars)`, plus `REFERENCE_LANG`, `SUPPORTED_LANGS`, `loadMessages(lang)`, `interpolate(text, vars)` from `src/lang.mjs`.
- Message keys used later: `cli.usage`, `cli.unknown_command`, `hook.unknown_event`, `lang.fallback_warning`.

- [ ] **Step 1: Write the failing test `test/lang.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT, kitVersion } from '../src/version.mjs';
import { createTranslator, loadMessages, interpolate, REFERENCE_LANG, SUPPORTED_LANGS } from '../src/lang.mjs';

const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('kitVersion matches package.json', () => {
  assert.equal(kitVersion(), pkg.version);
});

test('every supported pack has the same keys as the reference pack', () => {
  const reference = loadMessages(REFERENCE_LANG);
  for (const lang of SUPPORTED_LANGS) {
    const pack = loadMessages(lang);
    assert.deepEqual(Object.keys(pack).sort(), Object.keys(reference).sort(), `key set differs in ${lang}`);
    for (const key of Object.keys(reference)) {
      assert.equal(typeof pack[key], 'string', `${lang}.${key} must be a string`);
      assert.ok(pack[key].length > 0, `${lang}.${key} must not be empty`);
      assert.deepEqual(placeholders(pack[key]), placeholders(reference[key]), `placeholders differ for ${lang}.${key}`);
    }
  }
});

test('pt-BR values contain no em dash and no emoji', () => {
  for (const [key, value] of Object.entries(loadMessages('pt-BR'))) {
    assert.doesNotMatch(value, /—/, `${key} contains an em dash`);
    assert.doesNotMatch(value, /\p{Extended_Pictographic}/u, `${key} contains an emoji`);
  }
});

test('interpolate replaces known placeholders and keeps unknown ones', () => {
  assert.equal(interpolate('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
});

test('translator returns the requested language', () => {
  const t = createTranslator('en');
  assert.match(t('cli.unknown_command', { command: 'zzz' }), /zzz/);
});

test('translator falls back to the reference pack and warns once', () => {
  const warnings = [];
  const packs = {
    'pt-BR': { 'lang.fallback_warning': 'fallback {key} {lang} {reference}', 'only.here': 'so em pt-BR', 'shared': 'compartilhado' },
    en: { 'lang.fallback_warning': 'fallback {key} {lang} {reference}', shared: 'shared' },
  };
  const t = createTranslator('en', { warn: (m) => warnings.push(m), packs });
  assert.equal(t('only.here'), 'so em pt-BR');
  assert.equal(t('only.here'), 'so em pt-BR');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /only\.here/);
});

test('translator throws on an unknown key', () => {
  const t = createTranslator('pt-BR');
  assert.throws(() => t('does.not.exist'), /Unknown message key/);
});

test('unsupported language falls back to the reference pack with a warning', () => {
  const warnings = [];
  const t = createTranslator('xx', { warn: (m) => warnings.push(m) });
  assert.match(t('cli.unknown_command', { command: 'q' }), /q/);
  assert.equal(warnings.length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/lang.test.mjs`
Expected: FAIL (cannot find module `../src/version.mjs`).

- [ ] **Step 3: Write `src/version.mjs`**

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Absolute path of the brain-kit checkout or installed package.
export const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function kitVersion() {
  const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}
```

- [ ] **Step 4: Write `lang/pt-BR/messages.json`**

```json
{
  "cli.usage": "brain-kit {version}\n\nUso: brain-kit <comando> [opções]\n\nComandos disponíveis nesta versão:\n  hook <stop|session-start>   ponto de entrada dos hooks do plugin do Claude Code (lê o evento em JSON pelo stdin)\n  --version                   imprime a versão\n  --help                      imprime esta ajuda\n\nCódigos de saída: 0 ok, 1 falha, 2 uso ou fora de um vault, 3 degradado, 4 fonte obrigatória não lida, 69 rede ou conector indisponível, 75 adiado (tente de novo).",
  "cli.unknown_command": "brain-kit: comando desconhecido \"{command}\".",
  "hook.unknown_event": "brain-kit hook: evento desconhecido \"{event}\" (esperado: {events}).",
  "lang.fallback_warning": "[brain-kit] tradução ausente para \"{key}\" em {lang}; usando {reference}."
}
```

Accented UTF-8 is expected in pt-BR; only the em dash (U+2014) and emoji are forbidden.

- [ ] **Step 5: Write `lang/en/messages.json`**

```json
{
  "cli.usage": "brain-kit {version}\n\nUsage: brain-kit <command> [options]\n\nCommands available in this version:\n  hook <stop|session-start>   entry point for the Claude Code plugin hooks (reads the event JSON from stdin)\n  --version                   print the version\n  --help                      print this help\n\nExit codes: 0 ok, 1 failure, 2 usage or not inside a vault, 3 degraded, 4 required source not read, 69 network or connector unavailable, 75 postponed (retry later).",
  "cli.unknown_command": "brain-kit: unknown command \"{command}\".",
  "hook.unknown_event": "brain-kit hook: unknown event \"{event}\" (expected: {events}).",
  "lang.fallback_warning": "[brain-kit] missing translation for \"{key}\" in {lang}; using {reference}."
}
```

- [ ] **Step 6: Write `src/lang.mjs`**

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from './version.mjs';

// pt-BR is the reference pack: it is the language the original vault runs in
// and the one every message was tested against. en mirrors it key for key.
export const REFERENCE_LANG = 'pt-BR';
export const SUPPORTED_LANGS = Object.freeze(['pt-BR', 'en']);

const cache = new Map();

export function loadMessages(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) {
    throw new Error(`Unsupported language "${lang}" (supported: ${SUPPORTED_LANGS.join(', ')})`);
  }
  if (!cache.has(lang)) {
    cache.set(lang, JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'messages.json'), 'utf8')));
  }
  return cache.get(lang);
}

export function interpolate(text, vars = {}) {
  return text.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

// createTranslator(lang, { warn, packs })
//   warn:  receives one string the first time a key falls back to the reference pack
//   packs: optional { [lang]: messages } used instead of the files on disk (tests)
export function createTranslator(lang = REFERENCE_LANG, { warn = () => {}, packs = null } = {}) {
  const load = (l) => (packs ? packs[l] : loadMessages(l));
  const reference = load(REFERENCE_LANG);
  let primary = reference;
  let warned = false;
  if (lang !== REFERENCE_LANG) {
    if (SUPPORTED_LANGS.includes(lang) && (!packs || packs[lang])) {
      primary = load(lang);
    } else {
      warned = true;
      warn(interpolate(reference['lang.fallback_warning'], { key: '*', lang, reference: REFERENCE_LANG }));
    }
  }
  return function t(key, vars = {}) {
    let text = primary[key];
    if (text === undefined) {
      text = reference[key];
      if (text === undefined) throw new Error(`Unknown message key "${key}"`);
      if (!warned) {
        warned = true;
        warn(interpolate(reference['lang.fallback_warning'], { key, lang, reference: REFERENCE_LANG }));
      }
    }
    return interpolate(text, vars);
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/lang.test.mjs`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/version.mjs src/lang.mjs lang/ test/lang.test.mjs
git commit -q -m "feat: language packs with pt-BR reference and en mirror" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: CLI entry point, exit codes and hook stubs

**Files:**
- Create: `bin/brain-kit.mjs`
- Create: `src/exit-codes.mjs`
- Create: `src/io.mjs`
- Create: `src/cli.mjs`
- Create: `src/commands/hook.mjs`
- Test: `test/cli.test.mjs`
- Test: `test/zero-deps.test.mjs`

**Interfaces:**
- Consumes: `createTranslator`, `REFERENCE_LANG` (Task 2), `kitVersion` (Task 2).
- Produces: `EXIT` constants; `main(argv, io) -> Promise<number>`; command handler signature `async (argv, io, t) -> number` where `io = { stdin, stdout, stderr }`; `readStdin(stream) -> Promise<string>`.

- [ ] **Step 1: Write the failing tests**

`test/cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

function run(args, input = '') {
  return spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8' });
}

test('--version prints the package.json version', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkg.version}\n`);
});

test('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain-kit/);
  assert.match(r.stdout, /hook/);
});

test('no arguments prints usage and exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /brain-kit/);
});

test('unknown command exits 2 with the command named on stderr', () => {
  const r = run(['definitely-not-a-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /definitely-not-a-command/);
  assert.equal(r.stdout, '');
});

test('BRAIN_KIT_LANG=en switches CLI messages', () => {
  const r = spawnSync(process.execPath, [BIN, 'nope'], { encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' } });
  assert.match(r.stderr, /unknown command/);
});

test('hook stop is a silent no-op in phase 0', () => {
  const r = run(['hook', 'stop'], JSON.stringify({ stop_hook_active: false, cwd: KIT_ROOT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook session-start is a silent no-op in phase 0', () => {
  const r = run(['hook', 'session-start'], JSON.stringify({ cwd: KIT_ROOT }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('hook with an unknown event exits 2', () => {
  const r = run(['hook', 'nope'], '{}');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
});
```

`test/zero-deps.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const pkg = JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8'));

test('package.json declares no runtime or dev dependencies', () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
});

test('package is ESM, targets Node 24 and exposes the brain-kit binary', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(pkg.bin['brain-kit'], './bin/brain-kit.mjs');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cli.test.mjs test/zero-deps.test.mjs`
Expected: zero-deps PASS; cli FAIL (bin file missing, status null).

- [ ] **Step 3: Write `src/exit-codes.mjs`**

```js
// Exit codes shared by every command. Where sysexits.h has a code, we use it.
export const EXIT = Object.freeze({
  OK: 0,             // completed, or an expected no-op (day already covered, lock held by a sibling run)
  FAILURE: 1,        // the command ran and found a problem, or died before doing its job
  USAGE: 2,          // bad arguments, or not inside a brain-kit vault
  DEGRADED: 3,       // partial success that needs a human step (commit made, PR not opened)
  SOURCE_UNREAD: 4,  // a source listed as required produced no evidence of being read
  UNAVAILABLE: 69,   // EX_UNAVAILABLE: no network or connector after waiting for it
  TEMPFAIL: 75,      // EX_TEMPFAIL: postponed on purpose (dirty tree, lock held); retry later
});
```

- [ ] **Step 4: Write `src/io.mjs`**

```js
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
```

- [ ] **Step 5: Write `src/commands/hook.mjs`**

```js
import { EXIT } from '../exit-codes.mjs';
import { readStdin } from '../io.mjs';

export const HOOK_EVENTS = Object.freeze(['stop', 'session-start']);

// Phase 0: the plugin ships the hook wiring before the vault logic exists.
// Until Phase 1 lands the vault sentinel and the dirty-tree check, every event
// is a deliberate no-op: consume the event JSON, print nothing, exit 0. A hook
// that printed anything here would block or pollute every Claude Code session
// that has the plugin enabled.
export async function runHook(argv, io, t) {
  const [event] = argv;
  if (!HOOK_EVENTS.includes(event)) {
    io.stderr.write(t('hook.unknown_event', { event: String(event), events: HOOK_EVENTS.join(', ') }) + '\n');
    return EXIT.USAGE;
  }
  await readStdin(io.stdin);
  return EXIT.OK;
}
```

- [ ] **Step 6: Write `src/cli.mjs`**

```js
import { EXIT } from './exit-codes.mjs';
import { kitVersion } from './version.mjs';
import { createTranslator, REFERENCE_LANG } from './lang.mjs';
import { runHook } from './commands/hook.mjs';

// command name -> async (argv, io, t) => exit code
const COMMANDS = new Map([
  ['hook', runHook],
]);

export async function main(argv, io) {
  const t = createTranslator(process.env.BRAIN_KIT_LANG || REFERENCE_LANG, {
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout.write(`${t('cli.usage', { version: kitVersion() })}\n`);
    return EXIT.OK;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    io.stdout.write(`${kitVersion()}\n`);
    return EXIT.OK;
  }
  const handler = COMMANDS.get(command);
  if (!handler) {
    io.stderr.write(`${t('cli.unknown_command', { command })}\n`);
    io.stderr.write(`${t('cli.usage', { version: kitVersion() })}\n`);
    return EXIT.USAGE;
  }
  return handler(rest, io, t);
}
```

- [ ] **Step 7: Write `bin/brain-kit.mjs`**

```js
#!/usr/bin/env node
import { main } from '../src/cli.mjs';

process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
```

Then: `chmod +x bin/brain-kit.mjs`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: all PASS (lang, cli, zero-deps).

- [ ] **Step 9: Commit**

```bash
git add bin/ src/ test/cli.test.mjs test/zero-deps.test.mjs
git commit -q -m "feat: cli router with exit codes and phase-0 hook stubs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Schema validator

**Files:**
- Create: `src/schema.mjs`
- Test: `test/schema.test.mjs`

**Interfaces:**
- Produces: `validateSchema(value, schema, path = '$') -> string[]` (empty array means valid). Supported keywords: `type` (string or array), `properties`, `required`, `additionalProperties` (boolean or schema), `enum`, `const`, `items`, `minimum`, `maximum`, `minLength`, `pattern`.

- [ ] **Step 1: Write the failing test `test/schema.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../src/schema.mjs';

test('accepts a matching object and reports nothing', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.deepEqual(validateSchema({ a: 'x' }, schema), []);
});

test('reports type mismatches with the JSON path', () => {
  const errors = validateSchema({ a: 1 }, { type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(errors, ['$.a: expected string, got number']);
});

test('reports missing required keys', () => {
  const errors = validateSchema({}, { type: 'object', required: ['a'] });
  assert.deepEqual(errors, ['$.a: required']);
});

test('rejects unknown keys when additionalProperties is false', () => {
  const errors = validateSchema({ a: 1, b: 2 }, { type: 'object', properties: { a: { type: 'number' } }, additionalProperties: false });
  assert.deepEqual(errors, ['$.b: unknown key']);
});

test('validates additionalProperties given as a schema', () => {
  const errors = validateSchema({ x: 1, y: 'no' }, { type: 'object', additionalProperties: { type: 'integer' } });
  assert.deepEqual(errors, ['$.y: expected integer, got string']);
});

test('checks enum, const, pattern, minLength, minimum and maximum', () => {
  assert.deepEqual(validateSchema('c', { enum: ['a', 'b'] }), ['$: must be one of ["a","b"]']);
  assert.deepEqual(validateSchema('0.3', { const: '0.2' }), ['$: must equal "0.2"']);
  assert.deepEqual(validateSchema('ab', { type: 'string', pattern: '^[0-9]+$' }), ['$: does not match /^[0-9]+$/']);
  assert.deepEqual(validateSchema('', { type: 'string', minLength: 1 }), ['$: must have at least 1 characters']);
  assert.deepEqual(validateSchema(0, { type: 'integer', minimum: 1 }), ['$: must be >= 1']);
  assert.deepEqual(validateSchema(9, { type: 'integer', maximum: 5 }), ['$: must be <= 5']);
});

test('validates array items with indexed paths', () => {
  const errors = validateSchema(['a', 2], { type: 'array', items: { type: 'string' } });
  assert.deepEqual(errors, ['$[1]: expected string, got number']);
});

test('accepts a union type and null', () => {
  const schema = { type: ['string', 'null'] };
  assert.deepEqual(validateSchema(null, schema), []);
  assert.deepEqual(validateSchema('x', schema), []);
  assert.deepEqual(validateSchema(1, schema), ['$: expected string or null, got number']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/schema.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/schema.mjs`**

```js
// Minimal JSON Schema subset validator with no dependencies. It supports the
// keywords brain-kit's own schemas use and nothing else: type (string or
// array), properties, required, additionalProperties (boolean or schema),
// enum, const, items, minimum, maximum, minLength, pattern.
// Returns an array of "path: message" strings; an empty array means valid.
export function validateSchema(value, schema, path = '$') {
  const errors = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${describe(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((candidate) => sameJson(candidate, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && !sameJson(schema.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must have at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match /${schema.pattern}/`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(value)) {
      if (key in properties) {
        errors.push(...validateSchema(sub, properties[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unknown key`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validateSchema(sub, schema.additionalProperties, `${path}.${key}`));
      }
    }
  }
  return errors;
}

function matchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isPlainObject(value);
    default: return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/schema.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schema.mjs test/schema.test.mjs
git commit -q -m "feat: dependency-free JSON schema subset validator" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Config and machine schemas, config loader

**Files:**
- Create: `schema/config.schema.json`
- Create: `schema/machine.schema.json`
- Create: `src/config.mjs`
- Create: `test/fixtures/config/valid.json`
- Create: `test/fixtures/config/with-machine-key.json`
- Create: `test/fixtures/machine/valid.json`
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: `validateSchema` (Task 4), `KIT_ROOT` (Task 2).
- Produces: `CONFIG_FILENAME = 'brain-kit.config.json'`, `MACHINE_FILENAME = 'machine.json'`, `MACHINE_ONLY_KEYS`, `findMachineOnlyKeys(value)`, `validateConfig(config) -> string[]`, `validateMachine(machine) -> string[]`, `loadConfig(vaultDir)`, `loadMachine(stateDir)`, `class ConfigError extends Error { errors: string[] }`.

- [ ] **Step 1: Write the fixtures**

`test/fixtures/config/valid.json` (fictional owner, example.com addresses):

```json
{
  "$schema": "https://raw.githubusercontent.com/aleckyann/brain-kit/main/schema/config.schema.json",
  "kit_version": "0.0.1",
  "lang": "pt-BR",
  "okf_version": "0.2",
  "owner": { "name": "Ana", "handle": "ana", "email": "ana@example.com", "role": "founder", "company": "Example Ltd", "agent_role": "advisor and chief of staff" },
  "vault": { "title": "Ana's Second Brain", "repo": "ana/brain", "private": true, "default_branch": null, "timezone": "America/Sao_Paulo", "locale": "C.UTF-8" },
  "actors": { "human": "human:ana", "agent_prefix": "brain-kit-curator", "scheduled": "process:brain-kit-curate" },
  "taxonomy": {
    "collections": {
      "pessoas": { "type": "pessoa", "template": "templates/template-pessoa.md" },
      "organizacoes": { "type": "organizacao", "template": "templates/template-organizacao.md" },
      "projetos": { "type": "projeto", "template": "templates/template-projeto.md" },
      "decisoes": { "type": "decisao", "template": "templates/template-decisao.md", "filename_pattern": "YYYY-MM-<slug>" },
      "referencias/livros": { "type": "livro", "template": "templates/template-livro.md" }
    },
    "domains": ["nucleo", "empresa", "memoria", "pendencias", "pessoal", "reflexoes", "referencias"],
    "no_index": [],
    "log": "memoria/log.md",
    "log_markers": { "capture": "Captura", "promoted": "Promovido", "correction": "Correção", "creation": "Criação" },
    "templates_dir": "templates",
    "attachments_dir": "anexos",
    "files": {
      "followups": "pendencias/follow-ups.md",
      "promises": "pendencias/promessas.md",
      "rituals": "nucleo/ritmo-semanal.md",
      "execution_system": "nucleo/sistema-de-execucao.md",
      "style_guide": "nucleo/diretrizes-de-resposta.md",
      "bootstrap": "BOOTSTRAP.md",
      "strategy_index": "decisoes/index.md",
      "metrics": "empresa/metricas-e-metas.md",
      "glossary": null
    },
    "columns": {
      "followups": { "registered": "Registrado", "what": "O quê", "with": "Com quem / onde", "deadline": "Prazo", "next_step": "Próximo passo", "open_heading": "## Abertos", "resolved_heading": "## Resolvidos" },
      "promises": { "made_at": "Feita em", "to": "Para quem", "what": "O que prometi", "condition": "Condição / prazo", "status": "Status", "active_heading": "## Ativas", "done_heading": "## Cumpridas / renegociadas" },
      "rituals": { "calendar_title": "Título no calendário", "cadence": "Cadência", "time": "Horário", "owner": "Dono", "fixed_attendees": "Participantes fixos", "feeds": "Alimenta", "feeds_none": "nenhuma ainda" }
    }
  },
  "frontmatter": {
    "required": ["description", "generated"],
    "forbidden": ["timestamp"],
    "type_enum": null,
    "extensions": {
      "confidencial": { "type": "boolean", "default": false },
      "situacao": { "type": "enum", "values_by_type": { "decisao": ["aberta", "em-execucao", "concluida", "revertida"], "projeto": ["ativo", "ideia", "adiado", "concluido", "arquivado"] } },
      "vinculo": { "type": "enum", "values": ["equipe", "familia", "mentor", "externo"], "default": "equipe" },
      "autor": { "type": "string" },
      "lido": { "type": "string" },
      "data": { "type": "date" },
      "idioma": { "type": "string" }
    }
  },
  "stale_policy": { "key": "path", "months": { "pessoas/": 6, "organizacoes/": 12, "pendencias/": 3 } },
  "validate": { "stale_after_format": "datetime", "link_style": "file-relative", "wikilinks": "forbid", "require_root_okf_version": false, "placeholder_pattern": "<[^>]+>", "ignore_paths": [] },
  "lint": {
    "columns": "error", "tables": "error", "orphans": "warn", "index_completeness": "warn", "secrets": "error", "privacy": "error", "attribution": "warn",
    "style": { "forbidden_chars": ["—"], "base": "auto" },
    "tables_limits": { "max_cell_chars": 600, "duplicate_rows": "error" }
  },
  "privacy": {
    "confidential_dirs": ["pessoas/", "pessoal/"],
    "require_private_repo": true,
    "secret_patterns": ["ghp_[A-Za-z0-9]{20,}", "github_pat_", "sk-ant-", "BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY", "AKIA[0-9A-Z]{16}"],
    "third_party_data_acknowledged": true,
    "retention_note": "pessoas/ holds personal data about third parties; removal on request: see SECURITY.md",
    "audiences": {}
  },
  "git": { "agent_identity": { "name": "Ana's Second Brain (curator)", "email": "curator@example.invalid" }, "branch_prefix": "curador/", "commit_prefix": "curadoria:", "pr_command": "gh", "pr_title": "{{commit_prefix}} {{summary}}", "pr_body": ".brain-kit/pr-body.md", "ci": "github-actions", "ci_engine_ref": null, "forbid_agent_push_to_default": true },
  "hooks": { "stop": true, "session_start": true, "session_start_fetch": false, "block_on_inherited_dirt": false, "timeout_seconds": 15 },
  "curate": {
    "enabled": true, "schedule": ["09:30", "14:00", "20:00"], "prompt": ".brain-kit/prompts/curate.md", "signature": "Curador do segundo cérebro",
    "max_turns": 100, "budget_usd": 5.0, "network_min_wait_ms": 100,
    "caps": { "transcripts": 20, "search_docs_opened": 3, "attached_notes_opened": 6, "new_pending_items": 5 },
    "promotion_map": { "owner_action": "pendencias/follow-ups.md", "owner_promise": "pendencias/promessas.md", "third_party_strategic": "pendencias/follow-ups.md", "third_party_operational": "log-only", "strategic_decision": "decisoes/", "decision_needs_talk": "pendencias/follow-ups.md", "org_fact": "organizacoes/", "person_fact": "pessoas/", "ritual_change": "nucleo/ritmo-semanal.md" },
    "sources": { "required": ["transcripts"], "best_effort": ["calendar", "meeting_notes"] },
    "extra_signatures": [], "allowed_tools_extra": [], "disallowed_tools_extra": []
  },
  "sources": {
    "transcripts": { "adapter": "claude-code", "include_projects": ["-home-ana-brain"], "exclude_path_patterns": ["/-tmp-", "--claude-worktrees-"], "sample_strategy": "tail-first" },
    "calendar": { "provider": "claude-connector-google-calendar", "server_display_name": "claude.ai Google Calendar", "tool_prefix": "mcp__claude_ai_Google_Calendar__", "tool_suffixes": ["list_events", "list_calendars"], "calendars": ["ana@example.com"], "team_calendars": [], "team_calendars_consent_noted": false, "skip_events_with_owner": true, "dedup_by": "eventId", "privacy": { "exclude_event_types": ["OUT_OF_OFFICE", "FOCUS_TIME"], "exclude_keywords": ["consulta", "médico", "saúde"], "team_personal_events": "drop" }, "focus_blocks_as_ruler": true },
    "meeting_notes": { "provider": "claude-connector-google-drive", "server_display_name": "claude.ai Google Drive", "tool_prefix": "mcp__claude_ai_Google_Drive__", "tool_suffixes": ["search_files", "read_file_content"], "search_title_contains": "Anotações do Gemini", "attached_title_prefix": "Notas - ", "window_hours_before_day": 12, "dedup_by": "literal-title-in-log", "never_download": ["recording", "full_transcript"] }
  },
  "briefing": { "enabled": true, "schedule": "40 8 * * 1-5", "prompt": ".brain-kit/prompts/briefing.md", "signature": "Briefing matinal do segundo cérebro", "max_words": 500, "max_questions": 3, "questions_dedup_days": 15, "question_escalate_after": 3, "question_max_age_days": 45, "write_caps": { "captures": 5, "pending_changes": 3 }, "strategy_doc": { "index": "decisoes/index.md", "title_contains": "carta" }, "main_metric": "MRR", "calendar_id": "ana@example.com", "read": ["index.md", "AGENTS.md", "decisoes/index.md", "pendencias/promessas.md", "projetos/index.md", "nucleo/ritmo-semanal.md"], "never_read": ["pessoas/", "organizacoes/", "anexos/", ".brain-kit/", "memoria/log.md#inteiro"] }
}
```

`test/fixtures/config/with-machine-key.json`: copy `valid.json` and add `"claude_bin": "claude"` inside the `curate` object.

`test/fixtures/machine/valid.json`:

```json
{
  "vault_id": "ana-brain",
  "canonical_path": "/home/ana/brain",
  "claude_bin": "claude",
  "model": "claude-opus-4-8",
  "network_check": ["nm-online", "-q", "--timeout=90"],
  "notify_command": ["notify-send", "-u", "normal", "{title}", "{body}"],
  "path_extra": ["~/.npm-global/bin", "~/.local/bin"],
  "transcripts_dir": "~/.claude/projects",
  "paths": { "lock": "curate.lock", "watermark": "watermark.json", "last_run": "last-run.json", "log_dir": "logs", "questions_log": "questions.tsv", "snapshot": "snapshot.json", "viz": "viz.html" },
  "log_retention_days": 30,
  "keep_stream": false,
  "briefing_task_id": null
}
```

- [ ] **Step 2: Write the failing test `test/config.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { validateConfig, validateMachine, findMachineOnlyKeys, loadConfig, ConfigError, CONFIG_FILENAME } from '../src/config.mjs';

const fixture = (name) => JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', name), 'utf8'));

test('the example config is valid', () => {
  assert.deepEqual(validateConfig(fixture('config/valid.json')), []);
});

test('a machine-only key anywhere in the versioned config is rejected', () => {
  const errors = validateConfig(fixture('config/with-machine-key.json'));
  assert.ok(errors.some((e) => e.startsWith('$.curate.claude_bin: machine-only key')), errors.join('\n'));
});

test('findMachineOnlyKeys reports nested paths', () => {
  assert.deepEqual(findMachineOnlyKeys({ a: { notify_command: ['x'] }, b: [{ model: 'm' }] }), ['$.a.notify_command', '$.b[0].model']);
});

test('unknown top-level keys and bad enums are reported', () => {
  const config = fixture('config/valid.json');
  config.lang = 'xx';
  config.surprise = true;
  const errors = validateConfig(config);
  assert.ok(errors.includes('$.lang: must be one of ["pt-BR","en"]'), errors.join('\n'));
  assert.ok(errors.includes('$.surprise: unknown key'), errors.join('\n'));
});

test('curate.schedule entries must be HH:MM', () => {
  const config = fixture('config/valid.json');
  config.curate.schedule = ['9h30'];
  assert.ok(validateConfig(config).some((e) => e.startsWith('$.curate.schedule[0]')));
});

test('the example machine.json is valid and canonical_path is required', () => {
  const machine = fixture('machine/valid.json');
  assert.deepEqual(validateMachine(machine), []);
  delete machine.canonical_path;
  assert.deepEqual(validateMachine(machine), ['$.canonical_path: required']);
});

test('loadConfig fails clearly outside a vault', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-kit-'));
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && /Not a brain-kit vault/.test(e.message));
});

test('loadConfig exposes schema errors on the thrown ConfigError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-kit-'));
  writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ kit_version: '0.0.1' }));
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && e.errors.includes('$.lang: required'));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 4: Write `schema/config.schema.json`**

Rules for writing it: `additionalProperties: false` on every object that has a fixed key set; every key present in `test/fixtures/config/valid.json` is declared; all top-level sections are `required`; enums exactly as listed here. Skeleton with every declaration:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/aleckyann/brain-kit/main/schema/config.schema.json",
  "title": "brain-kit vault configuration (declarative, versioned in the vault)",
  "type": "object",
  "additionalProperties": false,
  "required": ["kit_version", "lang", "okf_version", "owner", "vault", "actors", "taxonomy", "frontmatter", "stale_policy", "validate", "lint", "privacy", "git", "hooks", "curate", "sources", "briefing"],
  "properties": {
    "$schema": { "type": "string" },
    "kit_version": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+" },
    "lang": { "type": "string", "enum": ["pt-BR", "en"] },
    "okf_version": { "type": "string", "enum": ["0.2"] },
    "owner": {
      "type": "object", "additionalProperties": false, "required": ["name", "handle"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "handle": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
        "email": { "type": ["string", "null"], "pattern": "^[^@\\s]+@[^@\\s]+$" },
        "role": { "type": ["string", "null"] },
        "company": { "type": ["string", "null"] },
        "agent_role": { "type": ["string", "null"] }
      }
    },
    "vault": {
      "type": "object", "additionalProperties": false, "required": ["title", "private", "timezone"],
      "properties": {
        "title": { "type": "string", "minLength": 1 },
        "repo": { "type": ["string", "null"], "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
        "private": { "type": "boolean" },
        "default_branch": { "type": ["string", "null"] },
        "timezone": { "type": "string", "minLength": 1 },
        "locale": { "type": "string" }
      }
    },
    "actors": {
      "type": "object", "additionalProperties": false, "required": ["human", "agent_prefix", "scheduled"],
      "properties": {
        "human": { "type": "string", "pattern": "^human:[a-z0-9][a-z0-9-]*$" },
        "agent_prefix": { "type": "string", "minLength": 1 },
        "scheduled": { "type": "string", "pattern": "^process:[a-z0-9][a-z0-9-]*$" }
      }
    },
    "taxonomy": {
      "type": "object", "additionalProperties": false,
      "required": ["collections", "domains", "log", "log_markers", "templates_dir", "files", "columns"],
      "properties": {
        "collections": {
          "type": "object",
          "additionalProperties": {
            "type": "object", "additionalProperties": false, "required": ["type"],
            "properties": { "type": { "type": "string" }, "template": { "type": "string" }, "filename_pattern": { "type": "string" } }
          }
        },
        "domains": { "type": "array", "items": { "type": "string" } },
        "no_index": { "type": "array", "items": { "type": "string" } },
        "log": { "type": "string", "minLength": 1 },
        "log_markers": {
          "type": "object", "additionalProperties": false, "required": ["capture", "promoted", "correction", "creation"],
          "properties": { "capture": { "type": "string" }, "promoted": { "type": "string" }, "correction": { "type": "string" }, "creation": { "type": "string" } }
        },
        "templates_dir": { "type": "string" },
        "attachments_dir": { "type": "string" },
        "files": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "followups": { "type": ["string", "null"] }, "promises": { "type": ["string", "null"] }, "rituals": { "type": ["string", "null"] },
            "execution_system": { "type": ["string", "null"] }, "style_guide": { "type": ["string", "null"] }, "bootstrap": { "type": ["string", "null"] },
            "strategy_index": { "type": ["string", "null"] }, "metrics": { "type": ["string", "null"] }, "glossary": { "type": ["string", "null"] }
          }
        },
        "columns": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "followups": { "type": "object", "additionalProperties": { "type": "string" } },
            "promises": { "type": "object", "additionalProperties": { "type": "string" } },
            "rituals": { "type": "object", "additionalProperties": { "type": "string" } }
          }
        }
      }
    },
    "frontmatter": {
      "type": "object", "additionalProperties": false, "required": ["required", "forbidden"],
      "properties": {
        "required": { "type": "array", "items": { "type": "string" } },
        "forbidden": { "type": "array", "items": { "type": "string" } },
        "type_enum": { "type": ["array", "null"], "items": { "type": "string" } },
        "extensions": {
          "type": "object",
          "additionalProperties": {
            "type": "object", "additionalProperties": false, "required": ["type"],
            "properties": {
              "type": { "type": "string", "enum": ["string", "boolean", "enum", "date", "number"] },
              "values": { "type": "array", "items": { "type": "string" } },
              "values_by_type": { "type": "object", "additionalProperties": { "type": "array", "items": { "type": "string" } } },
              "default": {}
            }
          }
        }
      }
    },
    "stale_policy": {
      "type": "object", "additionalProperties": false, "required": ["key", "months"],
      "properties": {
        "key": { "type": "string", "enum": ["path", "type"] },
        "months": { "type": "object", "additionalProperties": { "type": "integer", "minimum": 1 } }
      }
    },
    "validate": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "stale_after_format": { "type": "string", "enum": ["date", "datetime", "any"] },
        "link_style": { "type": "string", "enum": ["file-relative", "bundle-absolute", "any"] },
        "wikilinks": { "type": "string", "enum": ["forbid", "allow"] },
        "require_root_okf_version": { "type": "boolean" },
        "placeholder_pattern": { "type": "string" },
        "ignore_paths": { "type": "array", "items": { "type": "string" } }
      }
    },
    "lint": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "columns": { "type": "string", "enum": ["error", "warn", "off"] },
        "tables": { "type": "string", "enum": ["error", "warn", "off"] },
        "orphans": { "type": "string", "enum": ["error", "warn", "off"] },
        "index_completeness": { "type": "string", "enum": ["error", "warn", "off"] },
        "secrets": { "type": "string", "enum": ["error", "warn", "off"] },
        "privacy": { "type": "string", "enum": ["error", "warn", "off"] },
        "attribution": { "type": "string", "enum": ["error", "warn", "off"] },
        "style": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "forbidden_chars": { "type": "array", "items": { "type": "string" } },
            "base": { "type": "string", "enum": ["auto", "worktree", "merge-base", "all"] }
          }
        },
        "tables_limits": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "max_cell_chars": { "type": "integer", "minimum": 1 },
            "duplicate_rows": { "type": "string", "enum": ["error", "warn", "off"] }
          }
        }
      }
    },
    "privacy": {
      "type": "object", "additionalProperties": false, "required": ["confidential_dirs", "require_private_repo"],
      "properties": {
        "confidential_dirs": { "type": "array", "items": { "type": "string" } },
        "require_private_repo": { "type": "boolean" },
        "secret_patterns": { "type": "array", "items": { "type": "string" } },
        "third_party_data_acknowledged": { "type": "boolean" },
        "retention_note": { "type": "string" },
        "audiences": { "type": "object" }
      }
    },
    "git": {
      "type": "object", "additionalProperties": false, "required": ["agent_identity", "branch_prefix", "commit_prefix", "pr_command"],
      "properties": {
        "agent_identity": {
          "type": "object", "additionalProperties": false, "required": ["name", "email"],
          "properties": { "name": { "type": "string", "minLength": 1 }, "email": { "type": "string", "pattern": "^[^@\\s]+@[^@\\s]+$" } }
        },
        "branch_prefix": { "type": "string", "minLength": 1 },
        "commit_prefix": { "type": "string" },
        "pr_command": { "type": "string", "enum": ["gh"] },
        "pr_title": { "type": "string" },
        "pr_body": { "type": "string" },
        "ci": { "type": "string", "enum": ["github-actions", "none"] },
        "ci_engine_ref": { "type": ["string", "null"] },
        "forbid_agent_push_to_default": { "type": "boolean" }
      }
    },
    "hooks": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "stop": { "type": "boolean" }, "session_start": { "type": "boolean" }, "session_start_fetch": { "type": "boolean" },
        "block_on_inherited_dirt": { "type": "boolean" }, "timeout_seconds": { "type": "integer", "minimum": 1 }
      }
    },
    "curate": {
      "type": "object", "additionalProperties": false, "required": ["enabled", "schedule", "prompt", "signature", "sources"],
      "properties": {
        "enabled": { "type": "boolean" },
        "schedule": { "type": "array", "items": { "type": "string", "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$" } },
        "prompt": { "type": "string" },
        "signature": { "type": "string", "minLength": 1 },
        "max_turns": { "type": "integer", "minimum": 1 },
        "budget_usd": { "type": "number", "minimum": 0 },
        "network_min_wait_ms": { "type": "integer", "minimum": 0 },
        "caps": { "type": "object", "additionalProperties": { "type": "integer", "minimum": 0 } },
        "promotion_map": { "type": "object", "additionalProperties": { "type": "string" } },
        "sources": {
          "type": "object", "additionalProperties": false, "required": ["required", "best_effort"],
          "properties": {
            "required": { "type": "array", "items": { "type": "string" } },
            "best_effort": { "type": "array", "items": { "type": "string" } }
          }
        },
        "extra_signatures": { "type": "array", "items": { "type": "string" } },
        "allowed_tools_extra": { "type": "array", "items": { "type": "string" } },
        "disallowed_tools_extra": { "type": "array", "items": { "type": "string" } }
      }
    },
    "sources": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "transcripts": {
          "type": "object", "additionalProperties": false, "required": ["adapter", "include_projects"],
          "properties": {
            "adapter": { "type": "string", "enum": ["claude-code"] },
            "include_projects": { "type": "array", "items": { "type": "string" } },
            "exclude_path_patterns": { "type": "array", "items": { "type": "string" } },
            "sample_strategy": { "type": "string", "enum": ["tail-first"] }
          }
        },
        "calendar": {
          "type": "object", "additionalProperties": false, "required": ["provider", "server_display_name", "tool_prefix", "tool_suffixes", "calendars"],
          "properties": {
            "provider": { "type": "string" }, "server_display_name": { "type": "string" }, "tool_prefix": { "type": "string" },
            "tool_suffixes": { "type": "array", "items": { "type": "string" } },
            "calendars": { "type": "array", "items": { "type": "string" } },
            "team_calendars": { "type": "array", "items": { "type": "string" } },
            "team_calendars_consent_noted": { "type": "boolean" },
            "skip_events_with_owner": { "type": "boolean" },
            "dedup_by": { "type": "string" },
            "privacy": {
              "type": "object", "additionalProperties": false,
              "properties": {
                "exclude_event_types": { "type": "array", "items": { "type": "string" } },
                "exclude_keywords": { "type": "array", "items": { "type": "string" } },
                "team_personal_events": { "type": "string", "enum": ["drop"] }
              }
            },
            "focus_blocks_as_ruler": { "type": "boolean" }
          }
        },
        "meeting_notes": {
          "type": "object", "additionalProperties": false, "required": ["provider", "server_display_name", "tool_prefix", "tool_suffixes", "search_title_contains"],
          "properties": {
            "provider": { "type": "string" }, "server_display_name": { "type": "string" }, "tool_prefix": { "type": "string" },
            "tool_suffixes": { "type": "array", "items": { "type": "string" } },
            "search_title_contains": { "type": "string" }, "attached_title_prefix": { "type": "string" },
            "window_hours_before_day": { "type": "integer", "minimum": 0 },
            "dedup_by": { "type": "string" },
            "never_download": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    },
    "briefing": {
      "type": "object", "additionalProperties": false, "required": ["enabled", "prompt", "signature"],
      "properties": {
        "enabled": { "type": "boolean" }, "schedule": { "type": "string" }, "prompt": { "type": "string" }, "signature": { "type": "string" },
        "max_words": { "type": "integer", "minimum": 1 }, "max_questions": { "type": "integer", "minimum": 0 },
        "questions_dedup_days": { "type": "integer", "minimum": 0 }, "question_escalate_after": { "type": "integer", "minimum": 1 },
        "question_max_age_days": { "type": "integer", "minimum": 1 },
        "write_caps": { "type": "object", "additionalProperties": { "type": "integer", "minimum": 0 } },
        "strategy_doc": { "type": "object", "additionalProperties": false, "properties": { "index": { "type": "string" }, "title_contains": { "type": "string" } } },
        "main_metric": { "type": "string" }, "calendar_id": { "type": ["string", "null"] },
        "read": { "type": "array", "items": { "type": "string" } },
        "never_read": { "type": "array", "items": { "type": "string" } }
      }
    }
  }
}
```

- [ ] **Step 5: Write `schema/machine.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/aleckyann/brain-kit/main/schema/machine.schema.json",
  "title": "brain-kit machine file (state_dir/machine.json, never versioned, mode 0600)",
  "type": "object",
  "additionalProperties": false,
  "required": ["vault_id", "canonical_path", "claude_bin", "paths"],
  "properties": {
    "vault_id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]*$" },
    "canonical_path": { "type": "string", "minLength": 1 },
    "claude_bin": { "type": "string", "minLength": 1 },
    "model": { "type": ["string", "null"] },
    "network_check": { "type": "array", "items": { "type": "string" } },
    "notify_command": { "type": "array", "items": { "type": "string" } },
    "path_extra": { "type": "array", "items": { "type": "string" } },
    "transcripts_dir": { "type": "string" },
    "paths": {
      "type": "object", "additionalProperties": false,
      "required": ["lock", "watermark", "last_run", "log_dir"],
      "properties": {
        "lock": { "type": "string" }, "watermark": { "type": "string" }, "last_run": { "type": "string" }, "log_dir": { "type": "string" },
        "questions_log": { "type": "string" }, "snapshot": { "type": "string" }, "viz": { "type": "string" }
      }
    },
    "log_retention_days": { "type": "integer", "minimum": 1 },
    "keep_stream": { "type": "boolean" },
    "briefing_task_id": { "type": ["string", "null"] }
  }
}
```

- [ ] **Step 6: Write `src/config.mjs`**

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSchema } from './schema.mjs';
import { KIT_ROOT } from './version.mjs';

export const CONFIG_FILENAME = 'brain-kit.config.json';
export const MACHINE_FILENAME = 'machine.json';

// Keys that execute something or point at this machine. They belong in
// machine.json (outside the vault, never in a pull request) and are rejected
// anywhere inside the versioned config, at any depth: the versioned config is
// writable by the agent and travels through PRs, so a key like notify_command
// there would be a way to run commands via a merged PR.
export const MACHINE_ONLY_KEYS = Object.freeze([
  'claude_bin', 'model', 'network_check', 'notify_command', 'transcripts_dir', 'path_extra',
  'canonical_path', 'state_dir', 'paths', 'log_retention_days', 'keep_stream', 'briefing_task_id',
]);

export class ConfigError extends Error {
  constructor(message, errors = []) {
    super(errors.length ? `${message}\n  ${errors.join('\n  ')}` : message);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const schemaCache = new Map();
function loadSchema(name) {
  if (!schemaCache.has(name)) {
    schemaCache.set(name, JSON.parse(readFileSync(join(KIT_ROOT, 'schema', name), 'utf8')));
  }
  return schemaCache.get(name);
}

export function findMachineOnlyKeys(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findMachineOnlyKeys(item, `${path}[${index}]`, found));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, sub] of Object.entries(value)) {
      const here = `${path}.${key}`;
      if (MACHINE_ONLY_KEYS.includes(key)) found.push(here);
      findMachineOnlyKeys(sub, here, found);
    }
  }
  return found;
}

export function validateConfig(config) {
  const errors = validateSchema(config, loadSchema('config.schema.json'));
  for (const where of findMachineOnlyKeys(config)) {
    errors.push(`${where}: machine-only key is not allowed in the versioned config (it belongs in ${MACHINE_FILENAME})`);
  }
  return errors;
}

export function validateMachine(machine) {
  return validateSchema(machine, loadSchema('machine.schema.json'));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Cannot parse ${file}: ${error.message}`);
  }
}

export function loadConfig(vaultDir) {
  const file = join(vaultDir, CONFIG_FILENAME);
  if (!existsSync(file)) throw new ConfigError(`Not a brain-kit vault: ${CONFIG_FILENAME} not found in ${vaultDir}`);
  const config = readJson(file);
  const errors = validateConfig(config);
  if (errors.length) throw new ConfigError(`Invalid ${file}`, errors);
  return config;
}

export function loadMachine(stateDir) {
  const file = join(stateDir, MACHINE_FILENAME);
  if (!existsSync(file)) throw new ConfigError(`Machine file not found: ${file} (run brain-kit init or brain-kit machine register)`);
  const machine = readJson(file);
  const errors = validateMachine(machine);
  if (errors.length) throw new ConfigError(`Invalid ${file}`, errors);
  return machine;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: all PASS. If `valid.json` fails the schema, fix the schema (the fixture is the contract), never loosen `additionalProperties`.

- [ ] **Step 8: Commit**

```bash
git add schema/ src/config.mjs test/config.test.mjs test/fixtures/
git commit -q -m "feat: config and machine schemas with machine-only key rejection" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Maintainer anti-leak pre-push gate and generic no-leak test

**Files:**
- Create: `.githooks/pre-push`
- Test: `test/pre-push-hook.test.mjs`
- Test: `test/no-leak.test.mjs`

**Interfaces:**
- Produces: the hook reads `BRAIN_KIT_LEAK_PATTERNS` (path to a file with one extended regex per line, default `~/.config/brain-kit/leak-patterns.txt`), fails closed when the file is missing, and always applies the generic patterns below.

- [ ] **Step 1: Write the failing hook test `test/pre-push-hook.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const HOOK = join(KIT_ROOT, '.githooks', 'pre-push');

function git(cwd, args, env = {}) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'brain-kit-prepush-'));
  const bare = join(root, 'origin.git');
  const work = join(root, 'work');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
  mkdirSync(join(work, '.githooks'));
  copyFileSync(HOOK, join(work, '.githooks', 'pre-push'));
  chmodSync(join(work, '.githooks', 'pre-push'), 0o755);
  git(work, ['config', 'core.hooksPath', '.githooks']);
  git(work, ['remote', 'add', 'origin', bare]);
  const patterns = join(root, 'patterns.txt');
  writeFileSync(patterns, 'hunter2corp\nsecret[- ]partner\n');
  return { work, patterns };
}

function commit(work, file, content, message) {
  writeFileSync(join(work, file), content);
  git(work, ['add', file]);
  assert.equal(git(work, ['commit', '-q', '-m', message]).status, 0);
}

test('clean content pushes', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello world\n', 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.equal(r.status, 0, r.stderr);
});

test('a personal pattern blocks the push, case-insensitively, naming the file', () => {
  const { work, patterns } = setup();
  commit(work, 'README.md', 'hello\n', 'init');
  assert.equal(git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns }).status, 0);
  commit(work, 'notes.md', 'Meeting with Hunter2Corp tomorrow\n', 'leak');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in notes\.md/);
});

test('a private key header blocks the push even without a personal pattern', () => {
  const { work, patterns } = setup();
  // Header assembled at runtime so the repository's own leak gate does not trip on this fixture.
  commit(work, 'key.pem', ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ') + '\nabc\n', 'key');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: patterns });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /possible leak in key\.pem/);
});

test('a missing patterns file refuses the push (fail closed)', () => {
  const { work } = setup();
  commit(work, 'README.md', 'hello\n', 'init');
  const r = git(work, ['push', '-q', 'origin', 'main'], { BRAIN_KIT_LEAK_PATTERNS: join(work, 'nope.txt') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /leak patterns file not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/pre-push-hook.test.mjs`
Expected: FAIL (hook file missing).

- [ ] **Step 3: Write `.githooks/pre-push`**

```bash
#!/usr/bin/env bash
# brain-kit maintainer pre-push gate: refuse to push anything that looks like a
# secret or like household data (the maintainer's company, colleagues, clients).
#
# Why a pre-push and not CI: CI runs after the push, when the content is already
# in the public history of the repository. This hook runs before anything
# leaves the machine.
#
# Personal patterns live OUTSIDE the repository, one extended regex per line,
# because the list of names to protect is itself the data to protect:
#   default file: ~/.config/brain-kit/leak-patterns.txt
#   override:     BRAIN_KIT_LEAK_PATTERNS=/path/to/file
# The hook fails closed: no patterns file, no push.
#
# Activate once per clone:  git config core.hooksPath .githooks
set -u

PATTERNS_FILE="${BRAIN_KIT_LEAK_PATTERNS:-$HOME/.config/brain-kit/leak-patterns.txt}"
if [ ! -r "$PATTERNS_FILE" ]; then
  echo "pre-push: leak patterns file not found: $PATTERNS_FILE" >&2
  echo "pre-push: create it (one extended regex per line) or point BRAIN_KIT_LEAK_PATTERNS at it. Refusing to push." >&2
  exit 1
fi

# Generic patterns, versioned here because they name no one: private keys and
# well-known token prefixes.
GENERIC_PATTERNS='-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}'

ZERO='0000000000000000000000000000000000000000'
failed=0

scan_blob() {
  # $1 = commit sha, $2 = path. Prints "line: match" for every hit.
  local sha="$1" path="$2" hits
  hits="$(git show "$sha:$path" 2>/dev/null | grep -n -I -i -E -f "$PATTERNS_FILE" -e "$GENERIC_PATTERNS" || true)"
  if [ -n "$hits" ]; then
    failed=1
    echo "pre-push: possible leak in $path (at ${sha:0:7}):" >&2
    printf '%s\n' "$hits" | sed 's/^/    /' >&2
  fi
}

while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$ZERO" ] && continue   # branch deletion: nothing to scan
  if [ "$remote_sha" = "$ZERO" ]; then
    # New branch on the remote: every file in the pushed commit is new to it.
    files="$(git ls-tree -r --name-only "$local_sha")"
  else
    files="$(git diff --name-only --diff-filter=AM "$remote_sha" "$local_sha")"
  fi
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    scan_blob "$local_sha" "$path"
  done <<< "$files"
done

if [ "$failed" -ne 0 ]; then
  echo "pre-push: push refused. Remove the flagged content (and rewrite the commits that contain it) before pushing." >&2
  exit 1
fi
exit 0
```

Then: `chmod +x .githooks/pre-push`

- [ ] **Step 4: Run the hook test to verify it passes**

Run: `node --test test/pre-push-hook.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the generic no-leak test `test/no-leak.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

// Generic gate that can live in a public CI: it names no one. Personal patterns
// are enforced by .githooks/pre-push on the maintainer's machine.
const SECRET_PATTERNS = [
  /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];
const ALLOWED_EMAIL_DOMAINS = /@(example\.(com|org|net|invalid)|anthropic\.com|users\.noreply\.github\.com|gmail\.com)$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TEXT_EXT = /\.(mjs|js|json|md|yml|yaml|sh|cmd|txt)$/;

function trackedTextFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, 'git ls-files failed');
  return r.stdout.split('\0').filter((f) => f && (TEXT_EXT.test(f) || f === 'LICENSE' || f.startsWith('.githooks/')));
}

test('no tracked text file contains a secret-looking token', () => {
  for (const file of trackedTextFiles()) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (file === 'test/no-leak.test.mjs' || file === '.githooks/pre-push') continue; // they define the patterns
      assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
    }
  }
});

test('every e-mail address in tracked files uses an example or public-author domain', () => {
  for (const file of trackedTextFiles()) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    for (const email of text.match(EMAIL) ?? []) {
      assert.match(email, ALLOWED_EMAIL_DOMAINS, `${file}: unexpected e-mail domain in ${email}`);
    }
  }
});
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all PASS. (`aleckyann@gmail.com` appears only in git config, not in files; `curator@example.invalid` and `ana@example.com` are allowed.)

- [ ] **Step 7: Activate the hook in this clone and commit**

```bash
git config core.hooksPath .githooks
git add .githooks/pre-push test/pre-push-hook.test.mjs test/no-leak.test.mjs
git commit -q -m "feat: maintainer anti-leak pre-push gate and generic no-leak test" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Claude Code plugin manifest, marketplace and hook wiring

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `hooks/hooks.json`
- Create: `hooks/run-hook.cmd`
- Test: `test/plugin.test.mjs`

**Interfaces:**
- Consumes: `bin/brain-kit.mjs hook <event>` (Task 3).
- Produces: plugin `brain-kit`, marketplace `brain-kit` (install with `claude plugin marketplace add aleckyann/brain-kit` then `claude plugin install brain-kit@brain-kit`), hook events `Stop` and `SessionStart` routed through `hooks/run-hook.cmd`.

- [ ] **Step 1: Write the failing test `test/plugin.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const read = (p) => JSON.parse(readFileSync(join(KIT_ROOT, p), 'utf8'));
const pkg = read('package.json');

test('plugin.json names the plugin brain-kit and mirrors the package version', () => {
  const plugin = read('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'brain-kit');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, 'MIT');
  assert.ok(Array.isArray(plugin.keywords));
});

test('marketplace.json lists exactly this plugin from the repo root', () => {
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'brain-kit');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'brain-kit');
  assert.equal(market.plugins[0].source, './');
  assert.equal(market.plugins[0].version, pkg.version);
});

test('hooks.json declares Stop and SessionStart through an existing wrapper', () => {
  const hooks = read('hooks/hooks.json').hooks;
  assert.ok(hooks.Stop, 'Stop hook missing');
  assert.ok(hooks.SessionStart, 'SessionStart hook missing');
  for (const group of [...hooks.Stop, ...hooks.SessionStart]) {
    for (const hook of group.hooks) {
      assert.equal(hook.type, 'command');
      const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}', KIT_ROOT);
      const script = command.match(/^"([^"]+)"/)[1];
      assert.ok(existsSync(script), `${script} does not exist`);
      assert.ok(hook.timeout <= 15, 'hook timeout must stay short');
    }
  }
});

test('run-hook.cmd is executable and routes to the engine as a silent no-op', () => {
  const wrapper = join(KIT_ROOT, 'hooks', 'run-hook.cmd');
  assert.ok(statSync(wrapper).mode & 0o111, 'run-hook.cmd must be executable');
  // Claude Code runs hook commands through a shell; the wrapper has no shebang
  // (the first line is the cmd.exe half), so spawn it through bash as a shell would.
  const r = spawnSync('bash', [wrapper, 'stop'], { input: '{"stop_hook_active":false}', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('claude plugin validate --strict passes when the CLI is installed', (t) => {
  const which = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (which.error || which.status !== 0) return t.skip('claude CLI not installed');
  const r = spawnSync('claude', ['plugin', 'validate', '--strict', '.'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/plugin.test.mjs`
Expected: FAIL (files missing).

- [ ] **Step 3: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "brain-kit",
  "displayName": "Brain Kit",
  "version": "0.0.1",
  "description": "Second brain in OKF markdown, curated by Claude through pull requests: validator, PR loop, Stop hook, scheduled curation and morning briefing. Phase 0: engine skeleton and hook wiring.",
  "author": {
    "name": "Aleck Yann",
    "url": "https://github.com/aleckyann"
  },
  "homepage": "https://github.com/aleckyann/brain-kit",
  "repository": "https://github.com/aleckyann/brain-kit",
  "license": "MIT",
  "keywords": ["second-brain", "okf", "knowledge-base", "curation", "pull-request", "markdown"],
  "userConfig": {
    "vault_dir": {
      "type": "directory",
      "title": "Default vault directory",
      "description": "Vault used by brain-kit skills when the current directory is not a vault. Leave empty to require running inside the vault."
    },
    "lang": {
      "type": "string",
      "title": "Language",
      "description": "Language for skill bodies and messages outside a vault (pt-BR or en). Inside a vault, brain-kit.config.json wins.",
      "default": "pt-BR"
    }
  }
}
```

- [ ] **Step 4: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "brain-kit",
  "owner": {
    "name": "Aleck Yann"
  },
  "plugins": [
    {
      "name": "brain-kit",
      "source": "./",
      "description": "Second brain in OKF markdown, curated by Claude through pull requests.",
      "version": "0.0.1",
      "license": "MIT",
      "keywords": ["second-brain", "okf", "knowledge-base"]
    }
  ]
}
```

- [ ] **Step 5: Write `hooks/hooks.json`**

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" stop",
            "timeout": 15,
            "statusMessage": "brain-kit: checking for pending curation"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Write `hooks/run-hook.cmd`** (polyglot: cmd.exe reads the top block, bash skips it as a heredoc)

```
: << 'CMDBLOCK'
@echo off
REM brain-kit hook entry point, Windows half. cmd.exe runs this block; on Unix,
REM bash treats the first line as a no-op heredoc and jumps to the bottom.
REM Usage: run-hook.cmd <event>   (event JSON arrives on stdin)
set "HOOK_DIR=%~dp0"
node "%HOOK_DIR%..\bin\brain-kit.mjs" hook %1
exit /b %ERRORLEVEL%
CMDBLOCK

# brain-kit hook entry point, Unix half. Claude Code runs this file for the
# Stop and SessionStart events with the event JSON on stdin; exec keeps stdin
# attached to the engine and returns its exit code unchanged.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/../bin/brain-kit.mjs" hook "$1"
```

Then: `chmod +x hooks/run-hook.cmd`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: all PASS, including `claude plugin validate --strict .` (the CLI is installed on this machine). If validate reports warnings about `userConfig` fields, remove the offending field rather than loosening `--strict`.

- [ ] **Step 8: Smoke-load the plugin in a real session (one cheap model call)**

Run: `claude --plugin-dir . -p "Reply with exactly the word ok" --max-turns 1 --output-format text`
Expected: prints `ok` (or similar), exit 0, no `hook` error in the output.

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin/ hooks/ test/plugin.test.mjs
git commit -q -m "feat: claude code plugin manifest, marketplace and hook wiring" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    name: node --test (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
      - name: Tests (includes zero-dependency and generic no-leak gates)
        run: npm test
      - name: Package contents
        run: npm pack --dry-run

  plugin-validate:
    name: claude plugin validate --strict
    runs-on: ubuntu-latest
    # Unverified whether the CLI validates without a login; do not block on it yet.
    continue-on-error: true
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
      - run: npm install -g @anthropic-ai/claude-code
      - run: claude plugin validate --strict .
```

- [ ] **Step 2: Validate the YAML parses**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/jobs:\n  test:/.test(y)) process.exit(1); console.log('ci.yml ok')"`
Expected: `ci.yml ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -q -m "ci: node tests on ubuntu and macos, plugin validate" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Public design docs, scrubbed

**Files:**
- Create: `docs/rationale.md`
- Create: `docs/incidents.md`

**Sources (read-only, on the maintainer's machine, NOT to be copied):**
- Approved plan: `/home/aleck/.claude/plans/ultracode-ao-mostrar-o-hazy-rain.md` (sections "O que é o Brain", "Princípios", "Camadas", "Lições", "Lacunas").
- 73 lessons and 17 principles as JSON: `/tmp/claude-1000/-home-aleck--rea-de-trabalho-brain/825fb966-74f8-4e48-bcf6-c973c82aa1cb/scratchpad/brain-map-sintese.json` (fields `licoes_de_desenho[]` with `regra`/`incidente`, `principios[]`, `lacunas_conhecidas[]`).
- Agent memories with failure modes: `/home/aleck/.claude/projects/-home-aleck--rea-de-trabalho-brain/memory/*.md`.

**Scrubbing rules (mandatory):** replace every person by a role ("the maintainer", "a colleague", "the CTO" becomes "a senior engineer", "a mentor"); the company becomes "the company"; clients become "a customer"; internal tools and products become "an internal tool", "the CRM", "the ERP"; the local shell-rewriting hook becomes "a local shell hook that rewrites command output"; keep dates (DD/MM/YYYY), numbers, file names of the original vault scripts (they are generic: `validate-okf.mjs`, `propose.mjs`, `curadoria-noturna.sh`) and the technical facts. Never write the company name, a colleague's name, a client's name or a real e-mail. Write in English.

- [ ] **Step 1: Write `docs/rationale.md`** with exactly these sections, each 1 to 3 paragraphs, sourced from the plan's description and principles:

```markdown
# Why brain-kit works the way it does

## The problem: a giant prompt does not scale, RAG breaks relations
## The bet: a curated LLM wiki in an open format
## Why OKF (Open Knowledge Format)
## Why git and pull requests are the approval mechanism
## Why the agent never verifies its own work
## Why the log is append-only and the index is the map
## Why silent failure is treated as the enemy
## Why arithmetic lives in code and judgment lives in the prompt
## What the evidence says (including the study against us)
## The seventeen principles
```

Under "What the evidence says" cite arXiv 2605.18490 with its caveat (the wiki synthesized better across documents but used about 21 times more tokens per query; the advantage disappeared with combined evaluators) and the corpus-size trigger (50 to 100 thousand tokens) as the declared limit of this architecture. Under "The seventeen principles" list the 17 principles from the plan, one bold name plus one sentence each.

- [ ] **Step 2: Write `docs/incidents.md`**

Header:

```markdown
# Incidents that shaped brain-kit

Every guard in this kit exists because something broke in the original vault, at a
known date. This file keeps the incident next to the rule so nobody removes a guard
for looking paranoid. Entries are grouped by theme and dated DD/MM/YYYY.
Names of people, companies and tools were removed on purpose.
```

Then one entry per lesson in `licoes_de_desenho` (all 73; merge two only when they describe the same incident), grouped under these headings: `## Format and links`, `## Git and pull requests`, `## Headless runs, network and scheduling`, `## Connectors`, `## The Stop hook and the session`, `## Output folders and orphaned deliverables`, `## Prompts, policy and evidence`, `## Privacy`. Entry format:

```markdown
### DD/MM/YYYY: short title
**What happened.** One to three sentences.
**Rule.** The rule the incident produced.
**Where it lives in brain-kit.** Guard, command or test name from the design (for example `src/guards/self-trace.mjs`, `brain-kit propose --only`, `test/incidents/2026-08-11-self-trace-filter.test.mjs`), or "Phase N" when it lands later.
```

Worked example of one entry:

```markdown
### 11/08/2026: the self-trace filter ate the day's work
**What happened.** The scheduled curator discarded transcripts that contained its own prompt signature anywhere in the file. A human session that had merely opened the prompt file was discarded as if it were the curator, and the three working sessions of the previous day disappeared; the night looked calm.
**Rule.** Recognize your own runs only by the first user message, extracted with a JSON parser. When in doubt, the transcript stays in: including too much costs context, discarding too much costs the day.
**Where it lives in brain-kit.** `src/guards/self-trace.mjs`, `test/incidents/2026-08-11-self-trace-filter.test.mjs` (Phase 2).
```

- [ ] **Step 3: Scrub check before committing**

Run:
```bash
grep -n -i -E -f "${BRAIN_KIT_LEAK_PATTERNS:-$HOME/.config/brain-kit/leak-patterns.txt}" docs/rationale.md docs/incidents.md || echo "scrub ok"
npm test
```
Expected: `scrub ok` and all tests PASS. (Task 11 creates the patterns file; if it does not exist yet, create it first following Task 11 Step 1.)

- [ ] **Step 4: Commit**

```bash
git add docs/rationale.md docs/incidents.md
git commit -q -m "docs: public rationale and dated incidents behind every guard" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: README, README.pt-BR, CONTRIBUTING, SECURITY, CHANGELOG

**Files:**
- Create: `README.md`, `README.pt-BR.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# brain-kit

> Under construction. Phase 0 of 6: package skeleton, contracts and safety gates.
> Nothing here curates a vault yet. Follow the repository for the first usable release.

A second brain in plain markdown, in the Open Knowledge Format (OKF) v0.2, kept by an
AI agent that reads it through an index, feeds it every day from your own work (session
transcripts, calendar, meeting notes) and only ever changes it through pull requests.
Your merge is the approval and the verification.

brain-kit is one repository that is at the same time:

- an npm package with a single executable, `brain-kit` (validator, PR loop, curator,
  briefing pre-flight, scheduler templates, doctor);
- a Claude Code plugin (skills, Stop hook, read-only subagent) that calls the same engine;
- a plugin marketplace of one, so `claude plugin marketplace add aleckyann/brain-kit` works.

The engine is Node.js 24 with zero runtime dependencies. The vault it generates is yours:
markdown, YAML frontmatter and a declarative config file, nothing else.

## Status

| Phase | Content | State |
|---|---|---|
| 0 | Skeleton, exit codes, language packs, config schemas, anti-leak gate, CI, docs | in progress |
| 1 | Validator, lint, propose (PR loop), Stop hook, init, doctor, skills | planned |
| 2 | Scheduled curator over local transcripts, scheduler templates | planned |
| 3 | Calendar and meeting-notes sources (best effort by design) | planned |
| 4 | Morning briefing | planned |
| 5 | Migration of the original vault onto the kit | planned |
| 6 | 0.1.0 release | planned |

## Why

Read [docs/rationale.md](docs/rationale.md) for the reasoning and
[docs/incidents.md](docs/incidents.md) for the dated failures that produced every guard.

## Requirements (target)

Node.js >= 24, git, the GitHub CLI (`gh`) logged in, and Claude Code. Linux is the
reference platform for scheduling (systemd user timers); macOS (launchd) and cron are
planned; Windows is out of scope for scheduling.

## License

MIT. Portuguese README: [README.pt-BR.md](README.pt-BR.md).
```

- [ ] **Step 2: Write `README.pt-BR.md`**

```markdown
# brain-kit

> Em construção. Fase 0 de 6: esqueleto do pacote, contratos e travas de segurança.
> Nada aqui cura um vault ainda. Acompanhe o repositório para a primeira versão usável.

Um segundo cérebro em markdown puro, no Open Knowledge Format (OKF) v0.2, mantido por um
agente de IA que o lê pelo índice, o alimenta todo dia a partir do seu próprio trabalho
(transcripts de sessão, agenda, notas de reunião) e só o altera por pull request. Seu merge
é a aprovação e a verificação.

O brain-kit é um repositório que é, ao mesmo tempo:

- um pacote npm com um único executável, `brain-kit` (validador, loop de PR, curador,
  pré-voo do briefing, templates de agendamento, doctor);
- um plugin do Claude Code (skills, hook Stop, subagente só de leitura) que chama o mesmo motor;
- um marketplace de um plugin só, para `claude plugin marketplace add aleckyann/brain-kit` funcionar.

O motor é Node.js 24 sem dependência de runtime. O vault que ele gera é seu: markdown,
frontmatter YAML e um arquivo de configuração declarativo, nada mais.

## Estado

| Fase | Conteúdo | Situação |
|---|---|---|
| 0 | Esqueleto, códigos de saída, packs de idioma, schemas de config, trava anti-vazamento, CI, docs | em andamento |
| 1 | Validador, lint, propose (loop de PR), hook Stop, init, doctor, skills | planejada |
| 2 | Curador agendado sobre transcripts locais, templates de agendamento | planejada |
| 3 | Fontes de agenda e notas de reunião (best effort por desenho) | planejada |
| 4 | Briefing matinal | planejada |
| 5 | Migração do vault original para o kit | planejada |
| 6 | Publicação 0.1.0 | planejada |

## Por quê

Leia [docs/rationale.md](docs/rationale.md) para o racional e
[docs/incidents.md](docs/incidents.md) para as falhas datadas que produziram cada guarda.

## Requisitos (alvo)

Node.js >= 24, git, o GitHub CLI (`gh`) autenticado e o Claude Code. Linux é a plataforma
de referência para agendamento (timers systemd de usuário); macOS (launchd) e cron estão
planejados; Windows fica fora do agendamento.

## Licença

MIT. README em inglês: [README.md](README.md).
```

- [ ] **Step 3: Write `CONTRIBUTING.md`**

```markdown
# Contributing

- Node.js >= 24, no runtime dependencies. If a change needs a package, open an issue first.
- Tests: `npm test` (node:test). Every guard gets a test named after the incident that
  created it, under `test/incidents/YYYY-MM-DD-<slug>.test.mjs`.
- Code, identifiers and docs in English. Message packs: `lang/pt-BR` is the reference,
  `lang/en` must mirror it key for key (a test enforces parity).
- Never commit personal data: no real names of third parties, no real e-mail addresses
  outside example domains. Example data uses the fictional owner "Ana" and `example.com`.
- Commits use conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`).
- Shell commands in code are always argument arrays (`execFileSync`), never strings.
```

- [ ] **Step 4: Write `SECURITY.md`**

```markdown
# Security

brain-kit generates and curates a vault that may contain personal data about third parties
(colleagues, customers) and runs an AI agent without a human in the room. The design
choices that follow from that are documented in `docs/rationale.md`; the operational ones
land with the code in later phases (allowlist per subcommand, no credentials in the vault,
machine-specific paths and executables kept outside the repository, lint for secrets and
privacy on the write path).

Report a vulnerability by opening a private security advisory on GitHub or by e-mail to the
maintainer listed in `package.json`. Do not open a public issue for a secret or a leak.
```

- [ ] **Step 5: Write `CHANGELOG.md`**

```markdown
# Changelog

## 0.0.1 (unreleased)

Phase 0: package skeleton, CLI router with exit codes, language packs (pt-BR reference, en),
config and machine schemas, maintainer anti-leak pre-push gate, Claude Code plugin manifest
and hook wiring (hooks are no-ops until Phase 1), CI, rationale and incidents docs.
```

- [ ] **Step 6: Test and commit**

Run: `npm test`
Expected: PASS.

```bash
git add README.md README.pt-BR.md CONTRIBUTING.md SECURITY.md CHANGELOG.md
git commit -q -m "docs: readme (en, pt-BR), contributing, security, changelog" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Personal leak patterns, GitHub repository, first push

**Files:**
- Create (outside the repo): `~/.config/brain-kit/leak-patterns.txt`

- [ ] **Step 1: Create the personal patterns file from the private vault** (the terms are derived on the maintainer's machine and never written into this repository)

```bash
mkdir -p ~/.config/brain-kit
VAULT="/home/aleck/Área de trabalho/brain"
{
  # People and organizations known to the private vault, from file slugs:
  # "first-last.md" becomes the regex "first[- ]last".
  ls "$VAULT/pessoas" "$VAULT/organizacoes" | grep -v -E '^index\.md$|:$|^$' | sed -e 's/\.md$//' -e 's/-/[- ]/g'
  # Every e-mail address of the company domain that appears in the vault.
  grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.com\.br' --include='*.md' "$VAULT" | sort -u | sed 's/\./\\./g'
  # The company name, its products and the domain, one per line, typed by the maintainer:
  # take them from empresa/index.md and empresa/produtos.md of the vault (lowercase, escaped dots).
} > ~/.config/brain-kit/leak-patterns.txt
chmod 600 ~/.config/brain-kit/leak-patterns.txt
wc -l ~/.config/brain-kit/leak-patterns.txt
```

Then append manually the company name, the company domain, the product names and the names of internal tools found in the vault's `empresa/index.md`, `empresa/produtos.md` and `empresa/ferramentas.md` (one lowercase extended regex per line). Expected: about 60 lines.

- [ ] **Step 2: Dry-run the gate against the whole tree**

```bash
git ls-files -z | xargs -0 grep -n -i -I -E -f ~/.config/brain-kit/leak-patterns.txt || echo "tree is clean"
```
Expected: `tree is clean`. Any hit must be removed (and the commit rewritten) before pushing.

- [ ] **Step 3: Create the public repository and push**

```bash
gh repo create aleckyann/brain-kit --public --source=. --remote=origin \
  --description "Second brain kit: an OKF markdown vault curated by AI agents through pull requests, as an npm CLI and a Claude Code plugin" \
  --push
```
Expected: the pre-push hook runs (no output on success), then the push completes.

- [ ] **Step 4: Verify**

```bash
gh repo view aleckyann/brain-kit --json url,visibility,defaultBranchRef
gh run list --limit 3
```
Expected: `visibility: PUBLIC`, default branch `main`; a CI run appears. Wait for it: `gh run watch` and expect the `test` job green on both operating systems.

---

### Task 12: Reserve the npm name and final gate

- [ ] **Step 1: Check npm login**

Run: `npm whoami`
Expected: a username. If the output is `ENEEDAUTH`, STOP this task and ask the maintainer to run `npm login` in their own terminal (credentials are never entered by the agent), then resume here.

- [ ] **Step 2: Inspect the package and publish**

```bash
npm pack --dry-run
npm publish --access public
npm view brain-kit version
```
Expected: `npm view` prints `0.0.1`.

- [ ] **Step 3: Install from the registry in a clean directory**

```bash
cd "$(mktemp -d)" && npx --yes brain-kit@0.0.1 --version
```
Expected: `0.0.1`.

- [ ] **Step 4: Tag**

```bash
cd "/home/aleck/Área de trabalho/brain-kit"
git tag -a v0.0.1 -m "brain-kit 0.0.1: phase 0 foundation"
git push origin v0.0.1
```

- [ ] **Step 5: Phase 0 done-criteria checklist** (all must hold before Phase 1 starts)

- `npm pack` installs and `brain-kit --version` responds `0.0.1`.
- CI green on ubuntu and macos.
- `claude --plugin-dir .` loads and `claude plugin validate --strict .` exits 0.
- The pre-push gate refuses a commit containing a personal pattern (proven by `test/pre-push-hook.test.mjs` and by a manual attempt if desired).
- `npm view brain-kit` shows `0.0.1`.
- `docs/incidents.md` has one entry per lesson with the date next to the rule, and contains no household term.
