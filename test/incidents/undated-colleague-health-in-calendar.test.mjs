// docs/incidents.md, undated: a colleague's medical appointment was in the
// calendar window. While the prompt was calibrated against real calendar
// data, a teleconsultation appeared in a teammate's calendar, and nothing
// about it belonged anywhere near the vault. The rule: from someone else's
// calendar only the events they share with other people count, and one that
// does not count is never written. Where it lives: the calendar source's
// prompt block, in every round that reads a calendar; and, when the vault
// lists the phrase, `brain-kit lint`, rule `privacy`, on the lines a change
// adds, which is the gate `propose` runs before anything is published.
//
// Since 02/10/2026 (docs/incidents.md of that day) the packs list no phrase:
// the curator records everything by default, and a list of health words lint
// refuses would fight that default. A vault made before keeps its list, and
// one that wants the backstop sets it. So the lint half is proved with the
// phrases the packs shipped until then, set explicitly, and the default with
// none.
//
// The shape it took: an event title copied into the day's log, capitalised
// the way a calendar capitalises a title. Reproduced here in each language,
// through the real binary and the same `--base worktree` the proposal gate
// uses. Example data only: Ana owns the vault, Bruno is the teammate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { EXIT } from '../../src/exit-codes.mjs';
import { createTranslator } from '../../src/lang.mjs';
import { calendarSource } from '../../src/sources/calendar-google.mjs';
import { makeVault } from '../helpers/vault-fixture.mjs';
import { git } from '../helpers/git-repo.mjs';
import { makeTempDir } from '../helpers/tmp.mjs';
import { LEGACY_KEYWORDS } from '../helpers/privacy-keywords.mjs';

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

function committedVault(lang, privacy, older) {
  const root = makeVault({
    files: { 'index.md': '# Index\n\n[Log](log.md)\n', 'log.md': `# Log\n\n## 2026-09-22\n\n${older}\n` },
    config: { lang, privacy },
  });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

function packDefaults(lang) {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

for (const { lang, keyword, older, copied } of CASES) {
  test(`${lang}: with the phrase listed, a teammate's teleconsultation copied from the calendar into the log fails lint, naming the file, the line and the keyword`, () => {
    assert.ok(LEGACY_KEYWORDS[lang].includes(keyword), `${lang}: the pack shipped "${keyword}" until 02/10/2026`);
    const root = committedVault(lang, { third_party_keywords: [...LEGACY_KEYWORDS[lang]], keyword_exempt_paths: [] }, older);
    assert.equal(lint(root, lang).status, EXIT.OK, 'the vault as committed is clean');

    appendFileSync(join(root, 'log.md'), `\n## 2026-09-23\n\n${copied}\n`);
    const result = lint(root, lang);
    assert.equal(result.status, EXIT.FAILURE, result.stdout);
    const t = createTranslator(lang);
    assert.ok(result.stdout.includes(`log.md:9  privacy  ${t('lint.privacy.third_party_keyword', { keyword })}\n`), result.stdout);
    assert.equal(result.stdout.match(/ {2}privacy {2}/g).length, 1, 'only the copied line is named');
  });

  test(`${lang}: with the pack's defaults no phrase is listed, so lint refuses no such line, and every round that reads a calendar still drops the event that does not count`, () => {
    const { privacy } = packDefaults(lang);
    assert.deepEqual(privacy.third_party_keywords, [], `${lang}: the pack lists no phrase`);
    const root = committedVault(lang, { third_party_keywords: privacy.third_party_keywords, keyword_exempt_paths: privacy.keyword_exempt_paths }, older);
    appendFileSync(join(root, 'log.md'), `\n## 2026-09-23\n\n${copied}\n`);
    const result = lint(root, lang);
    assert.equal(result.status, EXIT.OK, result.stdout);
    assert.doesNotMatch(result.stdout, / {2}privacy {2}/);

    // The calendar's own guard, in the prompt block of every round that lists
    // someone else's calendar: an event with no other attendee does not count,
    // and one that does not count is never written.
    const config = packDefaults(lang);
    config.vault.timezone = 'UTC';
    config.sources.calendar = {
      ...config.sources.calendar, enabled: true, calendars: ['ana@example.com'], team_calendars: ['bruno@example.com'], team_authorization: { by: 'human:ana', at: '2026-09-01' },
    };
    const plan = calendarSource.collect({ window: { from: new Date('2026-09-23T00:00:00Z'), to: new Date('2026-09-24T00:00:00Z'), timezone: 'UTC' }, config });
    assert.deepEqual(plan.otherCalendars, ['bruno@example.com']);
    assert.ok(plan.promptBlock.includes(createTranslator(lang)('sources.calendar.privacy')), plan.promptBlock);
    assert.match(plan.promptBlock, lang === 'en' ? /only events with at least two attendees count, and one of theirs that does not count is never written/ : /só contam eventos com pelo menos dois participantes, e um evento dela que não conta nunca é escrito/);
  });
}
