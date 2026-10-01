// Outside a vault, every command that says "no vault found" ends the same
// way, in the user's language (the stranger's m3 and m8, and the second one's
// F14, 01/10/2026).
//
// The first version of this ending was "To create one: brain-kit init <dir>"
// on five commands and nothing on the others. The case that matters is not
// the person with no vault: it is the person who has one and forgot to go
// into its folder, and "to create one" sent them to make a second vault. The
// ending is now two sentences, the same everywhere: go into the folder (or
// pass -C), and only then how to create a new vault.
//
// `doctor` has its own task in the same release (it also checks the
// machine); it is held to the weaker claim that it still says how to create
// a vault, until it takes the ending too, and `prompt.*` messages are
// instructions to a model, not sentences for a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { loadMessages } from '../src/lang.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const FIND_IT = {
  en: 'If you already have a vault, go into its folder (cd <folder>) or pass -C <folder>.',
  'pt-BR': 'Se você já tem um vault, entre na pasta dele (cd <pasta>) ou use -C <pasta>.',
};
const CREATE_IT = {
  en: 'To create a new one: brain-kit init <dir>.',
  'pt-BR': 'Para criar um novo: brain-kit init <dir>.',
};
const TAIL = Object.fromEntries(Object.keys(FIND_IT).map((lang) => [lang, `${FIND_IT[lang]} ${CREATE_IT[lang]}`]));

// Every command whose message is the `<command>.no_vault` key, with an
// invocation that reaches the vault lookup.
const COMMANDS = {
  validate: ['validate'],
  lint: ['lint'],
  propose: ['propose', 'Add a note', '--only', 'notes/a.md'],
  curate: ['curate'],
  sync: ['sync'],
  machine: ['machine', 'show'],
  verify: ['verify', '--pr', '1'],
  watermark: ['watermark', 'show'],
  preflight: ['preflight'],
  update: ['update'],
  schedule: ['schedule', 'status'],
  questions: ['questions', 'list'],
};

function outsideAnyVault(argv, lang) {
  const base = makeTempDir('brain-kit-novault-');
  return spawnSync(process.execPath, [BIN, ...argv], {
    cwd: base,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LANG: lang, HOME: base, BRAIN_KIT_STATE_DIR: join(base, 'state') },
  });
}

for (const lang of ['en', 'pt-BR']) {
  for (const [name, argv] of Object.entries(COMMANDS)) {
    test(`${lang}: ${name} outside a vault exits 2 and ends with the two sentences: go into the folder, or create a new one`, () => {
      const r = outsideAnyVault(argv, lang);
      assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.endsWith(`${TAIL[lang]}\n`), r.stderr);
      assert.match(r.stderr, /brain-kit\.config\.json/, 'it still says what was looked for');
      assert.doesNotMatch(r.stderr, /\{[a-z_]+\}/);
      assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, 'one message, one line');
    });
  }

  test(`${lang}: machine register --new outside a vault says to go into the folder first, and keeps its own account of --new`, () => {
    const r = outsideAnyVault(['machine', 'register', '--new'], lang);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(FIND_IT[lang]), r.stderr);
    assert.ok(r.stderr.includes('brain-kit init <dir>'), r.stderr);
    assert.ok(r.stderr.includes('brain-kit init --adopt <dir>'), r.stderr);
    assert.doesNotMatch(r.stderr, /\{[a-z_]+\}/);
  });

  test(`${lang}: doctor outside a vault exits 2 and ends by saying how to create one`, () => {
    const r = outsideAnyVault(['doctor'], lang);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /brain-kit init <dir>\.?\n$/);
    assert.match(r.stderr, /brain-kit\.config\.json/);
  });
}

// The pack itself, so a command added tomorrow with a `no_vault` message
// cannot skip the ending: every such key of both packs carries it.
test('every no_vault message of both packs carries the ending, and the ones that are about a vault end with it', () => {
  const NOT_FOR_A_PERSON = (key) => key.startsWith('prompt.');
  const OWNED_ELSEWHERE = ['doctor.no_vault'];
  const WITH_ITS_OWN_TAIL = ['machine.register_new_no_vault'];
  for (const lang of ['en', 'pt-BR']) {
    const pack = loadMessages(lang);
    const keys = Object.keys(pack).filter((key) => /no_vault/.test(key) && !NOT_FOR_A_PERSON(key) && !OWNED_ELSEWHERE.includes(key));
    assert.deepEqual(keys.filter((key) => key.endsWith('.no_vault')).map((key) => key.split('.')[0]).sort(), [...Object.keys(COMMANDS)].sort(), `${lang}: the commands this file runs are the commands with a message`);
    for (const key of keys) {
      assert.ok(pack[key].includes(FIND_IT[lang]), `${lang} ${key}: ${pack[key]}`);
      if (!WITH_ITS_OWN_TAIL.includes(key)) assert.ok(pack[key].endsWith(TAIL[lang]), `${lang} ${key} must end with the two sentences: ${pack[key]}`);
    }
    assert.ok(keys.includes('machine.register_new_no_vault'));
  }
});

test('curate says the vault is marked by the configuration AND a root index, as the others do', () => {
  const en = outsideAnyVault(['curate'], 'en');
  assert.match(en.stderr, /looked for brain-kit\.config\.json and a root index\.md/);
  assert.doesNotMatch(en.stderr, /brain-kit\.config\.json or /);
  const pt = outsideAnyVault(['curate'], 'pt-BR');
  assert.match(pt.stderr, /brain-kit\.config\.json e um index\.md/);
  assert.doesNotMatch(pt.stderr, /brain-kit\.config\.json ou /);
});

test('a command that sits in a vault is not told to create one, nor to go looking for it', () => {
  const base = makeTempDir('brain-kit-novault-');
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  const env = { ...process.env, BRAIN_KIT_LANG: 'en', HOME: home, BRAIN_KIT_STATE_DIR: join(base, 'state') };
  const init = spawnSync(process.execPath, [BIN, 'init', vault, '--yes'], { cwd: base, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(init.status, EXIT.OK, init.stdout + init.stderr);
  const r = spawnSync(process.execPath, [BIN, 'validate', vault], { cwd: base, encoding: 'utf8', env });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /To create a new one|If you already have a vault/);
  // -C, the way out the sentence offers, works from outside.
  const viaC = spawnSync(process.execPath, [BIN, '-C', vault, 'validate'], { cwd: base, encoding: 'utf8', env });
  assert.equal(viaC.status, EXIT.OK, viaC.stdout + viaC.stderr);
});
