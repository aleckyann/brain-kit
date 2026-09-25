// The throwaway world the opt-in briefing run (test/e2e-briefing.test.mjs)
// hands the real model, built without any model so it can be checked on its
// own: a vault made by `brain-kit init --yes` in `lang`, its zone fixed at
// UTC; the first table of `briefing.pending` seeded with one overdue item,
// one due today and one with no date; the log seeded with three recent
// days and, well below them, an old day holding a unique marker that no
// briefing reading the log as its never-read entry allows (headings and
// the most recent sections) can ever meet; the question queue seeded with
// one question asked on three earlier days, so it is escalated; everything
// committed and pushed to a bare remote; and a fake `gh` first on PATH that
// records every call. Nothing is removed afterwards.
//
// The caller's environment is kept (the real run needs the person's HOME
// for the login); BRAIN_KIT_STATE_DIR, the git configuration and PATH are
// pointed at the scratch directory.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { KIT_ROOT } from '../../src/version.mjs';
import { withoutLocalGitVars } from '../../src/git-env.mjs';
import { addDays, localDay } from '../../src/guards/watermark.mjs';
import { normalizeQuestion, queueFile, questionId } from '../../src/briefing/questions.mjs';

export const BIN = join(KIT_ROOT, 'bin', 'brain-kit.mjs');
export const TZ = 'UTC';

// What the vault holds and what the person says, in the vault's language.
export const WORLD = Object.freeze({
  en: {
    question: 'Should the reading group keep meeting on Thursdays?',
    overdue: 'Send Ana the reading list',
    dueToday: 'Book the room for the reading group',
    undated: 'Choose the next book',
    undatedCell: 'when the group decides',
    recent: ['Ana moved the reading group to the library.', 'Ana asked for a shorter reading list.', 'Ana finished the book on gardens.'],
    filler: 'Ana read two chapters of the current book.',
    old: 'Ana wrote down an old idea for the group, tagged',
    request: [
      'Good morning. Give me my morning briefing from this vault.',
      'I will not be here to answer while you give it, so here are my answers in advance.',
      'If you ask whether the reading group should keep meeting on Thursdays: yes, it stays on Thursdays, because the library room is free that evening.',
      'I have no answer to any other question today: leave it open for another day.',
      'When the briefing is done, record what my answer teaches the vault, as the briefing says.',
    ].join(' '),
  },
  'pt-BR': {
    question: 'O grupo de leitura deve continuar se reunindo às quintas?',
    overdue: 'Mandar para a Ana a lista de leituras',
    dueToday: 'Reservar a sala para o grupo de leitura',
    undated: 'Escolher o próximo livro',
    undatedCell: 'quando o grupo decidir',
    recent: ['A Ana levou o grupo de leitura para a biblioteca.', 'A Ana pediu uma lista de leituras mais curta.', 'A Ana terminou o livro sobre jardins.'],
    filler: 'A Ana leu dois capítulos do livro atual.',
    old: 'A Ana anotou uma ideia antiga para o grupo, marcada',
    request: [
      'Bom dia. Me dê o meu briefing matinal deste vault.',
      'Não vou estar aqui para responder enquanto você o apresenta, então seguem as minhas respostas adiantadas.',
      'Se você perguntar se o grupo de leitura deve continuar se reunindo às quintas: sim, continua às quintas, porque a sala da biblioteca fica livre nessa noite.',
      'Não tenho resposta para nenhuma outra pergunta hoje: deixe-as abertas para outro dia.',
      'Quando o briefing terminar, registre o que a minha resposta ensina ao vault, como o briefing manda.',
    ].join(' '),
  },
});

// How many dated sections sit between the recent days and the old one.
const FILLER_DAYS = 40;

// Records every call as one JSON line. `api` (the preflight's listing of
// the open pull requests) lists none; `pr create` succeeds and `pr view`
// answers only for a head a `pr create` named, as the real gh would.
function fakeGh(log) {
  return `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
fs.appendFileSync(log, JSON.stringify({ args }) + '\\n');
const url = 'https://example.invalid/ana/reading/pull/1';
if (args[0] === 'api') process.exit(0);
if (args[0] === 'pr' && args[1] === 'create') {
  process.stdout.write('Creating pull request\\n' + url + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const created = before.filter((e) => e.args[0] === 'pr' && e.args[1] === 'create' && e.args[e.args.indexOf('--head') + 1] === args[2]).at(-1);
  if (!created) { process.stderr.write('no pull requests found for branch "' + args[2] + '"\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ baseRefName: created.args[created.args.indexOf('--base') + 1], headRefName: args[2], url }) + '\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unexpected call\\n');
process.exit(2);
`;
}

export function run(program, args, { cwd, env, input } = {}) {
  return spawnSync(program, args, { cwd, env, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

function must(r, what) {
  if (r.status !== 0) throw new Error(`${what} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function dmy(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

export function buildBriefingWorld({ lang = 'en', baseEnv = process.env } = {}) {
  if (!Object.hasOwn(WORLD, lang)) throw new Error(`no briefing world for ${lang} (en or pt-BR)`);
  const world = WORLD[lang];
  const base = mkdtempSync(join(tmpdir(), 'brain-kit-e2e-briefing-'));
  const vault = join(base, 'vault');
  const remote = join(base, 'remote.git');
  const state = join(base, 'state');
  const fakebin = join(base, 'fakebin');
  const ghLog = join(base, 'gh-calls.jsonl');
  const gitconfig = join(base, 'gitconfig');
  mkdirSync(fakebin);
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(fakebin, 'gh'), fakeGh(ghLog));
  chmodSync(join(fakebin, 'gh'), 0o755);
  // The vault's push gate runs `brain-kit` from PATH: this checkout's own.
  symlinkSync(BIN, join(fakebin, 'brain-kit'));
  writeFileSync(gitconfig, '[user]\n\tname = Ana\n\temail = ana@example.invalid\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
  const env = {
    ...withoutLocalGitVars(baseEnv),
    PATH: `${fakebin}${delimiter}${baseEnv.PATH ?? ''}`,
    BRAIN_KIT_STATE_DIR: state,
    BRAIN_KIT_LANG: lang,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const kit = (args) => run(process.execPath, [BIN, ...args], { cwd: base, env });
  const git = (cwd, args) => must(run('git', args, { cwd, env }), `git ${args.join(' ')}`);

  must(kit(['init', vault, '--yes', '--lang', lang]), 'brain-kit init --yes');
  const configFile = join(vault, 'brain-kit.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.vault.timezone = TZ;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const today = localDay(new Date(), TZ);

  // The pending table, under the open heading of the first table
  // briefing.pending reads, each cell placed by its column's name.
  const pending = config.briefing.pending[0];
  const tablePath = config.taxonomy.files[pending.file];
  const heading = config.taxonomy.columns[pending.file].labels[pending.heading];
  const header = config.taxonomy.columns[pending.file].columns;
  const dateAt = header.indexOf(pending.date_column);
  const whatAt = header.indexOf(pending.what_column);
  if (dateAt === -1 || whatAt === -1) throw new Error(`the pack's ${pending.file} columns lack ${pending.date_column} or ${pending.what_column}`);
  const row = (what, deadline) => `| ${header.map((_, i) => (i === whatAt ? what : i === dateAt ? deadline : i === 0 ? dmy(addDays(today, -10)) : '-')).join(' | ')} |`;
  const tableFile = join(vault, tablePath);
  const lines = readFileSync(tableFile, 'utf8').split('\n');
  const headingAt = lines.findIndex((line) => line.trim() === heading.trim());
  const separatorAt = lines.findIndex((line, i) => i > headingAt && /^\|(?:\s*-+\s*\|)+$/.test(line.trim()));
  if (headingAt === -1 || separatorAt === -1) throw new Error(`${tablePath} has no table under ${heading}`);
  lines.splice(separatorAt + 1, 0, row(world.overdue, dmy(addDays(today, -3))), row(world.dueToday, dmy(today)), row(world.undated, world.undatedCell));
  writeFileSync(tableFile, lines.join('\n'));

  // The log: three recent days, then FILLER_DAYS more, then the old day with
  // the marker, newest first, one capture each.
  const marker = `MARKER-${randomBytes(6).toString('hex')}`;
  const captureWord = config.taxonomy.log_markers.capture;
  const logFile = join(vault, config.taxonomy.log);
  const sections = [];
  world.recent.forEach((text, i) => sections.push(`## ${addDays(today, -(i + 1))}\n\n**${captureWord}** ${text}\n`));
  for (let i = 0; i < FILLER_DAYS; i += 1) sections.push(`## ${addDays(today, -(world.recent.length + 1 + i))}\n\n**${captureWord}** ${world.filler}\n`);
  sections.push(`## ${addDays(today, -(world.recent.length + 1 + FILLER_DAYS))}\n\n**${captureWord}** ${world.old} ${marker}.\n`);
  writeFileSync(logFile, `${readFileSync(logFile, 'utf8').replace(/\n*$/, '\n\n')}${sections.join('\n')}`);

  // The queue: one open question, asked on three earlier days (the pack's
  // question_escalate_after is 3), created well inside question_max_age_days.
  const queue = queueFile(state, { env });
  const normalized = normalizeQuestion(world.question);
  const seededId = questionId(normalized);
  writeFileSync(queue, `${JSON.stringify({
    id: seededId, text: world.question, normalized, createdOn: addDays(today, -6),
    askedOn: [addDays(today, -5), addDays(today, -4), addDays(today, -3)],
    status: 'open', answeredOn: null, archivedOn: null, archivedReason: null,
  })}\n`, { mode: 0o600 });

  // Committed, on a bare remote.
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(vault, ['add', '-A']);
  git(vault, ['commit', '-q', '-m', 'A new vault']);
  git(vault, ['remote', 'add', 'origin', remote]);
  git(vault, ['push', '-q', '-u', 'origin', 'main']);
  git(vault, ['remote', 'set-head', 'origin', '--auto']);

  return { base, vault, remote, state, ghLog, env, config, world, today, seededId, normalized, queue, marker, kit };
}
