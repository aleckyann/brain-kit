// The privacy rule the curate prompt of both packs carried until 02/10/2026,
// as this suite's own synthetic copy (never a real vault's text): one fixed
// sentence that kept everyone's private life but the owner's out, which the
// model stretched to the owner's own (docs/incidents.md, 02/10/2026). A vault
// whose own curate prompt (.brain-kit/prompts/curate.md) still holds it is a
// vault whose privacy rule is fixed text, which the setting never reaches.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';

export const OLD_RULE = Object.freeze({
  en: "Never record anything about the private life of someone other than the owner: health, family, relationships, personal matters. Leave it out entirely, without even mentioning that you left it out. The same holds for someone else's schedule, read with the authorization the configuration records: only the events they share with other people count, and nothing about their private life (an absence, an appointment, an errand) is ever content, not even as a mention that something was left out.",
  'pt-BR': 'Nunca registre nada sobre a vida particular de alguém que não seja o dono: saúde, família, relacionamentos, assuntos pessoais. Deixe de fora por completo, sem nem mencionar que deixou. O mesmo vale para os compromissos de outra pessoa, lidos com a autorização que a configuração registra: só contam os eventos que ela compartilha com outras pessoas, e nada da vida particular dela (uma ausência, uma consulta, uma tarefa particular) vira conteúdo, nem como menção de que algo ficou de fora.',
});

// The words only the old sentence holds.
export const OLD_WORDS = Object.freeze({ en: /private life of someone other than the owner/, 'pt-BR': /vida particular de alguém que não seja o dono/ });

// The pack's own template with its privacy rule put back to the old fixed
// sentence: the copy a vault would hold as its own prompt.
export function oldTemplate(lang) {
  const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
  assert.ok(pack.includes('{{privacy_policy}}'), `${lang}: the pack carries the placeholder`);
  return pack.replace(/\{\{privacy_policy\}\}\n\n[^\n]*\n/, `${OLD_RULE[lang]}\n`);
}
