// What the kit tells a person about what the curator records, held to the
// behaviour (02/10/2026, docs/incidents.md): every place that states a privacy
// rule or tells a new user what the curator will do says that by default it
// records everything, personal and sensitive information included, the owner's
// and other people's, and how to limit it. Each README has a section of its
// own; the SECURITY.md every vault gets says it plainly; docs/security.md says
// what the setting is not; the incidents page records the decision; and the
// CHANGELOG calls it a change of default, with the way back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { createTranslator } from '../src/lang.mjs';
import { PRIVACY_AUDIENCES, PRIVACY_LEVELS } from '../src/privacy-policy.mjs';

const read = (path) => readFileSync(join(KIT_ROOT, path), 'utf8');
const norm = (text) => text.replace(/\s+/g, ' ');

// Lines of a markdown text, each flagged when it sits inside a fenced block.
function scan(text) {
  const out = [];
  let open = false;
  for (const line of text.split('\n')) {
    const fence = /^\s*(```|~~~)/.test(line);
    out.push({ line, fenced: open || fence });
    if (fence) open = !open;
  }
  return out;
}

// The text under a heading of `level`, up to the next heading of that level or higher.
function section(text, heading) {
  const level = /^#+/.exec(heading)[0].length;
  const lines = scan(text);
  const start = lines.findIndex((entry) => !entry.fenced && entry.line === heading);
  assert.notEqual(start, -1, `no "${heading}" heading`);
  const body = [];
  for (const entry of lines.slice(start + 1)) {
    const m = /^(#+) /.exec(entry.line);
    if (!entry.fenced && m && m[1].length <= level) break;
    body.push(entry.line);
  }
  return body.join('\n');
}

function fenced(text) {
  const blocks = [];
  let current = null;
  for (const { line, fenced: inside } of scan(text)) {
    if (inside && /^\s*(```|~~~)/.test(line)) {
      if (current === null) current = { info: line.trim().slice(3), lines: [] };
      else {
        blocks.push({ info: current.info, text: current.lines.join('\n') });
        current = null;
      }
    } else if (current !== null) current.lines.push(line);
  }
  return blocks;
}

const READMES = {
  en: {
    file: 'README.md',
    heading: '## Privacy: what the curator saves',
    before: '## The morning briefing',
    after: '## The Claude Code plugin',
    says: [
      /By default the curator saves everything your sessions, calendar and meeting notes teach the vault, personal and sensitive information included \(health, family, relationships, finances, anything intimate\), yours and other people's: nothing is left out or shortened because it seems sensitive\./,
      /the vault's repository must stay private/,
      /To save less, set `privacy\.sensitive` in `brain-kit\.config\.json`/,
      /`owner` \(you\), `people` \(anyone who already has a note in the vault: team, family, mentors\) and `outsiders` \(everyone else: clients, prospects, strangers\)/,
      /`save` \(record normally\), `summary` \(record that the subject came up and what was decided or agreed, without the intimate details\) and `skip` \(leave it out, without saying so\)/,
      /`privacy\.never_topics` lists subjects never recorded for anyone/,
      /A configuration without these keys saves everything\./,
      /`brain-kit curate --dry` and `brain-kit doctor` \(check `privacy-policy`\)/,
      /The policy is an instruction to a model, not a guarantee/,
      /the policy controls what is written into the vault, not what the model reads/,
      /`privacy\.third_party_keywords`, empty by default/,
    ],
  },
  'pt-BR': {
    file: 'README.pt-BR.md',
    heading: '## Privacidade: o que o curador guarda',
    before: '## O briefing matinal',
    after: '## O plugin do Claude Code',
    says: [
      /Por padrão o curador guarda tudo o que as suas sessões, a agenda e as notas de reunião ensinam ao vault, inclusive informação pessoal e sensível \(saúde, família, relacionamentos, finanças, qualquer coisa íntima\), a sua e a de outras pessoas: nada fica de fora nem é resumido por parecer sensível\./,
      /o repositório do vault precisa continuar privado/,
      /Para guardar menos, ajuste `privacy\.sensitive` no `brain-kit\.config\.json`/,
      /`owner` \(você\), `people` \(quem já tem nota no vault: equipe, família, mentores\) e `outsiders` \(todas as outras pessoas: clientes, potenciais clientes, desconhecidos\)/,
      /`save` \(registra normalmente\), `summary` \(registra que o assunto apareceu e o que foi decidido ou combinado, sem os detalhes íntimos\) e `skip` \(deixa de fora, sem avisar\)/,
      /`privacy\.never_topics` lista assuntos que nunca são registrados para ninguém/,
      /Uma configuração sem essas chaves guarda tudo\./,
      /o `brain-kit curate --dry` e o `brain-kit doctor` \(verificação `privacy-policy`\)/,
      /A política é uma instrução para um modelo, não uma garantia/,
      /a política controla o que é escrito no vault, não o que o modelo lê/,
      /`privacy\.third_party_keywords`, vazia por padrão/,
    ],
  },
};

for (const [lang, spec] of Object.entries(READMES)) {
  const text = read(spec.file);

  test(`${spec.file}: a section of its own says the curator saves everything by default, how to limit it, and what the setting is not`, () => {
    const lines = text.split('\n');
    const at = lines.indexOf(spec.heading);
    assert.notEqual(at, -1, `${spec.heading} is missing`);
    assert.ok(lines.indexOf(spec.before) < at && at < lines.indexOf(spec.after), `${spec.file}: after the briefing, before the plugin`);
    const body = norm(section(text, spec.heading));
    for (const pattern of spec.says) assert.match(body, pattern, `${spec.file}: ${pattern}`);
  });

  test(`${spec.file}: the section's one JSON example gives each level to an audience and sets a topic aside, and names no tag or tarball`, () => {
    const blocks = fenced(section(text, spec.heading));
    assert.equal(blocks.length, 1, `${spec.file}: one code block`);
    assert.equal(blocks[0].info, 'json');
    const parsed = JSON.parse(`{${blocks[0].text}}`);
    const { sensitive, never_topics: topics } = parsed.privacy;
    assert.deepEqual(Object.keys(sensitive).sort(), [...PRIVACY_AUDIENCES].sort());
    assert.deepEqual(Object.values(sensitive).sort(), [...PRIVACY_LEVELS].sort(), 'each level once');
    assert.ok(Array.isArray(topics) && topics.length > 0 && topics.every((topic) => typeof topic === 'string' && topic.trim() !== ''));
    assert.doesNotMatch(blocks[0].text, /v\d+\.\d+\.\d+|second-brain-kit-\d+\.\d+\.\d+\.tgz/);
  });

  test(`${spec.file}: the section init's last line sends a person to is this heading`, () => {
    const line = createTranslator(lang)('init.privacy_default', { sensitive: 'privacy.sensitive', topics: 'privacy.never_topics', file: 'brain-kit.config.json' });
    const title = /\(README, "([^"]+)"\)/.exec(line)?.[1];
    assert.equal(`## ${title}`, spec.heading);
    const set = createTranslator(lang)('init.privacy_set', { policy: 'x' });
    assert.ok(set.includes(`"${title}"`), set);
  });
}

const TEMPLATES = {
  en: [
    /## What the curator saves\n\nBy default the curator saves everything it learns, personal and sensitive information included \(health, family, relationships, finances, anything intimate\), yours and other people's\./,
    /set `privacy\.sensitive` in `brain-kit\.config\.json`/,
    /That setting is an instruction to the curator, not a guarantee/,
    // Fix round 1, M2: the law in one sentence, and the minimisation line back.
    /by default the curator records it in full, sensitive subjects included\. Under privacy laws such as the LGPD and the GDPR, their health, sex life, religious beliefs or political opinions are sensitive personal data, and you, as the vault's owner, answer for keeping them\. Keep it to what you need, keep this repository private, and never copy a note about a person into anything shared\./,
    // Fix round 1, m5: step 1 deleted the note, so the person is an outsider now.
    /4\. The curator records again whatever a session, an event or a document it reads still holds\. Their note is gone, so they count as `outsiders`: to keep their sensitive subjects out from then on, set `privacy\.sensitive\.outsiders` to `skip` \(it applies to everyone without a note\), or list the subject in `privacy\.never_topics`/,
  ],
  'pt-BR': [
    /## O que o curador guarda\n\nPor padrão o curador guarda tudo o que aprende, inclusive informação pessoal e sensível \(saúde, família, relacionamentos, finanças, qualquer coisa íntima\), a sua e a de outras pessoas\./,
    /ajuste `privacy\.sensitive` no `brain-kit\.config\.json`/,
    /Essa configuração é uma instrução para o curador, não uma garantia/,
    /por padrão o curador os registra por inteiro, inclusive os assuntos sensíveis\. Para leis de privacidade como a LGPD e o GDPR, a saúde, a vida sexual, a convicção religiosa ou a opinião política dessa pessoa são dados pessoais sensíveis, e quem responde por guardá-los é você, como dono do vault\. Guarde só o necessário, mantenha este repositório privado e nunca copie uma nota sobre uma pessoa para algo compartilhado\./,
    /4\. O curador volta a registrar o que uma sessão, um evento ou um documento que ele lê ainda tiver\. A nota da pessoa foi apagada, então ela conta como `outsiders`: para deixar de fora os assuntos sensíveis dela daí em diante, ajuste `privacy\.sensitive\.outsiders` para `skip` \(vale para todos que não têm nota\), ou liste o assunto em `privacy\.never_topics`/,
  ],
};

for (const [lang, patterns] of Object.entries(TEMPLATES)) {
  test(`${lang}: the SECURITY.md init writes into every vault says plainly what the curator saves by default, what the law says of it, and how a removal on request keeps it out`, () => {
    const text = read(`lang/${lang}/vault/SECURITY.md`);
    for (const pattern of patterns) assert.match(text, pattern, `${lang}: ${pattern}`);
    assert.doesNotMatch(text, /privacy\.sensitive\.people/, `${lang}: step 4 does not point at people, whose note step 1 deletes`);
  });
}

test('the example vault shows the SECURITY.md the English template writes, refreshed by update', () => {
  const stamp = (text) => text.replace(/^ {2}at: .*$/m, '  at: <stamp>');
  assert.equal(stamp(read('examples/minimal-vault/SECURITY.md')), stamp(read('lang/en/vault/SECURITY.md')));
});

test('docs/security.md says what the curator records, and what that setting is not', () => {
  const body = norm(section(read('docs/security.md'), '## What the curator records'));
  for (const pattern of [
    /by default it records everything, the owner's and other people's alike/,
    /\*\*A guarantee\.\*\* It is an instruction to the model\./,
    /\*\*A limit on what the model reads\.\*\*/,
    /The setting controls what is written into the vault/,
    /`privacy\.third_party_keywords`.*Since 02\/10\/2026 it is empty by default/,
    /set `people` and `outsiders` to `skip`/,
    /`update` never rewrites it/,
  ]) assert.match(body, pattern);
});

test('docs/incidents.md records the decision of 02/10/2026, why the old rule existed, and its count of entries is right', () => {
  const text = read('docs/incidents.md');
  const entry = norm(section(text, '### 02/10/2026: the curator left the owner\'s own health out of the log, on purpose'));
  assert.match(entry, /"A colleague's medical appointment was in the calendar window"/);
  assert.match(entry, /What the curator records is a setting of the kit, never a patch for one vault/);
  assert.match(entry, /the default is to record everything/);
  assert.match(entry, /test\/incidents\/2026-10-02-owner-health-left-out\.test\.mjs/);
  const entries = scan(text).filter((l) => !l.fenced && l.line.startsWith('### ')).length;
  assert.equal(entries, 81);
  assert.match(norm(text.slice(0, text.indexOf('\n## '))), /Nine entries were added since/);
  assert.match(norm(text.slice(0, text.indexOf('\n## '))), /Eighty one entries follow/);
});

test('the CHANGELOG calls it a change of default, says why, and how to get the old behaviour back', () => {
  const text = read('CHANGELOG.md');
  const unreleased = norm(section(text, '## Unreleased'));
  assert.match(unreleased, /Change of default: the curator now records everything, personal and sensitive information included, about the owner and about other people\./);
  assert.match(unreleased, /"Never record anything about the private life of someone other than the owner"/);
  assert.match(unreleased, /To get the old behaviour back, set `people` and `outsiders` to `skip` in `privacy\.sensitive` and list the phrases you want refused in `privacy\.third_party_keywords`/);
  assert.match(unreleased, /a colleague's medical appointment was in the calendar window/);
  // The release gate refuses text in angle brackets outside code in a version's section.
  const prose = unreleased.replace(/`[^`]*`/g, '');
  assert.doesNotMatch(prose, /<[A-Za-z!/]/);
});

// Fix round 1, M1: the example shows what init writes now, never the list the
// pack used to ship, which doctor would warn about.
test('the example vault\'s configuration carries the privacy keys init writes now, and no keyword list', () => {
  const { privacy } = JSON.parse(read('examples/minimal-vault/brain-kit.config.json'));
  assert.deepEqual(privacy.sensitive, { owner: 'save', people: 'save', outsiders: 'save' });
  assert.deepEqual(privacy.never_topics, []);
  assert.deepEqual(privacy.third_party_keywords, []);
});

test('the CHANGELOG tells a person upgrading about the list init wrote before, and what doctor now says of it', () => {
  const unreleased = norm(section(read('CHANGELOG.md'), '## Unreleased'));
  assert.match(unreleased, /Upgrading a vault made before this change/);
  assert.match(unreleased, /`brain-kit doctor` \(check `privacy-keywords`\) now warns/);
  assert.match(unreleased, /clear it \(`\[\]`\) for the default to hold, or edit it to keep it as your choice/);
});
