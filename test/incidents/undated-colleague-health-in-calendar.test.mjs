// docs/incidents.md, undated: a colleague's medical appointment was in the
// calendar window. While the prompt was calibrated against real calendar
// data, a teleconsultation appeared in a teammate's calendar, and nothing
// about it belonged anywhere near the vault. The rule: a colleague's
// personal life is never content. Where it lives: `brain-kit lint`, rule
// `privacy`, on the lines a change adds, which is the gate `propose` runs
// before anything is published.
//
// The shape it took: an event title copied into the day's log, capitalised
// the way a calendar capitalises a title. Reproduced here in each language,
// in a vault configured with that language's own defaults, through the real
// binary and the same `--base worktree` the proposal gate uses. Example data
// only: Ana owns the vault, Bruno is the teammate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { makeVault } from '../helpers/vault-fixture.mjs';
import { git } from '../helpers/git-repo.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');

const CASES = [
  { lang: 'en', keyword: 'teleconsultation', older: '- 09:00 Weekly planning with Ana', copied: '- 15:00 Teleconsultation (Bruno\'s calendar)' },
  { lang: 'pt-BR', keyword: 'teleconsulta', older: '- 09:00 Planejamento semanal com a Ana', copied: '- 15:00 Teleconsulta (agenda do Bruno)' },
];

function lint(root, lang) {
  return spawnSync(process.execPath, [BIN, 'lint', root, '--base', 'worktree'], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_KIT_LANG: lang, BRAIN_KIT_STATE_DIR: makeTempDir('brain-kit-incident-state-') },
  });
}

for (const { lang, keyword, older, copied } of CASES) {
  test(`${lang}: a teammate's teleconsultation copied from the calendar into the log fails lint, naming the file, the line and the keyword`, () => {
    const { privacy } = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
    assert.ok(privacy.third_party_keywords.includes(keyword), `${lang} ships "${keyword}" among its keywords`);
    const root = makeVault({
      files: { 'index.md': '# Index\n\n[Log](log.md)\n', 'log.md': `# Log\n\n## 2026-09-22\n\n${older}\n` },
      config: { lang, privacy: { third_party_keywords: privacy.third_party_keywords, keyword_exempt_paths: privacy.keyword_exempt_paths } },
    });
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'initial']);
    assert.equal(lint(root, lang).status, EXIT.OK, 'the vault as committed is clean');

    appendFileSync(join(root, 'log.md'), `\n## 2026-09-23\n\n${copied}\n`);
    const result = lint(root, lang);
    assert.equal(result.status, EXIT.FAILURE, result.stdout);
    const t = createTranslator(lang);
    assert.ok(result.stdout.includes(`log.md:9  privacy  ${t('lint.privacy.third_party_keyword', { keyword })}\n`), result.stdout);
    assert.equal(result.stdout.match(/ {2}privacy {2}/g).length, 1, 'only the copied line is named');
  });
}
