// What a round does with the person's own Claude Code allow rules when it
// runs in connector mode (phase 3, decision D3): connector mode loads the
// user settings, so every allow rule there is inherited unless the round
// mirrors it as a deny. Every settings file here lives in a scratch
// directory; the person's own ~/.claude is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockingMessage, mirrorUserRules, userSettingsFiles } from '../src/curate/user-rules.mjs';
import { KIT_SUBCOMMANDS } from '../src/curate/tools.mjs';
import { rulesIn } from '../src/harness/claude-code.mjs';
import { createTranslator, REFERENCE_LANG } from '../src/lang.mjs';
import { makeTempDir } from './helpers/tmp.mjs';

const HOME = '/home/ana';
const VAULT = '/home/ana/vault';
const KIT = '"/opt/brain-kit/bin/brain-kit.mjs"';
// The round's own allow list as src/curate/tools.mjs builds it, for this kit.
const OWN = Object.freeze([
  'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./**)', 'Write(./**)', 'ToolSearch',
  ...KIT_SUBCOMMANDS.flatMap((sub) => [`Bash(${KIT} ${sub}:*)`, `Bash(node ${KIT} ${sub}:*)`]),
]);
const NOTHING = Object.freeze({ deny: [], widenedReads: [], blocking: [], dropNodeForms: false });

function configDir(files) {
  const dir = makeTempDir('brain-kit-user-rules-');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

// The mirror of one settings.json whose permissions.allow is `allow`.
function mirrorOf(allow) {
  const dir = configDir({ 'settings.json': { permissions: { allow } } });
  const file = join(dir, 'settings.json');
  return { file, out: mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }) };
}

// --- userSettingsFiles ---------------------------------------------------------

test('userSettingsFiles lists settings.json and settings.local.json of CLAUDE_CONFIG_DIR when set, of ~/.claude otherwise, and only those that exist', () => {
  const both = configDir({ 'settings.json': {}, 'settings.local.json': {} });
  assert.deepEqual(userSettingsFiles({ CLAUDE_CONFIG_DIR: both, HOME: '/nonexistent-home' }), [join(both, 'settings.json'), join(both, 'settings.local.json')]);
  const local = configDir({ 'settings.local.json': {} });
  assert.deepEqual(userSettingsFiles({ CLAUDE_CONFIG_DIR: local }), [join(local, 'settings.local.json')]);
  assert.deepEqual(userSettingsFiles({ CLAUDE_CONFIG_DIR: configDir({ 'other.json': {} }) }), []);
  const home = makeTempDir('brain-kit-user-rules-home-');
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  assert.deepEqual(userSettingsFiles({ HOME: home }), [join(home, '.claude', 'settings.json')]);
  // CLAUDE_CONFIG_DIR wins over HOME, even when it holds nothing.
  assert.deepEqual(userSettingsFiles({ HOME: home, CLAUDE_CONFIG_DIR: configDir({}) }), []);
});

test('a CLAUDE_CONFIG_DIR that is set but not absolute, empty included, gives both names as they are, and the mirror refuses them (review M3)', () => {
  const home = makeTempDir('brain-kit-user-rules-home-');
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  assert.deepEqual(userSettingsFiles({ HOME: home, CLAUDE_CONFIG_DIR: '' }), ['settings.json', 'settings.local.json']);
  assert.deepEqual(userSettingsFiles({ HOME: home, CLAUDE_CONFIG_DIR: 'config/claude' }), [join('config', 'claude', 'settings.json'), join('config', 'claude', 'settings.local.json')]);
  assert.deepEqual(userSettingsFiles({ CLAUDE_CONFIG_DIR: '~/.claude' }), [join('~', '.claude', 'settings.json'), join('~', '.claude', 'settings.local.json')]);
  // The round's CLI resolves such a path in the vault, not where the kit runs: whatever exists here (the
  // kit's own package.json, from where the tests run) is not read.
  const files = ['package.json', ...userSettingsFiles({ HOME: home, CLAUDE_CONFIG_DIR: 'config/claude' })];
  assert.deepEqual(mirrorUserRules({ files, ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }), {
    deny: [], widenedReads: [], blocking: files.map((file) => ({ rule: null, file, reason: 'unreadable' })), dropNodeForms: false,
  });
});

// --- mirrorUserRules ---------------------------------------------------------------

test('the brief\'s rules, from settings.json and settings.local.json, one unreadable file among them: each lands where D3 says', () => {
  const dir = configDir({
    'settings.json': {
      permissions: {
        allow: [
          'Bash(rtk curl *)', 'Bash(node:*)', 'Bash', 'Bash(*)', 'Bash("/opt/brain-kit/bin/brain:*)',
          'Edit(~/**)', 'Edit(//tmp/other/**)', 'Edit(./notes/**)', 'Read', 'Read(//etc/**)',
        ],
      },
    },
    'settings.local.json': { permissions: { allow: ['mcp__claude_ai_Gmail__send_email', 'WebFetch'] } },
    'broken.json': '{"permissions": ',
  });
  const [settings, local, broken] = ['settings.json', 'settings.local.json', 'broken.json'].map((f) => join(dir, f));
  const out = mirrorUserRules({ files: [settings, broken, local], ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT });
  assert.deepEqual(out, {
    deny: ['Bash(rtk curl *)', 'Bash(node:*)', 'Edit(//tmp/other/**)', 'mcp__claude_ai_Gmail__send_email', 'WebFetch'],
    widenedReads: ['Read', 'Read(//etc/**)'],
    blocking: [
      { rule: 'Bash', file: settings, reason: 'covers_kit' },
      { rule: 'Bash(*)', file: settings, reason: 'covers_kit' },
      { rule: 'Bash("/opt/brain-kit/bin/brain:*)', file: settings, reason: 'covers_kit' },
      { rule: 'Edit(~/**)', file: settings, reason: 'covers_vault' },
      { rule: null, file: broken, reason: 'unreadable' },
    ],
    dropNodeForms: true,
  });
});

test('a user rule the round\'s own allow list already holds is skipped; one character off, it is judged like any other', () => {
  assert.deepEqual(mirrorOf([...OWN]).out, NOTHING);
  const { file, out } = mirrorOf(['Edit(./** )', `Bash(${KIT} validate)`]);
  assert.deepEqual(out.blocking, [{ rule: 'Edit(./** )', file, reason: 'covers_vault' }, { rule: `Bash(${KIT} validate)`, file, reason: 'covers_kit' }]);
  // A scoped rule for a tool the round allows bare grants nothing more, and mirrored it could deny the round's own ToolSearch.
  assert.deepEqual(mirrorOf(['ToolSearch(*)', 'ToolSearch(select:x)']).out, NOTHING);
  // The round's own list is read the way the CLI splits it: one element may hold several rules (a vault's allowed_tools_extra).
  const web = mirrorOf(['WebSearch', 'WebFetch', 'mcp__claude_ai_Gmail__send_email']).file;
  const withExtra = mirrorUserRules({ files: [web], ownAllowed: [...OWN, 'WebSearch WebFetch', null, 7], vaultRoot: VAULT, home: HOME, kit: KIT });
  assert.deepEqual(withExtra, { deny: ['mcp__claude_ai_Gmail__send_email'], widenedReads: [], blocking: [], dropNodeForms: false });
});

test('read rules are never mirrored: each one reaching outside the vault is recorded as widening reads, and one inside it is not', () => {
  const widening = ['Read', 'Read(//etc/**)', 'Glob(//**)', 'Grep(~/**)', 'LS(//home/ana/vault*)', 'Read(/**)', 'Read(./../**)', 'Glob(//home/ana/vault2/**)', 'Read( //etc/**)'];
  const inside = ['Read(./notes/**)', 'Glob(//home/ana/vault/notes/*.md)', 'Grep(notes/**)', 'LS(./no*)', 'Read(**)', 'Read(//home/ana/vault)'];
  assert.deepEqual(mirrorOf([...widening, ...inside]).out, { deny: [], widenedReads: widening, blocking: [], dropNodeForms: false });
});

test('write rules covering the vault or a folder above it refuse connector mode; inside the vault they are skipped; outside, mirrored', () => {
  const covering = ['Edit', 'Edit(~/**)', 'Write(//home/**)', 'NotebookEdit(//home/ana/vault/**)', 'MultiEdit(//home/ana/va*)', 'Write(**)', 'Edit(//**)', 'Edit(~)', 'Write(./*.md)'];
  const inside = ['Edit(./notes/**)', 'Write(./no*)', 'NotebookEdit(notes/a.ipynb)', 'Edit(./.githooks/**)'];
  // A scope is read trimmed: were a space in front of `//` read as part of a relative path, this rule would be skipped as inside the vault.
  // A folder whose name only starts like the vault's name or its parent's (va, an) is a sibling, not a holder.
  const outside = ['Edit(//tmp/other/**)', 'Write(//home/ana/vault2/**)', 'Edit(//home/an)', 'Edit(//home/ana/va/**)', 'MultiEdit(/hooks/**)', 'Write(./../other/**)', 'Edit( //tmp/other/**)'];
  const { file, out } = mirrorOf([...covering, ...inside, ...outside]);
  assert.deepEqual(out, {
    deny: outside,
    widenedReads: [],
    blocking: covering.map((rule) => ({ rule, file, reason: 'covers_vault' })),
    dropNodeForms: false,
  });
});

test('a write rule is resolved the way user settings resolve paths: //x from the root, ~/x from home, /x from the settings file\'s folder, the rest from the vault', () => {
  // The settings file's own folder is not the vault: /x there is mirrored.
  assert.deepEqual(mirrorOf(['Edit(/**)']).out.deny, ['Edit(/**)']);
  // With the vault under that folder, the same rule covers it.
  const dir = configDir({ 'settings.json': { permissions: { allow: ['Edit(/**)', 'Write(/vault/**)', 'Edit(/vault/notes/**)'] } } });
  const file = join(dir, 'settings.json');
  const out = mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot: join(dir, 'vault'), home: HOME, kit: KIT });
  assert.deepEqual(out, {
    deny: [], widenedReads: [], blocking: [{ rule: 'Edit(/**)', file, reason: 'covers_vault' }, { rule: 'Write(/vault/**)', file, reason: 'covers_vault' }], dropNodeForms: false,
  });
  // The same file, with the vault somewhere else: all three are outside it.
  assert.deepEqual(mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }).deny, ['Edit(/**)', 'Write(/vault/**)', 'Edit(/vault/notes/**)']);
  // ~ is the home given, whatever the vault's parent is.
  const tilde = mirrorOf(['Edit(~/**)']).file;
  assert.deepEqual(mirrorUserRules({ files: [tilde], ownAllowed: OWN, vaultRoot: VAULT, home: '/srv/ana', kit: KIT }).deny, ['Edit(~/**)']);
});

test('Bash rules granting every command or the kit\'s own refuse connector mode; one for node is mirrored and drops the round\'s node forms; the rest is mirrored', () => {
  const covering = [
    'Bash', 'Bash(*)', 'Bash(:*)', 'Bash( * )', 'Bash()', 'Bash("/opt/brain-kit/bin/brain:*)', `Bash(${KIT}:*)`, `Bash(${KIT} v*)`, `Bash(${KIT} lint --fix:*)`,
  ];
  const mirrored = ['Bash(rtk curl *)', `Bash(${KIT} doctor:*)`, 'Bash(node --version)', 'Bash(git status:*)', 'Bash(npm run build)'];
  const { file, out } = mirrorOf([...covering, ...mirrored]);
  assert.deepEqual(out, { deny: mirrored, widenedReads: [], blocking: covering.map((rule) => ({ rule, file, reason: 'covers_kit' })), dropNodeForms: false });
  for (const rule of ['Bash(node:*)', 'Bash(node *)', 'Bash(no*)', 'Bash(n?de:*)', `Bash(node ${KIT}:*)`, `Bash(node ${KIT} propose --x:*)`]) {
    assert.deepEqual(mirrorOf([rule]).out, { deny: [rule], widenedReads: [], blocking: [], dropNodeForms: true }, rule);
  }
});

test('every other rule is mirrored as given: MCP tools, web tools, agents', () => {
  const rules = ['mcp__claude_ai_Gmail__send_email', 'WebFetch', 'WebFetch(domain:example.com)', 'WebSearch', 'Task', 'mcp__claude_ai_Gmail', 'mcp__claude_ai_Gmail__*', 'NotebookRead'];
  assert.deepEqual(mirrorOf(rules).out, { deny: rules, widenedReads: [], blocking: [], dropNodeForms: false });
});

test('a settings file that cannot be read, is not JSON, or holds allow as anything but a list of strings refuses connector mode; the other files are still read', () => {
  const dir = configDir({
    'bad-json.json': '{"permissions": {"allow": ["Bash(ls:*)"]',
    'allow-string.json': { permissions: { allow: 'Bash(ls:*)' } },
    'allow-number.json': { permissions: { allow: ['WebFetch', 7] } },
    'allow-null.json': { permissions: { allow: null } },
    'top-array.json': ['WebFetch'],
    'top-null.json': 'null',
    'permissions-string.json': { permissions: 'WebFetch' },
    'no-permissions.json': { env: { EXAMPLE: '1' } },
    'no-allow.json': { permissions: { deny: ['WebFetch'] } },
    'settings.local.json': { permissions: { allow: ['WebSearch'] } },
  });
  mkdirSync(join(dir, 'a-directory.json'));
  const unreadable = [
    'bad-json.json', 'allow-string.json', 'allow-number.json', 'allow-null.json', 'top-array.json', 'top-null.json', 'permissions-string.json', 'a-directory.json', 'missing.json',
  ].map((f) => join(dir, f));
  const files = [...unreadable, join(dir, 'no-permissions.json'), join(dir, 'no-allow.json'), join(dir, 'settings.local.json')];
  assert.deepEqual(mirrorUserRules({ files, ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }), {
    deny: ['WebSearch'], widenedReads: [], blocking: unreadable.map((file) => ({ rule: null, file, reason: 'unreadable' })), dropNodeForms: false,
  });
});

test('a rule that is not one Tool or Tool(scope), as the CLI would split it, refuses connector mode, naming the rule', () => {
  const rules = [
    'Bash(a) Bash(b)', 'WebFetch,WebSearch', 'Bash(ls', 'Bash(ls) x', 'Read Bash', '', ' WebFetch', 'WebFetch,', '-p', 'Bash(ls\n)', 'Web\tFetch', 'mcp__x(y)z',
    'Bash(ls\t-l:*)', `Bash(ls${String.fromCharCode(1)}:*)`, `Bash(ls:*)${String.fromCharCode(0)}`, `WebFetch${String.fromCharCode(127)}`,
  ];
  const { file, out } = mirrorOf(rules);
  assert.deepEqual(out, { deny: [], widenedReads: [], blocking: rules.map((rule) => ({ rule, file, reason: 'unreadable' })), dropNodeForms: false });
});

test('a rule with a parenthesis inside its scope is never mirrored: connector mode is refused, naming it (ruling I1)', () => {
  const rules = [
    'Bash(python3 -c "print(1)" *)', 'Bash(echo $(date) ok)', 'Bash(git log --format=%s (x) y)', 'Bash(echo ))', 'Bash(echo ( x)',
    'Read(//home/ana/notes (old)/**)', 'Read(//tmp/a (b/**)', 'Edit(//tmp/a(b)/**)', 'WebFetch(domain:example.com))', 'mcp__claude_ai_Gmail__send_email(x(y))',
  ];
  const { file, out } = mirrorOf(rules);
  assert.deepEqual(out, { deny: [], widenedReads: [], blocking: rules.map((rule) => ({ rule, file, reason: 'unreadable' })), dropNodeForms: false });
  // Without one, the same commands are judged as usual.
  assert.deepEqual(mirrorOf(['Bash(python3 -c *)', 'Bash(echo *)']).out.deny, ['Bash(python3 -c *)', 'Bash(echo *)']);
});

test('every rule the mirror denies is exactly one rule where the CLI splits its deny list, spaces and commas inside the scope included', () => {
  const rules = [
    'Bash(rtk curl *)', 'Bash(npm run build)', 'Bash(git log --oneline, --stat:*)', 'WebFetch(domain:example.com,other)', 'Edit(//tmp/a b/**)',
    'mcp__claude_ai_Gmail__send_email', 'Bash(node:*)', 'Write(//tmp/x, y/**)', 'Bash(echo "a  b":*)',
  ];
  const { out } = mirrorOf(rules);
  assert.deepEqual(out.deny, rules);
  for (const rule of out.deny) assert.deepEqual(rulesIn(rule), [rule], rule);
});

test('a path scope whose tail could climb out of its literal prefix is judged by the worst: a write rule refuses connector mode, a read rule widens reads (review M2)', () => {
  const writes = ['Edit(./notes/**/../../../../tmp/x)', 'Write(./notes/{a,../../../tmp}/**)', 'Edit(//tmp/x/*/..)', 'MultiEdit(./notes/{a,b}/**)'];
  const reads = ['Read(./**/../../../etc/**)', 'Read(./{a,../../../etc}/**)', 'Glob(./notes/*/../..)'];
  const { file, out } = mirrorOf([...writes, ...reads]);
  assert.deepEqual(out, { deny: [], widenedReads: reads, blocking: writes.map((rule) => ({ rule, file, reason: 'unreadable' })), dropNodeForms: false });
  // Dots that are not a whole segment, and a `..` before the first glob (resolved), climb nothing.
  assert.deepEqual(mirrorOf(['Edit(./notes/*..md)', 'Edit(./notes/../other/**)', 'Read(./notes/*..md)']).out, NOTHING);
});

test('a vault, a home or a folder reached through a link is judged by where the link leads too (review M1)', () => {
  const root = makeTempDir('brain-kit-user-rules-links-');
  const real = join(root, 'data', 'vault');
  mkdirSync(join(real, 'notes'), { recursive: true });
  mkdirSync(join(root, 'data', 'vault2'), { recursive: true });
  const linkVault = join(root, 'link-vault');
  symlinkSync(real, linkVault);
  const linkHome = join(root, 'link-home');
  symlinkSync(join(root, 'data'), linkHome);
  const { file } = mirrorOf([]);
  const mirror = (allow, vaultRoot, home = HOME) => {
    writeFileSync(file, JSON.stringify({ permissions: { allow } }));
    return mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot, home, kit: KIT });
  };
  // The kit handed the link, the rule naming the real place: a holder of the vault covers it, a folder inside it is inside.
  const byLink = mirror([`Edit(/${root}/data/**)`, `Write(/${real}/notes/**)`, `Read(/${real}/notes/**)`, `Edit(/${root}/data/vault2/**)`], linkVault);
  assert.deepEqual(byLink, { deny: [`Edit(/${root}/data/vault2/**)`], widenedReads: [], blocking: [{ rule: `Edit(/${root}/data/**)`, file, reason: 'covers_vault' }], dropNodeForms: false });
  // The kit handed the real path, the rule naming the link: the same answers.
  const byReal = mirror([`Edit(/${linkHome}/**)`, `Write(/${linkVault}/notes/**)`, `Read(/${linkVault}/**)`], real);
  assert.deepEqual(byReal, { deny: [], widenedReads: [], blocking: [{ rule: `Edit(/${linkHome}/**)`, file, reason: 'covers_vault' }], dropNodeForms: false });
  // A home reached through a link holds the vault it leads to, also for a scope that stops inside a name.
  assert.deepEqual(mirror(['Edit(~/**)', 'Edit(~/vault/notes/**)', 'Edit(~/va*)'], real, linkHome).blocking, [
    { rule: 'Edit(~/**)', file, reason: 'covers_vault' }, { rule: 'Edit(~/va*)', file, reason: 'covers_vault' },
  ]);
  // So does a settings folder reached through a link, for its /x rules.
  const linkConfig = join(root, 'link-config');
  symlinkSync(join(root, 'data'), linkConfig);
  writeFileSync(join(linkConfig, 'settings.json'), JSON.stringify({ permissions: { allow: ['Edit(/va*)', 'Edit(/vault/notes/**)'] } }));
  assert.deepEqual(mirrorUserRules({ files: [join(linkConfig, 'settings.json')], ownAllowed: OWN, vaultRoot: real, home: HOME, kit: KIT }), {
    deny: [], widenedReads: [], blocking: [{ rule: 'Edit(/va*)', file: join(linkConfig, 'settings.json'), reason: 'covers_vault' }], dropNodeForms: false,
  });
  // A scope that stops inside a name is judged as written: where one link of that name leads says nothing of
  // the other names that start the same way (link-notes-old, say).
  symlinkSync(join(real, 'notes'), join(root, 'link-notes'));
  assert.deepEqual(mirror([`Read(/${root}/link-notes*)`, `Read(/${root}/link-notes/**)`], real).widenedReads, [`Read(/${root}/link-notes*)`]);
});

test('a rule both files hold is mirrored or recorded once, in the order the files list them', () => {
  const dir = configDir({
    'settings.json': { permissions: { allow: ['WebFetch', 'Read(//etc/**)', 'Bash(node:*)'] } },
    'settings.local.json': { permissions: { allow: ['mcp__claude_ai_Gmail__send_email', 'WebFetch', 'Read(//etc/**)'] } },
  });
  assert.deepEqual(mirrorUserRules({ files: userSettingsFiles({ CLAUDE_CONFIG_DIR: dir }), ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }), {
    deny: ['WebFetch', 'Bash(node:*)', 'mcp__claude_ai_Gmail__send_email'], widenedReads: ['Read(//etc/**)'], blocking: [], dropNodeForms: true,
  });
});

test('mirrorUserRules needs the vault as an absolute path, and with no file has nothing to mirror', () => {
  for (const vaultRoot of [undefined, '', 'vault', './vault', 7]) {
    assert.throws(() => mirrorUserRules({ files: [], vaultRoot }), TypeError, JSON.stringify(vaultRoot));
  }
  assert.deepEqual(mirrorUserRules({ vaultRoot: VAULT }), NOTHING);
});

// --- messages ---------------------------------------------------------------------

test('every blocking entry renders in both packs with exactly the params it passes', () => {
  const file = '/home/ana/.claude/settings.json';
  const messages = [
    { rule: null, file, reason: 'unreadable' },
    { rule: 'Bash(ls', file, reason: 'unreadable' },
    { rule: 'Edit(~/**)', file, reason: 'covers_vault' },
    { rule: 'Bash', file: '/home/ana/.claude/settings.local.json', reason: 'covers_kit' },
  ].map(blockingMessage);
  assert.deepEqual(messages, [
    { messageKey: 'curate.user_rules.unreadable', params: { file } },
    { messageKey: 'curate.user_rules.unreadable_rule', params: { rule: 'Bash(ls', file } },
    { messageKey: 'curate.user_rules.covers_vault', params: { rule: 'Edit(~/**)', file } },
    { messageKey: 'curate.user_rules.covers_kit', params: { rule: 'Bash', file: '/home/ana/.claude/settings.local.json' } },
  ]);
  for (const lang of ['en', REFERENCE_LANG]) {
    const t = createTranslator(lang);
    for (const { messageKey, params } of messages) {
      const text = t(messageKey, params);
      assert.doesNotMatch(text, /\{\w+\}/, `${lang} ${messageKey}: ${text}`);
      for (const value of Object.values(params)) assert.ok(text.includes(String(value)), `${lang} ${messageKey} drops ${value}`);
    }
  }
});
