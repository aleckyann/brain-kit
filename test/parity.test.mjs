// Parity between the new validator and the one that has actually guarded a
// real vault for two months.
//
// This is the only test in the suite that touches a real, private second
// brain. It is opt-in and never runs in continuous integration: it is
// skipped entirely unless BRAIN_KIT_PARITY_VAULT names a real directory,
// which nobody's CI has any reason to set.
//
// PRIVACY, before anything about parity. This file is public, forever, in a
// public repository. It must never carry a path, a filename or a folder
// name that came from the vault BRAIN_KIT_PARITY_VAULT points at: a folder
// name reveals a taxonomy, a filename reveals a person or a company. Two
// things below exist only because of that constraint:
//
// 1. The original validator hard-codes one extra ignored directory name
//    (this project's own plan calls that out as a defect to fix, not to
//    reproduce: see src/vault.mjs's ALWAYS_IGNORED). That literal string
//    lives inside the PRIVATE vault, in its own scripts/validate-okf.mjs,
//    and is read from there at test-run time, through a regular
//    expression, rather than ever being typed into this file. Whatever
//    name that turns out to be on a given machine, this file never learns
//    it as a literal string; it only ever holds "whatever names this
//    pattern found."
// 2. A divergence that fails this test is reported with the real file path
//    in the assertion message, so whoever runs this locally (the only
//    place it ever runs) can find the note. That message is a local
//    console line, never committed, never posted; docs/validator-parity.md,
//    which IS committed, carries counts and rule ids only, never a path.
//
// WHY A CONFIGURATION IS WRITTEN INTO A TEMPORARY DIRECTORY RATHER THAN THE
// VAULT. The vault has no brain-kit.config.json of its own (the command
// that would adopt an existing vault and write one is a later slice), and
// this test must never write into the vault either way: it is not this
// project's to change, it is under version control, and another process
// curates it on a schedule. `brain-kit validate <dir>` needs its config
// file and its content to live in the very same directory (src/config.mjs
// and src/vault.mjs's own sentinel), and src/vault.mjs's walk deliberately
// never traverses a symlinked directory (its own header explains why: a
// vault has no supported use for one), so a shallow symlink tree does not
// work here. What does: a directory tree of real directories, built beside
// the vault (a sibling, on the same filesystem, never inside it), with a
// HARD LINK standing in for every real file. A hard link is not a symlink
// at all as far as src/vault.mjs's walk can tell (fs.Dirent reports it as
// an ordinary file), it shares the same bytes with no copy made, and
// creating one is not a write to the vault's own directory in any sense:
// nothing inside the vault is touched, only a new directory entry
// elsewhere that happens to point at the same inode. brain-kit.config.json
// itself is the one real file written, and it is written only inside that
// sibling directory, never beside the vault's own files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const VAULT = process.env.BRAIN_KIT_PARITY_VAULT;

function skipReason() {
  if (!VAULT) return 'BRAIN_KIT_PARITY_VAULT is not set';
  if (!existsSync(VAULT)) return `BRAIN_KIT_PARITY_VAULT (${VAULT}) does not exist`;
  if (!statSync(VAULT).isDirectory()) return `BRAIN_KIT_PARITY_VAULT (${VAULT}) is not a directory`;
  return false;
}

const SKIP = skipReason();
const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
const DOC = join(KIT_ROOT, 'docs', 'validator-parity.md');

// The configuration this test writes into its own temporary directory,
// pointed at the reference vault. Every setting under `validate` and
// `frontmatter` below was read out of the vault's own conventions document
// and its original validator (see docs/validator-parity.md for which of
// these are directly observed facts and which are judgment calls, with a
// confidence note on each), never guessed at. `taxonomy.templates_dir`,
// `frontmatter.required`/`forbidden`/`extensions`, `okf_version` and every
// `validate.*` key below are the only settings that can change what
// `brain-kit validate` finds; the rest of this object is filler in this
// project's own public fixture taxonomy (people/, projects/, decisions/,
// pending/, core/, memory/, attachments/, owner "Ana"), required by the
// schema but inert for this comparison.
const PARITY_CONFIG = {
  $schema: 'https://raw.githubusercontent.com/aleckyann/brain-kit/main/schema/config.schema.json',
  kit_version: '0.0.1',
  lang: 'pt-BR',
  okf_version: '0.2',
  owner: { name: 'Ana', handle: 'ana', email: 'ana@example.com', role: 'founder', company: 'Example Ltd', agent_role: 'advisor and chief of staff' },
  vault: { title: "Ana's Second Brain", repo: 'ana/brain', private: true, default_branch: null, timezone: 'America/Sao_Paulo', locale: 'pt_BR.UTF-8' },
  actors: { human: 'human:ana', agent_prefix: 'brain-kit-curator', scheduled: 'process:brain-kit-curate' },
  taxonomy: {
    collections: {
      people: { type: 'person', template: 'templates/modelo-pessoa.md' },
      projects: { type: 'project', template: 'templates/modelo-projeto.md' },
      decisions: { type: 'decision', template: 'templates/modelo-decisao.md', filename_pattern: 'YYYY-MM-<slug>' },
    },
    domains: ['core', 'memory', 'pending'],
    no_index: [],
    log: 'memory/log.md',
    log_markers: { capture: 'Captura', promoted: 'Promovido', correction: 'Correcao', creation: 'Criacao' },
    // The one taxonomy setting that actually changes what validate finds:
    // directly observed on the vault's own disk layout, not a guess.
    templates_dir: 'templates',
    attachments_dir: 'attachments',
    files: {
      followups: 'pending/acompanhamentos.md', promises: 'pending/promessas.md', rituals: 'core/ritmo-semanal.md',
      execution_system: 'core/sistema-de-execucao.md', style_guide: 'core/diretrizes-de-resposta.md', bootstrap: 'BOOTSTRAP.md',
      strategy_index: 'decisions/index.md', metrics: null, glossary: null,
    },
    // Split into an ordered "columns" array and a "labels" object (fix
    // round 1): the flat shape mixed the two, and a real vault's own
    // follow-ups/promises files have section headings ("## Abertos" /
    // "## Resolvidos") and a ritual file has placeholder cell text
    // ("nenhuma ainda") that are not column headings at all.
    columns: {
      followups: {
        columns: ['Registrado', 'O que', 'Com quem / onde', 'Prazo', 'Proximo passo'],
        labels: { open_heading: '## Abertos', resolved_heading: '## Resolvidos' },
      },
      promises: {
        columns: ['Feita em', 'Para quem', 'O que prometi', 'Condicao / prazo', 'Situacao'],
        labels: { active_heading: '## Ativas', done_heading: '## Cumpridas / renegociadas' },
      },
      rituals: {
        columns: ['Titulo no calendario', 'Cadencia', 'Horario', 'Dono', 'Participantes fixos', 'Alimenta'],
        labels: { feeds_none: 'nenhuma ainda' },
      },
    },
  },
  frontmatter: {
    // description and generated are required on every non-reserved file:
    // scripts/validate-okf.mjs's own "[casa] semDescription" and
    // "[casa] semGenerated" checks, unconditional, directly observed.
    required: ['description', 'generated'],
    // timestamp (the v0.1 field generated.at replaced) is forbidden:
    // "[casa] timestampLegado", directly observed.
    forbidden: ['timestamp'],
    // type is never checked against a closed list, in the original or
    // here: directly observed (no such check exists in the original).
    type_enum: null,
    extensions: {
      // situacao is a house-only field, its five values and the two note
      // types they apply to read directly out of CONVENCOES-OKF.md's own
      // table and out of scripts/validate-okf.mjs's SITUACAO_ENUM; the
      // note-type spelling ("decisao", "projeto") is read from the
      // vault's own frontmatter, not the fixture taxonomy's English one,
      // because this rule keys on the vault's real `type:` values.
      situacao: {
        type: 'enum',
        values_by_type: {
          decisao: ['aberta', 'em-execucao', 'concluida', 'revertida'],
          projeto: ['ativo', 'ideia', 'adiado', 'concluido', 'arquivado'],
        },
      },
      // vinculo and confidencial are documented as free, uncontrolled
      // house fields in CONVENCOES-OKF.md, and scripts/validate-okf.mjs
      // never checks either one's shape. Deliberately left unconfigured
      // here: adding either would make this validator check something
      // the original never did, which is not reproducing a house rule,
      // it is inventing one.
    },
  },
  stale_policy: { key: 'path', months: { 'pessoas/': 6, 'pendencias/': 3 } },
  validate: {
    // File-relative links only, wikilinks forbidden outright: both are
    // unconditional in the original ("[casa] linkAbsoluto", "[casa]
    // wikilinks"), directly observed.
    link_style: 'file-relative',
    wikilinks: 'forbid',
    // The root index.md's okf_version is always checked in the original
    // ("[casa] raizSemOkfVersion" has no opt-out), directly observed.
    require_root_okf_version: true,
    // The scoped placeholder convention this project's engine uses on
    // purpose, in place of the original's unscoped one (see defect 2 in
    // docs/validator-parity.md). This is the new validator's own default
    // shape, not a fact read out of the vault.
    placeholder_pattern: '<[^>]+>',
    // Deliberately empty: see docs/validator-parity.md, defect 3. Adding
    // the one directory the original hard-codes here would hide the exact
    // divergence this comparison exists to surface.
    ignore_paths: [],
    // Required by a fact settled after the plan was written: the vault
    // writes plain dates for stale_after throughout, while the
    // specification requires an explicit offset. Without this, that one
    // divergence would appear once per note and drown every other signal.
    timestamp_deviation: 'allow',
  },
  lint: {
    columns: 'error', tables: { severity: 'error', max_cell_chars: 600, duplicate_rows: 'error' }, orphans: 'warn', index_completeness: 'warn',
    secrets: 'error', privacy: 'error', attribution: 'warn',
    style: { forbidden_chars: ['\u2014'], base: 'auto' },
  },
  privacy: {
    confidential_dirs: ['pessoas/'],
    require_private_repo: true,
    secret_patterns: ['ghp_[A-Za-z0-9]{20,}', 'github_pat_', 'sk-ant-', 'BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY', 'AKIA[0-9A-Z]{16}'],
    third_party_data_acknowledged: true,
    retention_note: 'pessoas/ contem dados pessoais de terceiros; remocao sob solicitacao: veja SECURITY.md',
    audiences: {},
  },
  git: {
    agent_identity: { name: "Ana's Second Brain (curator)", email: 'curator@example.invalid' },
    branch_prefix: 'curador/', commit_prefix: 'curadoria:', pr_command: 'gh', pr_title: '{{commit_prefix}} {{summary}}', pr_body: '.brain-kit/pr-body.md',
    ci: 'github-actions', ci_engine_ref: null, forbid_agent_push_to_default: true,
  },
  hooks: { stop: true, session_start: true, session_start_fetch: false, block_on_inherited_dirt: false, timeout_seconds: 15 },
  curate: {
    enabled: true, schedule: ['06:00', '12:00', '18:00'], prompt: '.brain-kit/prompts/curate.md', signature: 'Curador do segundo cerebro (exemplo)',
    max_turns: 100, budget_usd: 5, network_min_wait_ms: 100,
    caps: { transcripts: 20, search_docs_opened: 3, attached_notes_opened: 6, new_pending_items: 5 },
    promotion_map: {
      owner_action: 'pending/acompanhamentos.md', owner_promise: 'pending/promessas.md', third_party_strategic: 'pending/acompanhamentos.md',
      third_party_operational: 'log-only', strategic_decision: 'decisions/', decision_needs_talk: 'pending/acompanhamentos.md',
      person_fact: 'people/', ritual_change: 'core/ritmo-semanal.md',
    },
    sources: { required: ['transcripts'], best_effort: ['calendar', 'meeting_notes'] },
    extra_signatures: [], allowed_tools_extra: [], disallowed_tools_extra: [],
  },
  sources: {
    transcripts: { adapter: 'claude-code', include_projects: ['-home-ana-brain'], exclude_path_patterns: ['/-tmp-', '/-scratch-'], sample_strategy: 'tail-first' },
    calendar: {
      provider: 'claude-connector-google-calendar', server_display_name: 'claude.ai Google Calendar', tool_prefix: 'mcp__claude_ai_Google_Calendar__',
      tool_suffixes: ['list_events', 'list_calendars'], calendars: ['ana@example.com'], team_calendars: [], team_calendars_consent_noted: false,
      skip_events_with_owner: true, dedup_by: 'eventId',
      privacy: { exclude_event_types: ['OUT_OF_OFFICE', 'FOCUS_TIME'], exclude_keywords: ['pessoal'], team_personal_events: 'drop' },
      focus_blocks_as_ruler: true,
    },
    meeting_notes: {
      provider: 'claude-connector-google-drive', server_display_name: 'claude.ai Google Drive', tool_prefix: 'mcp__claude_ai_Google_Drive__',
      tool_suffixes: ['search_files', 'read_file_content'], search_title_contains: 'Notas de reuniao', attached_title_prefix: 'Notas - ',
      window_hours_before_day: 12, dedup_by: 'literal-title-in-log', never_download: ['recording', 'full_transcript'],
    },
  },
  briefing: {
    enabled: true, schedule: '0 9 * * 1-5', prompt: '.brain-kit/prompts/briefing.md', signature: 'Briefing matinal do segundo cerebro (exemplo)',
    max_words: 500, max_questions: 3, questions_dedup_days: 15, question_escalate_after: 3, question_max_age_days: 45,
    write_caps: { captures: 5, pending_changes: 3 },
    strategy_doc: { index: 'decisions/index.md', title_contains: 'carta' },
    main_metric: 'MRR', calendar_id: 'ana@example.com',
    read: ['index.md', 'AGENTS.md', 'decisions/index.md', 'pending/promessas.md', 'projects/index.md', 'core/ritmo-semanal.md'],
    never_read: ['people/', 'attachments/', '.brain-kit/', 'memory/log.md#inteiro'],
  },
};

// Every original category (scripts/validate-okf.mjs's own `problems` keys,
// read directly from that file, never guessed) mapped to the (ruler, id)
// pair of the rule in this engine that covers the same ground, with an
// optional `field` when one id serves several frontmatter keys
// (required-fields, forbidden-fields, extension-fields).
const CATEGORY_MAP = [
  { original: '[spec] semType', ruler: 'spec', id: 'type-required' },
  { original: '[spec] indexComFrontmatter', ruler: 'spec', id: 'index-no-frontmatter' },
  { original: '[casa] raizSemOkfVersion', ruler: 'house', id: 'root-okf-version' },
  { original: '[casa] okfVersionDesatualizada', ruler: 'house', id: 'root-okf-version' },
  { original: '[spec] logForaDoFormato', ruler: 'spec', id: 'log-format' },
  { original: '[spec] generatedSemBy', ruler: 'spec', id: 'generated-actor' },
  { original: '[spec] verifiedForaDoFormato', ruler: 'spec', id: 'verified-events' },
  { original: '[spec] statusForaDoEnum', ruler: 'spec', id: 'status-enum' },
  { original: '[spec] staleAfterForaDoFormato', ruler: 'spec', id: 'stale-after-format' },
  { original: '[spec] sourcesSemResource', ruler: 'spec', id: 'sources-resource' },
  { original: '[casa] semDescription', ruler: 'house', id: 'required-fields', field: 'description' },
  { original: '[casa] semGenerated', ruler: 'house', id: 'required-fields', field: 'generated' },
  { original: '[casa] timestampLegado', ruler: 'house', id: 'forbidden-fields', field: 'timestamp' },
  { original: '[casa] situacaoForaDoEnum', ruler: 'house', id: 'extension-fields', field: 'situacao' },
  { original: '[casa] linksQuebrados', ruler: 'house', id: 'link-target-exists' },
  { original: '[casa] linkAbsoluto', ruler: 'house', id: 'link-style' },
  { original: '[casa] wikilinks', ruler: 'house', id: 'no-wikilinks' },
];

// Builds a mirror of `src` under `dest` (which must not exist yet):
// real directories throughout, and a hard link standing in for every
// regular file. Dot-entries and node_modules are left out, matching what
// src/vault.mjs's own ALWAYS_IGNORED already excludes on the new side, so
// leaving them out here changes nothing either engine would have reported.
// Nothing under `src` is opened for writing, ever; `linkSync` only adds a
// new directory entry elsewhere pointing at the same inode.
function mirrorWithHardLinks(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) mirrorWithHardLinks(srcPath, destPath);
    else if (entry.isFile()) linkSync(srcPath, destPath);
    // A symlink inside the reference vault would need its own decision;
    // none exists there today, and this function does not guess at one.
  }
}

// Reads the extra directory names the original validator's own walk
// hard-codes, straight out of its source text, so this file never has to
// spell one out itself. `node_modules` is excluded from the result: both
// engines already agree on that one, universally, so it is not a
// divergence source. Whatever remains (today, exactly one name on the
// author's machine) is a name this test file itself never learns as a
// literal string.
function extraHardcodedIgnores(originalSource) {
  const names = new Set();
  const pattern = /entry\.name === '([^']+)'/g;
  let match;
  while ((match = pattern.exec(originalSource)) !== null) names.add(match[1]);
  names.delete('node_modules');
  return [...names];
}

// Parses scripts/validate-okf.mjs's own console report into
// { fileCount, byCategory }, byCategory mapping each "[spec] xyz" /
// "[casa] xyz" bucket to the list of root-relative paths (each starting
// with "/") it reported, empty when the bucket printed "ok".
function parseOriginalOutput(stdout) {
  const lines = stdout.split('\n');
  const headerPattern = /^ {2}\[(spec|casa)\] (\S+):\s*(ok)?\s*$/;
  const entryPattern = /^ {4}(\S.*)$/;
  const pathPattern = /^(\/\S+?)(?=:|\s|$)/;
  const byCategory = new Map();
  let current = null;
  let fileCount = null;
  for (const line of lines) {
    const countMatch = /(\d+) arquivos \.md/.exec(line);
    if (countMatch) fileCount = Number(countMatch[1]);
    const header = headerPattern.exec(line);
    if (header) {
      current = `[${header[1]}] ${header[2]}`;
      byCategory.set(current, []);
      continue;
    }
    if (current) {
      const entry = entryPattern.exec(line);
      if (entry) {
        const pathMatch = pathPattern.exec(entry[1]);
        if (pathMatch) byCategory.get(current).push(pathMatch[1]);
        continue;
      }
      current = null; // this category's block ended (blank line, [info], OK/FALHOU)
    }
  }
  return { fileCount, byCategory };
}

// Loads the accepted-divergence list from the one fenced ```json block in
// docs/validator-parity.md. The document, not this file, is the source of
// truth for which divergences are expected and why: editing the document
// changes what this test accepts, with no code change required.
function loadAcceptedDivergences() {
  const text = readFileSync(DOC, 'utf8');
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  assert.ok(match, `docs/validator-parity.md must carry one fenced json block of accepted divergences`);
  return JSON.parse(match[1]);
}

// True when `finding` (one entry of the new engine's --json findings
// array) is excused by `rule` (one entry of the accepted list loaded from
// the document). Each `kind` this function knows about is a category, not
// a single instance: none of the three needs a file path to state, which
// is exactly why the document that declares them can stay free of one.
function ruleExcuses(rule, finding, extraIgnoredPrefixes) {
  if (rule.kind === 'downgraded-timestamp-warning') {
    return finding.warning === true && (rule.ruler === undefined || rule.ruler === finding.ruler);
  }
  if (rule.kind === 'placeholder-shaped-value') {
    if (finding.ruler !== rule.ruler || finding.id !== rule.id) return false;
    const value = String(finding.params?.value ?? '');
    return /[<|]/.test(value);
  }
  if (rule.kind === 'excluded-directory') {
    return extraIgnoredPrefixes.some((name) => finding.file === name || finding.file.startsWith(`${name}/`));
  }
  return false;
}

test(
  'the new validator agrees with the original validator on the reference vault',
  { skip: SKIP },
  () => {
    const vaultRoot = resolve(VAULT);
    const originalScript = join(vaultRoot, 'scripts', 'validate-okf.mjs');
    assert.ok(existsSync(originalScript), `expected an original validator at ${originalScript}`);
    const originalSource = readFileSync(originalScript, 'utf8');

    const extraIgnored = extraHardcodedIgnores(originalSource);
    assert.ok(
      extraIgnored.length > 0,
      'expected the original validator to hard-code at least one extra ignored name; without one, defect 3 (the accepted "excluded-directory" divergence) is not observable and the accepted list may be hiding nothing',
    );

    // A sibling of the vault, on the vault's own filesystem (never inside
    // it), so linkSync below can hard-link across directories on the same
    // device. Removed again in `finally`, whatever happens.
    const shadowRoot = mkdtempSync(join(dirname(vaultRoot), '.brain-kit-parity-'));
    try {
      mirrorWithHardLinks(vaultRoot, shadowRoot);
      writeFileSync(join(shadowRoot, 'brain-kit.config.json'), JSON.stringify(PARITY_CONFIG, null, 2));

      const originalRun = spawnSync(process.execPath, [originalScript, '.'], { cwd: vaultRoot, encoding: 'utf8' });
      assert.equal(originalRun.status === 0 || originalRun.status === 1, true, `original validator crashed: ${originalRun.stderr}`);
      const { fileCount: originalFileCount, byCategory: originalByCategory } = parseOriginalOutput(originalRun.stdout);
      assert.ok(originalFileCount > 0, 'expected the original validator to report a positive file count');

      const newRun = spawnSync(process.execPath, [BIN, 'validate', shadowRoot, '--json'], { encoding: 'utf8' });
      assert.equal(newRun.status === 0 || newRun.status === 1, true, `new validator crashed: ${newRun.stderr}`);
      const newReport = JSON.parse(newRun.stdout);

      const acceptedRules = loadAcceptedDivergences();

      console.log(`[parity] original: ${originalFileCount} files, exit ${originalRun.status}`);
      console.log(`[parity] new: ${newReport.findings.length} findings (must=${newReport.counts.must} should=${newReport.counts.should} house=${newReport.counts.house} warnings=${newReport.counts.warnings}), exit ${newRun.status}`);

      // Direction 1: every new finding is either accepted, or matched by
      // the original flagging the same file under a mapped category.
      const newOnlyDivergences = [];
      for (const finding of newReport.findings) {
        if (acceptedRules.some((rule) => ruleExcuses(rule, finding, extraIgnored))) continue;
        const field = finding.params?.key ?? finding.params?.field;
        const mapped = CATEGORY_MAP.filter((e) => e.ruler === finding.ruler && e.id === finding.id && (e.field === undefined || e.field === field));
        const flaggedHere = mapped.some((e) => (originalByCategory.get(e.original) ?? []).includes(finding.file));
        if (!flaggedHere) newOnlyDivergences.push(finding);
      }

      // Direction 2: every original-flagged (category, file) is matched
      // by some new finding of the mapped (ruler, id[, field]).
      const originalOnlyDivergences = [];
      for (const [category, files] of originalByCategory) {
        if (files.length === 0) continue;
        const mapped = CATEGORY_MAP.filter((e) => e.original === category);
        for (const file of files) {
          const matched = newReport.findings.some(
            (f) => mapped.some((e) => e.ruler === f.ruler && e.id === f.id && (e.field === undefined || e.field === (f.params?.key ?? f.params?.field))) && f.file === file,
          );
          if (!matched) originalOnlyDivergences.push({ category, file });
        }
      }

      assert.deepEqual(
        newOnlyDivergences,
        [],
        `${newOnlyDivergences.length} finding(s) from the new validator have no counterpart in the original and no accepted-divergence rule excuses them; each one is a defect in the new validator, not something to write up as acceptable`,
      );
      assert.deepEqual(
        originalOnlyDivergences,
        [],
        `${originalOnlyDivergences.length} original finding(s) have no counterpart in the new validator; the new validator is missing something the original caught`,
      );
    } finally {
      rmSync(shadowRoot, { recursive: true, force: true });
    }
  },
);
