import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { makeTempDir } from './helpers/tmp.mjs';
import { SKILL_NAMES } from '../src/commands/prompt.mjs';

const read = (p) => JSON.parse(readFileSync(join(KIT_ROOT, p), 'utf8'));
const pkg = read('package.json');

test('plugin.json names the plugin brain-kit and mirrors the package version', () => {
  const plugin = read('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'brain-kit');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, 'MIT');
  assert.ok(Array.isArray(plugin.keywords));
});

test('marketplace.json lists exactly this plugin from the repo root', () => {
  const market = read('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'brain-kit');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'brain-kit');
  assert.equal(market.plugins[0].source, './');
  assert.equal(market.plugins[0].version, pkg.version);
});

test('hooks.json declares Stop and SessionStart through an existing wrapper', () => {
  const hooks = read('hooks/hooks.json').hooks;
  assert.ok(hooks.Stop, 'Stop hook missing');
  assert.ok(hooks.SessionStart, 'SessionStart hook missing');
  for (const group of [...hooks.Stop, ...hooks.SessionStart]) {
    for (const hook of group.hooks) {
      assert.equal(hook.type, 'command');
      const command = hook.command.replace('${CLAUDE_PLUGIN_ROOT}', KIT_ROOT);
      const script = command.match(/^"([^"]+)"/)[1];
      assert.ok(existsSync(script), `${script} does not exist`);
      assert.ok(hook.timeout <= 15, 'hook timeout must stay short');
    }
  }
});

test('run-hook.cmd is executable and routes to the engine as a silent no-op', () => {
  const wrapper = join(KIT_ROOT, 'hooks', 'run-hook.cmd');
  assert.ok(statSync(wrapper).mode & 0o111, 'run-hook.cmd must be executable');
  // Claude Code runs hook commands through a shell; the wrapper has no shebang
  // (the first line is the cmd.exe half), so spawn it through a shell as
  // Claude Code would. Check both bash and the plain POSIX sh some machines
  // point /bin/sh at (e.g. dash), since the wrapper relies on no bash-only syntax.
  // Since slice E the hook finds a vault from the payload's cwd, else
  // CLAUDE_PROJECT_DIR, else its own directory: run it from a directory
  // that is no vault, with no CLAUDE_PROJECT_DIR inherited from the runner.
  const { CLAUDE_PROJECT_DIR: _ignored, ...env } = process.env;
  const cwd = makeTempDir('brain-kit-plugin-');
  for (const shell of ['bash', 'sh']) {
    const r = spawnSync(shell, [wrapper, 'stop'], { input: '{"stop_hook_active":false}', encoding: 'utf8', env, cwd });
    assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${shell}: unexpected stdout`);
  }
});

test('claude plugin validate --strict passes when the CLI is installed', (t) => {
  const which = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (which.error || which.status !== 0) return t.skip('claude CLI not installed');
  const r = spawnSync('claude', ['plugin', 'validate', '--strict', '.'], { cwd: KIT_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// --- skills and the read-only subagent (phase 1 slice E, task 4) --------

const SKILLS_DIR = join(KIT_ROOT, 'skills');

function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, 'file must open with a frontmatter block');
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2];
  }
  return { fields, body: match[2] };
}

test('the set of skill directories equals SKILL_NAMES', () => {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(dirs, [...SKILL_NAMES].sort());
});

test('every SKILL.md names its directory, describes itself in ASCII English and only runs brain-kit prompt for itself', () => {
  for (const name of readdirSync(SKILLS_DIR)) {
    const file = join(SKILLS_DIR, name, 'SKILL.md');
    assert.ok(existsSync(file), `${name}/SKILL.md missing`);
    const { fields, body } = frontmatterOf(readFileSync(file, 'utf8'));
    assert.equal(fields.name, name);
    assert.match(fields.description, /^[\x20-\x7e]+$/, `${name}: description must be printable ASCII`);
    assert.match(fields.description, /^Use (when|at|after) /, `${name}: description must start with "Use when", "Use at" or "Use after"`);
    const lines = body.split('\n').filter((line) => line.trim() !== '');
    assert.deepEqual(lines, [`!\`node "\${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill ${name}\``], `${name}: the body must be the single ! line`);
  }
});

test('the vault-reader agent declares exactly Read, Grep, Glob', () => {
  const { fields, body } = frontmatterOf(readFileSync(join(KIT_ROOT, 'agents', 'vault-reader.md'), 'utf8'));
  assert.equal(fields.name, 'vault-reader');
  assert.match(fields.description, /^[\x20-\x7e]+$/);
  assert.equal(fields.tools, 'Read, Grep, Glob');
  assert.match(body, /index\.md/);
});

test('brain-kit prompt --check exits 0 on the shipped packs', () => {
  const r = spawnSync(process.execPath, [join(KIT_ROOT, 'bin', 'brain-kit.mjs'), 'prompt', '--check'], {
    encoding: 'utf8', env: { ...process.env, BRAIN_KIT_LANG: 'en' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('plugin.json no longer describes the plugin as phase 0', () => {
  assert.doesNotMatch(read('.claude-plugin/plugin.json').description, /Phase 0/);
});

// --- eval cases (phase 1 slice E, task 5) --------------------------------

const EVALS_DIR = join(KIT_ROOT, 'evals');
const EVAL_LANGS = ['pt-BR', 'en'];
const PROMPT_KEYS = new Set(['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'artifact_publish', 'growthbook_overrides', 'append_system_prompt', 'env']);

function evalFile(skill, lang, ...parts) {
  return readFileSync(join(EVALS_DIR, `${skill}-${lang}`, ...parts), 'utf8');
}

test('evals/ holds exactly one case per skill and language', () => {
  const expected = SKILL_NAMES.flatMap((skill) => EVAL_LANGS.map((lang) => `${skill}-${lang}`)).sort();
  const dirs = readdirSync(EVALS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(dirs, expected);
});

test('every eval case has prompt.md with the agreed frontmatter and both graders', () => {
  for (const skill of SKILL_NAMES) {
    for (const lang of EVAL_LANGS) {
      const where = `${skill}-${lang}`;
      const { fields, body } = frontmatterOf(evalFile(skill, lang, 'prompt.md'));
      for (const key of Object.keys(fields)) assert.ok(PROMPT_KEYS.has(key), `${where}: unknown prompt.md key ${key}`);
      assert.equal(fields.max_turns, '6', where);
      assert.equal(fields.runs, '1', where);
      assert.equal(fields.allowed_tools, '[Read, Glob, Grep, Skill]', where);
      assert.equal(fields.tags, `[${skill}, ${lang}]`, where);
      assert.notEqual(body.trim(), '', `${where}: empty prompt`);

      const tool = frontmatterOf(evalFile(skill, lang, 'graders', 'skill.md')).fields;
      assert.deepEqual(tool, { type: 'tool_used', tool: 'Skill', weight: '1' }, where);

      const criteria = frontmatterOf(evalFile(skill, lang, 'graders', 'criteria.md'));
      assert.deepEqual(criteria.fields, { type: 'llm', weight: '1' }, where);
      assert.notEqual(criteria.body.trim(), '', `${where}: empty criteria`);
    }
  }
});

test('no eval prompt names its own skill, and no eval file keeps the blank template marker', () => {
  for (const skill of SKILL_NAMES) {
    const word = new RegExp(`(^|[^\\w-])${skill.replace(/-/g, '\\-')}($|[^\\w-])`, 'i');
    for (const lang of EVAL_LANGS) {
      const { body } = frontmatterOf(evalFile(skill, lang, 'prompt.md'));
      assert.doesNotMatch(body, word, `${skill}-${lang}: the prompt names the skill`);
      for (const file of [['prompt.md'], ['graders', 'skill.md'], ['graders', 'criteria.md']]) {
        assert.doesNotMatch(frontmatterOf(evalFile(skill, lang, ...file)).body, /TODO:/, `${skill}-${lang}/${file.join('/')}`);
      }
    }
  }
});

test('evals stay out of the npm package', () => {
  assert.ok(!pkg.files.some((entry) => entry.startsWith('evals')));
});

test('the seven SKILL.md descriptions are exactly the agreed text', () => {
  const expected = {
    setup: 'Use when the person wants to start a second brain with brain-kit, adopt an existing markdown vault, or check that the kit, git, gh and the plugin are ready on this machine.',
    'curate-session': "Use at the end of a working session in a brain-kit vault, or when asked to curate: sync, capture what was learned, compile it into notes, validate, lint and open a pull request with only this session's files.",
    capture: 'Use when the person says something new, changes their mind, or a fact conflicts with the brain-kit vault, and it should be written down now as a dated entry in the vault log without compiling notes.',
    ask: "Use when the person asks a question the brain-kit vault may answer: read from the root index down, only the notes needed, and answer with the vault's closed uncertainty states.",
    lint: 'Use when brain-kit validate or lint reported problems, or the person asks what a lint rule means and how to fix what it found.',
    'review-stale': 'Use when notes in the brain-kit vault are past their stale_after date, or the person asks to review what may be out of date.',
    approve: 'Use after the owner merged a brain-kit pull request and wants the merged notes stamped verified.',
  };
  for (const name of SKILL_NAMES) {
    assert.equal(frontmatterOf(readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')).fields.description, expected[name], name);
  }
});

test('no eval case description names its skill', () => {
  for (const skill of SKILL_NAMES) {
    const word = new RegExp(`(^|[^\\w-])${skill.replace(/-/g, '\\-')}($|[^\\w-])`, 'i');
    for (const lang of EVAL_LANGS) {
      assert.doesNotMatch(frontmatterOf(evalFile(skill, lang, 'prompt.md')).fields.description, word, `${skill}-${lang}`);
    }
  }
});

test('the setup body runs init from an answers file, never interactively', () => {
  for (const lang of ['en', 'pt-BR']) {
    const body = readFileSync(join(KIT_ROOT, 'lang', lang, 'skills', 'setup.md'), 'utf8');
    assert.match(body, /\{\{kit\}\} init <dir> --from-answers /, lang);
    assert.match(body, /\{\{kit\}\} init --adopt <dir> --from-answers /, lang);
    for (const key of ['lang', 'name', 'handle', 'title', 'repo', 'private', 'timezone']) assert.match(body, new RegExp(`"${key}"`), `${lang}: ${key}`);
    assert.match(body, /\.githooks\/pre-push/, lang);
    assert.match(body, /core\.hooksPath/, lang);
  }
});
