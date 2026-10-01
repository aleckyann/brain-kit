// Outside a vault, the five commands a first-time user is likely to run
// first end their "no vault found" message with the one command that makes a
// vault, in the user's language (the stranger's m3 and m8, 01/10/2026), and
// `curate` no longer says the vault is marked by one of two files when it is
// marked by both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const HINT = { en: 'To create one: brain-kit init <dir>', 'pt-BR': 'Para criar um: brain-kit init <dir>' };
const COMMANDS = {
  doctor: ['doctor'],
  validate: ['validate'],
  lint: ['lint'],
  propose: ['propose', 'Add a note', '--only', 'notes/a.md'],
  curate: ['curate'],
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
    test(`${lang}: ${name} outside a vault exits 2 and ends by saying how to create one`, () => {
      const r = outsideAnyVault(argv, lang);
      assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.endsWith(`${HINT[lang]}\n`), r.stderr);
      assert.match(r.stderr, /brain-kit\.config\.json/, 'it still says what was looked for');
      assert.doesNotMatch(r.stderr, /\{[a-z_]+\}/);
    });
  }
}

test('curate says the vault is marked by the configuration AND a root index, as the others do', () => {
  const en = outsideAnyVault(['curate'], 'en');
  assert.match(en.stderr, /looked for brain-kit\.config\.json and a root index\.md/);
  assert.doesNotMatch(en.stderr, /brain-kit\.config\.json or /);
  const pt = outsideAnyVault(['curate'], 'pt-BR');
  assert.match(pt.stderr, /brain-kit\.config\.json e um index\.md/);
  assert.doesNotMatch(pt.stderr, /brain-kit\.config\.json ou /);
});

test('a command that sits in a vault is not told to create one', () => {
  const base = makeTempDir('brain-kit-novault-');
  const home = join(base, 'home');
  const vault = join(base, 'vault');
  const env = { ...process.env, BRAIN_KIT_LANG: 'en', HOME: home, BRAIN_KIT_STATE_DIR: join(base, 'state') };
  const init = spawnSync(process.execPath, [BIN, 'init', vault, '--yes'], { cwd: base, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(init.status, EXIT.OK, init.stdout + init.stderr);
  const r = spawnSync(process.execPath, [BIN, 'validate', vault], { cwd: base, encoding: 'utf8', env });
  assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /To create one/);
});
