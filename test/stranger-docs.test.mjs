// What a stranger who follows only the README needs, pinned (phase 6: task F1,
// then task G1 of 0.0.9, then the README rework of 02/10/2026, task R1).
//
// A person in a clean room installed the kit from the README alone and found
// that no document showed the path from `init` to the first pull request. The
// second walkthrough, a Brazilian who is not a developer, reached it, but on a
// page so dense and technical that the path would take such a person 30 to 40
// minutes. Since R1 there are three documents, and the tests below keep each of
// them from rotting:
//
//   - README.md, the front door, in Portuguese: what the kit is and for whom,
//     how it works, what it needs, the step by step to the first pull request
//     (the commands of the English guide's "Your first vault", word for word but
//     the Portuguese ones), what to do when stuck, privacy, cost and stage;
//   - docs/guide.md, the English README moved as it was, with its own "Start
//     here" box and first-run path: the complete guide in English;
//   - docs/guia.md, the complete guide in Portuguese: every section of the old
//     README.pt-BR.md that the front door does not carry, nothing true dropped.
//
// Also pinned here:
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';

const read = (path) => readFileSync(join(KIT_ROOT, path), 'utf8');
const pkg = JSON.parse(read('package.json'));

const README = 'README.md';
const GUIA = 'docs/guia.md';
const GUIDE = 'docs/guide.md';
const DOCUMENTS = [README, GUIA, GUIDE];

const E_ACUTE = String.fromCharCode(0xe9);
const PT_LATEST_TAG = `A tag mais recente ${E_ACUTE} a \`v${pkg.version}\`.`;
const EN_LATEST_TAG = `The latest tag is \`v${pkg.version}\`.`;

// ------------------------------------------------------------------ helpers

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

// The text under a heading, up to the next heading of the same level or a
// higher one (a level-two section holds its level-three subsections).
function section(text, heading) {
  const level = /^#+/.exec(heading)[0].length;
  const lines = scan(text);
  const start = lines.findIndex((entry) => !entry.fenced && entry.line === heading);
  assert.notEqual(start, -1, `no "${heading}" heading`);
  const body = [];
  for (const entry of lines.slice(start + 1)) {
    const match = /^(#+) /.exec(entry.line);
    if (!entry.fenced && match && match[1].length <= level) break;
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

// The headings of a text, outside code blocks, at the given level.
const headings = (text, level) => scan(text).filter((entry) => !entry.fenced && new RegExp(`^#{${level}} `).test(entry.line)).map((entry) => entry.line);

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

// The markdown links of a text, outside code blocks, as written.
function links(text) {
  const found = [];
  for (const { line, fenced } of scan(text)) {
    if (!fenced) for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) found.push(match[1]);
  }
  return found;
}

// What is wrong with the links of `file`: a relative link to a file that does not
// exist, or to an anchor its target does not have. Web addresses are not followed.
function brokenLinks(file, text = read(file)) {
  const problems = [];
  for (const target of links(text)) {
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    const [path, fragment] = target.split('#');
    const resolved = path === '' ? file : posix.normalize(posix.join(posix.dirname(file), path));
    if (path !== '' && !existsSync(join(KIT_ROOT, resolved))) {
      problems.push(`${file}: ${target}: ${resolved} does not exist`);
      continue;
    }
    if (fragment === undefined) continue;
    if (!resolved.endsWith('.md')) {
      problems.push(`${file}: ${target}: an anchor into a file that is not markdown`);
      continue;
    }
    const known = anchors(path === '' ? text : read(resolved));
    if (!known.has(fragment)) problems.push(`${file}: ${target}: no such heading or anchor in ${resolved}`);
  }
  return problems;
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

// The numbered items of a section, each as its own text (an item runs to the next one).
const items = (text) => text.split(/\n(?=\d+\. )/).filter((item) => /^\d+\. /.test(item));

// The bullets of a text that start at the margin, each as its own text with its continuation lines.
function bullets(text) {
  const found = [];
  let open = false;
  for (const { line, fenced } of scan(text)) {
    if (fenced) continue;
    if (line.startsWith('- ')) {
      found.push(line);
      open = true;
    } else if (open && /^\s+\S/.test(line)) found[found.length - 1] += ` ${line.trim()}`;
    else if (line.trim() !== '') open = false;
  }
  return found;
}

// One numbered item of a section, cut where the text goes back to the margin: the
// last item of a list does not run into the paragraphs and subsections after it.
function itemOf(text, n) {
  const item = items(text).find((candidate) => candidate.startsWith(`${n}. `));
  assert.ok(item, `no item ${n}`);
  const lines = item.split('\n');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() !== '' && !/^\s/.test(line));
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
}

// --------------------------------------------------- the commands, as verified

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

const UPDATE_BLOCK = 'claude plugin update brain-kit@brain-kit';

// The code blocks of the README's step by step, in order: the install, the eleven steps,
// the EACCES block and the update. They are the commands the English guide gives (the
// test below holds that) and the ones run by hand in a scratch directory (the task
// reports list them); only the words a Portuguese reader reads differ.
const README_BLOCKS = [
  SNIPPET.join('\n'),
  'gh auth login',
  'brain-kit doctor',
  'brain-kit init ~/my-brain',
  'cd ~/my-brain\ngit add -A\ngit commit -m "Inicia o vault"',
  'git config --global user.name "Seu Nome"\ngit config --global user.email "voce@example.com"',
  'gh repo create my-brain --private --source . --push',
  'brain-kit doctor',
  'claude',
  'brain-kit propose "Primeira captura" --only memoria/log.md',
  ...EACCES_BLOCKS,
  UPDATE_BLOCK,
];

const toEnglishCommands = (block) => block
  .replace('memoria/log.md', 'memory/log.md')
  .replace('Inicia o vault', 'Start the vault')
  .replace('Primeira captura', 'First capture')
  .replace('"Seu Nome"', '"Your Name"')
  .replace('voce@example.com', 'you@example.com');

// The second machine, in the order docs/scheduling.md gives (clone, register, push gate, doctor, schedule).
const SECOND_MACHINE = ['gh repo clone my-brain ~/my-brain', 'cd ~/my-brain', 'brain-kit machine register --new', 'git config core.hooksPath .githooks', 'brain-kit doctor', 'brain-kit schedule install'];

// ------------------------------------------------- the three documents together

test('the three documents exist, README.pt-BR.md is gone, and the package ships the two guides the README links', () => {
  for (const file of DOCUMENTS) assert.ok(existsSync(join(KIT_ROOT, file)), `${file} is missing`);
  assert.equal(existsSync(join(KIT_ROOT, 'README.pt-BR.md')), false, 'README.md is the Portuguese README now');
  for (const file of DOCUMENTS) assert.ok(pkg.files.includes(file), `package.json files does not list ${file}`);
  assert.ok(!pkg.files.includes('README.pt-BR.md'));
});

test('every relative link of the three documents lands on a file, and on a heading or an anchor, that exists', () => {
  const problems = DOCUMENTS.flatMap((file) => brokenLinks(file));
  assert.deepEqual(problems, []);
  const inPage = links(read(README)).filter((target) => target.startsWith('#'));
  const crossFile = links(read(README)).filter((target) => !/^(?:https?:|#)/.test(target));
  assert.ok(inPage.length >= 6 && crossFile.length >= 10, `precondition: README.md has ${inPage.length} in-page and ${crossFile.length} cross-file links`);
  assert.ok(links(read(GUIA)).some((target) => target.startsWith('../README.md#')), 'the guia links to the README sections it does not repeat');
});

test('self-check: the link guard reports a missing file, a missing anchor and a missing in-page anchor, and passes good ones', () => {
  assert.deepEqual(brokenLinks(GUIA, '[a](../README.md) [b](scheduling.md#before-the-first-round) [c](https://example.com/x.md#y)'), []);
  assert.equal(brokenLinks(GUIA, '[a](no-such-page.md)').length, 1);
  assert.equal(brokenLinks(GUIA, '[a](scheduling.md#no-such-heading)').length, 1);
  assert.equal(brokenLinks(README, '# T\n\n## Passo a passo\n\n[x](#passo-a-passo) [y](#nowhere)').length, 1);
  assert.deepEqual(brokenLinks(README, '## Se aparecer `EACCES`\n\n<a id="passo-2"></a>[x](#se-aparecer-eacces) [y](#passo-2)'), []);
});

test('no em dash, no en dash and no emoji in the three documents', () => {
  for (const file of DOCUMENTS) {
    const text = read(file);
    for (const [name, code] of [['em dash', 0x2014], ['en dash', 0x2013]]) {
      const at = text.indexOf(String.fromCharCode(code));
      assert.equal(at, -1, `${file}: an ${name} on line ${text.slice(0, at).split('\n').length}`);
    }
    const emoji = /\p{Extended_Pictographic}|\uFE0F/u.exec(text);
    assert.equal(emoji, null, `${file}: an emoji (${emoji?.[0]})`);
  }
});

test('self-check: the dash and emoji patterns see what they are for', () => {
  assert.ok(/\p{Extended_Pictographic}|\uFE0F/u.test('pronto \u{1F680}'));
  assert.ok(!/\p{Extended_Pictographic}|\uFE0F/u.test('Privacidade: o que o curador guarda (ver o guia).'));
});

test('the release gate holds each document: one stamp right under its section, the latest-tag sentence in its language, no literal tag in a code block', () => {
  for (const [file, heading, sentence] of [[README, '## Em que pé está', PT_LATEST_TAG], [GUIA, '## Status', PT_LATEST_TAG], [GUIDE, '## Status', EN_LATEST_TAG]]) {
    const text = read(file);
    assert.equal(text.split('<!-- status-reviewed: ').length - 1, 1, `${file}: exactly one stamp`);
    const body = section(text, heading);
    assert.ok(body.startsWith(`\n<!-- status-reviewed: ${pkg.version} -->\n`), `${file}: the stamp is right under ${heading}`);
    assert.ok(norm(body).includes(sentence), `${file}: the latest-tag sentence`);
    for (const block of fencedBlocks(text)) assert.doesNotMatch(block, /v\d+\.\d+\.\d+|second-brain-kit-\d+\.\d+\.\d+\.tgz/, file);
  }
});

test('the README and the English guide give the same first-run commands, only the Portuguese words differ', () => {
  const readme = fencedBlocks(section(read(README), '## Passo a passo'));
  const guide = read(GUIDE);
  const english = [...fencedBlocks(section(guide, '## Installing a fixed version')), ...fencedBlocks(section(guide, '## Your first vault'))];
  assert.deepEqual(readme.map(toEnglishCommands).sort(), [...english].sort());
});

// ------------------------------------------------------ README.md, the front door

// The sections the front door holds, in the order the owner asked for (02/10/2026): what it
// is, why, what you gain, for whom, how it works, what you need, the step by step, what to do
// when stuck, privacy, cost, stage and where to read more.
const FRONT_DOOR = [
  '## Em 30 segundos',
  '## Por que isso existe',
  '## O que você ganha',
  '## Para quem é',
  '## Como funciona',
  '## O que você precisa',
  '## Passo a passo',
  '## Se travar',
  '## Privacidade',
  '## Quanto custa',
  '## Em que pé está',
  '## Quer mais?',
];

const readme = read(README);
const step = (n) => itemOf(section(readme, '## Passo a passo'), n);
const stepWords = (n) => norm(prose(step(n)));

test('README.md: the front door has the twelve sections in order, and nothing else at that level', () => {
  assert.deepEqual(headings(readme, 2), FRONT_DOOR);
});

test('README.md: a name and a one-line pitch, before any section', () => {
  const opening = readme.slice(0, readme.indexOf('\n## ')).trim().split('\n');
  assert.equal(opening[0], '# brain-kit');
  const pitch = opening.slice(1).filter((line) => line.trim() !== '');
  assert.equal(pitch.length, 1, `the pitch is one line: ${pitch.join(' | ')}`);
  assert.ok(pitch[0].length <= 140, `a pitch of ${pitch[0].length} characters`);
  // What the kit enforces, not a promise of zero errors: it records what it read, and asks first.
  assert.match(pitch[0], /lembra/);
  assert.match(pitch[0], /leu/);
  assert.match(pitch[0], /licença/);
  assert.doesNotMatch(pitch[0], /não inventa|nunca erra|sem erro/);
});

test('README.md: under the line target, so the front door stays short', () => {
  const lines = readme.split('\n').length;
  assert.ok(lines <= 300, `README.md has ${lines} lines`);
});

test('README.md: "Em 30 segundos" says it in three short lines: plain text files, an AI that reads and updates them, and your approval', () => {
  const lines = bullets(section(readme, '## Em 30 segundos'));
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(line.length <= 260, `a line of ${line.length} characters`);
  assert.match(lines[0], /Markdown/);
  assert.match(lines[1], /Claude Code/);
  assert.match(lines[2], /pull request/);
  assert.match(lines[2], /aprova/);
});

test('README.md: "Por que isso existe" names the problem and where the kit came from, with no name in it', () => {
  const body = norm(section(readme, '## Por que isso existe'));
  for (const word of [/contexto/, /esquece/, /escreve/, /fundador/, /docs\/incidents\.md/]) assert.match(body, word);
});

test('README.md: "O que você ganha" lists five or six benefits, one line each', () => {
  const body = section(readme, '## O que você ganha');
  const list = bullets(body);
  assert.ok(list.length >= 5 && list.length <= 6, `${list.length} benefits`);
  assert.equal(body.split('\n').filter((line) => line.startsWith('- ')).length, body.split('\n').filter((line) => line.trim() !== '').length, 'one line each, and nothing but the list');
  const all = norm(list.join(' '));
  for (const word of [/reunião/, /véspera/, /celular/, /briefing|manhã/, /editor/, /MIT/, /plano do Claude/]) assert.match(all, word);
});

test('README.md: "Para quem é" has four to six personas with an example each, and says who it is not for yet', () => {
  const body = section(readme, '## Para quem é');
  const personas = bullets(body);
  assert.ok(personas.length >= 4 && personas.length <= 6, `${personas.length} personas`);
  for (const persona of personas) assert.match(persona, /^- \*\*[^*]+\*\* /, `a persona starts with who it is: ${persona}`);
  const notYet = norm(prose(body)).slice(norm(prose(body)).indexOf('Ainda não'));
  assert.ok(notYet.startsWith('Ainda não'), 'the section says who it is not for yet');
  for (const word of [/GitHub/, /terminal/, /Windows/]) assert.match(notYet, word);
});

test('README.md: "Como funciona" is the loop in three steps, the briefing, where the data lives and what the curator reads by default', () => {
  const body = section(readme, '## Como funciona');
  const loop = items(prose(body.slice(0, body.indexOf('### '))));
  assert.equal(loop.length, 3);
  assert.match(loop[0], /Você trabalha/);
  assert.match(loop[1], /curador/);
  assert.match(loop[2], /Você aprova/);
  const words = norm(body);
  assert.match(words, /briefing/);
  assert.ok(words.includes('`~/.local/state/brain-kit/`'), 'where the machine state lives');
  // By default a round reads only the sessions run inside the vault's folder (init lists {vault}).
  assert.match(words, /por padrão, as sessões do Claude Code abertas dentro da pasta do vault/);
  assert.match(words, /Instrução não é garantia/);
  assert.match(words, /nada entra sem o seu merge/);
});

test('README.md: the glossary is shorter than the old one and holds the words the step by step uses', () => {
  const body = section(readme, '### Palavras que você vai ver');
  const rows = body.split('\n').filter((line) => line.startsWith('|')).slice(2);
  assert.ok(rows.length >= 8 && rows.length <= 11, `${rows.length} entries`);
  const words = rows.map((row) => row.split('|')[1].trim()).join(' ').toLowerCase();
  for (const term of ['terminal', 'repositório', 'commit', 'push', 'pull request', 'merge', 'vault', 'trava de push', 'plugin', 'skill', 'hook']) assert.ok(words.includes(term), `the glossary lacks: ${term}`);
});

test('README.md: "O que você precisa" names each tool with a line and a link, and the time the first run takes', () => {
  const body = section(readme, '## O que você precisa');
  const flat = norm(body);
  assert.match(flat, /Node\.js 22 ou mais novo \(o 24 LTS é o recomendado\)/);
  for (const link of ['https://nodejs.org', 'https://git-scm.com/downloads', 'https://github.com/signup', 'https://cli.github.com', 'https://code.claude.com/docs/en/overview']) assert.ok(body.includes(`(${link})`), `no link to ${link}`);
  for (const word of [/`node --version`/, /\bgit\b/, /`gh`/, /Claude Code/, /conta no GitHub/]) assert.match(flat, word);
  // The time, honest and arithmetic: the reading and the steps add up to at most the whole,
  // which adds only a few minutes for the approval on GitHub. The second walkthrough estimated
  // 30 to 40 for a person who is not a developer.
  const whole = Number(/cerca de (\d+) minutos/.exec(flat)?.[1]);
  const reading = Number(/uns (\d+) de leitura/.exec(flat)?.[1]);
  const steps = Number(/(\d+) nos passos/.exec(flat)?.[1]);
  assert.ok(whole >= 30 && whole <= 40, `${whole} minutes`);
  assert.ok(reading >= 10 && reading + steps <= whole && whole - (reading + steps) <= 5, `${reading} + ${steps} against ${whole}`);
  assert.match(flat, /São estimativas, não uma promessa/);
  // What the first pull request does not need is named and sent to the guide, without the
  // words that scare a first reader.
  for (const word of [/systemd/i, /linger/i, /launchd/i, /\bcron\b/i, /Windows/, /desktop/i]) assert.doesNotMatch(body, word);
  assert.match(flat, /opcionais/);
  assert.ok(body.includes('(docs/guia.md#o-curador-agendado)'));
});

test('README.md: the step by step is eleven numbered steps whose code blocks are the verified commands, in order', () => {
  const body = section(readme, '## Passo a passo');
  const steps = body.split('\n').filter((line) => /^\d+\. /.test(line));
  assert.deepEqual(steps.map((line) => Number(/^(\d+)\./.exec(line)[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(fencedBlocks(body), README_BLOCKS);
  for (const id of ['passo-2', 'passo-3', 'passo-4', 'passo-5', 'passo-6', 'passo-7', 'passo-11']) assert.ok(body.includes(`<a id="${id}"></a>`), id);
  assert.doesNotMatch(body, /\bexits? (with )?0\b|\bexit code\b|sai com 0|código de saída/i, 'the screen shows no exit code');
});

test('README.md: each step says what it does, the command, and what the screen shows', () => {
  const one = stepWords(1);
  assert.ok(one.includes('A pasta `brain-kit` que a primeira linha baixou (ela fica onde você colou o trecho) não é mais usada e pode ser apagada'), 'the clone folder can go, and where it is');
  assert.match(one, /Já a pasta `~\/\.local\/share\/brain-kit\/`, que o trecho cria, \*\*não pode ser apagada\*\*/);
  assert.ok(one.includes('`brain-kit --version`') && one.includes('Successfully installed'), 'what the screen shows');
  assert.ok(one.includes('(#se-aparecer-eacces)'));
  assert.ok(stepWords(2).includes('Logged in as'));
  const three = stepWords(3);
  assert.match(three, /confere só a máquina: o Node, o git, o `gh` e o login dele, e o Claude Code\. Está tudo certo quando a linha que começa com `doctor:` termina em `0 falha\(s\)`/);
  assert.match(three, /A mensagem "nenhum vault brain-kit encontrado", que vem logo depois, é esperada/);
  assert.ok(three.includes('`fail`') && three.includes('`0 fail`'), 'the words of a system in English');
  const four = stepWords(4);
  const pack = JSON.parse(read('lang/pt-BR/messages.json'));
  assert.ok(pack['init.ask_handle'].startsWith(pack['init.label_handle']));
  assert.ok(four.includes(`Na pergunta "${pack['init.label_handle']}" (o nome curto que assina as suas aprovações), aceite a sugestão`), 'the question as the screen shows it');
  assert.match(four, /Enter/);
  assert.match(four, /sete perguntas/);
  const five = step(5);
  assert.ok(five.indexOf('Author identity unknown') > five.indexOf('git commit'), 'the identity commands only when git refuses');
  assert.match(norm(five), /O git guarda quem fez cada commit/);
  assert.ok(five.includes('example.com'));
  const six = stepWords(6);
  assert.match(six, /privado/);
  assert.match(six, /trava de push/);
  assert.ok(six.includes('`nothing matched`') && six.includes('`refusing to push`'), 'what a good push ends with, and what a refusal says');
  const seven = stepWords(7);
  for (const word of ['`falha`', '`aviso`', '--verbose', 'só os avisos e as falhas, com a contagem das linhas `ok`', 'a última linha termina em `0 falha(s)`']) assert.ok(seven.includes(word), `step 7 lacks ${word}`);
  for (const word of ['`fail`', '`warn`']) assert.ok(!seven.includes(word), `step 7 uses ${word}, the English word`);
  for (const word of ['`watermark`', '`last-run`', '`schedule`', '`notify`', '`briefing`']) assert.ok(seven.includes(word), `step 7 names the warning ${word}`);
  assert.match(stepWords(8), /confia/);
  const nine = step(9);
  assert.ok(nine.includes('`**Captura**`') && nine.includes('`**Capture**`'), 'both markers');
  assert.ok(nine.includes('`memoria/log.md`') && nine.includes('`memory/log.md`'), 'both log paths');
  const marker = (code) => JSON.parse(read(`lang/${code}/config.defaults.json`)).taxonomy.log_markers.capture;
  assert.deepEqual([marker('pt-BR'), marker('en')], ['Captura', 'Capture']);
  const ten = stepWords(10);
  for (const word of ['Stop', '`Pull request aberto`', '`--dry`', 'não faça commit desse arquivo', 'divergiram']) assert.ok(ten.includes(word), `step 10 lacks ${word}`);
  const eleven = stepWords(11);
  for (const word of ['merge', '`brain-kit sync`', '`brain-kit verify --pr <número>`', 'carimba `verified` (verificada)', 'nada a carimbar, e nada foi escrito']) assert.ok(eleven.includes(word), `step 11 lacks ${word}`);
  // A message the README quotes is the one the tool prints.
  assert.ok(pack['verify.nothing_to_stamp'].includes('nada a carimbar, e nada foi escrito'));
  assert.ok(pack['propose.opened'].startsWith('Pull request aberto'), 'step 10 quotes the start of propose.opened');
});

test('README.md: the EACCES block follows the steps, with the exact commands, why not sudo, what nvm users do, and the check', () => {
  const body = section(readme, '### Se aparecer `EACCES`');
  const passo = section(readme, '## Passo a passo');
  assert.ok(passo.indexOf('### Se aparecer `EACCES`') > passo.indexOf('\n11. '), 'after the eleven steps');
  assert.deepEqual(fencedBlocks(body), EACCES_BLOCKS);
  const words = norm(prose(body));
  for (const word of [/nvm/, /`sudo`/, /Feche o terminal e abra outro/]) assert.match(words, word);
  assert.ok(words.includes('a lista de pastas onde o terminal procura os comandos que você digita'), 'PATH is explained where it first matters');
  assert.ok(words.includes('cole o trecho de instalação de novo'), 'the snippet is pasted again after the fix');
});

test('README.md: moving to a newer version says to drop the old clone, paste again, record the version in Claude Code and which folders can go', () => {
  const body = section(readme, '### Para atualizar depois');
  const words = norm(prose(body));
  assert.match(words, /apague a pasta `brain-kit` que a primeira linha baixou, se ela ainda existir \(senão o trecho reaproveita essa cópia velha e instala a versão velha\)/);
  assert.match(words, /As pastas das versões antigas em `~\/\.local\/share\/brain-kit\/` não são mais usadas e podem ser apagadas; a mais nova não/);
  assert.deepEqual(fencedBlocks(body), [UPDATE_BLOCK]);
});

test('README.md: "Se travar" gives the five likeliest traps and one secrets line, in at most 8 lines', () => {
  const body = section(readme, '## Se travar').split('\n').filter((line) => line.trim() !== '');
  assert.ok(body.length <= 8, `the section has ${body.length} lines`);
  const list = body.filter((line) => line.startsWith('- '));
  assert.equal(list.length, 6);
  const traps = [/EACCES/, /`gh auth login`/, /`propose`.*commit.*`git push -u origin HEAD`/, /command not found.*Successfully installed.*bloco .*EACCES.* inteiro/, /`doctor`.*falha.*gh auth login --hostname github\.com/, /incident-response\.md/];
  traps.forEach((pattern, index) => assert.match(list[index], pattern, `trap ${index + 1}`));
  // What the old wording said and no longer holds: a configuration complaint for the propose
  // trap, and "redo the PATH" for a kit that was never installed.
  assert.doesNotMatch(list[2], /configura/);
  assert.doesNotMatch(list[3], /refaça o PATH/);
  assert.equal(list.filter((line) => line.includes('docs/incident-response.md')).length, 1, 'the incident page is linked once, for secrets only');
  assert.match(list[5], /senha|chave/i);
  assert.ok(list[0].includes('(#se-aparecer-eacces)'), 'the first trap links the EACCES block');
});

test('README.md: the cost is the plan the person already has, with one measured figure, its source and its date', () => {
  const flat = norm(section(readme, '## Quanto custa'));
  for (const word of [/grátis/, /MIT/, /plano/, /US\$ 0,78/, /US\$ 4,45/, /`last-run\.json`/, /01 e 02\/10\/2026/, /API/, /limites do plano/, /`curate\.budget_usd`/]) assert.match(flat, word);
  // The cap the README names is the one init writes.
  assert.equal(JSON.parse(read('lang/pt-BR/config.defaults.json')).curate.budget_usd, 5);
  assert.match(flat, /teto de US\$ 5 por rodada/);
});

test('README.md: "Em que pé está" says the stage in a few lines and sends the phase table to the guide', () => {
  const body = section(readme, '## Em que pé está');
  const flat = norm(body);
  assert.ok(body.split('\n').filter((line) => line.trim() !== '').length <= 7, 'a few lines');
  for (const word of [/em construção/, /0\.0\.1/, /npm/]) assert.match(flat, word);
  assert.ok(body.includes('(docs/guia.md#status)'));
  assert.ok(flat.includes(PT_LATEST_TAG));
});

test('README.md: "Quer mais?" links the complete guide, the docs that matter, the English guide, the CHANGELOG, CONTRIBUTING and the license', () => {
  const body = section(readme, '## Quer mais?');
  for (const target of ['docs/guia.md', 'docs/scheduling.md', 'docs/connectors.md', 'docs/security.md', 'docs/incident-response.md', 'docs/guide.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE']) {
    assert.ok(body.includes(`](${target})`), `no link to ${target}`);
  }
  assert.ok(body.includes('[English version of the complete guide](docs/guide.md)'));
});

test('README.md: in Portuguese a non-developer reads: one name for the push check, and none of the words the stranger listed', () => {
  assert.ok(readme.includes('trava de push'));
  assert.doesNotMatch(readme, /\bgates?\b/i, 'the push check is "trava de push" everywhere');
  for (const fragment of ['best effort', 'overlay de prompt', 'tarball']) assert.ok(!readme.includes(fragment), `"${fragment}" is in the text`);
  for (const pattern of [/\bpipe\b/, /árvore de trabalho/, /\bfrontmatter YAML\b/, /CLI do GitHub/, /\bcurrent LTS\b|\bLTS atual\b|\bLTS mais recente\b/i]) assert.doesNotMatch(readme, pattern);
  assert.doesNotMatch(norm(readme), /Node\.js 24 ou mais novo/);
});

// ------------------------------------------- docs/guia.md, the guide in Portuguese

const guia = read(GUIA);

test('docs/guia.md: opens with what the kit is, sends a newcomer to the README, and the phase history lives in its Status section', () => {
  const opening = guia.slice(0, guia.indexOf('\n## '));
  assert.match(norm(opening), /Open Knowledge Format \(OKF\) v0\.2/);
  assert.match(opening, /pull request/);
  assert.ok(opening.includes('](../README.md)') && opening.includes('](guide.md)'));
  assert.doesNotMatch(opening, /\bfase\b|em construção/i, 'the opening is not the phase history');
  const status = section(guia, '## Status');
  for (const fact of ['flock', 'watermark import', '01/10/2026', '0.1.0']) assert.ok(status.includes(fact), `Status lost: ${fact}`);
  assert.match(status, /\bfase\b|em construção/i);
});

test('docs/guia.md: what moved to the README is linked, not repeated', () => {
  for (const heading of ['## Requisitos', '## Seu primeiro vault', '## Passo a passo', '## Se travar', '### Se aparecer `EACCES`', '### Palavras que você vai ver']) {
    assert.ok(!guia.split('\n').includes(heading), `the guia repeats ${heading}`);
  }
  assert.ok(!guia.includes('> **Comece aqui.**'));
  assert.ok(!fencedBlocks(guia).some((block) => block.includes(SNIPPET[0])), 'the install snippet lives in the README');
  for (const anchor of ['passo-a-passo', 'se-aparecer-eacces', 'para-atualizar-depois', 'palavras-que-você-vai-ver']) assert.ok(guia.includes(`](../README.md#${anchor})`), `no link to the README's ${anchor}`);
});

test('docs/guia.md: the install details and the first vault in detail keep what the README leaves out', () => {
  const install = norm(section(guia, '## Instalando uma versão fixa'));
  for (const fact of ['`npm i -g github:aleckyann/brain-kit#<tag>`', '`EALLOWGIT`', '`claude plugin marketplace add aleckyann/brain-kit`', 'O trecho já apaga o arquivo `.tgz` que ele mesmo criou', 'As seis primeiras linhas instalam o kit']) assert.ok(install.includes(fact), `the install details lost: ${fact}`);
  const first = norm(section(guia, '## O primeiro vault, em detalhe'));
  for (const fact of ['`--from-answers <arquivo>`', '`--yes`', 'o `init` não cria repositório nem remoto', 'a skill `curate-session` também faz', 'A skill `approve` faz o mesmo', 'São os três comandos que o próprio `init` imprime']) assert.ok(first.includes(fact), `the first vault in detail lost: ${fact}`);
});

test('docs/guia.md: the sections are in order: install, first vault, second machine, the repository, the commands', () => {
  const at = (heading) => guia.split('\n').indexOf(heading);
  const order = ['## Instalando uma versão fixa', '## O primeiro vault, em detalhe', '## O mesmo vault em uma segunda máquina', '## O que há no repositório', '## O que funciona hoje', '## O curador agendado', '## Agenda e notas de reunião', '## O briefing matinal', '## Privacidade: o que o curador guarda', '## O plugin do Claude Code', '## Status'].map(at);
  assert.ok(order.every((index) => index !== -1), `a section is missing: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the sections are out of order');
});

test('docs/guia.md: the commands use brain-kit, with one way to run from a clone, and the language is said', () => {
  const works = section(guia, '## O que funciona hoje');
  assert.ok(works.includes('node <clone>/bin/brain-kit.mjs'));
  for (const block of fencedBlocks(works)) assert.doesNotMatch(block, /node brain-kit\/bin\/brain-kit\.mjs/);
  assert.ok(fencedBlocks(works).join('\n').includes('brain-kit init '));
  assert.ok(guia.includes('BRAIN_KIT_LANG') && guia.includes('init --lang'));
  for (const variable of ['LC_ALL', 'LC_MESSAGES', 'LANG']) assert.ok(guia.includes(variable), variable);
});

test('docs/guia.md: the repository section says which Nodes the engine runs on, and keeps every fact it had', () => {
  const repo = norm(section(guia, '## O que há no repositório'));
  assert.match(repo, /roda no Node\.js 22 e no 24/);
  assert.match(repo, /os dois são testados/);
  for (const fact of ['`second-brain-kit`', '`brainkit`', 'SessionStart', 'claude plugin marketplace add aleckyann/brain-kit', '`preflight`']) assert.ok(repo.includes(fact), `the repository section lost: ${fact}`);
  assert.doesNotMatch(norm(guia), /Node\.js 24 ou mais novo|O motor é Node\.js 24/);
});

test('docs/guia.md: the scheduled curator, the calendar and the briefing keep what each one needs', () => {
  const curator = section(guia, '## O curador agendado');
  for (const word of ['loginctl enable-linger', 'launchd', 'cron', 'Windows']) assert.ok(curator.includes(word), `the scheduled-curator section lost: ${word}`);
  const calendar = section(guia, '## Agenda e notas de reunião');
  assert.ok(calendar.includes('Google Calendar') && calendar.includes('Google Drive'));
  assert.match(norm(calendar), /ativados para o Claude Code/);
  assert.match(norm(section(guia, '## O briefing matinal')), /exige o aplicativo Claude para desktop/);
});

test('docs/guia.md: the second machine is a section of its own, in the order docs/scheduling.md gives', () => {
  const body = section(guia, '## O mesmo vault em uma segunda máquina');
  assert.deepEqual(fencedBlocks(body).flatMap((block) => block.split('\n')), SECOND_MACHINE);
  assert.equal(body.split('\n').filter((line) => /^\d+\. /.test(line)).length, 5);
  assert.ok(body.includes('](scheduling.md#the-same-vault-on-a-second-machine)'));
  assert.ok(body.includes('](../README.md#passo-a-passo)'), 'steps 1 and 2 are the README\'s');
  const words = norm(body);
  assert.match(words, /Deixe só uma máquina rodar as rodadas do curador/);
  // A vault made by this version needs no edit; one made before it lists its project by the
  // first machine's name, and the doctor's own way out is named, step by step.
  assert.match(words, /Um vault criado por esta versão do `init` não precisa de edição nenhuma na segunda máquina/);
  assert.match(words, /Um vault criado antes da 0\.0\.9 lista o projeto pelo nome que ele tinha na primeira máquina/);
  assert.ok(words.includes('Não ponha no `brain-kit.config.json` o nome do projeto desta máquina para fazer o `doctor` calar'));
  const first = words.search(/Primeiro, instale esta versão do kit em todas as máquinas que abrem o vault: /);
  // `update` runs ONCE, on the machine that edits the file (the final review of 0.0.9, M2).
  const once = words.search(/rode `brain-kit update` dentro do vault uma vez, na máquina em que você vai editar o arquivo; nas outras máquinas, só instale o kit, e elas recebem a mudança com `brain-kit sync` depois do merge/);
  const proposal = words.indexOf('`brain-kit propose "Usa {vault}" --only brain-kit.config.json`');
  assert.ok(first !== -1 && first < once && once < proposal, 'the kit on every machine, then update once, then the proposal');
  assert.doesNotMatch(words, /em todas as máquinas que abrem o vault e rode `brain-kit update`/);
  for (const pattern of [/um kit mais velho que a 0\.0\.9 lê `"\{vault\}"` como o nome de um projeto e falha na mesma checagem/, /troque o nome que está em `sources\.transcripts\.include_projects` por `"\{vault\}"`/, /depois de `--only`, ponha também qualquer outro arquivo que o `update` disse ter mudado/, /Não faça você mesmo o commit desse arquivo antes do merge do pull request/, /imprime os mesmos três passos quando termina, na mesma ordem/]) assert.match(words, pattern);
  assert.ok(body.includes('](scheduling.md#before-the-first-round)'));
  assert.ok(read('docs/scheduling.md').split('\n').includes('## Before the first round'), 'which exists');
  const doc = read('docs/scheduling.md');
  const part = doc.slice(doc.indexOf('## The same vault on a second machine'), doc.indexOf('## Moving from a legacy lock'));
  const docCommands = part.split('\n').filter((line) => /^\d+\. `/.test(line)).map((line) => /`([^`]+)`/.exec(line)[1]);
  assert.deepEqual(docCommands, SECOND_MACHINE.slice(2), 'the guia and docs/scheduling.md give the same commands in the same order');
});

test('docs/guia.md: one name for the push check, and the English fragments the stranger listed are gone before the Status table', () => {
  assert.ok(guia.includes('trava de push'));
  // `.githooks/install-gate` is a file name, not the push check.
  assert.doesNotMatch(guia.replace(/install-gate/g, ''), /\bgates?\b/i);
  const beforeStatus = guia.slice(0, guia.indexOf('\n## Status\n'));
  for (const fragment of ['best effort', 'overlay de prompt', 'tarball']) assert.ok(!beforeStatus.includes(fragment), `"${fragment}" is still in the text`);
  assert.match(guia, /um prompt do próprio vault \(`briefing\.prompt`\)/, 'the overlay is described in Portuguese');
});

// --------------------------------------------- docs/guide.md, the guide in English
//
// The English README moved as it was: its first-run path, its box and its glossary keep the
// pins they had (0.0.9, task G1). They check the text; the commands the text gives were run
// by hand against the integrated CLI (the task reports list them).

const guide = read(GUIDE);
const SPEC = {
  requirements: '## Requirements',
  install: '## Installing a fixed version',
  first: '## Your first vault',
  works: '## What works today',
  status: '## Status',
  second: '## The same vault on a second machine',
  repo: '## What is in the repository',
  curator: '## The scheduled curator',
  calendar: '## Calendar and meeting notes',
  briefing: '## The morning briefing',
  eacces: '### If you see `EACCES`',
  stuck: '**If you get stuck**',
  box: '> **Start here.**',
  glossary: '**Words you will see**',
};
const guideStep = (n) => itemOf(section(guide, SPEC.first), n);

test('docs/guide.md: requirements come before the install, the first vault right after it, then the second machine, the repository and the commands', () => {
  const at = (heading) => guide.split('\n').indexOf(heading);
  const order = [SPEC.requirements, SPEC.install, SPEC.first, SPEC.second, SPEC.repo, SPEC.works, SPEC.status].map(at);
  assert.ok(order.every((index) => index !== -1), `a section is missing: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the sections are out of order');
  assert.ok(guide.includes('](../README.md)') || guide.includes('](guia.md)'), 'it points at the Portuguese documents');
});

test('docs/guide.md: opens with what the kit is, and the phase history lives in the Status section', () => {
  const opening = guide.slice(0, guide.indexOf('\n## '));
  assert.doesNotMatch(opening, /\bphase\b|under construction/i);
  assert.match(opening, /OKF|Open Knowledge Format/);
  assert.match(opening, /pull request/);
  assert.doesNotMatch(opening, /npm package/, 'the opening no longer carries the long description');
  const status = section(guide, SPEC.status);
  for (const fact of ['flock', 'watermark import', '01/10/2026', '0.1.0']) assert.ok(status.includes(fact), `Status lost: ${fact}`);
  assert.match(status, /\bphase\b|under construction/i);
});

test('docs/guide.md: a "start here" box follows the two-sentence description: at most 12 lines, seven steps with their minutes, honest about the time', () => {
  const { lines, before } = startBox(guide, SPEC.box);
  assert.equal(before[0], '# brain-kit');
  assert.ok(!before.some((line) => /^## /.test(line)), 'the box comes before any section');
  const description = before.slice(1).join('\n').trim();
  assert.ok(!description.includes('\n\n'), 'the description is one paragraph');
  assert.equal(norm(description).split(/(?<=[.!?])\s+(?=[A-Z])/).length, 2, 'the description has two sentences');
  assert.ok(lines.length <= 12, `the box has ${lines.length} lines`);
  const flat = norm(lines.map((line) => line.replace(/^>\s?/, '')).join(' '));
  const whole = Number(/about (\d+) minutes the first time/.exec(flat)?.[1]);
  const reading = Number(/about (\d+) of reading/.exec(flat)?.[1]);
  for (const word of [/estimates/, /not a promise/, /account ready/, /Node\.js 22 or newer \(24 LTS is recommended\)/, /\bgit\b/, /`gh`/, /Claude Code/, /GitHub account/]) assert.match(flat, word);
  assert.doesNotMatch(flat, /clean machine/, 'a clean machine would have to install them first');
  const steps = lines.map((line) => line.replace(/^>\s?/, '')).filter((line) => /^\d+\. /.test(line));
  assert.equal(steps.length, 7);
  const minutes = steps.map((item) => Number(/\b(\d+) min\b/.exec(item)?.[1]));
  assert.deepEqual(minutes, [2, 3, 1, 3, 3, 1, 8]);
  const total = minutes.reduce((sum, value) => sum + value, 0);
  assert.ok(reading >= 10 && reading + total <= whole && whole - (reading + total) <= 5 && whole >= 30 && whole <= 40, `${reading} + ${total} against ${whole}`);
  assert.ok(flat.includes(`${total} for the steps below`));
  ['gh auth login', 'brain-kit doctor', 'brain-kit init ~/my-brain', 'git add -A', 'gh repo create my-brain --private --source . --push', 'brain-kit propose'].forEach((command, index) => assert.ok(steps[index + 1].includes(command), `step ${index + 2} names ${command}`));
  assert.ok(steps[4].includes('git commit'));
  assert.match(steps[2], /outside any vault/);
  assert.ok(steps[0].includes('(#installing-a-fixed-version)'), 'step 1 links the install snippet');
  assert.ok(flat.includes('(#your-first-vault)'), 'the box links the first-vault section');
  steps.forEach((item, index) => assert.match(item, /\]\(#[^)\s]+\)/, `step ${index + 1} links to its detail`));
  assert.doesNotMatch(`${lines.join('\n')}\n${section(guide, SPEC.first)}`, /\bexits? (with )?0\b|\bexit code\b/i, 'the screen shows no exit code');
});

test('docs/guide.md: a glossary of 10 to 12 words sits right after the box', () => {
  const { after } = startBox(guide, SPEC.box);
  assert.ok(after.join('\n').trimStart().startsWith(SPEC.glossary));
  const table = [];
  for (const line of after.slice(after.indexOf(SPEC.glossary) + 1)) {
    if (line.startsWith('|')) table.push(line);
    else if (table.length > 0) break;
  }
  const entries = table.slice(2);
  assert.ok(entries.length >= 10 && entries.length <= 12, `${entries.length} entries`);
  const words = entries.map((row) => row.split('|')[1].trim()).join(' ').toLowerCase();
  for (const term of ['terminal', 'PATH', 'repository', 'branch', 'commit', 'pull request', 'merge', 'vault', 'push gate', 'hook', 'skill', 'plugin', 'marketplace']) assert.ok(words.includes(term.toLowerCase()), `the glossary lacks: ${term}`);
});

test('docs/guide.md: the requirements are what the first pull request needs; the rest moved to where it is introduced', () => {
  const requirements = section(guide, SPEC.requirements);
  assert.match(norm(requirements), /Node\.js 22 or newer \(24 LTS is recommended\)/);
  assert.ok(requirements.includes('`gh`') && requirements.includes('gh auth login') && requirements.includes('Claude Code'));
  assert.match(requirements, /node --version/);
  for (const word of [/systemd/i, /linger/i, /launchd/i, /\bcron\b/i, /Windows/, /Google/, /desktop/i]) assert.doesNotMatch(requirements, word);
  assert.match(requirements, /optional/);
  assert.ok(requirements.includes('(scheduling.md)') && requirements.includes('(#the-scheduled-curator)'));
  const curator = section(guide, SPEC.curator);
  for (const word of ['loginctl enable-linger', 'launchd', 'cron', 'Windows']) assert.ok(curator.includes(word), `the scheduled-curator section lost: ${word}`);
  const calendar = section(guide, SPEC.calendar);
  assert.ok(calendar.includes('Google Calendar') && calendar.includes('Google Drive'));
  assert.match(norm(calendar), /enabled for Claude Code/);
  assert.match(norm(section(guide, SPEC.briefing)), /needs the Claude desktop application/);
});

test('docs/guide.md: the repository section says which Nodes the engine runs on and that both are tested, with every fact it had', () => {
  const repo = norm(section(guide, SPEC.repo));
  assert.match(repo, /runs on Node\.js 22 and 24/);
  assert.match(repo, /both are tested/);
  for (const fact of ['`second-brain-kit`', '`brainkit`', 'SessionStart', 'claude plugin marketplace add aleckyann/brain-kit', '`preflight`']) assert.ok(repo.includes(fact), `the moved text lost: ${fact}`);
  assert.doesNotMatch(norm(guide), /Node\.js 24 or newer|The engine is Node\.js 24|\bcurrent LTS\b|\blatest LTS\b/i);
});

test('docs/guide.md: the install snippet, the folders, the upgrade and the EACCES block', () => {
  const install = section(guide, SPEC.install);
  const blocks = fencedBlocks(install);
  assert.equal(blocks[0], SNIPPET.join('\n'));
  assert.equal(blocks[1], UPDATE_BLOCK, 'the second block of the install section records the version');
  const words = norm(prose(install));
  assert.ok(words.includes('The `brain-kit` folder that the first line cloned'));
  assert.match(words, /is no longer used and can be deleted/);
  assert.match(words, /\*\*must not be deleted\*\*/);
  assert.match(words, /delete the `brain-kit` folder that the first line cloned, if it is still there \(otherwise the snippet reuses that old copy and installs the old version\)/);
  assert.match(words, /The folders of older versions under `~\/\.local\/share\/brain-kit\/` are no longer used and can be deleted; the newest must stay/);
  const flat = install.split('\n');
  const at = (needle) => flat.findIndex((line) => line.includes(needle));
  assert.ok(at(UPDATE_BLOCK) > at(SNIPPET[7]) && at(UPDATE_BLOCK) < at(SPEC.eacces), 'the update comes after the snippet and before the EACCES block');
  const eacces = section(guide, SPEC.eacces);
  assert.deepEqual(fencedBlocks(eacces), EACCES_BLOCKS);
  const eaccesWords = norm(prose(eacces));
  for (const word of [/nvm/, /`sudo`/, /Close the terminal and open a new one/]) assert.match(eaccesWords, word);
  assert.ok(eaccesWords.includes('the list of folders where the terminal looks for the commands you type'));
  assert.ok(eaccesWords.includes('paste the install snippet again'));
  assert.ok(fencedBlocks(install).some((block) => block.includes('npm pack --silent && npm i -g ')), 'the snippet packs with --silent');
});

test('docs/guide.md: the first vault is a numbered sequence from gh login to the merged pull request', () => {
  const first = section(guide, SPEC.first);
  assert.ok(first.split('\n').filter((line) => /^\d+\. /.test(line)).length >= 10);
  const commands = fencedBlocks(first).join('\n');
  for (const command of ['gh auth login', 'brain-kit init ~/my-brain', 'cd ~/my-brain', 'git add -A', 'git commit', 'gh repo create my-brain --private --source . --push', 'brain-kit doctor', 'brain-kit propose "', '--only memory/log.md']) {
    assert.ok(commands.includes(command), `no command block holds: ${command}`);
  }
  for (const word of ['--from-answers', '--yes', 'private', 'memory/log.md', 'Stop']) assert.ok(first.includes(word), `the first vault does not mention: ${word}`);
  // The doctor is run twice: once before any vault exists, after the login, and once in the vault, after the push.
  const all = `\n${commands}\n`;
  const machineCheck = all.indexOf('brain-kit doctor');
  const order = [all.indexOf('gh auth login'), machineCheck, all.indexOf('brain-kit init'), all.indexOf('git commit'), all.indexOf('gh repo create'), all.indexOf('brain-kit doctor', machineCheck + 1), all.indexOf('\nclaude\n'), all.indexOf('brain-kit propose')];
  assert.ok(order.every((index) => index !== -1), `a command is missing: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the commands are out of order');
  const works = section(guide, SPEC.works);
  assert.ok(works.includes('node <clone>/bin/brain-kit.mjs'));
  for (const block of fencedBlocks(works)) assert.doesNotMatch(block, /node brain-kit\/bin\/brain-kit\.mjs/);
  assert.ok(guide.includes('BRAIN_KIT_LANG') && guide.includes('init --lang'));
  for (const variable of ['LC_ALL', 'LC_MESSAGES', 'LANG']) assert.ok(guide.includes(variable), variable);
});

test('docs/guide.md: each step of the first vault says what the screen shows', () => {
  assert.deepEqual(fencedBlocks(guideStep(2)), ['gh auth login']);
  assert.deepEqual(fencedBlocks(guideStep(3)), ['brain-kit doctor']);
  assert.match(norm(guideStep(3)), /checks only the machine: Node, git, `gh` and its login, and Claude Code\. All is well when the line that starts with `doctor:` ends with `0 fail`/);
  assert.match(norm(guideStep(3)), /The message "no brain-kit vault found", which comes right after it, is expected/);
  assert.ok(items(section(guide, SPEC.first))[0].includes('(#installing-a-fixed-version)'), 'step 1 is the install');
  const pack = JSON.parse(read('lang/en/messages.json'));
  assert.ok(pack['init.ask_handle'].startsWith(pack['init.label_handle']));
  assert.ok(norm(guideStep(4)).includes(`"${pack['init.label_handle']}"`) && /accept the suggestion/.test(guideStep(4)) && /Enter/.test(guideStep(4)));
  assert.doesNotMatch(guideStep(4), /handle/i, 'no screen says "handle"');
  const five = guideStep(5);
  assert.equal(fencedBlocks(five).length, 2);
  assert.deepEqual(fencedBlocks(five)[1].split('\n'), ['git config --global user.name "Your Name"', 'git config --global user.email "you@example.com"']);
  assert.ok(five.indexOf('Author identity unknown') > five.indexOf('git commit') && five.includes('example.com'));
  assert.match(norm(five), /git records who made each commit/);
  const seven = guideStep(7);
  for (const word of ['`fail`', '`warn`', '--verbose']) assert.ok(seven.includes(word), `step 7 lacks ${word}`);
  for (const word of ['`falha`', '`aviso`']) assert.ok(!seven.includes(word), `step 7 uses ${word}`);
  assert.match(norm(seven), /only the warnings and the failures, with a count of the `ok` lines/);
  assert.match(norm(seven), /its last line ends with `0 fail`/);
  const nine = guideStep(9);
  assert.ok(nine.includes('`**Capture**`') && nine.includes('`**Captura**`') && nine.includes('`memory/log.md`') && nine.includes('`memoria/log.md`'));
  assert.ok(norm(guideStep(10)).includes('Leave the changed file uncommitted until the pull request is merged (step 11)') && guideStep(10).includes('diverged'));
  assert.ok(norm(guideStep(11)).includes('nothing to stamp, and nothing was written'));
  assert.doesNotMatch(guideStep(11), /exits? 0/);
});

test('docs/guide.md: the second machine is a section of its own, in the order docs/scheduling.md gives', () => {
  const body = section(guide, SPEC.second);
  assert.deepEqual(fencedBlocks(body).flatMap((block) => block.split('\n')), SECOND_MACHINE);
  assert.equal(body.split('\n').filter((line) => /^\d+\. /.test(line)).length, 5);
  assert.ok(body.includes('](scheduling.md#the-same-vault-on-a-second-machine)') && body.includes('](scheduling.md#before-the-first-round)'));
  const words = norm(body);
  for (const pattern of [/Let only one machine run the curator's rounds/, /A vault created by this version of `init` needs no edit on the second machine/, /A vault created before 0\.0\.9 lists its project by the name it had on the first machine/, /a kit older than 0\.0\.9 reads `"\{vault\}"` as the name of a project, and fails the same check/, /replace the name in `sources\.transcripts\.include_projects` with `"\{vault\}"`/, /after `--only`, add any other file that `update` said it changed/, /Do not commit that file yourself before the pull request is merged/, /prints the same three steps after it finishes, in the same order/]) assert.match(words, pattern);
  assert.ok(words.includes('Do not put this machine\'s project name in `brain-kit.config.json` to silence the `doctor`'));
  const first = words.search(/First install this version of the kit on every machine that opens the vault: /);
  const once = words.search(/run `brain-kit update` in the vault once, on the machine where you will edit the file; the other machines only install the kit, and receive the change with `brain-kit sync` after the merge/);
  assert.ok(first !== -1 && first < once && once < words.indexOf('`brain-kit propose "Use {vault}" --only brain-kit.config.json`'));
  assert.doesNotMatch(words, /on every machine that opens the vault and run `brain-kit update`/);
});

test('docs/guide.md: "If you get stuck" closes the first vault: the five likeliest traps and one secrets line, in at most 8 lines', () => {
  const lines = section(guide, SPEC.first).split('\n');
  const start = lines.indexOf(SPEC.stuck);
  assert.notEqual(start, -1);
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || lines[end].startsWith('- '))) end += 1;
  const block = lines.slice(start, end);
  while (block.at(-1) === '') block.pop();
  assert.ok(block.length <= 8, `the block has ${block.length} lines`);
  assert.ok(lines.slice(end).every((line) => line.trim() === ''), 'it is the last thing in the first-vault section');
  const list = block.filter((line) => line.startsWith('- '));
  assert.equal(list.length, 6);
  [/EACCES/, /`gh auth login`/, /`propose`.*commit.*`git push -u origin HEAD`/, /command not found.*Successfully installed.*whole .*EACCES/, /`doctor`.*fail.*gh auth login --hostname github\.com/, /incident-response\.md/].forEach((pattern, index) => assert.match(list[index], pattern, `trap ${index + 1}`));
  assert.doesNotMatch(list[2], /configuration/);
  assert.doesNotMatch(list[3], /redo the PATH/);
  assert.equal(list.filter((line) => line.includes('docs/incident-response.md')).length, 1);
  assert.match(list[5], /password|key/i);
  assert.ok(list[0].includes('(#if-you-see-eacces)'));
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
