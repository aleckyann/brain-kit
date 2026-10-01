// A folder of loose notes meets `init` and then `init --adopt` (the second
// stranger's F15, the first one's m20, 01/10/2026).
//
// `init` refused the folder and pointed at `--adopt`; `--adopt` refused it
// again because the folder had no index.md at its root, and ended with
// "Nothing was written" and no next step: a dead end. Both refusals now say
// what to do. `init` says what adopting needs (a git repository, and an
// index.md at its root that lists its folders) and the simplest way out (a
// new, empty folder for `init`, and the notes moved in); `--adopt` says,
// for each thing missing, how to supply it, with the index.md as an example
// of three lines. Message-only: nothing here makes adopt create a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { MANIFEST_PATH } from '../src/manifest.mjs';
import { CLEAN_ENV } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const NEW_DIR = { en: 'brain-kit init <new-dir>', 'pt-BR': 'brain-kit init <pasta-nova>' };

// A folder of loose notes: no git, no index.md.
function looseNotes(lang) {
  const base = makeTempDir('brain-kit-nextstep-');
  const folder = join(base, 'notes');
  mkdirSync(folder);
  writeFileSync(join(folder, 'idea.md'), '# An idea\n');
  writeFileSync(join(folder, 'meeting.md'), '# A meeting\n');
  const env = { ...process.env, BRAIN_KIT_LANG: lang, HOME: join(base, 'home'), BRAIN_KIT_STATE_DIR: join(base, 'state'), TZ: 'UTC' };
  mkdirSync(env.HOME);
  const kit = (argv) => spawnSync(process.execPath, [BIN, ...argv], { cwd: base, encoding: 'utf8', env, input: '' });
  // The caller's GIT_* variables stripped (CLEAN_ENV), as everywhere git is called here.
  const git = (argv) => spawnSync('git', argv, { cwd: folder, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_AUTHOR_NAME: 'Ana', GIT_AUTHOR_EMAIL: 'ana@example.com', GIT_COMMITTER_NAME: 'Ana', GIT_COMMITTER_EMAIL: 'ana@example.com' } });
  return { base, folder, env, kit, git };
}

function listing(root) {
  const out = [];
  const walk = (rel) => {
    const abs = rel === '' ? root : join(root, rel);
    if (lstatSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(rel === '' ? name : `${rel}/${name}`);
    } else {
      out.push(`${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk('');
  return out;
}

// The index.md the message shows: its indented lines, as they are to be typed.
function exampleIn(text) {
  return text.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.slice(2));
}

for (const lang of ['en', 'pt-BR']) {
  const t = createTranslator(lang);

  test(`${lang}: init in a folder of loose notes explains what adopting needs and offers the simplest way out, and writes nothing`, () => {
    const w = looseNotes(lang);
    const before = listing(w.base);
    const r = w.kit(['init', w.folder]);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${t('init.not_empty', { dir: w.folder, count: 2 })}\n`);
    assert.ok(r.stderr.includes(NEW_DIR[lang]), 'the new, empty folder for init, and the notes moved in');
    assert.ok(r.stderr.includes('brain-kit init --adopt'), 'adopt is still named');
    assert.match(r.stderr, /git init/, 'what adopting needs: a git repository');
    assert.match(r.stderr, /index\.md/, 'what adopting needs: an index.md at the root');
    assert.doesNotMatch(r.stderr, /\{[a-z_]+\}/);
    assert.deepEqual(listing(w.base), before, 'nothing was written');
  });

  test(`${lang}: init in a folder that is already a git repository says what adopting still needs, which is the index.md and not git init`, () => {
    const w = looseNotes(lang);
    assert.equal(w.git(['init', '-q']).status, 0);
    const r = w.kit(['init', w.folder]);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(r.stderr, `${t('init.already_repository', { dir: w.folder })}\n`);
    assert.ok(r.stderr.includes(NEW_DIR[lang]));
    assert.ok(r.stderr.includes('brain-kit init --adopt'));
    assert.match(r.stderr, /index\.md/);
    assert.doesNotMatch(r.stderr, /git init/, 'it already is a repository');
  });

  test(`${lang}: init --adopt on a folder with no index.md says how to make one, with an example of three lines, and that git must be set up too`, () => {
    const w = looseNotes(lang);
    const before = listing(w.base);
    const r = w.kit(['init', '--adopt', w.folder]);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${t('init.adopt_no_index', { dir: w.folder })}\n`);
    const example = exampleIn(r.stderr);
    assert.equal(example.length, 3, `three lines of example: ${r.stderr}`);
    assert.match(example[0], /^# \S/, 'a title');
    assert.match(example[1], /^- \[[^\]]+\]\([^)]+\/index\.md\)$/, 'a link to a folder');
    assert.match(example[2], /^- \[[^\]]+\]\([^)]+\/index\.md\)$/, 'and another');
    assert.match(r.stderr, /\.gitignore/, 'a file git ignores is not one adopt can read');
    assert.match(r.stderr, /git init/, 'and the folder has to be a repository too');
    assert.doesNotMatch(r.stderr, /\{[a-z_]+\}/);
    assert.deepEqual(listing(w.base), before, 'adopt writes nothing: not the index.md either');
  });

  test(`${lang}: init --adopt on a folder with an index.md and no git repository says to run git init in it`, () => {
    const w = looseNotes(lang);
    writeFileSync(join(w.folder, 'index.md'), `${exampleIn(t('init.adopt_no_index', { dir: w.folder })).join('\n')}\n`);
    const before = listing(w.base);
    const r = w.kit(['init', '--adopt', w.folder]);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(r.stderr, `${t('init.adopt_not_repository', { dir: w.folder })}\n`);
    assert.match(r.stderr, /git init/);
    assert.ok(r.stderr.includes(w.folder), 'it says where to run it');
    assert.match(r.stderr, /\.gitignore/);
    assert.deepEqual(listing(w.base), before);
  });

  test(`${lang}: an index.md that .gitignore excludes is not read as one, and the message that says so has already told how to fix it`, () => {
    const w = looseNotes(lang);
    assert.equal(w.git(['init', '-q']).status, 0);
    writeFileSync(join(w.folder, '.gitignore'), 'index.md\n');
    writeFileSync(join(w.folder, 'index.md'), '# Notes\n');
    // Found only once the answers are in (what git would publish is listed then), hence --yes.
    const r = w.kit(['init', '--adopt', w.folder, '--yes', '--lang', lang]);
    assert.equal(r.status, EXIT.USAGE, r.stdout + r.stderr);
    assert.equal(r.stderr, `${t('init.adopt_no_index', { dir: w.folder })}\n`);
    assert.match(r.stderr, /\.gitignore/);
    assert.equal(existsSync(join(w.folder, 'brain-kit.config.json')), false);
  });

  test(`${lang}: doing what the messages say, one after the other, ends in an adopted vault: no dead end`, () => {
    const w = looseNotes(lang);
    // 1. init says to adopt, or to start in a new folder.
    assert.equal(w.kit(['init', w.folder]).status, EXIT.USAGE);
    // 2. adopt says to write an index.md, and shows one.
    const noIndex = w.kit(['init', '--adopt', w.folder]);
    assert.equal(noIndex.status, EXIT.USAGE);
    const example = exampleIn(noIndex.stderr);
    assert.equal(example.length, 3, `the refusal shows the file to write: ${noIndex.stderr}`);
    writeFileSync(join(w.folder, 'index.md'), `${example.join('\n')}\n`);
    // 3. adopt then says to make the folder a repository.
    const noRepository = w.kit(['init', '--adopt', w.folder]);
    assert.equal(noRepository.status, EXIT.USAGE);
    assert.match(noRepository.stderr, /git init/);
    assert.equal(w.git(['init', '-q']).status, 0);
    // 4. and now it adopts: whatever the checks that follow find, the refusal is over.
    const adopted = w.kit(['init', '--adopt', w.folder, '--yes', '--lang', lang]);
    assert.notEqual(adopted.status, EXIT.USAGE, adopted.stdout + adopted.stderr);
    assert.equal(existsSync(join(w.folder, 'brain-kit.config.json')), true, adopted.stdout + adopted.stderr);
    assert.equal(existsSync(join(w.folder, MANIFEST_PATH)), true);
    assert.equal(readFileSync(join(w.folder, 'idea.md'), 'utf8'), '# An idea\n', 'no note was touched');
  });
}
