// Incident of 28/09/2026 (docs/incidents.md, "the round took its own parent
// for a competing curator"). A vault moving off a legacy scheduled job had
// the kit's plugin installed and machine.json `paths.legacy_lock` naming the
// legacy job's flock file. The legacy job holds that lock for its whole run
// and starts `claude -p` without isolating the person's settings, so its
// round loaded the plugin and ran the SessionStart hook, which put "the
// legacy lock is held by another process, a writer started now is
// postponed" into the round's context. The round's model, the holder's own
// child, took its parent for a competing curator, read no source and exited
// 0, and the legacy job advanced its mark over a day nobody read.
//
// The rule: what a SessionStart hook says reaches every session that loads
// the plugin, including the round of another tool that holds the very lock
// the text would talk about. So the line says nothing about the legacy
// lock, whoever holds it and whether or not it can be used; the lock is
// enforced by mechanism (every writer refuses, the Stop hook releases).
//
// The holders are real processes: bash doing what the legacy job does
// (`exec 9>>file; flock -n 9`), either as the hook's own parent
// (runUnderHolder) or as an unrelated process (startHolder), stopped in a
// finally block. The line of a bridged vault is compared word for word with
// the line of the same vault with the bridge off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock } from '../../src/guards/lock.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { BIN, makeHookVault, runHookProcess } from '../helpers/hook-world.mjs';
import { flockAvailable, flockProbe, runUnderHolder, runWatched, startHolder } from '../helpers/legacy-lock-world.mjs';

const NEEDS_FLOCK = { skip: !flockAvailable() && 'needs Linux and util-linux flock' };
const T = { en: createTranslator('en'), 'pt-BR': createTranslator('pt-BR') };
const LANGS = ['en', 'pt-BR'];
// Any word for the legacy lock or its bridge, in either language.
const LEGACY_WORDS = /legacy|legad|flock|bridge|ponte/i;

function setLegacy(fx, value) {
  const file = join(fx.stateDir, 'machine.json');
  const machine = JSON.parse(readFileSync(file, 'utf8'));
  machine.paths.legacy_lock = value;
  writeFileSync(file, `${JSON.stringify(machine, null, 2)}\n`);
}

function vault(lang) {
  const fx = makeHookVault({ lang });
  mkdirSync(join(fx.base, 'jobs'));
  return { ...fx, file: join(fx.base, 'jobs', 'legacy.lock') };
}

const payload = (fx) => JSON.stringify({ session_id: 's1', source: 'startup', cwd: fx.root });

function contextOf(r) {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  return out.hookSpecificOutput.additionalContext;
}

function startLine(fx) {
  return contextOf(runHookProcess('session-start', payload(fx), { env: fx.env, cwd: join(fx.base, 'elsewhere') }));
}

// The line the same vault gets with the bridge off: the baseline every
// bridged case must equal.
function bridgeOffLine(fx) {
  setLegacy(fx, null);
  const line = startLine(fx);
  assert.doesNotMatch(line, LEGACY_WORDS);
  return line;
}

function assertSaysNothingOfTheLegacyLock(line, off, fx, label) {
  assert.equal(line, off, `${label}: the line is the line of the bridge off`);
  assert.equal(line.includes(fx.file), false, `${label}: the file is not named`);
  assert.doesNotMatch(line, LEGACY_WORDS, label);
}

test('the hook run as the child of the legacy job holding its lock says nothing about the legacy lock, in either language', NEEDS_FLOCK, async () => {
  for (const lang of LANGS) {
    const fx = vault(lang);
    const off = bridgeOffLine(fx);
    setLegacy(fx, fx.file);
    const r = await runUnderHolder(fx.file, process.execPath, [BIN, 'hook', 'session-start'], { env: fx.env, cwd: join(fx.base, 'elsewhere'), input: payload(fx) });
    assertSaysNothingOfTheLegacyLock(contextOf(r), off, fx, `${lang}, held by the parent`);
    assert.equal(flockProbe(fx.file), 0, `${lang}: the holder ended with its child`);
  }
});

test('the hook with the legacy lock held by an unrelated process says nothing about it either', NEEDS_FLOCK, async () => {
  const fx = vault('en');
  const off = bridgeOffLine(fx);
  setLegacy(fx, fx.file);
  const holder = startHolder(fx.file);
  try {
    await holder.ready;
    const r = await runWatched(process.execPath, [BIN, 'hook', 'session-start'], { file: fx.file, env: fx.env, cwd: join(fx.base, 'elsewhere'), input: payload(fx) });
    assertSaysNothingOfTheLegacyLock(contextOf(r), off, fx, 'held by an unrelated process');
  } finally {
    await holder.stop();
  }
  assertSaysNothingOfTheLegacyLock(startLine(fx), off, fx, 'free');
});

// A bridge that cannot be used, in each shape the removed sentence named:
// the file in a missing directory (the probe's refusal), a relative path
// written by hand and a machine.json that cannot be parsed (the setting's
// own refusal). The last one is written last: setLegacy cannot read it.
test('the hook with a bridge that cannot be used says nothing about it, alone or under the legacy job: a missing directory, a relative setting, a machine.json that cannot be parsed', NEEDS_FLOCK, async () => {
  for (const lang of LANGS) {
    const fx = vault(lang);
    const off = bridgeOffLine(fx);
    const gone = join(fx.base, 'gone');
    const missing = join(gone, 'legacy.lock');
    const refusal = T[lang]('lock.legacy_dir_missing', { lock: missing, dir: gone });
    const shapes = [
      ['a missing directory', () => setLegacy(fx, missing)],
      ['a relative setting', () => setLegacy(fx, 'legacy.lock')],
      ['a machine.json that cannot be parsed', () => writeFileSync(join(fx.stateDir, 'machine.json'), '{"paths": {"legacy_lock": ')],
    ];
    for (const [shape, write] of shapes) {
      write();
      const alone = startLine(fx);
      assertSaysNothingOfTheLegacyLock(alone, off, fx, `${lang}, ${shape}`);
      // The migration's other half: the legacy job holds its own file and
      // runs the round, while machine.json cannot be used.
      const r = await runUnderHolder(fx.file, process.execPath, [BIN, 'hook', 'session-start'], { env: fx.env, cwd: join(fx.base, 'elsewhere'), input: payload(fx) });
      const under = contextOf(r);
      assertSaysNothingOfTheLegacyLock(under, off, fx, `${lang}, ${shape}, under the legacy job`);
      for (const line of [alone, under]) {
        assert.equal(line.includes(missing), false);
        assert.equal(line.includes(refusal), false);
      }
    }
  }
});

test('unchanged: the line still names a held vault lock, with the bridge on and the legacy lock held by the parent', NEEDS_FLOCK, async () => {
  const fx = vault('en');
  const off = bridgeOffLine(fx);
  const lock = acquireLock(fx.root, { command: 'brain-kit sync', env: fx.env });
  let held;
  try {
    setLegacy(fx, fx.file);
    const r = await runUnderHolder(fx.file, process.execPath, [BIN, 'hook', 'session-start'], { env: fx.env, cwd: join(fx.base, 'elsewhere'), input: payload(fx) });
    held = contextOf(r);
  } finally {
    lock.release();
  }
  assert.equal(held, `${off} ${T.en('hook.session_start.lock_held', { command: 'brain-kit sync', pid: process.pid })}`);
});

test('unchanged: the Stop hook run as the child of the legacy job holding its lock releases, naming the lock, even with session work to propose', NEEDS_FLOCK, async () => {
  const fx = vault('en');
  setLegacy(fx, fx.file);
  startLine(fx);
  writeFileSync(join(fx.root, 'mine.md'), 'this session\n');
  const stop = JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, cwd: fx.root });
  const r = await runUnderHolder(fx.file, process.execPath, [BIN, 'hook', 'stop'], { env: fx.env, cwd: join(fx.base, 'elsewhere'), input: stop });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'released');
  assert.equal(r.stderr, `${T.en('hook.stop.release_legacy_held', { lock: fx.file })}\n`);
  assert.equal(flockProbe(fx.file), 0, 'the holder ended with its child');
  const after = JSON.parse(runHookProcess('stop', stop, { env: fx.env, cwd: join(fx.base, 'elsewhere') }).stdout);
  assert.equal(after.decision, 'block', 'once the legacy job is gone, the session is asked to propose again');
});
