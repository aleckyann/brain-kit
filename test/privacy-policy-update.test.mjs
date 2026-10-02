// What `brain-kit update` does about the privacy rule of 02/10/2026, measured
// on real vaults made by the real `init`.
//
// The curate prompt is not a file the kit writes into a vault: `init` writes no
// .brain-kit/prompts/curate.md and the manifest records none, so a vault runs
// the language pack's own prompt, and the kit itself, once updated, is what
// carries the new rule to it; `update` has nothing to rewrite. A vault that
// holds a curate prompt of its own (an overlay, `curate.prompt`) holds the
// person's file, which `update` never reads or writes, edited or not (phase 2,
// decision 1: "`update` never overwrites it"). For that vault the fix is
// `doctor`'s privacy-policy warning, which names the file and the pack prompt
// to copy the rule from. The old text is this suite's synthetic copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { CLEAN_ENV } from './helpers/git-repo.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { OLD_WORDS, oldTemplate } from './helpers/privacy-old-rule.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const OVERLAY = join('.brain-kit', 'prompts', 'curate.md');

function newVault(lang) {
  const base = makeTempDir('brain-kit-privacy-update-');
  const vault = join(base, 'vault');
  const env = { ...CLEAN_ENV, BRAIN_KIT_LANG: 'en', BRAIN_KIT_STATE_DIR: join(base, 'state'), HOME: join(base, 'home'), USER: 'ana', LOGNAME: 'ana', TZ: 'UTC' };
  mkdirSync(env.HOME);
  const kit = (argv) => spawnSync(process.execPath, [BIN, ...argv], { cwd: vault, encoding: 'utf8', env });
  const made = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], { cwd: base, encoding: 'utf8', env });
  assert.equal(made.status, EXIT.OK, made.stdout + made.stderr);
  return { vault, kit };
}

for (const lang of ['pt-BR', 'en']) {
  const t = createTranslator(lang);

  test(`${lang}: a vault init made runs the pack's own curate prompt, so the new rule reaches it with the kit, and update has nothing of it to rewrite`, () => {
    const { vault, kit } = newVault(lang);
    assert.equal(existsSync(join(vault, OVERLAY)), false, 'init writes no curate prompt into the vault');
    const manifest = JSON.parse(readFileSync(join(vault, '.brain-kit', 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.some((entry) => entry.path.startsWith('.brain-kit/prompts/')), false, 'the manifest records none');
    const checked = kit(['update', '--check']);
    assert.equal(checked.status, EXIT.OK, checked.stdout + checked.stderr);
    assert.doesNotMatch(checked.stdout, /privacy_policy/, 'nothing to say of a prompt the vault does not have');
    const rendered = kit(['prompt', 'curate']);
    assert.equal(rendered.status, EXIT.OK, rendered.stderr);
    assert.ok(rendered.stdout.includes(t('privacy.policy_everyone_save')), 'the pack prompt carries the policy');
    assert.doesNotMatch(rendered.stdout, OLD_WORDS[lang]);
  });

  test(`${lang}: a vault's own copy of the old template, unedited or edited, is left byte for byte by update, and doctor names it and the fix`, () => {
    for (const text of [oldTemplate(lang), `${oldTemplate(lang)}\nA line the owner added.\n`]) {
      const { vault, kit } = newVault(lang);
      mkdirSync(join(vault, '.brain-kit', 'prompts'), { recursive: true });
      writeFileSync(join(vault, OVERLAY), text);
      const updated = kit(['update']);
      assert.equal(updated.status, EXIT.OK, updated.stdout + updated.stderr);
      assert.equal(readFileSync(join(vault, OVERLAY), 'utf8'), text, 'the file is the person\'s: never rewritten');
      assert.equal(existsSync(join(vault, `${OVERLAY}.brain-kit-new`)), false, 'and nothing is written beside it');
      const doctor = kit(['doctor', '--only', 'privacy-policy', '--json']);
      const [line] = JSON.parse(doctor.stdout).checks;
      assert.equal(line.status, 'warn', doctor.stdout);
      assert.equal(line.messageKey, 'doctor.privacy_policy.overlay_fixed');
      // The real path: doctor finds the vault from its working directory, and on
      // macOS the temporary directory (/var/folders/...) is a link to /private/var/....
      assert.ok(line.message.includes(join(realpathSync(vault), OVERLAY)), line.message);
      assert.ok(line.message.includes(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md')), line.message);
      // Fix round 1, m3: update leaves the file alone but no longer says
      // nothing: one line, the same text as doctor's, in a real run and a check.
      assert.equal(updated.stdout.split('\n').filter((l) => l === line.message).length, 1, `update says it, once:\n${updated.stdout}`);
      const checked = kit(['update', '--check']);
      assert.equal(checked.stdout.split('\n').filter((l) => l === line.message).length, 1, checked.stdout);
      assert.equal(checked.status, EXIT.OK, 'the overlay is not a managed file: update --check still has nothing pending');
      // The round runs the overlay as written: the old sentence, and no policy.
      const rendered = kit(['prompt', 'curate']);
      assert.match(rendered.stdout, OLD_WORDS[lang]);
      assert.equal(rendered.stdout.includes(t('privacy.policy_intro')), false);
    }
  });

  // Fix round 1, m3 and P2: a curate prompt that carries both rules is named by
  // update too, with doctor's line; the shapes doctor alone names (a curate
  // prompt with no privacy rule of the kit, a briefing prompt without the
  // placeholder) are not update's to say.
  test(`${lang}: update prints doctor's line for a curate prompt that carries both rules, and nothing for the shapes only doctor names`, () => {
    const both = newVault(lang);
    mkdirSync(join(both.vault, '.brain-kit', 'prompts'), { recursive: true });
    writeFileSync(join(both.vault, OVERLAY), oldTemplate(lang).replace('<!-- rule:third-party-privacy -->\n', '<!-- rule:third-party-privacy -->\n{{privacy_policy}}\n\n'));
    const [line] = JSON.parse(both.kit(['doctor', '--only', 'privacy-policy', '--json']).stdout).checks;
    assert.equal(line.messageKey, 'doctor.privacy_policy.overlay_both');
    for (const argv of [['update'], ['update', '--check']]) {
      const r = both.kit(argv);
      assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
      assert.equal(r.stdout.split('\n').filter((l) => l === line.message).length, 1, `${argv.join(' ')}:\n${r.stdout}`);
    }

    const other = newVault(lang);
    mkdirSync(join(other.vault, '.brain-kit', 'prompts'), { recursive: true });
    writeFileSync(join(other.vault, OVERLAY), '{{signature}}\n\nA prompt of the vault\'s own.\n');
    const briefing = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'briefing.md'), 'utf8');
    writeFileSync(join(other.vault, '.brain-kit', 'prompts', 'briefing.md'), briefing.replace(/\n\{\{privacy_policy\}\}\n/, '\n'));
    const lines = JSON.parse(other.kit(['doctor', '--only', 'privacy-policy', '--json']).stdout).checks;
    assert.deepEqual(lines.map((c) => c.messageKey), ['doctor.privacy_policy.overlay_without', 'doctor.privacy_policy.briefing_overlay_without'], 'doctor names both');
    for (const argv of [['update'], ['update', '--check']]) {
      const r = other.kit(argv);
      assert.equal(r.status, EXIT.OK, r.stdout + r.stderr);
      for (const c of lines) assert.equal(r.stdout.includes(c.message), false, `${argv.join(' ')}:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /\{\{privacy_policy\}\}/, r.stdout);
    }
  });

  test(`${lang}: update says nothing of a vault's own curate prompt that carries the policy`, () => {
    const { vault, kit } = newVault(lang);
    mkdirSync(join(vault, '.brain-kit', 'prompts'), { recursive: true });
    writeFileSync(join(vault, OVERLAY), readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8'));
    const updated = kit(['update']);
    assert.equal(updated.status, EXIT.OK, updated.stdout + updated.stderr);
    assert.doesNotMatch(updated.stdout, /\{\{privacy_policy\}\}|third-party-privacy/, updated.stdout);
  });
}
