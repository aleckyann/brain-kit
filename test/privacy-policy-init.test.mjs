// What a vault the real `init` makes says about privacy (02/10/2026): its
// configuration carries privacy.sensitive at save for all three audiences, no
// topic set aside and no keyword for lint to refuse, and its checks stay the
// one clean line init prints for a clean vault: with no keyword listed, lint's
// keyword clause is not in play, so a whole-vault run adds no line about it.
// And init's last lines say, in one line, that by default the curator records
// everything and where to change it, for a new vault and an adopted one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { walkVault } from '../src/vault.mjs';
import { runInit } from '../src/commands/init.mjs';
import { privacyLine } from '../src/privacy-policy.mjs';
import { CLEAN_ENV } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

const ANSWERS = {
  en: { lang: 'en', name: 'Ana', handle: 'ana', title: "Ana's brain", repo: null, private: true, timezone: 'UTC', email: null },
  'pt-BR': { lang: 'pt-BR', name: 'Ana', handle: 'ana', title: 'O cérebro da Ana', repo: null, private: true, timezone: 'UTC', email: null },
};

function init(lang) {
  const base = makeTempDir('brain-kit-privacy-init-');
  const vault = join(base, 'vault');
  const home = join(base, 'home');
  mkdirSync(home);
  const env = { ...CLEAN_ENV, BRAIN_KIT_LANG: lang, BRAIN_KIT_STATE_DIR: join(base, 'state'), HOME: home, TZ: 'UTC' };
  const answers = join(base, 'answers.json');
  writeFileSync(answers, JSON.stringify(ANSWERS[lang]));
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--from-answers', answers], { cwd: base, encoding: 'utf8', env });
  const kit = (argv) => spawnSync(process.execPath, [BIN, ...argv], { cwd: vault, encoding: 'utf8', env });
  return { r, vault, kit };
}

for (const lang of ['pt-BR', 'en']) {
  const t = createTranslator(lang);

  test(`${lang}: init writes the privacy keys with the default, and lists no keyword`, () => {
    const { r, vault } = init(lang);
    assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
    const { privacy } = JSON.parse(readFileSync(join(vault, 'brain-kit.config.json'), 'utf8'));
    assert.deepEqual(privacy.sensitive, { owner: 'save', people: 'save', outsiders: 'save' });
    assert.deepEqual(privacy.never_topics, []);
    assert.deepEqual(privacy.third_party_keywords, []);
  });

  test(`${lang}: with no keyword listed, init still prints its one clean line, and lint over the whole vault adds no line about keywords`, () => {
    const { r, kit } = init(lang);
    assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
    assert.equal(r.stdout.split(`${t('init.checks_clean')}\n`).length - 1, 1, r.stdout);
    assert.equal(r.stdout.includes(t('lint.privacy_keywords_not_checked')), false);
    const text = kit(['lint', '--base', 'all']);
    assert.equal(text.status, EXIT.OK, text.stdout + text.stderr);
    assert.equal(text.stdout.includes(t('lint.privacy_keywords_not_checked')), false, text.stdout);
    assert.ok(text.stdout.trimEnd().endsWith(t('lint.verdict_clean')), text.stdout);
    const json = JSON.parse(kit(['lint', '--base', 'all', '--json']).stdout);
    assert.equal(json.privacyKeywords, null, 'the keyword clause is not in play');
    assert.equal(json.counts.skipped, 0, 'and no rule is skipped');
  });

  test(`${lang}: init ends with one line saying the curator records everything by default and where to change it, before the next steps`, () => {
    const { r, vault } = init(lang);
    assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
    const line = t('init.privacy_default', { sensitive: 'privacy.sensitive', topics: 'privacy.never_topics', file: 'brain-kit.config.json' });
    assert.equal(line.includes('\n'), false);
    assert.match(line, lang === 'en'
      ? /^Privacy: by default the curator records everything, personal and sensitive information included, yours and other people's\. To limit it, set privacy\.sensitive and privacy\.never_topics in brain-kit\.config\.json \(README, "Privacy: what the curator saves"\)\.$/
      : /^Privacidade: por padrão o curador guarda tudo, inclusive informação pessoal e sensível, a sua e a de outras pessoas\. Para limitar, ajuste privacy\.sensitive e privacy\.never_topics no brain-kit\.config\.json \(README, "Privacidade: o que o curador guarda"\)\.$/);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.filter((l) => l === line).length, 1, r.stdout);
    const at = lines.indexOf(line);
    assert.equal(lines[at - 1], t('init.no_commit'), 'right after the commit line');
    const block = t('init.next_steps', { dir: realpathSync(vault), name: 'vault' });
    assert.ok(r.stdout.endsWith(`${line}\n${block}\n`), `the next steps follow it, last:\n${r.stdout}`);
  });

  test(`${lang}: an adopted vault gets the same line, last`, () => {
    const base = makeTempDir('brain-kit-privacy-adopt-');
    const vault = join(base, 'notes');
    const home = join(base, 'home');
    mkdirSync(vault);
    mkdirSync(home);
    writeFileSync(join(vault, 'index.md'), '# Index\n');
    const env = { ...CLEAN_ENV, BRAIN_KIT_LANG: lang, BRAIN_KIT_STATE_DIR: join(base, 'state'), HOME: home, TZ: 'UTC' };
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: vault, env }).status, 0);
    const answers = join(base, 'answers.json');
    writeFileSync(answers, JSON.stringify(ANSWERS[lang]));
    const r = spawnSync(process.execPath, [BIN, 'init', '--adopt', vault, '--from-answers', answers, '--no-hook'], { cwd: base, encoding: 'utf8', env });
    // Adopted: the configuration is written, whatever validate and lint then
    // say of a one-line index (their verdict is the exit code).
    assert.ok(readFileSync(join(vault, 'brain-kit.config.json'), 'utf8').includes('"sensitive"'), r.stdout + r.stderr);
    const line = t('init.privacy_default', { sensitive: 'privacy.sensitive', topics: 'privacy.never_topics', file: 'brain-kit.config.json' });
    assert.ok(r.stdout.endsWith(`${t('init.adopt_no_commit')}\n${line}\n`), r.stdout.slice(-600));
  });
}

// A configuration that is not the default (an inference that kept a limit) is
// said as the policy in effect, never as the default.
test('a configuration that sets a limit is said as the policy in effect', async () => {
  const t = createTranslator('en');
  const base = makeTempDir('brain-kit-privacy-adopt-set-');
  const vault = join(base, 'notes');
  mkdirSync(vault);
  writeFileSync(join(vault, 'index.md'), '# Index\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: vault, env: CLEAN_ENV }).status, 0);
  const answers = join(base, 'answers.json');
  writeFileSync(answers, JSON.stringify(ANSWERS.en));
  const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', 'en', 'config.defaults.json'), 'utf8'));
  defaults.privacy.sensitive.people = 'skip';
  let out = '';
  const io = { stdin: { isTTY: false }, stdout: { write: (s) => { out += s; return true; } }, stderr: { write: () => true } };
  const quiet = { validate: async () => EXIT.OK, lint: async () => EXIT.OK };
  await runInit(['--adopt', vault, '--from-answers', answers, '--no-hook'], io, t, {
    walkVault, env: { ...CLEAN_ENV, BRAIN_KIT_STATE_DIR: join(base, 'state'), TZ: 'UTC' }, cwd: base, infer: () => ({ config: structuredClone(defaults), notes: [] }), checks: quiet,
  });
  const written = JSON.parse(readFileSync(join(vault, 'brain-kit.config.json'), 'utf8'));
  assert.equal(written.privacy.sensitive.people, 'skip');
  const expected = t('init.privacy_set', { policy: privacyLine(written, t) });
  assert.ok(out.endsWith(`${expected}\n`), out.slice(-400));
  assert.ok(expected.includes('people=skip'));
  assert.equal(out.includes(t('init.privacy_default', { sensitive: 'privacy.sensitive', topics: 'privacy.never_topics', file: 'brain-kit.config.json' })), false);
});
