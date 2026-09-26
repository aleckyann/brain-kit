// Found while adopting the reference vault, 26/09/2026 (phase 5a, task 4),
// before it became an incident in production; this file exists so it never
// does (ruling R-A4). A Claude Code project directory the round could not
// list (its permissions closed) was only a warning, `project_unreadable`:
// the round exited 0 and moved the transcripts mark over a day whose
// sessions in that directory nobody had read, while doctor's
// include-projects said such a round "would exit 4 and keep those days
// open". Replayed then exactly as below (the fake claude, a directory at
// mode 000 holding a session from yesterday): exit 0 and the mark at
// yesterday, under a list and under include_projects "all" alike.
//
// The rule: a directory that cannot be listed is unread, like a file that
// cannot be read. Its sessions could be on any day, so a required source
// stops the round before the model (exit 4), no mark moves, the reason and
// last-run.json name the directory, and every round stops there until it
// can be listed or leaves the configuration; then the day is read and
// closed as any other. So does a project reached through a link the round
// cannot follow (ruling R-A7), the last test below.
//
// Every round is `brain-kit curate` as a process, in the curate world: a
// vault with a bare remote on this machine, the fake claude, a scratch
// transcripts directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../../src/exit-codes.mjs';
import { makeCurateWorld, note, PROJECT, utcDay } from '../helpers/curate-world.mjs';
import { user } from '../helpers/transcripts-world.mjs';

const LOCKED = '-home-ana-locked';
const AS_ROOT = { skip: process.getuid?.() === 0 ? 'root lists any directory' : false };

const propose = (w) => [{ write: { path: 'notes/reading.md', content: note('Reading') } }, w.proposeAction('notes/reading.md')];

for (const [label, include, bothRead] of [
  ['a list naming it beside a readable project', [PROJECT, LOCKED], true],
  ['a list naming it alone', [LOCKED], false],
  ['include_projects "all"', 'all', true],
]) {
  test(`under ${label}, a project directory the round cannot list stops it before the model (exit 4), no mark moves, and the day is read once it can be listed`, AS_ROOT, () => {
    const w = makeCurateWorld({ config: (c) => { c.sources.transcripts.include_projects = include; } });
    const dir = join(w.projects, LOCKED);
    mkdirSync(dir);
    const session = join(dir, 'dddddddd-1111-4222-8333-444444444444.jsonl');
    writeFileSync(session, `${JSON.stringify(user('Ana decided to move the launch', `${utcDay(-1)}T13:00:00.000Z`))}\n`);
    chmodSync(dir, 0o000);
    try {
      w.scenario({ actions: propose(w) });
      const r = w.curate();
      assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
      assert.equal(w.watermark(), null, 'no mark moves');
      assert.equal(w.launches().length, 0, 'the model is never started');
      assert.equal(w.ghCalls().filter((call) => call.args[1] === 'create').length, 0, 'nothing is proposed');
      const last = w.lastRun();
      assert.equal(last.exit, EXIT.SOURCE_UNREAD);
      assert.equal(last.reasonCode, 'source_unreadable');
      assert.ok(last.reason.includes(dir), `the reason names the directory: ${last.reason}`);
      assert.match(last.reason, /project directories that could not be listed, so no session in them was read, whatever its day: skipping days does not clear them/);
      assert.ok(last.warnings.some((line) => line.includes(`project_unreadable (${LOCKED})`)), JSON.stringify(last.warnings));
      assert.ok(r.stderr.includes(dir), r.stderr);
      // Every later round stops there too, whatever it is asked.
      const again = w.curate();
      assert.equal(again.status, EXIT.SOURCE_UNREAD, again.stderr);
      assert.equal(w.watermark(), null);
    } finally {
      chmodSync(dir, 0o755);
    }
    // Listable again: the next round reads its sessions and only then closes the day.
    const kept = bothRead ? [w.transcript, session] : [session];
    w.scenario({ actions: propose(w), rewrite: { toolUses: kept.map((file_path) => ({ name: 'Read', input: { file_path, offset: 1 } })) } });
    const fixed = w.curate();
    assert.equal(fixed.status, EXIT.OK, fixed.stderr);
    assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
    assert.deepEqual(w.lastRun().sources.transcripts, { kept: kept.length, read: kept.length, advanced: true, noTimestamp: 0 });
  });
}

// Ruling R-A7: the same holds for a project reached through a link the
// round cannot follow, here a target that is gone as on a volume that is
// not mounted. Under "all" it was left out in silence (the review's probe:
// exit 0, the mark at yesterday, nothing in the warnings), and under a list
// it read as missing. Once the link can be followed it is a project like
// any other, read and closed.
test('under include_projects "all", a symlinked project the round cannot follow stops it before the model (exit 4) with no mark; once it can be followed its session is read', () => {
  const w = makeCurateWorld({ config: (c) => { c.sources.transcripts.include_projects = 'all'; } });
  const volume = join(w.base, 'unmounted', 'volume');
  const link = join(w.projects, '-home-ana-linked');
  symlinkSync(volume, link);
  w.scenario({ actions: propose(w) });
  const r = w.curate();
  assert.equal(r.status, EXIT.SOURCE_UNREAD, r.stderr);
  assert.equal(w.watermark(), null, 'no mark moves');
  assert.equal(w.launches().length, 0, 'the model is never started');
  const last = w.lastRun();
  assert.ok(last.reason.includes(link), `the reason names the link: ${last.reason}`);
  assert.ok(last.warnings.some((line) => line.includes('project_unreadable (-home-ana-linked)')), JSON.stringify(last.warnings));
  // Mounted again: the link is followed, its session read, the day closed.
  mkdirSync(volume, { recursive: true });
  const name = 'eeeeeeee-1111-4222-8333-444444444444.jsonl';
  writeFileSync(join(volume, name), `${JSON.stringify(user('Ana wrote the plan', `${utcDay(-1)}T15:00:00.000Z`))}\n`);
  const kept = [w.transcript, join(link, name)];
  w.scenario({ actions: propose(w), rewrite: { toolUses: kept.map((file_path) => ({ name: 'Read', input: { file_path, offset: 1 } })) } });
  const fixed = w.curate();
  assert.equal(fixed.status, EXIT.OK, fixed.stderr);
  assert.deepEqual(w.watermark(), { transcripts: utcDay(-1) });
  assert.deepEqual(w.lastRun().sources.transcripts, { kept: 2, read: 2, advanced: true, noTimestamp: 0 });
});
