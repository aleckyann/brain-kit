// `brain-kit doctor`'s include-projects check for the vault's own project, on
// more than one machine.
//
// The second stranger (01/10/2026) cloned a vault that 0.0.8 `init` had made
// onto a second machine, at another path, and the doctor failed there: first
// "the transcripts directory does not exist" with an advice (`machine set
// transcripts_dir`) that does not help, and once that folder existed, "fix the
// names in brain-kit.config.json", which would have pointed machine 1's
// curator at machine 2's path. Machine 1, in the same situation, was ok. The
// entry `{vault}` means "the project Claude Code names for this vault's folder
// on this machine", so one configuration is right on both. These tests build
// machines of their own (a HOME, a state directory and a clone each, at paths
// that differ) and run the real check on each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from '../src/lang.mjs';
import { runDoctor } from '../src/commands/doctor.mjs';
import { stateDirFor } from '../src/state.mjs';
import { claudeProjectName } from '../src/sources/transcripts-claude-code.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const root = realpathSync(makeTempDir('bk-vpd-'));
let counter = 0;

const FIXTURE = { en: 'valid.json', 'pt-BR': 'valid-pt-BR.json' };
// The sentence every message about a name that is not there ends up carrying.
const WAY_OUT = {
  en: 'If this vault is also used on another machine, use {vault} instead of a project name so the same configuration works on both.',
  'pt-BR': 'Se este vault também é usado em outra máquina, use {vault} no lugar de um nome de projeto, para que a mesma configuração sirva nas duas.',
};

// One machine: its own HOME and state directory, and a clone of the vault at
// `path` under it. `like` is a machine whose HOME this one shares (a second
// clone on the same machine). `include` is the list, or a function of the
// machine that gives it (a name that depends on the clone's path).
function machine({ path = ['home', 'ana', 'my-brain'], include, lang = 'en', transcripts = null, like = null } = {}) {
  counter += 1;
  const top = join(root, `machine-${counter}`);
  const vault = join(top, ...path);
  mkdirSync(vault, { recursive: true });
  const home = like ? like.home : join(top, 'user-home');
  mkdirSync(home, { recursive: true });
  const env = like ? like.env : { HOME: home, XDG_STATE_HOME: join(top, 'state') };
  const real = realpathSync(vault);
  const m = {
    top, home, env, lang, vault: real, projects: join(home, '.claude', 'projects'), own: claudeProjectName(real), file: join(real, 'brain-kit.config.json'),
  };
  writeFileSync(join(real, 'index.md'), '# Index\n');
  m.configure = (list) => {
    const config = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', FIXTURE[lang]), 'utf8'));
    config.sources.transcripts.include_projects = typeof list === 'function' ? list(m) : list;
    writeFileSync(m.file, JSON.stringify(config, null, 2));
  };
  if (include !== undefined) m.configure(include);
  if (transcripts !== null) {
    const dir = stateDirFor(real, env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'machine.json'), JSON.stringify({ transcripts_dir: transcripts }));
  }
  return m;
}

// The include-projects check on machine `m`, from a working directory that is
// not the vault, as the report prints it.
async function check(m, { env = {} } = {}) {
  const out = [];
  const err = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  const code = await runDoctor([m.vault, '--only', 'include-projects', '--json'], io, createTranslator('en'), { env: { ...m.env, ...env }, cwd: root });
  assert.equal(err.join(''), '');
  const [result] = JSON.parse(out.join('')).checks;
  return { ...result, code };
}

const isOk = (c, key) => {
  assert.equal(c.status, 'ok', JSON.stringify(c));
  assert.equal(c.messageKey, key, JSON.stringify(c));
  assert.equal(c.code, 0);
};

// --- the stranger's second machine -------------------------------------------

test('the same configuration, {vault} alone, on two machines whose clones are at different paths: neither fails, whether or not Claude Code ever ran there, and each names its own project', async () => {
  const first = machine({ path: ['home', 'ana', 'my-brain'], include: ['{vault}'] });
  const second = machine({ path: ['Users', 'ana', 'my-brain'], include: ['{vault}'] });
  assert.equal(readFileSync(first.file, 'utf8'), readFileSync(second.file, 'utf8'), 'one configuration, byte for byte');
  assert.notEqual(first.own, second.own);

  for (const m of [first, second]) {
    isOk(await check(m), 'doctor.include_projects.no_sessions_yet');
    assert.deepEqual((await check(m)).params.projects, [m.own]);
  }
  // Claude Code ran on both machines, in other projects only.
  for (const m of [first, second]) mkdirSync(join(m.projects, '-home-ana-something-else'), { recursive: true });
  for (const m of [first, second]) {
    isOk(await check(m), 'doctor.include_projects.no_sessions_yet');
    assert.deepEqual((await check(m)).params.projects, [m.own]);
  }
  // A session ran in the second machine's vault: it is read there, and the first is as it was.
  mkdirSync(join(second.projects, second.own), { recursive: true });
  const found = await check(second);
  isOk(found, 'doctor.include_projects.ok');
  assert.equal(found.params.count, 1);
  isOk(await check(first), 'doctor.include_projects.no_sessions_yet');
});

test('two clones on ONE machine share its projects folder: a folder for B alone makes B read it and leaves A with no sessions yet', async () => {
  const a = machine({ path: ['home', 'ana', 'my-brain'], include: ['{vault}'] });
  const b = machine({ path: ['Users', 'ana', 'my-brain'], include: ['{vault}'], like: a });
  assert.equal(a.projects, b.projects);
  mkdirSync(a.projects, { recursive: true });
  mkdirSync(join(a.projects, b.own));
  isOk(await check(a), 'doctor.include_projects.no_sessions_yet');
  assert.deepEqual((await check(a)).params.projects, [a.own]);
  isOk(await check(b), 'doctor.include_projects.ok');
  mkdirSync(join(a.projects, a.own));
  isOk(await check(a), 'doctor.include_projects.ok');
});

test('the entry beside a name: the name is checked like any other, and the vault\'s own project with no sessions yet waits', async () => {
  const waiting = machine({ include: ['{vault}', '-home-ana-code'] });
  mkdirSync(join(waiting.projects, '-home-ana-code'), { recursive: true });
  const c = await check(waiting);
  isOk(c, 'doctor.include_projects.some_waiting');
  assert.equal(c.params.count, 1);
  assert.deepEqual(c.params.projects, [waiting.own]);

  const both = machine({ include: ['{vault}', '-home-ana-code'] });
  mkdirSync(join(both.projects, '-home-ana-code'), { recursive: true });
  mkdirSync(join(both.projects, both.own));
  const ok = await check(both);
  isOk(ok, 'doctor.include_projects.ok');
  assert.equal(ok.params.count, 2);

  const lost = machine({ include: ['{vault}', '-home-ana-gone'] });
  mkdirSync(join(lost.projects, lost.own), { recursive: true });
  const warned = await check(lost);
  assert.equal(warned.status, 'warn', JSON.stringify(warned));
  assert.equal(warned.messageKey, 'doctor.include_projects.some_missing');
  assert.deepEqual(warned.params.projects, ['-home-ana-gone']);
  assert.equal(warned.code, 0);
});

test('"all" is as it was: every project of the folder counts, and the vault\'s own project being there or not changes nothing', async () => {
  const m = machine({ include: 'all' });
  mkdirSync(join(m.projects, '-home-ana-code'), { recursive: true });
  mkdirSync(join(m.projects, '-home-ana-notes'));
  const c = await check(m);
  isOk(c, 'doctor.include_projects.all');
  assert.equal(c.params.count, 2);
});

// --- a vault made before the entry existed --------------------------------------

test('a vault whose configuration names machine 1\'s project, opened on machine 2 at another path: the diagnosis is today\'s, and every message about a name that is not there now says what makes one configuration work on both', async () => {
  const first = machine({ path: ['home', 'ana', 'my-brain'] });
  first.configure([first.own]);
  const second = machine({ path: ['Users', 'ana', 'my-brain'] });
  second.configure([first.own]);
  assert.equal(readFileSync(first.file, 'utf8'), readFileSync(second.file, 'utf8'));

  // Machine 1 is exactly as it was in 0.0.8: its own name, no sessions yet.
  isOk(await check(first), 'doctor.include_projects.no_sessions_yet');

  // Machine 2, where Claude Code never ran: there is no projects folder, and machine set transcripts_dir is no cure.
  let c = await check(second);
  assert.equal(c.status, 'fail');
  assert.equal(c.messageKey, 'doctor.include_projects.root_missing', 'the same message as ever');
  assert.match(c.message, /the transcripts directory .* does not exist/);
  assert.ok(c.message.includes('brain-kit machine set transcripts_dir <dir>'), c.message);
  assert.ok(c.message.includes(WAY_OUT.en), c.message);

  // The projects folder is made, without that name: today's message, plus the way out.
  mkdirSync(second.projects, { recursive: true });
  c = await check(second);
  assert.equal(c.status, 'fail');
  assert.equal(c.messageKey, 'doctor.include_projects.all_missing');
  assert.deepEqual(c.params.projects, [first.own]);
  assert.match(c.message, /Fix the names in /);
  assert.ok(c.message.includes(WAY_OUT.en), c.message);
  assert.ok(c.message.includes('Before the first round'), c.message);

  // One of two names there: a warning, with the same sentence.
  mkdirSync(join(second.projects, '-home-ana-code'));
  second.configure([first.own, '-home-ana-code']);
  c = await check(second);
  assert.equal(c.status, 'warn');
  assert.equal(c.messageKey, 'doctor.include_projects.some_missing');
  assert.deepEqual(c.params.projects, [first.own]);
  assert.ok(c.message.includes(WAY_OUT.en), c.message);
  assert.equal(c.code, 0);
});

test('the way out is said in Portuguese too, with the entry spelt out', async () => {
  const first = machine({ lang: 'pt-BR' });
  const second = machine({ path: ['Users', 'ana', 'my-brain'], lang: 'pt-BR' });
  second.configure([first.own]);
  const missing = await check(second);
  assert.equal(missing.messageKey, 'doctor.include_projects.root_missing');
  assert.ok(missing.message.includes(WAY_OUT['pt-BR']), missing.message);
  mkdirSync(second.projects, { recursive: true });
  const all = await check(second);
  assert.equal(all.messageKey, 'doctor.include_projects.all_missing');
  assert.ok(all.message.includes(WAY_OUT['pt-BR']), all.message);
  mkdirSync(join(second.projects, '-home-ana-code'));
  second.configure([first.own, '-home-ana-code']);
  const some = await check(second);
  assert.equal(some.messageKey, 'doctor.include_projects.some_missing');
  assert.ok(some.message.includes(WAY_OUT['pt-BR']), some.message);
  for (const c of [missing, all, some]) assert.doesNotMatch(c.message.replaceAll('{vault}', ''), /\{\w+\}/, c.message);
});

test('a name written out that is the vault\'s own on this machine is as it was: ok with no sessions yet, no way out suggested, nothing to migrate', async () => {
  const m = machine({ include: (self) => [self.own] });
  const c = await check(m);
  isOk(c, 'doctor.include_projects.no_sessions_yet');
  assert.doesNotMatch(c.message, /\{vault\}/);
  mkdirSync(join(m.projects, m.own), { recursive: true });
  isOk(await check(m), 'doctor.include_projects.ok');
});

test('a typo beside the entry is still a name that is not there, and the sentence follows it; the project the entry stands for is not listed among the names to fix', async () => {
  const bare = machine({ include: ['{vault}', '-home-ana-typo'] });
  const noFolder = await check(bare);
  assert.equal(noFolder.status, 'fail');
  assert.equal(noFolder.messageKey, 'doctor.include_projects.root_missing');
  assert.ok(noFolder.message.includes(WAY_OUT.en));
  mkdirSync(bare.projects, { recursive: true });
  const none = await check(bare);
  assert.equal(none.status, 'fail');
  assert.equal(none.messageKey, 'doctor.include_projects.all_missing');
  assert.deepEqual(none.params.projects, ['-home-ana-typo'], 'the entry is not a name in the file to correct');
  assert.ok(none.message.includes(WAY_OUT.en));
});

// --- the empty list -------------------------------------------------------------

test('an empty list: the message offers {vault} first, as the project of this vault on whatever machine it is opened, and explains "all" second', async () => {
  const m = machine({ include: [] });
  const c = await check(m);
  assert.equal(c.status, 'fail');
  assert.equal(c.messageKey, 'doctor.include_projects.empty');
  assert.equal(c.code, 1);
  assert.equal(c.params.token, '{vault}');
  assert.equal(c.params.project, m.own, 'what the entry is here');
  assert.equal(c.params.doc, 'docs/scheduling.md');
  assert.ok(c.message.includes('["{vault}"]'), c.message);
  assert.match(c.message, /the project of this vault, on whatever machine it is opened/);
  assert.ok(c.message.includes(m.own), 'it says what the entry is on this machine');
  assert.ok(c.message.indexOf('["{vault}"]') < c.message.indexOf('"all"'), 'the entry first, "all" second');
  assert.ok(!c.message.includes(`["${m.own}"]`), 'the name that depends on this machine is no longer what is offered');
  assert.match(c.message, /"all" is accepted .* every project on this machine/);
  assert.match(c.message, /name of a directory under /);
  assert.match(c.message, /docs\/scheduling\.md/);
  assert.match(c.message, /Before the first round/);
});

test('the empty list in Portuguese offers the same entry first and the same "all" second', async () => {
  const m = machine({ include: [], lang: 'pt-BR' });
  const c = await check(m);
  assert.equal(c.messageKey, 'doctor.include_projects.empty');
  assert.ok(c.message.includes('["{vault}"]'), c.message);
  assert.match(c.message, /o projeto deste vault, em qualquer máquina em que ele for aberto/);
  assert.ok(c.message.indexOf('["{vault}"]') < c.message.indexOf('"all"'));
  assert.doesNotMatch(c.message.replaceAll('{vault}', ''), /\{\w+\}/, c.message);
  assert.match(c.message, /docs\/scheduling\.md/);
  assert.match(c.message, /Before the first round/);
});

// --- the guards of a new vault, for the entry -----------------------------------

test('the guards hold for the entry as they did for its name: a named projects folder that is not there, one moved by CLAUDE_CONFIG_DIR, a broken link and a file all fail; and none of them says to edit the shared configuration', async () => {
  const messages = [];
  const failed = async (m, key, options) => {
    const c = await check(m, options);
    assert.equal(c.status, 'fail', JSON.stringify(c));
    assert.equal(c.messageKey, key, JSON.stringify(c));
    assert.equal(c.code, 1);
    messages.push(c.message);
    return c;
  };

  // A projects folder named on purpose that is not there.
  await failed(machine({ include: ['{vault}'], transcripts: '~/nowhere' }), 'doctor.include_projects.root_missing');

  // Moved by CLAUDE_CONFIG_DIR and not named: the default folder absent...
  const moved = (m) => ({ env: { CLAUDE_CONFIG_DIR: join(m.top, 'elsewhere') } });
  const absent = machine({ include: ['{vault}'] });
  await failed(absent, 'doctor.include_projects.root_missing', moved(absent));
  // ...and present without the vault's project: where Claude Code keeps it is the question, not the names in the file.
  const present = machine({ include: ['{vault}'] });
  mkdirSync(present.projects, { recursive: true });
  const own = await failed(present, 'doctor.include_projects.own_missing', moved(present));
  assert.equal(own.params.project, present.own);
  assert.match(own.message, /CLAUDE_CONFIG_DIR/);
  assert.ok(own.message.includes('brain-kit machine set transcripts_dir <dir>'), own.message);
  // Naming the folder says where to look, and then the project is only waiting.
  const named = machine({ include: ['{vault}'], transcripts: '~/sessions' });
  mkdirSync(join(named.home, 'sessions'), { recursive: true });
  isOk(await check(named, moved(named)), 'doctor.include_projects.no_sessions_yet');
  // An empty CLAUDE_CONFIG_DIR is no setting.
  isOk(await check(present, { env: { CLAUDE_CONFIG_DIR: '' } }), 'doctor.include_projects.no_sessions_yet');

  // A broken link, or a file, where the default folder should be.
  const link = machine({ include: ['{vault}'] });
  mkdirSync(join(link.home, '.claude'), { recursive: true });
  symlinkSync(join(link.top, 'unmounted', 'volume'), link.projects);
  await failed(link, 'doctor.include_projects.root_missing');
  const file = machine({ include: ['{vault}'] });
  mkdirSync(join(file.home, '.claude'), { recursive: true });
  writeFileSync(file.projects, 'not a folder');
  await failed(file, 'doctor.include_projects.root_missing');

  // The entry stands for the vault's own project: no failure above sends a person to the shared file to fix a name that depends on the machine.
  assert.equal(messages.length, 5);
  for (const message of messages) {
    assert.doesNotMatch(message, /brain-kit\.config\.json|include_projects|Fix the names/, message);
  }
});

test('a project of the entry that cannot be read is a failure with the permissions advice, as for any name', { skip: process.getuid?.() === 0 ? 'root reads any directory' : false }, async () => {
  const m = machine({ include: ['{vault}'] });
  const dir = join(m.projects, m.own);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o000);
  try {
    const c = await check(m);
    assert.equal(c.status, 'fail');
    assert.equal(c.messageKey, 'doctor.include_projects.unreadable');
    assert.deepEqual(c.params.projects, [m.own]);
  } finally {
    chmodSync(dir, 0o700);
  }
});

// --- a vault whose path Claude Code shortens ---------------------------------------

test('a vault whose project cannot be named from its path: the entry stands for nothing there and the doctor says so, instead of saying that the list is empty or that a project is missing', async () => {
  const long = 'v'.repeat(210);
  const alone = machine({ path: [long], include: ['{vault}'] });
  assert.equal(alone.own, null);
  let c = await check(alone);
  assert.equal(c.status, 'fail');
  assert.equal(c.messageKey, 'doctor.include_projects.vault_unnamed');
  assert.equal(c.code, 1);
  assert.ok(c.message.includes(alone.vault), 'the path it could not be told from');
  assert.match(c.message, /stands for nothing here/);
  assert.match(c.message, /"all"/);
  assert.match(c.message, /Before the first round/);

  // The list empty on such a vault: the same advice, since the entry is no way out here.
  alone.configure([]);
  c = await check(alone);
  assert.equal(c.messageKey, 'doctor.include_projects.vault_unnamed');

  // Beside a name that is there: a warning, and that project is read.
  const beside = machine({ path: [long], include: ['{vault}', '-home-ana-code'] });
  mkdirSync(join(beside.projects, '-home-ana-code'), { recursive: true });
  c = await check(beside);
  assert.equal(c.status, 'warn');
  assert.equal(c.messageKey, 'doctor.include_projects.some_unnamed');
  assert.ok(c.message.includes(beside.vault));
  assert.equal(c.code, 0);

  // Portuguese.
  const pt = machine({ path: [long], include: ['{vault}'], lang: 'pt-BR' });
  c = await check(pt);
  assert.equal(c.messageKey, 'doctor.include_projects.vault_unnamed');
  assert.doesNotMatch(c.message.replaceAll('{vault}', ''), /\{\w+\}/, c.message);
});
