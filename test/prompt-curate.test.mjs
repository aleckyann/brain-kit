// The generic curate prompt and the tool lists the round passes
// (docs/superpowers/plans/2026-09-24-phase-2-scheduled-curator.md, task 4).
//
// The contract test here is decision 2's acceptance criterion: every
// contract rule is present, by its `<!-- rule:<id> -->` marker, in the
// rendered prompt of both languages; every command the prompt tells the
// model to run is `{{kit}}` plus one of KIT_SUBCOMMANDS, and allowedTools()
// grants it; nothing is left unresolved. Vaults are real (`init --yes`)
// under a temporary directory, with the state directory pinned there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers/tmp.mjs';
import { KIT_ROOT } from '../src/version.mjs';
import { EXIT } from '../src/exit-codes.mjs';
import { createTranslator } from '../src/lang.mjs';
import { loadConfig } from '../src/config.mjs';
import { CURATE_RULES, renderCuratePrompt, runPrompt, vaultClock } from '../src/commands/prompt.mjs';
import { KIT_SUBCOMMANDS, PROTECTED_PATHS, allowedTools, disallowedTools, kitCommand } from '../src/curate/tools.mjs';
import { RULE_UNSAFE_CHARACTERS, unsafeRuleCharacters } from '../src/curate/rule-path.mjs';

const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const LANGS = ['pt-BR', 'en'];

function testEnv(state, extra = {}) {
  return {
    ...process.env, BRAIN_KIT_STATE_DIR: state, USER: 'ana', LOGNAME: 'ana', TZ: 'UTC',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    ...extra,
  };
}

const vaults = {};
function vaultFor(lang) {
  if (vaults[lang]) return vaults[lang];
  const base = makeTempDir('brain-kit-curate-prompt-');
  const vault = join(base, 'vault');
  const state = join(base, 'state');
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], { encoding: 'utf8', env: testEnv(state), cwd: base });
  assert.equal(r.status, 0, `init failed: ${r.stdout}${r.stderr}`);
  vaults[lang] = { vault, state, config: loadConfig(vault) };
  return vaults[lang];
}

function freshVault(lang) {
  const base = makeTempDir('brain-kit-curate-prompt-');
  const vault = join(base, 'vault');
  const state = join(base, 'state');
  const r = spawnSync(process.execPath, [BIN, 'init', vault, '--yes', '--lang', lang], { encoding: 'utf8', env: testEnv(state), cwd: base });
  assert.equal(r.status, 0, `init failed: ${r.stdout}${r.stderr}`);
  return { vault, state };
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

const PARAMS = 'PARAMETERS-BLOCK-FOR-THIS-TEST';
const NOW = new Date(2026, 8, 24, 10, 0, 0);

function rendered(lang) {
  const { vault, config } = vaultFor(lang);
  return renderCuratePrompt({ vaultRoot: vault, config, lang, parameters: PARAMS, now: NOW });
}

function codeSpans(text) {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

// --- src/curate/tools.mjs ----------------------------------------------

test('KIT_SUBCOMMANDS is exactly validate, lint, propose', () => {
  assert.deepEqual([...KIT_SUBCOMMANDS], ['validate', 'lint', 'propose']);
});

test('kitCommand() is the kit\'s own bin/brain-kit.mjs, double quoted and absolute, with no node in front', () => {
  const kit = kitCommand();
  assert.match(kit, /^"[^"]+"$/);
  const path = kit.slice(1, -1);
  assert.equal(path, join(KIT_ROOT, 'bin', 'brain-kit.mjs'));
  assert.ok(existsSync(path));
  assert.doesNotMatch(kit, /\bnode\b/);
});

test('allowedTools() is exactly the list phase 3 task 1 names: reads, writes, Glob and Grep inside the vault, ToolSearch, each subcommand bare and behind node, then the extras', () => {
  const kit = kitCommand();
  assert.deepEqual(allowedTools(), [
    'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)', 'ToolSearch',
    `Bash(${kit} validate:*)`, `Bash(node ${kit} validate:*)`,
    `Bash(${kit} lint:*)`, `Bash(node ${kit} lint:*)`,
    `Bash(${kit} propose:*)`, `Bash(node ${kit} propose:*)`,
  ]);
  assert.deepEqual(allowedTools(['mcp__x__y']).slice(-1), ['mcp__x__y']);
  for (const bare of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']) assert.ok(!allowedTools().includes(bare), `${bare} is never granted without a scope`);
});

test('allowedTools() grants reading each listed file exactly, and each listed directory under it, by absolute path, a space and an accent kept, before the kit rules', () => {
  const kit = kitCommand();
  const file = '/home/ana/Notas de reunião/-home-ana-vault/sessão 1.jsonl';
  const other = '/srv/transcripts/b.jsonl';
  const dir = '/home/ana/Sessões antigas';
  const rules = allowedTools(['mcp__x__y'], { readFiles: [file, other], readDirs: [dir, '/srv/archive/'] });
  assert.deepEqual(rules, [
    'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)', 'ToolSearch',
    'Read(//home/ana/Notas de reunião/-home-ana-vault/sessão 1.jsonl)', 'Read(//srv/transcripts/b.jsonl)',
    'Read(//home/ana/Sessões antigas/**)', 'Read(//srv/archive/**)',
    `Bash(${kit} validate:*)`, `Bash(node ${kit} validate:*)`,
    `Bash(${kit} lint:*)`, `Bash(node ${kit} lint:*)`,
    `Bash(${kit} propose:*)`, `Bash(node ${kit} propose:*)`,
    'mcp__x__y',
  ]);
  // A file listed twice is granted once.
  assert.equal(allowedTools([], { readFiles: [other, other] }).filter((r) => r === 'Read(//srv/transcripts/b.jsonl)').length, 1);
});

// Every character whose meaning inside a rule is not measured, one per
// class of src/curate/rule-path.mjs, and a control character of each kind.
const UNSAFE = ['*', '?', '[', ']', '{', '}', '(', ')', '\\', ',', '\n', '\r', '\t', String.fromCharCode(1), String.fromCharCode(31), String.fromCharCode(127)];

test('unsafeRuleCharacters names each character a rule cannot carry, a control character as U+XXXX, once each in order; spaces and accents pass', () => {
  assert.deepEqual([...RULE_UNSAFE_CHARACTERS], ['*', '?', '[', ']', '{', '}', '(', ')', '\\', ',']);
  for (const ch of RULE_UNSAFE_CHARACTERS) assert.deepEqual(unsafeRuleCharacters(`/home/ana/a${ch}b.jsonl`), [ch], ch);
  assert.deepEqual(unsafeRuleCharacters('/home/ana/a\nb'), ['U+000A']);
  assert.deepEqual(unsafeRuleCharacters('/home/ana/a\rb\tc'), ['U+000D', 'U+0009']);
  assert.deepEqual(unsafeRuleCharacters(`/a${String.fromCharCode(1)}b${String.fromCharCode(31)}c${String.fromCharCode(127)}`), ['U+0001', 'U+001F', 'U+007F']);
  assert.deepEqual(unsafeRuleCharacters('/home/ana/(x) Read (y)/z*.jsonl'), ['(', ')', '*']);
  assert.deepEqual(unsafeRuleCharacters('/home/ana/Notas de reunião/Sessões antigas/sessão 1.jsonl'), []);
  assert.deepEqual(unsafeRuleCharacters('/home/ana/a-b_c.d/e f/-home-ana-vault/0000.jsonl'), []);
});

test('allowedTools() refuses to turn a path holding any of those characters into a rule, file or directory; spaces and accents pass', () => {
  for (const ch of UNSAFE) {
    const path = `/home/ana/Sessões ${ch} x/-home-ana-vault/a.jsonl`;
    assert.throws(() => allowedTools([], { readFiles: [path] }), TypeError, `readFiles ${JSON.stringify(ch)}`);
    assert.throws(() => allowedTools([], { readDirs: [`/home/ana/Sessões ${ch} x`] }), TypeError, `readDirs ${JSON.stringify(ch)}`);
  }
  assert.throws(() => allowedTools([], { readFiles: ['/home/ana/-home-ana-vault/(a) Read (b).jsonl'] }), /holds \( \)/);
  assert.deepEqual(allowedTools([], { readFiles: ['/home/ana/Sessões de estudo/sessão 1.jsonl'] }).slice(6, 7), ['Read(//home/ana/Sessões de estudo/sessão 1.jsonl)']);
});

test('allowedTools() refuses a read root that is not an absolute path, and a directory that is the whole disk', () => {
  for (const bad of ['relative/a.jsonl', './a.jsonl', '~/a.jsonl', '', 'C:\\a.jsonl', null, 7]) {
    assert.throws(() => allowedTools([], { readFiles: [bad] }), TypeError, `readFiles ${JSON.stringify(bad)}`);
    assert.throws(() => allowedTools([], { readDirs: [bad] }), TypeError, `readDirs ${JSON.stringify(bad)}`);
  }
  for (const root of ['/', '//', '///']) assert.throws(() => allowedTools([], { readDirs: [root] }), TypeError, root);
});

test('disallowedTools() is exactly the list task 6 names, then the extras, and never carries Bash(node:*)', () => {
  assert.deepEqual(PROTECTED_PATHS, ['.githooks', '.git', '.github', '.claude', '.brain-kit', 'brain-kit.config.json', '.gitignore', '.gitattributes', '.gitmodules', '.mcp.json']);
  const protectedRules = PROTECTED_PATHS.flatMap((p) => [`Edit(./${p})`, `Edit(./${p}/**)`, `Write(./${p})`, `Write(./${p}/**)`]);
  assert.deepEqual(disallowedTools(), [
    'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(rm:*)', 'WebFetch', 'WebSearch',
    ...protectedRules,
  ]);
  assert.ok(disallowedTools().includes('Edit(./.githooks/**)'));
  assert.ok(disallowedTools().includes('Write(./brain-kit.config.json)'));
  assert.ok(!allowedTools().includes('Edit') && !allowedTools().includes('Write'), 'Edit and Write are never granted without a path');
  assert.deepEqual(disallowedTools(['Bash(scp:*)']).slice(-1), ['Bash(scp:*)']);
  assert.ok(!disallowedTools().includes('Bash(node:*)'));
});

// --- the contract ------------------------------------------------------

test('CURATE_RULES lists the thirteen contract rules, phase 3\'s four last', () => {
  assert.deepEqual([...CURATE_RULES], [
    'read-index-first', 'sample-from-end', 'log-before-note', 'never-verified', 'never-empty-unopened',
    'closed-uncertainty', 'only-kit-commands', 'propose-only', 'sources-line',
    'no-workaround', 'notes-first-class', 'no-access-label', 'third-party-privacy',
  ]);
});

// Phase 3, task 5: the four rules the connector sources paid for, each
// pinned by what it must say in both languages.
const NEW_RULES = {
  en: {
    'no-workaround': [/marks unavailable, or whose tools are not in your session, is written `unavailable`/, /not through the shell, not through another tool/],
    'notes-first-class': [/same weight as a transcript/, /A title and a link alone are never a capture/],
    'no-access-label': [/\*\*not verified\*\*, with this exact reason: `no access \(document store permission\)`/, /never empty, never missing/],
    'third-party-privacy': [/private life of someone other than the owner/, /someone else's schedule, read with the authorization the configuration records: only the events they share with other people count/],
  },
  'pt-BR': {
    'no-workaround': [/marca como indisponível, ou cujas ferramentas não estão na sua sessão, é escrita `unavailable`/, /nem pelo shell, nem por outra ferramenta/],
    'notes-first-class': [/mesmo peso de uma transcrição/, /Título e link sozinhos nunca são captura/],
    'no-access-label': [/\*\*não verificado\*\*, com este motivo exato: `sem acesso \(permissão do repositório de documentos\)`/, /nunca está vazio, nunca está ausente/],
    'third-party-privacy': [/vida particular de alguém que não seja o dono/, /compromissos de outra pessoa, lidos com a autorização que a configuração registra: só contam os eventos que ela compartilha com outras pessoas/],
  },
};

for (const lang of LANGS) {
  test(`${lang}: each of phase 3's rules says what it must, in the paragraph its marker opens`, () => {
    const text = rendered(lang);
    for (const [rule, patterns] of Object.entries(NEW_RULES[lang])) {
      const at = text.indexOf(`<!-- rule:${rule} -->`);
      assert.notEqual(at, -1, `${lang}: ${rule}`);
      const paragraph = text.slice(at, text.indexOf('\n\n', at) === -1 ? undefined : text.indexOf('\n\n', at));
      for (const pattern of patterns) assert.match(paragraph, pattern, `${lang}: ${rule}`);
    }
  });

  // 01/10/2026 (docs/incidents.md): real transcripts were too big for the
  // Read tool, so the rule that told the model to sample them from a line
  // offset could never be followed. The model now reads each transcript's
  // digest, which the kit already sampled from the end, whole: the same
  // marker, new words, no offset to pass.
  test(`${lang}: sample-from-end hands the model the digests, read whole, and never the transcripts or an offset`, () => {
    const text = rendered(lang);
    const at = text.indexOf('<!-- rule:sample-from-end -->');
    assert.notEqual(at, -1);
    const paragraph = text.slice(at, text.indexOf('\n\n', at));
    const expected = {
      en: [/through their digests/, /already sampled it from its end/, /holds whole days: a day that does not fit waits for a later round/, /a single day that alone does not fit keeps its most recent messages, and the first line says how many were left out/, /Read each digest whole, with Read and no offset or limit/, /reading it is reading the transcript, and the transcript file itself is not readable/],
      'pt-BR': [/pelos extratos delas/, /já a amostrou a partir do fim/, /guarda dias inteiros: um dia que não cabe fica para uma próxima rodada/, /um dia só que sozinho não cabe guarda as mensagens mais recentes, e a primeira linha diz quantas ficaram de fora/, /Leia cada extrato inteiro, com o Read e sem offset nem limit/, /ler o extrato é ler a transcrição, e o arquivo da transcrição em si não pode ser lido/],
    }[lang];
    for (const pattern of expected) assert.match(paragraph, pattern, `${lang}: ${pattern}`);
    assert.doesNotMatch(paragraph, /sampleLine/, `${lang}: no line offset is handed out any more`);
  });

  // 30/09/2026 (docs/incidents.md): two attachments came back "not found",
  // the rule named only a permission reason, and the model reported the
  // whole meeting-notes source failed, so its mark did not move. The same
  // rule now covers the connector's "not found", with a label of its own,
  // without a marker of its own: the permission label stays byte for byte.
  test(`${lang}: no-access-label also covers a document the connector answers "not found" for, and it never holds the source's days open`, () => {
    const text = rendered(lang);
    const at = text.indexOf('<!-- rule:no-access-label -->');
    const paragraph = text.slice(at, text.indexOf('\n\n', at));
    const expected = {
      en: [
        'A document that does not open for a permission reason is **not verified**, with this exact reason: `no access (document store permission)`.',
        'A document the connector answers "not found" for (such as "Requested entity was not found") is **not verified** too, with this exact reason: `not found by the connector (deleted attachment or no access)`, because the connector gives that answer both for an attachment that was deleted and for one never shared with you.',
        'Either way, the document is never empty, never missing and never a failure of the source: with everything else read, the source is written `ok` in the last line, and its days close.',
        'List those documents by title in your final message, so the owner can ask for access or ignore them.',
      ],
      'pt-BR': [
        'Um documento que não abre por motivo de permissão fica **não verificado**, com este motivo exato: `sem acesso (permissão do repositório de documentos)`.',
        'Um documento para o qual o conector responde "not found" (como "Requested entity was not found") também fica **não verificado**, com este motivo exato: `não encontrado pelo conector (anexo apagado ou sem acesso)`, porque o conector dá essa resposta tanto para um anexo que foi apagado quanto para um que nunca foi compartilhado com você.',
        'Nos dois casos, o documento nunca está vazio, nunca está ausente e nunca é falha da fonte: com todo o resto lido, a fonte é escrita `ok` na última linha, e os dias dela fecham.',
        'Liste esses documentos pelo título na sua mensagem final, para o dono poder pedir acesso ou ignorá-los.',
      ],
    }[lang];
    for (const sentence of expected) assert.ok(paragraph.includes(sentence), `${lang}: ${sentence}`);
    assert.equal(text.split('<!-- rule:').length - 1, CURATE_RULES.length, `${lang}: no marker was added`);
  });

  // Found in the first real run on 30/09/2026 (after the sentence above was
  // written): the `failed` bullet still said "something the block lists could
  // not be read", and the model followed it for two not-found attachments.
  test(`${lang}: the failed state never covers a document filed as not verified`, () => {
    const text = rendered(lang);
    const bullet = text.split('\n').find((line) => line.startsWith('- `failed`:'));
    assert.ok(bullet, `${lang}: the failed bullet exists`);
    const expected = {
      en: 'A document the rule above files as **not verified** (no access, or not found by the connector) is not that: it never makes the source `failed`.',
      'pt-BR': 'Um documento que a regra acima classifica como **não verificado** (sem acesso, ou não encontrado pelo conector) não é isso: ele nunca torna a fonte `failed`.',
    }[lang];
    assert.ok(bullet.includes(expected), `${lang}: ${bullet}`);
  });

  test(`${lang}: the last line is the one the round gives, naming every state a source can be written with`, () => {
    const { vault, config } = vaultFor(lang);
    const line = 'BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed> calendar=<ok|empty|failed|unavailable>';
    const text = renderCuratePrompt({ vaultRoot: vault, config, lang, parameters: PARAMS, now: NOW, sourcesLine: line });
    assert.ok(text.includes(`\`${line}\``), lang);
    assert.equal(text.includes('`BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed>`'), false, `${lang}: the default line is not there when a line is given`);
    const rule = text.slice(text.indexOf('<!-- rule:sources-line -->'));
    for (const state of ['ok', 'empty', 'partial', 'failed', 'unavailable']) assert.ok(rule.includes(`- \`${state}\`: `), `${lang}: ${state}`);
  });
}

for (const lang of LANGS) {
  test(`${lang}: the rendered prompt carries every contract marker, once each`, () => {
    const text = rendered(lang);
    for (const rule of CURATE_RULES) {
      const count = text.split(`<!-- rule:${rule} -->`).length - 1;
      assert.equal(count, 1, `${lang}: rule ${rule} appears ${count} times`);
    }
  });

  test(`${lang}: the first line is the vault's signature and no placeholder is left unresolved`, () => {
    const text = rendered(lang);
    const { config } = vaultFor(lang);
    assert.equal(text.split('\n')[0], config.curate.signature);
    assert.doesNotMatch(text, /\{\{\w+\}\}/);
    assert.ok(text.includes(PARAMS));
    const clock = vaultClock(NOW, config.vault.timezone);
    assert.ok(text.includes(`## ${clock.date}`));
    assert.ok(text.includes(`at: ${clock.iso} }`), `${lang}: generated.at is the round's own timestamp`);
    assert.ok(text.includes(config.taxonomy.log));
    assert.ok(text.includes(`**${config.taxonomy.log_markers.capture}**`));
    assert.ok(text.includes(`${config.actors.agent_prefix}/<model>`));
  });

  test(`${lang}: every command the prompt names is the kit plus one of KIT_SUBCOMMANDS, and allowedTools() grants it`, () => {
    const text = rendered(lang);
    const kit = kitCommand();
    const allowed = allowedTools();
    const kitSpans = codeSpans(text).filter((span) => span.includes(kit));
    const seen = new Set();
    for (const span of kitSpans) {
      assert.ok(span.startsWith(`${kit} `), `${lang}: "${span}" does not start with the kit command`);
      const sub = span.slice(kit.length + 1).split(' ')[0];
      assert.ok(KIT_SUBCOMMANDS.includes(sub), `${lang}: "${span}" runs "${sub}", not a kit subcommand the round allows`);
      const granted = allowed.some((rule) => {
        const m = /^Bash\((.+):\*\)$/.exec(rule);
        return m !== null && span.startsWith(m[1]);
      });
      assert.ok(granted, `${lang}: "${span}" is not granted by allowedTools()`);
      seen.add(sub);
    }
    assert.deepEqual([...seen].sort(), [...KIT_SUBCOMMANDS].sort(), `${lang}: every subcommand is named`);
    // Nothing else reads as a command to run, and the kit never appears
    // behind node.
    for (const span of codeSpans(text)) {
      assert.doesNotMatch(span, /^(git|gh|node|npm|npx|rm|curl|wget|bash|sh|zsh|cat|ls|cd|mv|cp|date|find|sed|awk|grep|rg|head|tail|echo|python|python3|touch|mkdir|chmod)\s/, `${lang}: "${span}" reads as a command outside the kit`);
    }
    assert.ok(!text.includes(`node ${kit}`), `${lang}: the kit appears behind node`);
    assert.ok(text.includes(`${kit} lint --base worktree`));
    assert.ok(text.includes(`${kit} propose "`));
  });

  test(`${lang}: the last-line contract is spelled exactly`, () => {
    assert.ok(rendered(lang).includes('`BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed>`'));
  });
}

// Incidents of 26/09 and 30/09/2026: a new `sources` item written at the
// end of the frontmatter, after another key's line, hung under that key and
// failed the vault's validate. One sentence in the Compile section, where
// the round writes `sources`, and no new contract marker, so an overlay
// that carries every marker today still does.
const LIST_ITEM_PLACEMENT = {
  en: "When you add an item to a frontmatter list such as `sources`, put it at the end of that list, before the next top-level key: an item written after another key's line hangs under that key and the note no longer reads.",
  'pt-BR': 'Quando você acrescentar um item a uma lista do frontmatter, como `sources`, ponha o item no fim dessa lista, antes da próxima chave de primeiro nível: um item escrito depois da linha de outra chave fica pendurado nessa chave, e a nota deixa de ser lida.',
};

for (const lang of LANGS) {
  test(`${lang}: the curate prompt tells the round where a new frontmatter list item goes, in the Compile section, outside every contract rule`, () => {
    const text = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
    const sentence = LIST_ITEM_PLACEMENT[lang];
    assert.equal(text.split(sentence).length - 1, 1, `${lang}: the sentence, once`);
    const at = text.indexOf(sentence);
    const compile = text.lastIndexOf('\n## ', at);
    assert.match(text.slice(compile, text.indexOf('\n', compile + 1)), lang === 'en' ? /## Compile$/ : /## Compilar$/, `${lang}: under the Compile heading`);
    const paragraph = text.slice(text.lastIndexOf('\n\n', at) + 2, at);
    assert.doesNotMatch(paragraph, /<!-- rule:/, `${lang}: not inside a contract rule's paragraph`);
    assert.ok(rendered(lang).includes(sentence), `${lang}: rendered as written`);
  });
}

test('the two packs\' curate prompts carry no em dash and no work vocabulary', () => {
  const banned = {
    en: /\b(company|companies|team|teams|calendar|meeting|meetings|CRM|sales|customer|customers|client|clients|colleague|colleagues|employee|manager|boss)\b/i,
    'pt-BR': /\b(empresa|empresas|equipe|equipes|agenda|reunião|reuniões|CRM|vendas|cliente|clientes|colega|colegas|funcionário|chefe|gestor)\b/iu,
  };
  for (const lang of LANGS) {
    const text = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
    assert.ok(!text.includes(String.fromCodePoint(0x2014)), `${lang}: em dash`);
    assert.doesNotMatch(text, banned[lang], `${lang}: work vocabulary`);
  }
});

// --- brain-kit prompt curate --------------------------------------------

test('prompt curate renders the pack prompt in the vault\'s language, with the standalone parameters line', async () => {
  for (const lang of LANGS) {
    const { vault, state, config } = vaultFor(lang);
    const c = collector();
    const code = await runPrompt(['curate'], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state), now: NOW });
    assert.equal(code, EXIT.OK, c.stdout + c.stderr);
    assert.equal(c.stderr, '');
    assert.equal(c.stdout.split('\n')[0], config.curate.signature);
    assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/);
    const line = createTranslator(lang)('prompt.curate_parameters_standalone');
    assert.ok(c.stdout.includes(line), `${lang}: the standalone parameters line`);
  }
});

test('prompt curate outside a vault renders by the locale with the pack defaults', async () => {
  const outside = makeTempDir('brain-kit-curate-outside-');
  for (const lang of LANGS) {
    const defaults = JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
    const c = collector();
    const code = await runPrompt(['curate'], c.io, createTranslator('en'), { cwd: outside, env: { ...process.env, BRAIN_KIT_LANG: lang } });
    assert.equal(code, EXIT.OK, c.stdout + c.stderr);
    assert.equal(c.stdout.split('\n')[0], defaults.curate.signature);
    assert.ok(c.stdout.includes(defaults.taxonomy.log));
    assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/);
  }
});

test('prompt curate --vault points at a vault other than the working directory', async () => {
  const { vault, state } = vaultFor('en');
  const c = collector();
  const code = await runPrompt(['curate', '--vault', vault], c.io, createTranslator('en'), { cwd: makeTempDir('brain-kit-curate-elsewhere-'), env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.ok(c.stdout.includes('memory/log.md'));
});

test('an unreadable pack prompt prints one translated line to stdout and exits 1', async () => {
  const packs = makeTempDir('brain-kit-curate-packs-');
  cpSync(join(KIT_ROOT, 'lang'), packs, { recursive: true });
  rmSync(join(packs, 'en', 'prompts', 'curate.md'));
  const c = collector();
  const code = await runPrompt(['curate'], c.io, createTranslator('en'), {
    cwd: makeTempDir('brain-kit-curate-outside-'), env: { ...process.env, BRAIN_KIT_LANG: 'en' }, packsDir: packs,
  });
  assert.equal(code, EXIT.FAILURE);
  assert.notEqual(c.stdout.trim(), '');
  assert.equal(c.stdout.trim().split('\n').length, 1);
  assert.match(c.stdout, /doctor/);
});

// --- the vault's overlay -------------------------------------------------

function writeOverlay(vault, text) {
  mkdirSync(join(vault, '.brain-kit', 'prompts'), { recursive: true });
  writeFileSync(join(vault, '.brain-kit', 'prompts', 'curate.md'), text);
}

test('an overlay in the vault is rendered instead of the pack prompt, frontmatter stripped, placeholders filled', async () => {
  const { vault, state } = freshVault('en');
  writeOverlay(vault, '---\ntype: prompt\n---\n{{signature}}\nOVERLAY BODY {{log}} {{kit}} {{parameters}}\n');
  const c = collector();
  const code = await runPrompt(['curate'], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.equal(c.stdout.split('\n')[0], loadConfig(vault).curate.signature);
  assert.ok(c.stdout.includes(`OVERLAY BODY memory/log.md ${kitCommand()}`));
  assert.doesNotMatch(c.stdout, /\{\{\w+\}\}/);
  assert.doesNotMatch(c.stdout, /type: prompt/);
});

test('--check warns, and still passes, when the vault\'s overlay lacks contract markers', async () => {
  const { vault, state } = freshVault('en');
  writeOverlay(vault, '{{signature}}\n<!-- rule:read-index-first -->\nOverlay.\n');
  const c = collector();
  const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  for (const rule of CURATE_RULES.filter((r) => r !== 'read-index-first')) assert.ok(c.stderr.includes(rule), `warns about ${rule}`);
  assert.ok(!c.stderr.includes('"read-index-first"'));
});

test('--check says nothing about an overlay that carries every marker and the sources line', async () => {
  const { vault, state } = freshVault('en');
  writeOverlay(vault, `{{signature}}\n${CURATE_RULES.map((r) => `<!-- rule:${r} -->\nx\n`).join('')}BRAIN_KIT_SOURCES: {{sources_line}}\n`);
  const c = collector();
  const code = await runPrompt(['--check'], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.equal(c.stderr, '');
});

test('final review M4: --check warns, in both languages, and still passes, when the overlay does not use {{sources_line}}, as one written before phase 3', async () => {
  for (const [lang, text] of [['en', /does not use \{\{sources_line\}\}: .*a calendar or meeting-notes mark never moves/], ['pt-BR', /não usa \{\{sources_line\}\}: .*a marca da agenda ou das notas de reunião nunca anda/]]) {
    const { vault, state } = freshVault(lang);
    writeOverlay(vault, `{{signature}}\n${CURATE_RULES.map((r) => `<!-- rule:${r} -->\nx\n`).join('')}BRAIN_KIT_SOURCES: transcripts=<ok|empty|failed>\n`);
    const c = collector();
    const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator(lang), { cwd: vault, env: testEnv(state) });
    assert.equal(code, EXIT.OK, c.stdout + c.stderr);
    assert.match(c.stderr, text, lang);
  }
});

// Fix round 1 of 01/10/2026 (Important 4): an overlay that kept the
// sampling rule of before the digests sends the model to the transcripts
// themselves, which a round no longer grants, so every round exits 4.
// --check says so, and still passes: the overlay is the owner's to write.
const OLD_SAMPLE_RULE = {
  en: 'Read the transcripts the block lists, and only those. A transcript is long: read each one with Read, starting at the line the block gives as its `sampleLine` (pass it as the offset), which is near the end, and read from there to the end.',
  'pt-BR': 'Leia as transcrições que o bloco lista, e só elas. Uma transcrição é longa: leia cada uma com o Read, começando na linha que o bloco indica como `sampleLine` (passe esse número como offset), que fica perto do fim.',
};

function overlayWith(rule) {
  return `{{signature}}\n${CURATE_RULES.map((r) => `<!-- rule:${r} -->\n${r === 'sample-from-end' ? rule : 'x'}\n\n`).join('')}BRAIN_KIT_SOURCES: {{sources_line}}\n`;
}

test('--check warns, in both languages, and still passes, when the overlay still tells the model to read a transcript from its sampleLine or with an offset', async () => {
  for (const [lang, text] of [['en', /still carries the old wording of the rule sample-from-end: it tells the model to read a transcript itself/], ['pt-BR', /ainda traz a redação antiga da regra sample-from-end: ele manda o modelo ler a própria transcrição/]]) {
    for (const rule of [OLD_SAMPLE_RULE[lang], 'Read each transcript with Read, with an offset near its end, a slice at a time.']) {
      const { vault, state } = freshVault(lang);
      writeOverlay(vault, overlayWith(rule));
      const c = collector();
      const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator(lang), { cwd: vault, env: testEnv(state) });
      assert.equal(code, EXIT.OK, c.stdout + c.stderr);
      assert.match(c.stderr, text, `${lang}: ${rule.slice(0, 40)}`);
    }
  }
});

test('--check says nothing of the sampling rule when the overlay carries the kit\'s own wording, in either language', async () => {
  for (const lang of LANGS) {
    const pack = readFileSync(join(KIT_ROOT, 'lang', lang, 'prompts', 'curate.md'), 'utf8');
    const { vault, state } = freshVault(lang);
    writeOverlay(vault, pack);
    const c = collector();
    const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator(lang), { cwd: vault, env: testEnv(state) });
    assert.equal(code, EXIT.OK, c.stdout + c.stderr);
    assert.doesNotMatch(c.stderr, /sample-from-end/, lang);
  }
});

// --- --check on the packs' prompts ---------------------------------------

function scratchPacks() {
  const dir = makeTempDir('brain-kit-curate-check-');
  cpSync(join(KIT_ROOT, 'lang'), dir, { recursive: true });
  return dir;
}

async function checkOn(dir) {
  const c = collector();
  const code = await runPrompt(['--check'], c.io, createTranslator('en'), { packsDir: dir, cwd: makeTempDir('brain-kit-curate-outside-') });
  return { code, out: c.stdout, err: c.stderr };
}

test('--check passes on the real packs', async () => {
  const { code, out } = await checkOn(join(KIT_ROOT, 'lang'));
  assert.equal(code, EXIT.OK, out);
});

test('--check fails when a pack prompt loses a contract marker', async () => {
  const dir = scratchPacks();
  const file = join(dir, 'pt-BR', 'prompts', 'curate.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('<!-- rule:never-verified -->', ''));
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /never-verified/);
  assert.match(out, /pt-BR/);
});

test('--check fails when a pack has no curate prompt', async () => {
  const dir = scratchPacks();
  rmSync(join(dir, 'en', 'prompts', 'curate.md'));
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /curate/);
  assert.match(out, /\ben\b/);
});

test('--check fails on an unknown placeholder in a prompt, and on placeholders that differ between packs', async () => {
  const dir = scratchPacks();
  const file = join(dir, 'en', 'prompts', 'curate.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n{{nonexistent_value}}\n`);
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /nonexistent_value/);
  assert.match(out, /differ/);
});

test('--check fails when a prompt\'s first line is not the signature placeholder', async () => {
  const dir = scratchPacks();
  const file = join(dir, 'en', 'prompts', 'curate.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('{{signature}}\n', '# Title\n{{signature}}\n'));
  const { code, out } = await checkOn(dir);
  assert.equal(code, EXIT.FAILURE);
  assert.match(out, /first line/);
});

// --- through the real binary ----------------------------------------------

test('brain-kit prompt curate, run through the real binary inside a real vault, exits 0', () => {
  const { vault, state, config } = vaultFor('pt-BR');
  const r = spawnSync(process.execPath, [BIN, 'prompt', 'curate'], { encoding: 'utf8', cwd: vault, env: testEnv(state) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.split('\n')[0], config.curate.signature);
  for (const rule of CURATE_RULES) assert.ok(r.stdout.includes(`<!-- rule:${rule} -->`));
});

// --- fix round 1: the round's timestamp, the signature on overlays --------

test('vaultClock renders the date and the ISO 8601 time with the offset of the vault time zone', () => {
  const noonUtc = new Date(Date.UTC(2026, 8, 24, 12, 30, 0));
  assert.deepEqual(vaultClock(noonUtc, 'America/Argentina/Buenos_Aires'), { date: '2026-09-24', iso: '2026-09-24T09:30:00-03:00' });
  assert.deepEqual(vaultClock(noonUtc, 'UTC'), { date: '2026-09-24', iso: '2026-09-24T12:30:00+00:00' });
  assert.deepEqual(vaultClock(noonUtc, 'Asia/Kolkata'), { date: '2026-09-24', iso: '2026-09-24T18:00:00+05:30' });
  // The date is the vault's, not UTC's: 01:00 UTC on the 25th is still the 24th in Buenos Aires.
  assert.deepEqual(vaultClock(new Date(Date.UTC(2026, 8, 25, 1, 0, 0)), 'America/Argentina/Buenos_Aires'), { date: '2026-09-24', iso: '2026-09-24T22:00:00-03:00' });
});

test('vaultClock falls back to the process clock, still with an explicit offset, for a missing or unknown zone', () => {
  const now = new Date(Date.UTC(2026, 8, 24, 12, 30, 0));
  for (const zone of [undefined, '<vault-timezone>', 'Not/AZone']) {
    const { date, iso } = vaultClock(now, zone);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.equal(Date.parse(iso), now.getTime(), `${zone}: the same instant`);
  }
});

test('renderCuratePrompt renders {{now_iso}} from the now it receives, in the vault time zone', () => {
  for (const lang of LANGS) {
    const { vault, config } = vaultFor(lang);
    const zoned = { ...config, vault: { ...config.vault, timezone: 'America/Argentina/Buenos_Aires' } };
    const text = renderCuratePrompt({ vaultRoot: vault, config: zoned, lang, parameters: PARAMS, now: new Date(Date.UTC(2026, 8, 24, 12, 30, 0)) });
    assert.ok(text.includes('at: 2026-09-24T09:30:00-03:00 }'), lang);
    assert.ok(text.includes('## 2026-09-24'), lang);
    assert.doesNotMatch(text, /\{\{now_iso\}\}/);
  }
});

test('an overlay that does not start with the signature gets the signature line put in front, once', async () => {
  const { vault, state } = freshVault('en');
  const signature = loadConfig(vault).curate.signature;
  writeOverlay(vault, '---\ntype: prompt\n---\n# My own curation prompt\nBody {{log}}\n');
  const c = collector();
  const code = await runPrompt(['curate'], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  const lines = c.stdout.split('\n');
  assert.equal(lines[0], signature);
  assert.equal(lines[2], '# My own curation prompt');
  assert.equal(c.stdout.split(signature).length - 1, 1);
});

test('an overlay whose first non-empty line is already the signature, as placeholder or as text, is left as written', () => {
  const { vault } = freshVault('en');
  const config = loadConfig(vault);
  for (const first of ['{{signature}}', config.curate.signature]) {
    writeOverlay(vault, `\n${first}\nBody\n`);
    const text = renderCuratePrompt({ vaultRoot: vault, config, lang: 'en', parameters: PARAMS });
    assert.equal(text, `\n${config.curate.signature}\nBody\n`);
  }
});

test('--check warns when the overlay does not start with the signature, and about placeholders a round does not fill', async () => {
  const { vault, state } = freshVault('en');
  writeOverlay(vault, `# Heading\n${CURATE_RULES.map((r) => `<!-- rule:${r} -->\nx\n`).join('')}{{today}}\n`);
  const c = collector();
  const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.OK, c.stdout + c.stderr);
  assert.match(c.stderr, /does not start with \{\{signature\}\}; a round will put the signature line in front of it/);
  assert.match(c.stderr, /"\{\{today\}\}", which a round does not fill/);
  assert.doesNotMatch(c.stderr, /contract marker/);
});

// --- ruling M5: a curate.prompt outside the vault ------------------------------

test('--check fails, naming the path, when the vault\'s curate.prompt points outside the vault; a path inside passes', async () => {
  const { vault, state } = freshVault('en');
  const file = join(vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  for (const setting of ['../outside.md', '/tmp/outside.md']) {
    writeFileSync(file, `${JSON.stringify({ ...config, curate: { ...config.curate, prompt: setting } }, null, 2)}\n`);
    const c = collector();
    const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
    assert.equal(code, EXIT.FAILURE, setting);
    assert.match(c.stdout + c.stderr, /outside the vault/);
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const c = collector();
  assert.equal(await runPrompt(['--check', '--vault', vault], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) }), EXIT.OK, c.stdout + c.stderr);
});

test('--check fails when the curate prompt inside the vault is a link leading outside it', async () => {
  const { vault, state } = freshVault('en');
  const outside = join(makeTempDir('brain-kit-outside-'), 'curate.md');
  writeFileSync(outside, '{{signature}}\nSomething else.\n');
  mkdirSync(join(vault, '.brain-kit', 'prompts'), { recursive: true });
  symlinkSync(outside, join(vault, '.brain-kit', 'prompts', 'curate.md'));
  const c = collector();
  const code = await runPrompt(['--check', '--vault', vault], c.io, createTranslator('en'), { cwd: vault, env: testEnv(state) });
  assert.equal(code, EXIT.FAILURE);
  assert.match(c.stdout + c.stderr, /outside the vault/);
});
