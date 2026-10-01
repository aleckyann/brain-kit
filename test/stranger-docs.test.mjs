// What a stranger who follows only the README needs, pinned (phase 6, task
// F1). A person in a clean room installed the kit from the README alone and
// found that no document showed the path from `init` to the first pull
// request. The tests below keep the repair from rotting:
//
//   - both READMEs open with what the kit is, list the requirements before the
//     install, and carry the "Your first vault" sequence with the same
//     commands in both languages;
//   - the `setup` and `curate-session` skill bodies say the things the
//     stranger tripped on (a repository created without `--push` is empty; a
//     `sync` that refuses because of the session's own uncommitted files is
//     not a reason to stop);
//   - the plugin manifest declares no option nothing reads;
//   - no file the package ships cites a `docs/` file the package does not
//     ship (the npm README pointed at four of them, and the doctor's own
//     messages at one more).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const read = (path) => readFileSync(join(KIT_ROOT, path), 'utf8');
const pkg = JSON.parse(read('package.json'));

// ------------------------------------------------------------------ READMEs

const E_ACUTE = String.fromCharCode(0xe9);
const READMES = {
  en: {
    file: 'README.md',
    requirements: '## Requirements',
    install: '## Installing a fixed version',
    first: '## Your first vault',
    works: '## What works today',
    status: '## Status',
    history: /\bphase\b|under construction/i,
    logPath: 'memory/log.md',
  },
  'pt-BR': {
    file: 'README.pt-BR.md',
    requirements: '## Requisitos',
    install: '## Instalando uma versão fixa',
    first: '## Seu primeiro vault',
    works: '## O que funciona hoje',
    status: '## Status',
    history: /\bfase\b|em construção/i,
    logPath: 'memoria/log.md',
  },
};

// What each README says in the first-run path added for a person who is not a developer
// (0.0.9, task G1). The commands are the same in both languages; the words are not.
const FIRST_RUN = {
  en: {
    box: '> **Start here.**',
    whole: /about (\d+) minutes the first time/,
    estimates: 'estimates',
    promise: /not a promise/,
    stepsWord: 'for the steps below',
    reading: /about (\d+) of reading/,
    ready: /account ready/,
    glossary: '**Words you will see**',
    terms: ['terminal', 'PATH', 'repository', 'branch', 'commit', 'pull request', 'merge', 'vault', 'push gate', 'hook', 'skill', 'plugin', 'marketplace'],
    needs: [/Node\.js 22 or newer \(24 LTS is recommended\)/, /\bgit\b/, /`gh`/, /Claude Code/, /GitHub account/],
    node: { requirements: /Node\.js 22 or newer \(24 LTS is recommended\)/, engine: /runs on Node\.js 22 and 24/, tested: /both are tested/ },
    optional: /optional/,
    curator: '## The scheduled curator',
    curatorAnchor: '(#the-scheduled-curator)',
    calendar: '## Calendar and meeting notes',
    briefing: '## The morning briefing',
    connectorsEnabled: /enabled for Claude Code/,
    desktop: /needs the Claude desktop application/,
    eacces: '### If you see `EACCES`',
    nvm: /nvm/,
    sudo: /`sudo`/,
    pathGloss: 'the list of folders where the terminal looks for the commands you type',
    reopen: /Close the terminal and open a new one/,
    again: 'paste the install snippet again',
    cloneFolder: 'The `brain-kit` folder that the first line cloned',
    deletable: /is no longer used and can be deleted/,
    keep: /\*\*must not be deleted\*\*/,
    upgradeFolder: /delete the `brain-kit` folder that the first line cloned, if it is still there \(otherwise the snippet reuses that old copy and installs the old version\)/,
    upgradeOld: /The folders of older versions under `~\/\.local\/share\/brain-kit\/` are no longer used and can be deleted; the newest must stay/,
    identityError: 'Author identity unknown',
    identity: ['git config --global user.name "Your Name"', 'git config --global user.email "you@example.com"'],
    identityWhy: /git records who made each commit/,
    machineCheck: /checks only the machine: Node, git, `gh` and its login, and Claude Code\. All is well when the line that starts with `doctor:` ends with `0 fail`/,
    noVaultMessage: /The message "no brain-kit vault found", which comes right after it, is expected/,
    healthy: /its last line ends with `0 fail`/,
    handle: /At the "Short id" question \(the one that signs your approvals\)/,
    accept: /accept the suggestion/,
    doctorWords: { used: ['`fail`', '`warn`'], unused: ['`falha`', '`aviso`'] },
    compact: /only the warnings and the failures, with a count of the `ok` lines/,
    second: '## The same vault on a second machine',
    repo: '## What is in the repository',
    oneMachine: /Let only one machine run the curator's rounds/,
    newVault: /A vault created by this version of `init` needs no edit on the second machine/,
    oldVault: /A vault created before 0\.0\.9 lists its project by the name it had on the first machine/,
    noName: 'Do not put this machine\'s project name in `brain-kit.config.json` to silence the `doctor`',
    switchTo: /replace the name in `sources\.transcripts\.include_projects` with `"\{vault\}"`/,
    switchPropose: '`brain-kit propose "Use {vault}" --only brain-kit.config.json`',
    switchDoc: 'docs/scheduling.md#before-the-first-round',
    toolSame: /prints the same three steps after it finishes, in the same order/,
    switchFirst: /First install this version of the kit on every machine that opens the vault: /,
    switchOnce: /run `brain-kit update` in the vault once, on the machine where you will edit the file; the other machines only install the kit, and receive the change with `brain-kit sync` after the merge/,
    switchEveryMachine: /on every machine that opens the vault and run `brain-kit update`/,
    switchOlder: /a kit older than 0\.0\.9 reads `"\{vault\}"` as the name of a project, and fails the same check/,
    switchFiles: /after `--only`, add any other file that `update` said it changed/,
    switchUncommitted: /Do not commit that file yourself before the pull request is merged/,
    stuck: '**If you get stuck**',
    traps: [/EACCES/, /`gh auth login`/, /`propose`.*commit.*`git push -u origin HEAD`/, /command not found.*Successfully installed.*whole .*EACCES/, /`doctor`.*fail.*gh auth login --hostname github\.com/, /incident-response\.md/],
    notTrap: [null, null, /configuration/, /redo the PATH/, null, null],
    secrets: /password|key/i,
    stamp: 'nothing to stamp, and nothing was written',
  },
  'pt-BR': {
    box: '> **Comece aqui.**',
    whole: /cerca de (\d+) minutos na primeira vez/,
    estimates: 'estimativas',
    promise: /não uma promessa/,
    stepsWord: 'nos passos abaixo',
    reading: /uns (\d+) de leitura/,
    ready: /já prontos/,
    glossary: '**Palavras que você vai ver**',
    terms: ['terminal', 'PATH', 'repositório', 'branch', 'commit', 'pull request', 'merge', 'vault', 'trava de push', 'hook', 'skill', 'plugin', 'marketplace'],
    needs: [/Node\.js 22 ou mais novo \(o 24 LTS é o recomendado\)/, /\bgit\b/, /`gh`/, /Claude Code/, /conta no GitHub/],
    node: { requirements: /Node\.js 22 ou mais novo \(o 24 LTS é o recomendado\)/, engine: /roda no Node\.js 22 e no 24/, tested: /os dois são testados/ },
    optional: /opcionais/,
    curator: '## O curador agendado',
    curatorAnchor: '(#o-curador-agendado)',
    calendar: '## Agenda e notas de reunião',
    briefing: '## O briefing matinal',
    connectorsEnabled: /ativados para o Claude Code/,
    desktop: /exige o aplicativo Claude para desktop/,
    eacces: '### Se aparecer `EACCES`',
    nvm: /nvm/,
    sudo: /`sudo`/,
    pathGloss: 'a lista de pastas onde o terminal procura os comandos que você digita',
    reopen: /Feche o terminal e abra outro/,
    again: 'cole o trecho de instalação de novo',
    cloneFolder: 'A pasta `brain-kit` que a primeira linha baixou',
    deletable: /não é mais usada e pode ser apagada/,
    keep: /\*\*não pode ser apagada\*\*/,
    upgradeFolder: /apague a pasta `brain-kit` que a primeira linha baixou, se ela ainda existir \(senão o trecho reaproveita essa cópia velha e instala a versão velha\)/,
    upgradeOld: /As pastas das versões antigas em `~\/\.local\/share\/brain-kit\/` não são mais usadas e podem ser apagadas; a mais nova não/,
    identityError: 'Author identity unknown',
    identity: ['git config --global user.name "Seu Nome"', 'git config --global user.email "voce@example.com"'],
    identityWhy: /O git guarda quem fez cada commit/,
    machineCheck: /confere só a máquina: o Node, o git, o `gh` e o login dele, e o Claude Code\. Está tudo certo quando a linha que começa com `doctor:` termina em `0 falha\(s\)`/,
    noVaultMessage: /A mensagem "nenhum vault brain-kit encontrado", que vem logo depois, é esperada/,
    healthy: /a última linha termina em `0 falha\(s\)`/,
    handle: /Na pergunta "Apelido curto" \(o nome curto que assina as suas aprovações\)/,
    accept: /aceite a sugestão/,
    doctorWords: { used: ['`falha`', '`aviso`'], unused: ['`fail`', '`warn`'] },
    compact: /só os avisos e as falhas, com a contagem das linhas `ok`/,
    second: '## O mesmo vault em uma segunda máquina',
    repo: '## O que há no repositório',
    oneMachine: /Deixe só uma máquina rodar as rodadas do curador/,
    newVault: /Um vault criado por esta versão do `init` não precisa de edição nenhuma na segunda máquina/,
    oldVault: /Um vault criado antes da 0\.0\.9 lista o projeto pelo nome que ele tinha na primeira máquina/,
    noName: 'Não ponha no `brain-kit.config.json` o nome do projeto desta máquina para fazer o `doctor` calar',
    switchTo: /troque o nome que está em `sources\.transcripts\.include_projects` por `"\{vault\}"`/,
    switchPropose: '`brain-kit propose "Usa {vault}" --only brain-kit.config.json`',
    switchDoc: 'docs/scheduling.md#before-the-first-round',
    toolSame: /imprime os mesmos três passos quando termina, na mesma ordem/,
    switchFirst: /Primeiro, instale esta versão do kit em todas as máquinas que abrem o vault: /,
    switchOnce: /rode `brain-kit update` dentro do vault uma vez, na máquina em que você vai editar o arquivo; nas outras máquinas, só instale o kit, e elas recebem a mudança com `brain-kit sync` depois do merge/,
    switchEveryMachine: /em todas as máquinas que abrem o vault e rode `brain-kit update`/,
    switchOlder: /um kit mais velho que a 0\.0\.9 lê `"\{vault\}"` como o nome de um projeto e falha na mesma checagem/,
    switchFiles: /depois de `--only`, ponha também qualquer outro arquivo que o `update` disse ter mudado/,
    switchUncommitted: /Não faça você mesmo o commit desse arquivo antes do merge do pull request/,
    stuck: '**Se travar**',
    traps: [/EACCES/, /`gh auth login`/, /`propose`.*commit.*`git push -u origin HEAD`/, /command not found.*Successfully installed.*bloco .*EACCES.* inteiro/, /`doctor`.*falha.*gh auth login --hostname github\.com/, /incident-response\.md/],
    notTrap: [null, null, /configura/, /refaça o PATH/, null, null],
    secrets: /senha|chave/i,
    stamp: 'nada a carimbar, e nada foi escrito',
  },
};

// Lines of a markdown text with a flag for the ones inside a fenced block.
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

// The text under a level-two heading, up to the next level-two heading.
function section(text, heading) {
  const lines = scan(text);
  const start = lines.findIndex((entry) => !entry.fenced && entry.line === heading);
  assert.notEqual(start, -1, `no "${heading}" heading`);
  const body = [];
  for (const entry of lines.slice(start + 1)) {
    if (!entry.fenced && /^## /.test(entry.line)) break;
    body.push(entry.line);
  }
  return body.join('\n');
}

// The code blocks of a text, each with the indentation of its fence removed
// (a block inside a numbered list item is indented).
function fencedBlocks(text) {
  const blocks = [];
  let current = null;
  let indent = '';
  for (const { line, fenced } of scan(text)) {
    if (fenced && /^\s*(```|~~~)/.test(line)) {
      if (current === null) {
        current = [];
        indent = /^\s*/.exec(line)[0];
      } else {
        blocks.push(current.join('\n'));
        current = null;
      }
    } else if (current !== null) current.push(line.startsWith(indent) ? line.slice(indent.length) : line);
  }
  return blocks;
}

function headingLevels(text) {
  return scan(text).filter((entry) => !entry.fenced && /^#{1,6} /.test(entry.line)).map((entry) => /^#+/.exec(entry.line)[0].length);
}

for (const [lang, spec] of Object.entries(READMES)) {
  const text = read(spec.file);

  test(`${spec.file}: requirements come before the install, and the first vault right after it`, () => {
    const at = (heading) => text.split('\n').indexOf(heading);
    for (const heading of [spec.requirements, spec.install, spec.first, spec.works, spec.status]) assert.notEqual(at(heading), -1, `${heading} is missing`);
    assert.ok(at(spec.requirements) < at(spec.install), 'requirements must precede the install');
    assert.ok(at(spec.install) < at(spec.first), 'the first vault follows the install');
    assert.ok(at(spec.first) < at(spec.works), 'the first vault comes before the command reference');
    assert.ok(at(spec.first) < at(spec.status));
  });

  test(`${spec.file}: opens with what the kit is, and the phase history lives in the Status section`, () => {
    const opening = text.slice(0, text.indexOf('\n## '));
    assert.doesNotMatch(opening, spec.history, 'the opening must not start with the phase history');
    assert.match(opening, /OKF|Open Knowledge Format/);
    assert.match(opening, /pull request/);
    const status = section(text, spec.status);
    // Every fact the old preamble carried is still said somewhere in Status.
    for (const fact of ['flock', 'watermark import', '01/10/2026', '0.1.0']) assert.ok(status.includes(fact), `Status lost: ${fact}`);
    assert.match(status, spec.history);
  });

  test(`${spec.file}: the requirements name Node 22 or newer (24 recommended), git, a logged-in gh and Claude Code`, () => {
    const requirements = section(text, spec.requirements);
    assert.match(norm(requirements), FIRST_RUN[lang].node.requirements);
    assert.match(requirements, /\bgit\b/);
    assert.ok(requirements.includes('`gh`') && requirements.includes('gh auth login'), 'gh and how to log in');
    assert.ok(requirements.includes('Claude Code'));
    assert.doesNotMatch(requirements, /\(target\)/);
  });

  test(`${spec.file}: the install says what a non-writable npm prefix needs and packs quietly`, () => {
    const install = section(text, spec.install);
    assert.ok(install.includes('EACCES'));
    assert.ok(install.includes('npm config set prefix ~/.local'));
    assert.ok(install.includes('~/.local/bin'));
    assert.ok(fencedBlocks(install).some((block) => block.includes('npm pack --silent && npm i -g ')), 'the snippet packs with --silent');
  });

  test(`${spec.file}: the first vault is a numbered sequence from gh login to the merged pull request`, () => {
    const first = section(text, spec.first);
    const steps = first.split('\n').filter((line) => /^\d+\. /.test(line));
    assert.ok(steps.length >= 10, `only ${steps.length} numbered steps`);
    const commands = fencedBlocks(first).join('\n');
    for (const command of [
      'gh auth login',
      'brain-kit init ~/my-brain',
      'cd ~/my-brain',
      'git add -A',
      'git commit',
      'gh repo create my-brain --private --source . --push',
      'brain-kit doctor',
      'brain-kit propose "',
      '--only ' + spec.logPath,
    ]) {
      assert.ok(commands.includes(command), `no command block holds: ${command}`);
    }
    for (const word of ['--from-answers', '--yes', 'private', spec.logPath, 'Stop']) {
      assert.ok(first.includes(word), `the first vault does not mention: ${word}`);
    }
    // The order of the commands is the order of the sequence. The doctor is run twice:
    // once before any vault exists (it checks the machine, after the login it checks) and
    // once in the vault, after the push.
    const all = `\n${commands}\n`;
    const machineCheck = all.indexOf('brain-kit doctor');
    const vaultCheck = all.indexOf('brain-kit doctor', machineCheck + 1);
    const order = [all.indexOf('gh auth login'), machineCheck, all.indexOf('brain-kit init'), all.indexOf('git commit'), all.indexOf('gh repo create'), vaultCheck, all.indexOf('\nclaude\n'), all.indexOf('brain-kit propose')];
    assert.ok(order.every((index) => index !== -1), `a command is missing: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'the commands are out of order');
  });

  test(`${spec.file}: the commands after the install use brain-kit, with one way to run from a clone`, () => {
    const works = section(text, spec.works);
    assert.ok(works.includes('node <clone>/bin/brain-kit.mjs'), 'say how to run from a clone without installing');
    for (const block of fencedBlocks(works)) assert.doesNotMatch(block, /node brain-kit\/bin\/brain-kit\.mjs/);
    assert.ok(fencedBlocks(works).join('\n').includes('brain-kit init '));
  });

  test(`${spec.file}: step 9 names the log marker of each language, the way the packs define them`, () => {
    const marker = (code) => JSON.parse(read(`lang/${code}/config.defaults.json`)).taxonomy.log_markers.capture;
    assert.deepEqual([marker('en'), marker('pt-BR')], ['Capture', 'Captura']);
    const step = section(text, spec.first).split(/\n(?=\d+\. )/).find((item) => item.startsWith('9. '));
    assert.ok(step, 'step 9');
    assert.ok(step.includes('`**Capture**`') && step.includes('`**Captura**`'), 'both markers');
    assert.ok(step.includes('`memory/log.md`') && step.includes('`memoria/log.md`'), 'both log paths');
  });

  test(`${spec.file}: the file stays uncommitted until the merge, and the first verify says nothing to stamp`, () => {
    const steps = section(text, spec.first).split(/\n(?=\d+\. )/);
    const propose = steps.find((item) => item.startsWith('10. '));
    const merge = steps.find((item) => item.startsWith('11. '));
    assert.ok(propose && merge, 'steps 10 and 11');
    const words = lang === 'en'
      ? { uncommitted: 'Leave the changed file uncommitted until the pull request is merged (step 11)', diverged: 'diverged', stamp: FIRST_RUN[lang].stamp }
      : { uncommitted: 'Deixe o arquivo alterado sem commit até o pull request ser mergeado (passo 11)', diverged: 'divergiram', stamp: FIRST_RUN[lang].stamp };
    assert.ok(propose.replace(/\s+/g, ' ').includes(words.uncommitted), 'step 10 says to leave the file uncommitted');
    assert.ok(propose.includes(words.diverged), 'step 10 says why');
    assert.ok(merge.replace(/\s+/g, ' ').includes(words.stamp), 'step 11 says what verify prints when it has nothing to stamp');
    assert.doesNotMatch(merge, /exits? 0|sai com 0/, 'an exit code is not on the screen');
  });

  test(`${spec.file}: says how the language is chosen`, () => {
    assert.ok(text.includes('BRAIN_KIT_LANG'));
    assert.ok(text.includes('init --lang'));
    for (const variable of ['LC_ALL', 'LC_MESSAGES', 'LANG']) assert.ok(text.includes(variable), variable);
  });
}

test('the two READMEs have the same structure and the same first-vault commands', () => {
  const en = read(READMES.en.file);
  const pt = read(READMES['pt-BR'].file);
  assert.deepEqual(headingLevels(pt), headingLevels(en), 'same headings, level by level');
  assert.equal(fencedBlocks(pt).length, fencedBlocks(en).length, 'same number of code blocks');
  // Only the words a Portuguese reader reads differ: the vault's log path, the two
  // messages the example commands carry and the two placeholders of the git identity.
  const sameCommands = (block) => block
    .replace('memoria/log.md', 'memory/log.md')
    .replace('Inicia o vault', 'Start the vault')
    .replace('Primeira captura', 'First capture')
    .replace('"Seu Nome"', '"Your Name"')
    .replace('voce@example.com', 'you@example.com');
  assert.deepEqual(fencedBlocks(section(pt, READMES['pt-BR'].first)).map(sameCommands), fencedBlocks(section(en, READMES.en.first)));
  assert.deepEqual(fencedBlocks(section(pt, READMES['pt-BR'].install)), fencedBlocks(section(en, READMES.en.install)));
  assert.deepEqual(fencedBlocks(section(pt, FIRST_RUN['pt-BR'].second)), fencedBlocks(section(en, FIRST_RUN.en.second)));
  const steps = (text, heading) => section(text, heading).split('\n').filter((line) => /^\d+\. /.test(line)).length;
  assert.equal(steps(pt, READMES['pt-BR'].first), steps(en, READMES.en.first));
});

test('the release gate is untouched: one stamp, the latest-tag sentence, and no literal tag in a code block', () => {
  for (const [lang, spec] of Object.entries(READMES)) {
    const text = read(spec.file);
    assert.equal(text.split('<!-- status-reviewed: ').length - 1, 1, `${spec.file}: exactly one stamp`);
    const status = section(text, spec.status);
    assert.ok(status.startsWith(`\n<!-- status-reviewed: ${pkg.version} -->\n`), `${spec.file}: the stamp is right under the Status heading`);
    const sentence = lang === 'en' ? `The latest tag is \`v${pkg.version}\`.` : `A tag mais recente ${E_ACUTE} a \`v${pkg.version}\`.`;
    assert.ok(status.replace(/\s+/g, ' ').includes(sentence), `${spec.file}: the latest-tag sentence`);
    for (const block of fencedBlocks(text)) assert.doesNotMatch(block, /v\d+\.\d+\.\d+|second-brain-kit-\d+\.\d+\.\d+\.tgz/);
  }
});

// ---------------------------------------------- the first-run path (0.0.9, task G1)
//
// The second stranger followed only the Portuguese README and reached the first pull
// request, but a person who is not a developer would need 30 to 40 minutes: ten to
// fifteen reading a dense page, ten to thirty more for the npm permission error
// (`EACCES`), and minutes on the git identity, the doctor's words and the second machine.
// The tests below pin the repair in both languages. They check the text; the commands the
// text gives were run by hand against the integrated CLI (the task report lists them).

const norm = (value) => value.replace(/\s+/g, ' ');

// GitHub's anchor for a heading: lower case, backticks and punctuation dropped, spaces to hyphens.
const slug = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');

// Every anchor a link can land on: the headings, and the `<a id="...">` anchors in the text.
function anchors(text) {
  const found = new Set();
  for (const { line, fenced } of scan(text)) {
    if (fenced) continue;
    const heading = /^#{1,6} (.+?)\s*$/.exec(line);
    if (heading) found.add(slug(heading[1]));
    for (const match of line.matchAll(/<a (?:id|name)="([^"]+)"><\/a>/g)) found.add(match[1]);
  }
  return found;
}

// The in-page links of a text, outside code blocks.
function pageLinks(text) {
  const found = [];
  for (const { line, fenced } of scan(text)) {
    if (!fenced) for (const match of line.matchAll(/\]\(#([^)\s]+)\)/g)) found.push(match[1]);
  }
  return found;
}

// The blockquote that opens with `box`: its lines, and what comes before and after it.
function startBox(text, box) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(box));
  assert.notEqual(start, -1, `no box opens with ${box}`);
  let end = start;
  while (end < lines.length && lines[end].startsWith('>')) end += 1;
  return { lines: lines.slice(start, end), before: lines.slice(0, start), after: lines.slice(end) };
}

// The prose of a text: everything outside the code blocks.
const prose = (text) => scan(text).filter((entry) => !entry.fenced).map((entry) => entry.line).join('\n');

// The numbered items of a section, each as its own text.
const items = (text) => text.split(/\n(?=\d+\. )/).filter((item) => /^\d+\. /.test(item));

// The install snippet, line by line: the tarball it packs is removed with the same $TAG
// variable (the release gate allows no literal version in a code block), after the
// install and before the plugin copies the folder into its cache.
const SNIPPET = [
  'git clone https://github.com/aleckyann/brain-kit.git',
  'TAG=$(git -C brain-kit describe --tags --abbrev=0)',
  'mkdir -p ~/.local/share/brain-kit/$TAG',
  'git -C brain-kit archive $TAG | tar -x -C ~/.local/share/brain-kit/$TAG',
  'cd ~/.local/share/brain-kit/$TAG && npm pack --silent && npm i -g ./second-brain-kit-${TAG#v}.tgz',
  'rm -f ~/.local/share/brain-kit/$TAG/second-brain-kit-${TAG#v}.tgz',
  'claude plugin marketplace add ~/.local/share/brain-kit/$TAG',
  'claude plugin install brain-kit@brain-kit --scope user',
];

// What `EACCES` needs, as the code blocks of its block.
const EACCES_BLOCKS = [
  'npm config set prefix ~/.local',
  'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc\necho \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zshrc',
  'brain-kit --version',
];

// The second machine, in the order docs/scheduling.md gives (clone, register, push gate, doctor, schedule).
const SECOND_MACHINE = ['gh repo clone my-brain ~/my-brain', 'cd ~/my-brain', 'brain-kit machine register --new', 'git config core.hooksPath .githooks', 'brain-kit doctor', 'brain-kit schedule install'];

for (const [lang, spec] of Object.entries(READMES)) {
  const text = read(spec.file);
  const run = FIRST_RUN[lang];
  const firstLink = lang === 'en' ? '(#your-first-vault)' : '(#seu-primeiro-vault)';
  const installLink = lang === 'en' ? '(#installing-a-fixed-version)' : '(#instalando-uma-versão-fixa)';

  test(`${spec.file}: a "start here" box follows the two-sentence description: at most 12 lines, seven steps with their minutes, honest about the time`, () => {
    const { lines, before } = startBox(text, run.box);
    assert.equal(before[0], '# brain-kit');
    assert.ok(!before.some((line) => /^## /.test(line)), 'the box comes before any section');
    const description = before.slice(1).join('\n').trim();
    assert.ok(!description.includes('\n\n'), 'the description is one paragraph');
    assert.equal(norm(description).split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú])/).length, 2, 'the description has two sentences');
    assert.ok(lines.length <= 12, `the box has ${lines.length} lines`);
    const body = lines.map((line) => line.replace(/^>\s?/, ''));
    const flat = norm(body.join(' '));
    const whole = Number(run.whole.exec(flat)?.[1]);
    assert.ok(whole > 0, 'it says how long the whole path takes');
    assert.ok(flat.includes(run.estimates), 'and that the times are estimates');
    assert.match(flat, run.promise);
    assert.match(flat, run.ready, 'the minutes assume the programs are already there');
    assert.doesNotMatch(flat, /clean machine|máquina limpa/, 'a clean machine would have to install them first');
    for (const need of run.needs) assert.match(flat, need);
    const steps = body.filter((line) => /^\d+\. /.test(line));
    assert.equal(steps.length, 7);
    const minutes = steps.map((step) => Number(/\b(\d+) min\b/.exec(step)?.[1]));
    assert.deepEqual(minutes, [2, 3, 1, 3, 3, 1, 8]);
    // The whole is arithmetic and never less than its parts: the reading and the timed steps add up
    // to at most the "about N" the box prints, which adds only a few minutes for the step it does
    // not time (approving the request on GitHub). The second walkthrough estimated 30 to 40 for a
    // person who is not a developer, so a number under 30 or over 40 is not what that supports.
    const reading = Number(run.reading.exec(flat)?.[1]);
    const total = minutes.reduce((sum, value) => sum + value, 0);
    assert.ok(reading >= 10, `the box counts ${reading} minutes of reading`);
    assert.ok(reading + total <= whole, `${reading} of reading and ${total} of steps are more than the ${whole} the box promises`);
    assert.ok(whole - (reading + total) <= 5, `the box adds ${whole - (reading + total)} minutes to ${reading} of reading and ${total} of steps`);
    assert.ok(whole >= 30 && whole <= 40, `${whole} minutes is outside the 30 to 40 the walkthrough estimated`);
    assert.ok(flat.includes(`${total} ${run.stepsWord}`), 'and it says what the steps come to');
    const named = ['gh auth login', 'brain-kit doctor', 'brain-kit init ~/my-brain', 'git add -A', 'gh repo create my-brain --private --source . --push', 'brain-kit propose'];
    named.forEach((command, index) => assert.ok(steps[index + 1].includes(command), `step ${index + 2} names ${command}`));
    assert.ok(steps[4].includes('git commit'));
    assert.match(steps[2], lang === 'en' ? /outside any vault/ : /fora de qualquer vault/);
    assert.ok(steps[0].includes(installLink), 'step 1 links the install snippet');
    assert.ok(flat.includes(firstLink), 'the box links the first-vault section');
    steps.forEach((step, index) => assert.match(step, /\]\(#[^)\s]+\)/, `step ${index + 1} links to its detail`));
  });

  test(`${spec.file}: the box and the first vault say what the screen shows, never an exit code`, () => {
    const { lines } = startBox(text, run.box);
    const firstRun = `${lines.join('\n')}\n${section(text, spec.first)}`;
    assert.doesNotMatch(firstRun, /\bexits? (with )?0\b|\bexit code\b|sai com 0|código de saída/i);
  });

  test(`${spec.file}: every link inside the page lands on a heading or an anchor that exists`, () => {
    const known = anchors(text);
    const links = pageLinks(text);
    assert.ok(links.length >= 15, `only ${links.length} in-page links`);
    assert.deepEqual([...new Set(links)].filter((id) => !known.has(id)), []);
  });

  test(`${spec.file}: a glossary of 10 to 12 words sits right after the box`, () => {
    const { after } = startBox(text, run.box);
    assert.ok(after.join('\n').trimStart().startsWith(run.glossary), 'the glossary follows the box');
    const start = after.indexOf(run.glossary);
    const table = [];
    for (const line of after.slice(start + 1)) {
      if (line.startsWith('|')) table.push(line);
      else if (table.length > 0) break;
    }
    const entries = table.slice(2);
    assert.ok(entries.length >= 10 && entries.length <= 12, `${entries.length} entries`);
    const words = entries.map((row) => row.split('|')[1].trim()).join(' ').toLowerCase();
    for (const term of run.terms) assert.ok(words.includes(term.toLowerCase()), `the glossary lacks: ${term}`);
  });

  test(`${spec.file}: the requirements are what the first pull request needs, and nothing true is cut: the rest moved to where it is introduced`, () => {
    const requirements = section(text, spec.requirements);
    for (const word of [/systemd/i, /linger/i, /launchd/i, /\bcron\b/i, /Windows/, /Google/, /desktop/i]) assert.doesNotMatch(requirements, word);
    assert.match(requirements, run.optional);
    assert.ok(requirements.includes('docs/scheduling.md'));
    assert.ok(requirements.includes(run.curatorAnchor), 'and it points at the section that introduces the rounds');
    assert.match(requirements, /node --version/);
    const curator = section(text, run.curator);
    for (const word of ['loginctl enable-linger', 'launchd', 'cron', 'Windows']) assert.ok(curator.includes(word), `the scheduled-curator section lost: ${word}`);
    const calendar = section(text, run.calendar);
    assert.ok(calendar.includes('Google Calendar') && calendar.includes('Google Drive'));
    assert.match(norm(calendar), run.connectorsEnabled);
    assert.match(norm(section(text, run.briefing)), run.desktop);
  });

  // The minimum is 22 and the recommended Node is 24 (0.0.9, task G4). The engine line is the
  // one that used to say "The engine is Node.js 24": it now says both Nodes run it, and that
  // both are tested (CI runs the suite on each). test/node-minimum.test.mjs holds the number.
  test(`${spec.file}: the repository section says which Nodes the engine runs on and that both are tested, and no sentence still makes Node 24 the minimum`, () => {
    const repo = norm(section(text, run.repo));
    assert.match(repo, run.node.engine);
    assert.match(repo, run.node.tested);
    assert.doesNotMatch(norm(text), /Node\.js 24 (or newer|ou mais novo)|The engine is Node\.js 24|O motor é Node\.js 24/);
    // The recommendation says "LTS" and nothing about which release line is the LTS today: that
    // goes stale the day the next line becomes one.
    assert.doesNotMatch(norm(text), /\bcurrent LTS\b|\bLTS atual\b|\bLTS mais recente\b|\blatest LTS\b/i);
  });

  test(`${spec.file}: the install snippet removes the tarball it made, and says which folder can go and which must stay`, () => {
    const install = section(text, spec.install);
    assert.equal(fencedBlocks(install)[0], SNIPPET.join('\n'));
    const words = norm(prose(install));
    assert.ok(words.includes(run.cloneFolder), 'it says the cloned folder is no longer used');
    assert.match(words, run.deletable);
    assert.ok(words.includes('`~/.local/share/brain-kit/`'));
    assert.match(words, run.keep);
  });

  test(`${spec.file}: moving to a newer version says to drop the old clone, paste again, record the version in Claude Code and which folders can go`, () => {
    const install = section(text, spec.install);
    const words = norm(prose(install));
    assert.match(words, run.upgradeFolder, 'a stale clone would make the snippet install the old version again');
    assert.match(words, run.upgradeOld);
    const blocks = fencedBlocks(install);
    assert.equal(blocks[1], 'claude plugin update brain-kit@brain-kit', 'the second block of the install section records the version');
    const flat = install.split('\n');
    const at = (needle) => flat.findIndex((line) => line.includes(needle));
    assert.ok(at('claude plugin update') > at('claude plugin install brain-kit@brain-kit'), 'it comes after the snippet');
    assert.ok(at(run.eacces) === -1 || at('claude plugin update') < at(run.eacces), 'and before the EACCES block');
  });

  test(`${spec.file}: the EACCES block has the exact commands, says why not sudo and what nvm users do, and ends with the check`, () => {
    const install = section(text, spec.install);
    const at = install.indexOf(`\n${run.eacces}\n`);
    assert.notEqual(at, -1, `no "${run.eacces}" heading`);
    assert.ok(at > install.indexOf(SNIPPET[0]), 'it comes after the snippet');
    const block = install.slice(at);
    assert.deepEqual(fencedBlocks(block), EACCES_BLOCKS);
    const words = norm(prose(block));
    assert.match(words, run.nvm);
    assert.match(words, run.sudo);
    assert.ok(words.includes(run.pathGloss), 'PATH is explained where it first matters');
    assert.match(words, run.reopen);
    assert.ok(words.includes(run.again), 'the snippet is pasted again after the fix');
  });

  test(`${spec.file}: step 5 gives the git identity commands with placeholders, after the commit, and says why`, () => {
    const step = items(section(text, spec.first)).find((item) => item.startsWith('5. '));
    assert.ok(step, 'step 5');
    const blocks = fencedBlocks(step);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].includes('git add -A') && blocks[0].includes('git commit'));
    assert.deepEqual(blocks[1].split('\n'), run.identity);
    assert.ok(step.includes(run.identityError));
    assert.ok(step.indexOf(run.identityError) > step.indexOf('git commit'), 'a person runs the identity commands only when git refuses');
    assert.ok(step.includes('example.com'));
    assert.match(norm(step), run.identityWhy);
  });

  test(`${spec.file}: step 3 checks the machine with the doctor before any vault exists, after the login`, () => {
    const steps = items(section(text, spec.first));
    const login = steps.find((item) => item.startsWith('2. '));
    const machine = steps.find((item) => item.startsWith('3. '));
    assert.ok(login && machine);
    assert.deepEqual(fencedBlocks(login), ['gh auth login']);
    assert.deepEqual(fencedBlocks(machine), ['brain-kit doctor']);
    assert.match(norm(machine), run.machineCheck);
    assert.match(norm(machine), run.noVaultMessage);
    assert.doesNotMatch(machine, /exits? 0|sai com 0/, 'an exit code is not on the screen');
    assert.ok(items(section(text, spec.first))[0].includes(installLink), 'step 1 is the install');
  });

  test(`${spec.file}: step 4 says what to answer to the short-id question`, () => {
    const step = items(section(text, spec.first)).find((item) => item.startsWith('4. '));
    assert.ok(step, 'step 4');
    assert.match(norm(step), run.handle);
    assert.match(norm(step), run.accept);
    assert.match(step, /Enter/);
    // The README names the question by the words on the screen (the final review of 0.0.9, M6): the
    // label is the start of the prompt the pack prints, and the old word, "handle", is on no screen.
    const pack = JSON.parse(read(`lang/${lang}/messages.json`));
    const label = pack['init.label_handle'];
    assert.ok(pack['init.ask_handle'].startsWith(label), `the prompt starts with its label: ${label}`);
    assert.ok(norm(step).includes(`"${label}"`), `step 4 quotes the question as the screen shows it: "${label}"`);
    if (lang === 'en') assert.doesNotMatch(step, /handle/i, 'no screen says "handle"');
  });

  test(`${spec.file}: the doctor step names the lines by the words on the screen, and says how to read the compact output`, () => {
    const step = items(section(text, spec.first)).find((item) => item.startsWith('7. '));
    assert.ok(step, 'step 7');
    for (const word of run.doctorWords.used) assert.ok(step.includes(word), `step 7 lacks ${word}`);
    for (const word of run.doctorWords.unused) assert.ok(!step.includes(word), `step 7 uses ${word}, the other language's word`);
    assert.ok(step.includes('--verbose'));
    assert.match(norm(step), run.compact);
    assert.match(norm(step), run.healthy);
    assert.doesNotMatch(step, /exits? 0|sai com 0/, 'an exit code is not on the screen');
  });

  test(`${spec.file}: the second machine is a section of its own, in the order docs/scheduling.md gives`, () => {
    const body = section(text, run.second);
    assert.deepEqual(fencedBlocks(body).flatMap((block) => block.split('\n')), SECOND_MACHINE);
    assert.equal(body.split('\n').filter((line) => /^\d+\. /.test(line)).length, 5);
    assert.ok(body.includes(`docs/scheduling.md#the-same-vault-on-a-second-machine`));
    assert.match(norm(body), run.oneMachine);
    // A vault made by this version needs no edit; one made before it lists its project by the
    // first machine's name, and the doctor's own way out is named, step by step (measured against
    // the integrated doctor: it says to use {vault} instead of a project name, and the scheduling
    // page says to replace the entry and commit it).
    const words = norm(body);
    assert.match(words, run.newVault);
    assert.match(words, run.oldVault);
    assert.ok(words.includes(run.noName), 'it does not tell a person to put this machine\'s name in the shared file');
    assert.match(words, run.switchFirst, 'the kit is brought up to date on every machine before the entry changes');
    assert.match(words, run.switchOlder, 'and it says why: an older kit reads the token as a name');
    // `update` runs ONCE, on the machine that edits the file (the final review of 0.0.9, M2): run on every
    // machine, the others are left with a changed, uncommitted file whose `sync` postpones, and the first
    // branch of its message would propose the machine-specific name back over `{vault}`.
    assert.match(words, run.switchOnce, 'update runs once, on the machine that edits the file; the others only install the kit');
    assert.doesNotMatch(words, run.switchEveryMachine, 'the ambiguous wording, which read as "run update on every machine", is gone');
    assert.match(words, run.switchTo);
    assert.ok(words.includes(run.switchPropose));
    assert.match(words, run.switchFiles);
    assert.match(words, run.switchUncommitted);
    const first = words.search(run.switchFirst);
    const once = words.search(run.switchOnce);
    assert.ok(first !== -1 && first < once && once < words.indexOf(run.switchPropose), 'the kit on every machine, then update once, then the proposal');
    assert.ok(words.includes('`brain-kit sync`'));
    assert.ok(body.includes(run.switchDoc), 'and it points at the section that explains it');
    assert.ok(read('docs/scheduling.md').split('\n').includes('## Before the first round'), 'which exists');
    const at = (heading) => text.split('\n').indexOf(heading);
    assert.ok(at(spec.first) < at(run.second) && at(run.second) < at(spec.works), 'between the first vault and the command reference');
    // The tool's own next steps (machine.register_new_next) give the same order as the README;
    // test/machine-register-new.test.mjs pins that order in both packs.
    assert.match(norm(body), run.toolSame);
    const doc = read('docs/scheduling.md');
    const part = doc.slice(doc.indexOf('## The same vault on a second machine'), doc.indexOf('## Moving from a legacy lock'));
    const docCommands = part.split('\n').filter((line) => /^\d+\. `/.test(line)).map((line) => /`([^`]+)`/.exec(line)[1]);
    assert.deepEqual(docCommands, SECOND_MACHINE.slice(2), 'the README and docs/scheduling.md give the same commands in the same order');
  });

  test(`${spec.file}: what the repository holds is described after the first-run path, with every fact it had`, () => {
    // A linear reader goes from the glossary to the requirements, not through the npm naming story.
    const at = (heading) => text.split('\n').indexOf(heading);
    const order = [spec.requirements, spec.install, spec.first, run.second, run.repo, spec.works].map(at);
    assert.ok(order.every((index) => index !== -1), `a section is missing: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'the sections are out of order');
    const opening = text.slice(0, text.indexOf('\n## '));
    assert.doesNotMatch(opening, /npm package|pacote npm/, 'the opening no longer carries the long description');
    const body = norm(section(text, run.repo));
    for (const fact of ['`second-brain-kit`', '`brainkit`', 'SessionStart', 'claude plugin marketplace add aleckyann/brain-kit', '`preflight`']) assert.ok(body.includes(fact), `the moved text lost: ${fact}`);
  });

  test(`${spec.file}: "${run.stuck}" closes the first vault: the five likeliest traps and one secrets line, in at most 8 lines`, () => {
    const lines = section(text, spec.first).split('\n');
    const start = lines.indexOf(run.stuck);
    assert.notEqual(start, -1, `no ${run.stuck} line`);
    let end = start + 1;
    while (end < lines.length && (lines[end] === '' || lines[end].startsWith('- '))) end += 1;
    const block = lines.slice(start, end);
    while (block.at(-1) === '') block.pop();
    assert.ok(block.length <= 8, `the block has ${block.length} lines`);
    assert.ok(lines.slice(end).every((line) => line.trim() === ''), 'it is the last thing in the first-vault section');
    const bullets = block.filter((line) => line.startsWith('- '));
    assert.equal(bullets.length, 6);
    run.traps.forEach((pattern, index) => assert.match(bullets[index], pattern, `trap ${index + 1}`));
    // What the old wording said and no longer holds: a configuration complaint for the propose
    // trap (after the second task no case of it talks about configuration), and "redo the PATH"
    // for a kit that was never installed.
    run.notTrap.forEach((pattern, index) => { if (pattern) assert.doesNotMatch(bullets[index], pattern, `trap ${index + 1} still says what no longer holds`); });
    assert.equal(bullets.filter((bullet) => bullet.includes('docs/incident-response.md')).length, 1, 'the incident page is linked once, for secrets only');
    assert.match(bullets[5], run.secrets);
    assert.ok(bullets[0].includes('(#' + slug(run.eacces.replace(/^### /, '')) + ')'), 'the first trap links the EACCES block');
  });
}

test('README.pt-BR.md: one name for the push check, and the English fragments and unglossed words the stranger listed are gone from the first-run path', () => {
  const text = read('README.pt-BR.md');
  assert.ok(text.includes('trava de push'));
  // `.githooks/install-gate` is a file name, not the push check.
  assert.doesNotMatch(text.replace(/install-gate/g, ''), /\bgates?\b/i, 'the push check is "trava de push" everywhere');
  // The Status table (phase 3 says "best effort por desenho") belongs to the release, not to this task.
  const beforeStatus = text.slice(0, text.indexOf('\n## Status\n'));
  for (const fragment of ['best effort', 'overlay de prompt', 'tarball']) assert.ok(!beforeStatus.includes(fragment), `"${fragment}" is still in the text`);
  const firstRun = text.slice(0, text.indexOf('\n## O que funciona hoje\n'));
  for (const pattern of [/\bpipe\b/, /árvore de trabalho/, /\bfrontmatter YAML\b/, /CLI do GitHub/]) assert.doesNotMatch(firstRun, pattern, `${pattern} is still in the first-run path`);
  const step = items(section(text, '## Seu primeiro vault')).find((item) => item.startsWith('11. '));
  assert.ok(step.includes('carimba `verified` (verificada)'), 'the English literal is glossed');
  assert.match(text, /um prompt do próprio vault \(`briefing\.prompt`\)/, 'the overlay is described in Portuguese');
});

// ------------------------------------------------------------------- skills

const SKILL_SENTENCES = {
  setup: {
    en: [
      'gh repo create <name> --private --source <dir> --push',
      'Without `--push` the remote is empty and `propose` cannot work',
      '`claude --version`',
      'Then run `{{kit}} doctor` from a folder that is not a vault yet',
      'that is expected here, not a problem',
      '{{kit}} doctor <dir>',
      'a repository with no commit has nothing to push',
      'If that folder already has a `brain-kit.config.json`, it is a vault that was set up before, usually on another machine and cloned here: `init` and `init --adopt` both refuse it, so skip steps 5 to 10 and go to step 11.',
      'run `{{kit}} machine register --new` instead, then `git config core.hooksPath .githooks`, since a clone has no push gate.',
      'never choose `--from` or `--new` for them.',
    ],
    'pt-BR': [
      'gh repo create <nome> --private --source <dir> --push',
      'Sem o `--push` o remoto fica vazio e o `propose` não consegue funcionar',
      '`claude --version`',
      'Depois rode o `{{kit}} doctor` numa pasta que ainda não é um vault',
      'isso é esperado aqui, não é problema',
      '{{kit}} doctor <dir>',
      'um repositório sem commit não tem o que enviar',
      'Se essa pasta já tem um `brain-kit.config.json`, é um vault configurado antes, em geral em outra máquina e clonado aqui: o `init` e o `init --adopt` recusam esse vault, então pule os passos 5 a 10 e vá para o passo 11.',
      'rode `{{kit}} machine register --new` no lugar, e depois `git config core.hooksPath .githooks`, porque um clone não tem a trava de push.',
      'nunca escolha `--from` ou `--new` por ela.',
    ],
  },
  'curate-session': {
    en: [
      'postpones (exit 75) when the working tree has changes that are not committed',
      'every file it lists is one this session wrote or changed',
      '`propose` fetches the base itself',
      'If it refuses for any other reason',
      'If it refuses with "These paths are not the same at HEAD as at ..."',
      'the base moved while this session worked: stop, leave the files as they are and tell the person',
      'The recovery is theirs (`git stash`, then `{{kit}} sync`, then `git stash pop`',
      'Do not alternate `sync` and `propose`',
    ],
    'pt-BR': [
      'adia (saída 75) quando a árvore de trabalho tem mudanças sem commit',
      'todo arquivo que ele lista é um que esta sessão escreveu ou alterou',
      'o `propose` busca a base sozinho',
      'Se ele recusar por qualquer outro motivo',
      'Se ele recusar com "Estes caminhos não estão iguais no HEAD e em ..."',
      'a base andou enquanto esta sessão trabalhava: pare, deixe os arquivos como estão e diga isso à pessoa',
      'A recuperação é dela (`git stash`, depois `{{kit}} sync`, depois `git stash pop`',
      'Não alterne `sync` e `propose`',
    ],
  },
};

for (const [skill, byLang] of Object.entries(SKILL_SENTENCES)) {
  for (const [lang, sentences] of Object.entries(byLang)) {
    test(`the ${lang} ${skill} skill body holds the sentences the stranger's run showed it needs`, () => {
      const body = read(`lang/${lang}/skills/${skill}.md`);
      for (const sentence of sentences) assert.ok(body.includes(sentence), `${lang}/${skill}.md lacks: ${sentence}`);
    });
  }
}

// Measured in a scratch repository: the remote gained a merged commit that touched
// memory/log.md, the session appended to the same file on a stale HEAD, `sync` exited
// 75 (dirty tree), `propose --only memory/log.md` exited 1 with propose.base_differs
// and told the model to run `sync`, which exited 75 again. The skill names the message
// it must recognise, so the quoted words must be the start of the real one (in the
// Portuguese skill both: the CLI speaks the environment's language, not the vault's).
test('the curate-session skill quotes the real start of the propose refusal for a moved base, in each language', () => {
  const start = (lang, key) => JSON.parse(read(`lang/${lang}/messages.json`))[key];
  const quoted = {
    en: ['These paths are not the same at HEAD as at'],
    'pt-BR': ['Estes caminhos não estão iguais no HEAD e em', 'These paths are not the same at HEAD as at'],
  };
  for (const [lang, fragments] of Object.entries(quoted)) {
    const body = read(`lang/${lang}/skills/curate-session.md`);
    const step7 = body.split('\n').find((line) => line.startsWith('7. '));
    assert.ok(step7, `${lang}: step 7`);
    for (const fragment of fragments) {
      assert.ok(step7.includes(fragment), `${lang}: step 7 does not quote "${fragment}"`);
      const owner = fragment.startsWith('These') ? 'en' : 'pt-BR';
      assert.ok(start(owner, 'propose.base_differs').startsWith(fragment), `${owner}: propose.base_differs no longer starts with "${fragment}"`);
    }
  }
});

// The doctor checks the machine when it runs outside a vault (phase 6, 0.0.9), so the setup skill
// runs it three times: as the machine check before any vault exists, after `init`, and at the end.
// It used to say the opposite ("it refuses to run outside a vault, so it runs after init"), which
// is false now; the skills, the eval criteria and this test were the five places that said so.
test('the setup skill runs the doctor outside a vault as the machine check, again after init, and once more at the end', () => {
  for (const lang of ['en', 'pt-BR']) {
    const body = read(`lang/${lang}/skills/setup.md`);
    const machine = body.slice(body.indexOf('\n1. '), body.indexOf('\n4. '));
    assert.match(machine, /(run|rode)( o)? `\{\{kit\}\} doctor`/i, `${lang}: the machine check runs the doctor before any vault exists`);
    assert.match(machine, lang === 'en' ? /from a folder that is not a vault yet/ : /numa pasta que ainda não é um vault/, `${lang}: from outside a vault`);
    assert.match(machine, lang === 'en' ? /checks only this machine/ : /confere só esta máquina/, `${lang}: where it checks only the machine`);
    assert.doesNotMatch(body, /refuses to run outside a vault|recusa rodar fora de um vault|runs after `init`, in step 9|roda depois do `init`, no passo 9/, `${lang}: the old claim is gone`);
    const runs = body.split('{{kit}} doctor').length - 1;
    assert.equal(runs, 3, `${lang}: the doctor runs three times (${runs})`);
    assert.ok(body.indexOf('{{kit}} doctor') < body.indexOf('--from-answers <'), `${lang}: the first run is before init`);
    assert.ok(body.indexOf('--from-answers <') < body.indexOf('{{kit}} doctor <dir>'), `${lang}: the doctor runs after init`);
    assert.ok(body.indexOf('{{kit}} doctor <dir>') < body.lastIndexOf('{{kit}} doctor'), `${lang}: and once more at the end`);
    assert.ok(!/gh repo create <(name|nome)> --private --source <dir>(?! --push)/.test(body), `${lang}: every repository command pushes`);
    // What the eval judge is told to expect is the same story (nothing pinned it, and it went stale).
    const criteria = read(`evals/setup-${lang}/graders/criteria.md`);
    assert.doesNotMatch(criteria, /refuses outside a vault|recusa fora de um vault|without running the kit's `doctor` yet|sem rodar o `doctor` do kit ainda/, `${lang}: the criteria still say the doctor is not run yet`);
    assert.match(criteria, lang === 'en' ? /then the kit's `doctor` from a folder that is not a vault, as the machine check/ : /e depois o `doctor` do kit numa pasta que não é um vault, como conferência da máquina/, `${lang}: the criteria expect the machine check`);
  }
});

test('the curate-session skill still stops for any other refusal and gains no step', () => {
  for (const lang of ['en', 'pt-BR']) {
    const body = read(`lang/${lang}/skills/curate-session.md`);
    const steps = body.split('\n').filter((line) => /^\d+\. /.test(line));
    assert.equal(steps.length, 8, `${lang}: the skill has eight steps`);
    assert.match(steps[0], /\{\{kit\}\} sync/);
    assert.match(steps[0], lang === 'en' ? /stop and tell the person why before writing anything/ : /pare e diga à pessoa o porquê antes de escrever qualquer coisa/);
    assert.doesNotMatch(steps[0], lang === 'en' ? /for any reason, stop/ : /por qualquer motivo, pare/, `${lang}: sync's refusal is no longer a blanket stop`);
  }
});

// ------------------------------------------------------------ plugin manifest

test('the plugin manifest declares no user option: nothing reads one, and the install announced it as unset', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(plugin.userConfig, undefined);
  assert.equal(JSON.parse(read('.claude-plugin/marketplace.json')).plugins[0].userConfig, undefined);
});

function repositoryFiles() {
  const skip = new Set(['.git', 'node_modules', '.superpowers', 'test']);
  const out = [];
  (function walk(dir, rel) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (skip.has(next) || next === '.claude/worktrees') continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), next);
      else if (entry.isFile() && statSync(join(dir, entry.name)).size < 5_000_000) out.push(next);
    }
  })(KIT_ROOT, '');
  return out;
}

test('no document tells a person to configure a plugin option (the CHANGELOG, which records the removal, excepted)', () => {
  const found = [];
  for (const file of repositoryFiles().filter((f) => f !== 'CHANGELOG.md')) {
    const text = readFileSync(join(KIT_ROOT, file), 'utf8');
    if (text.includes('\u0000')) continue;
    for (const pattern of [/userConfig/, /plugin configure/i]) if (pattern.test(text)) found.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(found, []);
});

// ------------------------------------------------------------ packaged docs

// A path in a shipped text file that names a docs/ file: the text `docs/x.md`
// not glued to a longer path or a URL, and a relative markdown link that
// resolves into docs/. `lineIsCodeComment` marks a comment line of a script:
// a maintainer's plan cited there as provenance is not a pointer a person
// follows, and the plans are never shipped.
const CITATION = /(?<![\w./:@~-])docs\/[\w./-]*\w\.md\b/g;
const LINK = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

// docs/incident-response.md is announced in the Status table as not yet
// written; task C writes it and ships it. Delete this entry then.
const ANNOUNCED_NOT_WRITTEN = new Set(['docs/incident-response.md']);

function unshippedCitations(files, shipped, { exists = () => true } = {}) {
  const found = [];
  for (const [path, text] of files) {
    const script = /^(src|bin)\/.*\.mjs$/.test(path);
    const cited = new Set();
    for (const line of text.split('\n')) {
      const comment = script && /^\s*(\/\/|\*|\/\*)/.test(line);
      for (const match of line.matchAll(CITATION)) {
        if (comment && match[0].startsWith('docs/superpowers/')) continue;
        cited.add(match[0]);
      }
    }
    if (path.endsWith('.md')) {
      for (const match of text.matchAll(LINK)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(match[1]) || match[1].startsWith('/')) continue;
        const target = posix.normalize(posix.join(dirname(path), match[1]));
        if (target.startsWith('docs/')) cited.add(target);
      }
    }
    for (const doc of cited) {
      if (shipped.has(doc)) continue;
      if (ANNOUNCED_NOT_WRITTEN.has(doc) && !exists(doc)) continue;
      found.push(`${path} cites ${doc}`);
    }
  }
  return found;
}

function packedFiles() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return report.files.map((file) => file.path);
}

test('every docs/ file a shipped file cites is in the package', () => {
  const paths = packedFiles();
  assert.ok(paths.includes('README.md') && paths.includes('lang/en/messages.json'), 'the pack list holds the files that cite docs');
  const shipped = new Set(paths);
  const files = [];
  for (const path of paths) {
    const bytes = readFileSync(join(KIT_ROOT, path));
    if (bytes.includes(0)) continue;
    files.push([path, bytes.toString('utf8')]);
  }
  const exists = (doc) => {
    try {
      return statSync(join(KIT_ROOT, doc)).isFile();
    } catch {
      return false;
    }
  };
  const found = unshippedCitations(files, shipped, { exists });
  assert.deepEqual(found, [], `a shipped file cites a docs/ file package.json "files" does not ship (add the file, or change the citation if it is maintainer-only):\n  ${found.join('\n  ')}`);
});

test('the maintainer-only docs stay out of the package', () => {
  const paths = packedFiles();
  assert.ok(!paths.includes('docs/releasing.md'));
  assert.ok(paths.every((p) => !p.startsWith('docs/superpowers/')));
});

test('self-check: the citation guard flags a planted citation, a planted link and a planted plan, and passes a clean file', () => {
  const shipped = new Set(['README.md', 'docs/shipped.md']);
  const flagged = (path, text, options) => unshippedCitations([[path, text]], shipped, options);
  assert.deepEqual(flagged('README.md', 'See docs/missing.md for more.'), ['README.md cites docs/missing.md']);
  assert.deepEqual(flagged('README.md', 'See [it](docs/missing.md).'), ['README.md cites docs/missing.md']);
  assert.deepEqual(flagged('docs/shipped.md', 'See [it](other.md) and [x](../README.md).'), ['docs/shipped.md cites docs/other.md']);
  assert.deepEqual(flagged('lang/en/messages.json', '"x": "docs/missing.md says"'), ['lang/en/messages.json cites docs/missing.md']);
  assert.deepEqual(flagged('src/a.mjs', "const DOC = 'docs/missing.md';"), ['src/a.mjs cites docs/missing.md']);
  assert.deepEqual(flagged('src/a.mjs', '// docs/superpowers/plans/x.md is where the plan lives'), []);
  assert.deepEqual(flagged('src/a.mjs', "const DOC = 'docs/superpowers/plans/x.md';"), ['src/a.mjs cites docs/superpowers/plans/x.md']);
  assert.deepEqual(flagged('README.md', 'See [it](https://example.com/docs/missing.md) and docs/shipped.md.'), []);
  assert.deepEqual(flagged('README.md', 'Announced: docs/incident-response.md.', { exists: () => false }), []);
  assert.deepEqual(flagged('README.md', 'Written: docs/incident-response.md.', { exists: () => true }), ['README.md cites docs/incident-response.md']);
});
