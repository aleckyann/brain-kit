// The privacy setting is the kit's, not one round's (docs/incidents.md,
// 02/10/2026): the session that curates itself (curate-session), the capture
// of one fact (capture) and the morning briefing's own record follow
// privacy.sensitive and privacy.never_topics too, through the same
// `{{privacy_policy}}` the curate prompt carries, rendered by the one function
// (src/privacy-policy.mjs). In a session the person is there, so a skill also
// says to ask before leaving out or shortening what they asked to record.
// The setup skill tells a new owner what the curator keeps by default, and the
// briefing's calendar block no longer says nothing of anyone's private life is
// content, which kept the owner's own appointments out of their own briefing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { BRIEFING_PLACEHOLDERS, runPrompt } from '../src/commands/prompt.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const LANGS = ['pt-BR', 'en'];
const NOW = new Date('2026-09-25T12:00:00Z');
const NO_GH = { findExecutable: () => null };

function freshVault(lang, edit = null) {
  const base = makeTempDir('brain-kit-privacy-skills-');
  mkdirSync(join(base, 'home'));
  const vault = join(base, 'vault');
  const env = { ...process.env, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: join(base, 'state'), HOME: join(base, 'home'), USER: 'ana', LOGNAME: 'ana', TZ: 'UTC' };
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], { encoding: 'utf8', env, cwd: base });
  assert.equal(r.status, 0, `init failed: ${r.stdout}${r.stderr}`);
  if (edit) {
    const file = join(vault, 'brain-kit.config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    edit(config);
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { base, vault, env };
}

function collector() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (chunk) => { out += chunk; return true; } },
      stderr: { write: (chunk) => { err += chunk; return true; } },
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

async function prompt(argv, world, extra = {}) {
  const c = collector();
  const code = await runPrompt(argv, c.io, createTranslator('en'), { cwd: world.vault ?? world.cwd, env: world.env, now: NOW, ...extra });
  return { code, out: c.stdout, err: c.stderr };
}

const ASK_FIRST = {
  en: 'When the person asks you to record something this setting leaves out or shortens, tell them what the setting says and let them decide: never decide it for them.',
  'pt-BR': 'Quando a pessoa pedir para registrar algo que essa configuração deixa de fora ou resume, diga o que a configuração diz e deixe a decisão com ela: nunca decida por ela.',
};

for (const lang of LANGS) {
  const t = createTranslator(lang);

  for (const skill of ['curate-session', 'capture']) {
    test(`${lang}: the ${skill} skill carries the vault's privacy policy, and says to ask before leaving out what the person asked to record`, async () => {
      const world = freshVault(lang);
      const { code, out } = await prompt(['skill', skill], world);
      assert.equal(code, EXIT.OK, out);
      assert.ok(out.includes(`${t('privacy.policy_intro')}\n${t('privacy.policy_everyone_save')}\n${t('privacy.policy_no_topics')}\n`), out);
      assert.ok(out.includes(ASK_FIRST[lang]), out);
      assert.doesNotMatch(out, /\{\{\w+\}\}/);

      const limited = freshVault(lang, (c) => { c.privacy.sensitive = { owner: 'save', people: 'summary', outsiders: 'skip' }; c.privacy.never_topics = ['health']; });
      const set = (await prompt(['skill', skill], limited)).out;
      for (const key of ['privacy.policy_owner_save', 'privacy.policy_people_summary', 'privacy.policy_outsiders_skip']) assert.ok(set.includes(t(key)), `${key}:\n${set}`);
      assert.ok(set.includes(t('privacy.policy_topics', { topics: ['"health"'] })));
    });

    test(`${lang}: the ${skill} skill in a vault whose configuration does not load renders no level, only what to do`, async () => {
      const world = freshVault(lang, (c) => { c.privacy.sensitive = { people: 'always' }; });
      const { out } = await prompt(['skill', skill], world);
      // The configuration does not load, so the body speaks the caller's language.
      assert.ok(out.includes(createTranslator('en')('privacy.policy_unknown')), out);
      assert.doesNotMatch(out, /`save`|`summary`|`skip`/);
    });
  }

  test(`${lang}: the setup skill tells a new owner that the curator records everything by default, and where to limit it`, () => {
    const body = readFileSync(join(KIT_ROOT, 'lang', lang, 'skills', 'setup.md'), 'utf8');
    const step = body.split('\n').find((line) => line.startsWith('10. '));
    assert.ok(step, `${lang}: step 10`);
    assert.match(step, lang === 'en'
      ? /by default the curator records everything, personal and sensitive information included, about the person and about others, and `privacy\.sensitive` and `privacy\.never_topics` in `brain-kit\.config\.json` limit it/
      : /por padrão o curador guarda tudo, inclusive informação pessoal e sensível, da pessoa e dos outros, e `privacy\.sensitive` e `privacy\.never_topics` no `brain-kit\.config\.json` limitam isso/);
  });

  test(`${lang}: the briefing records by the same policy, in the section that says how it records`, async () => {
    assert.ok(BRIEFING_PLACEHOLDERS.includes('privacy_policy'));
    const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'briefing.md'), 'utf8');
    const recording = pack.slice(pack.indexOf('<!-- rule:propose-only -->'));
    assert.ok(recording.includes('\n\n{{privacy_policy}}\n\n'), `${lang}: the policy is a paragraph of the recording section`);
    const world = freshVault(lang, (c) => { c.privacy.sensitive = { outsiders: 'skip' }; });
    const { code, out, err } = await prompt(['briefing', '--vault', world.vault], { ...world, cwd: world.base }, { facts: NO_GH });
    assert.equal(code, EXIT.OK, out + err);
    const at = out.indexOf('<!-- rule:propose-only -->');
    assert.ok(out.indexOf(t('privacy.policy_outsiders_skip')) > at, 'after the rule that says how the briefing records');
    assert.ok(out.includes(t('privacy.policy_intro')));
  });

  test(`${lang}: the briefing's calendar block keeps which events count and no longer keeps anyone's private life out of the owner's own briefing`, async () => {
    const world = freshVault(lang, (c) => { c.briefing.blocks = ['today_calendar']; });
    const { code, out } = await prompt(['briefing', '--vault', world.vault], { ...world, cwd: world.base }, { facts: NO_GH });
    assert.equal(code, EXIT.OK, out);
    assert.match(out, lang === 'en' ? /Of other people's events only what they share with others counts\./ : /Dos eventos de outras pessoas só conta o que elas compartilham com outros\./);
    assert.doesNotMatch(out, lang === 'en' ? /nothing of anyone's private life is content/ : /nada da vida particular de ninguém é conteúdo/);
  });
}
