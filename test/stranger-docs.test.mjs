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

  test(`${spec.file}: the requirements name Node 24, git, a logged-in gh and Claude Code`, () => {
    const requirements = section(text, spec.requirements);
    assert.match(requirements, /Node\.js (>= 24|24)/);
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
    // The order of the commands is the order of the sequence.
    const order = ['gh auth login', 'brain-kit init', 'git commit', 'gh repo create', 'brain-kit doctor', '\nclaude\n', 'brain-kit propose'].map((c) => `\n${commands}\n`.indexOf(c));
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
      ? { uncommitted: 'Leave the changed file uncommitted until the pull request is merged (step 11)', diverged: 'diverged', stamp: 'there is nothing to stamp and exits 0' }
      : { uncommitted: 'Deixe o arquivo alterado sem commit até o pull request ser mergeado (passo 11)', diverged: 'divergiram', stamp: 'não há nada a carimbar e sai com 0' };
    assert.ok(propose.replace(/\s+/g, ' ').includes(words.uncommitted), 'step 10 says to leave the file uncommitted');
    assert.ok(propose.includes(words.diverged), 'step 10 says why');
    assert.ok(merge.replace(/\s+/g, ' ').includes(words.stamp), 'step 11 says verify has nothing to stamp');
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
  // Only the words a Portuguese reader reads differ: the vault's log path and the two
  // messages the example commands carry.
  const sameCommands = (block) => block.replace('memoria/log.md', 'memory/log.md').replace('Inicia o vault', 'Start the vault').replace('Primeira captura', 'First capture');
  assert.deepEqual(fencedBlocks(section(pt, READMES['pt-BR'].first)).map(sameCommands), fencedBlocks(section(en, READMES.en.first)));
  assert.deepEqual(fencedBlocks(section(pt, READMES['pt-BR'].install)), fencedBlocks(section(en, READMES.en.install)));
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

// ------------------------------------------------------------------- skills

const SKILL_SENTENCES = {
  setup: {
    en: [
      'gh repo create <name> --private --source <dir> --push',
      'Without `--push` the remote is empty and `propose` cannot work',
      '`claude --version`',
      'refuses to run outside a vault',
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
      'recusa rodar fora de um vault',
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

test('the setup skill no longer runs the doctor before a vault exists, and still ends with it', () => {
  for (const lang of ['en', 'pt-BR']) {
    const body = read(`lang/${lang}/skills/setup.md`);
    const machine = body.slice(body.indexOf('\n1. '), body.indexOf('\n4. '));
    assert.doesNotMatch(machine, /(Run|Rode) `\{\{kit\}\} doctor/, `${lang}: the machine checks run before any vault exists`);
    assert.ok(body.indexOf('--from-answers <') < body.indexOf('{{kit}} doctor <dir>'), `${lang}: the doctor runs after init`);
    assert.ok(body.indexOf('{{kit}} doctor <dir>') < body.lastIndexOf('{{kit}} doctor'), `${lang}: and once more at the end`);
    assert.ok(!/gh repo create <(name|nome)> --private --source <dir>(?! --push)/.test(body), `${lang}: every repository command pushes`);
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
