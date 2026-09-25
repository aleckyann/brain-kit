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

test('with CLAUDE_CONFIG_DIR unset, a HOME that is set but not absolute gives both names under it as they are, and the mirror refuses them (review N5 of task 2)', () => {
  assert.deepEqual(userSettingsFiles({ HOME: 'rel-home' }), [join('rel-home', '.claude', 'settings.json'), join('rel-home', '.claude', 'settings.local.json')]);
  assert.deepEqual(userSettingsFiles({ HOME: './home/ana' }), [join('home', 'ana', '.claude', 'settings.json'), join('home', 'ana', '.claude', 'settings.local.json')]);
  const files = userSettingsFiles({ HOME: 'rel-home' });
  assert.deepEqual(mirrorUserRules({ files, ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }).blocking, files.map((file) => ({ rule: null, file, reason: 'unreadable' })));
  // An absolute CLAUDE_CONFIG_DIR still decides, whatever HOME says.
  assert.deepEqual(userSettingsFiles({ HOME: 'rel-home', CLAUDE_CONFIG_DIR: configDir({}) }), []);
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
          'Bash(rtk curl *)', 'Bash(node:*)', 'Bash', 'Bash(*)', 'Bash("/opt/brain-kit/bin/brain*")',
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
    deny: ['Bash(rtk curl *)', 'Bash(node:*)', 'Edit(//tmp/other/**)', 'Read(//etc/**)', 'mcp__claude_ai_Gmail__send_email', 'WebFetch'],
    widenedReads: ['Read'],
    blocking: [
      { rule: 'Bash', file: settings, reason: 'covers_kit' },
      { rule: 'Bash(*)', file: settings, reason: 'covers_kit' },
      { rule: 'Bash("/opt/brain-kit/bin/brain*")', file: settings, reason: 'covers_kit' },
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

test('ruling R-F2: a read rule that is bare or overlaps the vault is recorded as widening reads; one disjoint from the vault and the round\'s reads is mirrored in its absolute form; one inside the vault is skipped', () => {
  const widening = ['Read', 'Glob(//**)', 'Grep(~/**)', 'LS(//home/ana/vault*)', 'Read(./../**)', 'Glob(//home/**)'];
  const disjoint = ['Read(//etc/**)', 'Read(/**)', 'Glob(//home/ana/vault2/**)', 'Read( //etc/**)', 'Grep(~/other/**)', 'LS(./../other/*)'];
  const inside = ['Read(./notes/**)', 'Glob(//home/ana/vault/notes/*.md)', 'Grep(notes/**)', 'LS(./no*)', 'Read(**)', 'Read(//home/ana/vault)'];
  const { file, out } = mirrorOf([...widening, ...disjoint, ...inside]);
  const dir = file.slice(0, -'/settings.json'.length);
  assert.deepEqual(out, {
    deny: ['Read(//etc/**)', `Read(/${dir}/**)`, 'Glob(//home/ana/vault2/**)', 'Grep(//home/ana/other/**)', 'LS(//home/ana/other/*)'],
    widenedReads: widening,
    blocking: [],
    dropNodeForms: false,
  });
  for (const rule of out.deny) assert.deepEqual(rulesIn(rule), [rule], rule);
});

test('ruling R-F2: a read rule overlapping one of the round\'s own reads (a transcript its plan lists, a folder an extra rule reads) stays unmirrored, since the deny would take that read; disjoint from them, it is mirrored', () => {
  const transcript = '/home/ana/.claude/projects/-home-ana-vault/s-0001.jsonl';
  const own = [...OWN, `Read(/${transcript})`, 'Read(//srv/shared/**)', 'Glob(//opt/ref*)'];
  const dir = configDir({ 'settings.json': { permissions: { allow: [
    'Read(~/.claude/**)', 'Read(~/.claude/projects/-home-ana-vault/*.jsonl)', `Read(/${transcript})`, 'Read(//srv/**)', 'Read(//srv/shared/a.md)', 'Grep(//opt/reference/**)',
    'Read(~/.claude/projects/-home-ana-other/**)', 'Read(//srv/sharedx/**)', 'Read(//opt/other/**)',
  ] } } });
  const file = join(dir, 'settings.json');
  const out = mirrorUserRules({ files: [file], ownAllowed: own, vaultRoot: VAULT, home: HOME, kit: KIT });
  assert.deepEqual(out.widenedReads, ['Read(~/.claude/**)', 'Read(~/.claude/projects/-home-ana-vault/*.jsonl)', 'Read(//srv/**)', 'Read(//srv/shared/a.md)', 'Grep(//opt/reference/**)']);
  assert.deepEqual(out.deny, ['Read(//home/ana/.claude/projects/-home-ana-other/**)', 'Read(//srv/sharedx/**)', 'Read(//opt/other/**)']);
  assert.deepEqual(out.blocking, []);
  // The vault counts as one of the round's reads even when the own list does not name it.
  assert.deepEqual(mirrorUserRules({ files: [file], ownAllowed: [], vaultRoot: VAULT, home: HOME, kit: KIT }).widenedReads.includes('Read(~/.claude/**)'), false, 'disjoint from the vault alone');
  const overVault = mirrorOf([]).file;
  writeFileSync(overVault, JSON.stringify({ permissions: { allow: ['Read(//home/**)', 'Read(//etc/**)'] } }));
  assert.deepEqual(mirrorUserRules({ files: [overVault], ownAllowed: [], vaultRoot: VAULT, home: HOME, kit: KIT }), { deny: ['Read(//etc/**)'], widenedReads: ['Read(//home/**)'], blocking: [], dropNodeForms: false });
  // A bare read in the round's own list overlaps everything: no read rule is mirrored.
  assert.deepEqual(mirrorUserRules({ files: [file], ownAllowed: [...OWN, 'Read'], vaultRoot: VAULT, home: HOME, kit: KIT }).deny, []);
});

test('write rules covering the vault or a folder above it refuse connector mode; inside the vault they are skipped; outside, mirrored', () => {
  const covering = ['Edit', 'Edit(~/**)', 'Write(//home/**)', 'NotebookEdit(//home/ana/vault/**)', 'MultiEdit(//home/ana/va*)', 'Write(**)', 'Edit(//**)', 'Edit(~)', 'Write(./*.md)'];
  const inside = ['Edit(./notes/**)', 'Write(./no*)', 'NotebookEdit(notes/a.ipynb)', 'Edit(./.githooks/**)'];
  // A scope is read trimmed: were a space in front of `//` read as part of a relative path, this rule would be skipped as inside the vault.
  // A folder whose name only starts like the vault's name or its parent's (va, an) is a sibling, not a holder.
  const outside = ['Edit(//tmp/other/**)', 'Write(//home/ana/vault2/**)', 'Edit(//home/an)', 'Edit(//home/ana/va/**)', 'MultiEdit(/hooks/**)', 'Write(./../other/**)', 'Edit( //tmp/other/**)'];
  const { file, out } = mirrorOf([...covering, ...inside, ...outside]);
  const dir = file.slice(0, -'/settings.json'.length);
  assert.deepEqual(out, {
    // Each in its resolved absolute form, once (final review I3).
    deny: ['Edit(//tmp/other/**)', 'Write(//home/ana/vault2/**)', 'Edit(//home/an)', 'Edit(//home/ana/va/**)', `MultiEdit(/${dir}/hooks/**)`, 'Write(//home/ana/other/**)'],
    widenedReads: [],
    blocking: covering.map((rule) => ({ rule, file, reason: 'covers_vault' })),
    dropNodeForms: false,
  });
});

test('a write rule is resolved the way user settings resolve paths: //x from the root, ~/x from home, /x from the settings file\'s folder, the rest from the vault; mirrored, it is passed in that resolved absolute form, never as written (final review I3)', () => {
  // The settings file's own folder is not the vault: /x there is mirrored, anchored at that folder, since on the
  // command line a rule has no settings file and a single leading slash would be anchored elsewhere.
  const alone = mirrorOf(['Edit(/**)', 'Write(/notes/**)']);
  const own = alone.file.slice(0, -'/settings.json'.length);
  assert.deepEqual(alone.out.deny, [`Edit(/${own}/**)`, `Write(/${own}/notes/**)`]);
  for (const rule of alone.out.deny) assert.ok(rule.includes('(//'), rule);
  // With the vault under that folder, the same rule covers it.
  const dir = configDir({ 'settings.json': { permissions: { allow: ['Edit(/**)', 'Write(/vault/**)', 'Edit(/vault/notes/**)'] } } });
  const file = join(dir, 'settings.json');
  const out = mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot: join(dir, 'vault'), home: HOME, kit: KIT });
  assert.deepEqual(out, {
    deny: [], widenedReads: [], blocking: [{ rule: 'Edit(/**)', file, reason: 'covers_vault' }, { rule: 'Write(/vault/**)', file, reason: 'covers_vault' }], dropNodeForms: false,
  });
  // The same file, with the vault somewhere else: all three are outside it.
  assert.deepEqual(mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }).deny, [`Edit(/${dir}/**)`, `Write(/${dir}/vault/**)`, `Edit(/${dir}/vault/notes/**)`]);
  // ~ is the home given, whatever the vault's parent is.
  const tilde = mirrorOf(['Edit(~/**)', 'Write(~/notes/)', 'Edit(~//notes/*.md)', 'Edit(~)', 'Write(~/no*)']).file;
  assert.deepEqual(mirrorUserRules({ files: [tilde], ownAllowed: OWN, vaultRoot: VAULT, home: '/srv/ana', kit: KIT }).deny, ['Edit(//srv/ana/**)', 'Write(//srv/ana/notes/)', 'Edit(//srv/ana/notes/*.md)', 'Edit(//srv/ana)', 'Write(//srv/ana/no*)']);
  // A relative scope that leaves the vault is anchored at the vault, and a rule already absolute keeps its text.
  assert.deepEqual(mirrorOf(['Write(../other/**)', 'Edit(./../x.md)', 'Edit(//tmp/a b/**)', 'Edit(///tmp/c/**)']).out.deny, ['Write(//home/ana/other/**)', 'Edit(//home/ana/x.md)', 'Edit(//tmp/a b/**)', 'Edit(//tmp/c/**)']);
});

test('a path rule to mirror whose resolved form holds a character no rule can carry refuses connector mode as unreadable, naming the rule as written (final review I3)', () => {
  // The base carries it: a home or a settings folder with a comma, a parenthesis, a bracket or a backslash.
  for (const home of ['/srv/ana,b', '/srv/ana (old)', '/srv/ana[1]', '/srv/an\\a', '/srv/a}b']) {
    const { file } = mirrorOf([]);
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Edit(~/notes/**)', 'Read(~/docs/**)'] } }));
    assert.deepEqual(mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot: VAULT, home, kit: KIT }).blocking, [
      { rule: 'Edit(~/notes/**)', file, reason: 'unreadable' }, { rule: 'Read(~/docs/**)', file, reason: 'unreadable' },
    ], home);
  }
  const odd = makeTempDir('brain-kit-user-rules-a,b-');
  writeFileSync(join(odd, 'settings.json'), JSON.stringify({ permissions: { allow: ['Write(/x/**)', 'WebFetch'] } }));
  const file = join(odd, 'settings.json');
  assert.deepEqual(mirrorUserRules({ files: [file], ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }), {
    deny: ['WebFetch'], widenedReads: [], blocking: [{ rule: 'Write(/x/**)', file, reason: 'unreadable' }], dropNodeForms: false,
  });
  // The scope carries it: a comma, a stray bracket, a backslash in the rest of the scope.
  const { file: scoped, out } = mirrorOf(['Write(//tmp/x, y/**)', 'Edit(//tmp/a]b/**)', 'Edit(//tmp/a/*\\*)', 'Read(//etc/*,x)']);
  assert.deepEqual(out, { deny: [], widenedReads: [], blocking: ['Write(//tmp/x, y/**)', 'Edit(//tmp/a]b/**)', 'Edit(//tmp/a/*\\*)', 'Read(//etc/*,x)'].map((rule) => ({ rule, file: scoped, reason: 'unreadable' })), dropNodeForms: false });
  // A rule that is skipped or refused anyway is not judged by its form.
  assert.deepEqual(mirrorUserRules({ files: [mirrorOf(['Edit(~/**)', 'Edit(~/vault/notes/**)']).file], ownAllowed: OWN, vaultRoot: VAULT, home: '/home/ana', kit: KIT }).blocking.map((b) => b.reason), ['covers_vault']);
});

test('a scope ending in a backslash, or holding an odd number of double quotes, is never mirrored: connector mode is refused, naming it (review N3 of task 2)', () => {
  const rules = ['Bash(foo \\)', 'Bash(echo "a)', 'Bash(echo "a" "b)', 'WebFetch(domain:example.com\\)', 'Edit(//tmp/"x/**)'];
  const { file, out } = mirrorOf(rules);
  assert.deepEqual(out, { deny: [], widenedReads: [], blocking: rules.map((rule) => ({ rule, file, reason: 'unreadable' })), dropNodeForms: false });
  // An even number of quotes, or a backslash inside, is judged as usual.
  assert.deepEqual(mirrorOf(['Bash(echo "a b":*)', 'Bash(printf a\\nb)']).out.deny, ['Bash(echo "a b":*)', 'Bash(printf a\\nb)']);
});

test('Bash rules granting every command or the kit\'s own refuse connector mode; one for node is mirrored and drops the round\'s node forms; the rest is mirrored', () => {
  const covering = [
    'Bash', 'Bash(*)', 'Bash(:*)', 'Bash( * )', 'Bash()', 'Bash("/opt/brain-kit/bin/brain*")', `Bash(${KIT}:*)`, `Bash(${KIT} v*)`, `Bash(${KIT} lint --fix:*)`,
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
    'mcp__claude_ai_Gmail__send_email', 'Bash(node:*)', 'Write(//tmp/x y/**)', 'Bash(echo "a  b":*)',
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
  // The kit handed the real path, the rule naming the link: a holder through a link still covers the vault, but a
  // folder of the vault named through the link is not taken as inside it (review N1 of task 2): the CLI works in
  // the vault's real path, and whether it matches a rule by its written path or by its link target is not
  // measured, so the write rule is mirrored, in the form the person wrote it resolves to. The read rule reaches
  // the vault through the link: it stays unmirrored, widening reads.
  const byReal = mirror([`Edit(/${linkHome}/**)`, `Write(/${linkVault}/notes/**)`, `Read(/${linkVault}/**)`], real);
  assert.deepEqual(byReal, { deny: [`Write(/${linkVault}/notes/**)`], widenedReads: [`Read(/${linkVault}/**)`], blocking: [{ rule: `Edit(/${linkHome}/**)`, file, reason: 'covers_vault' }], dropNodeForms: false });
  // A home reached through a link holds the vault it leads to, also for a scope that stops inside a name; the
  // protected paths named through that home are mirrored, as the CLI expands ~ to the home as given (review N1).
  const viaHome = mirror(['Edit(~/**)', 'Edit(~/vault/notes/**)', 'Edit(~/va*)', 'Edit(~/vault/.claude/**)', 'Write(~/vault/brain-kit.config.json)'], real, linkHome);
  assert.deepEqual(viaHome.blocking, [
    { rule: 'Edit(~/**)', file, reason: 'covers_vault' }, { rule: 'Edit(~/va*)', file, reason: 'covers_vault' },
  ]);
  assert.deepEqual(viaHome.deny, [`Edit(/${linkHome}/vault/notes/**)`, `Edit(/${linkHome}/vault/.claude/**)`, `Write(/${linkHome}/vault/brain-kit.config.json)`]);
  // The same rules with the home as the real path are inside the vault, and skipped.
  assert.deepEqual(mirror(['Edit(~/vault/.claude/**)', 'Write(~/vault/brain-kit.config.json)'], real, join(root, 'data')), NOTHING);
  // So does a settings folder reached through a link, for its /x rules.
  const linkConfig = join(root, 'link-config');
  symlinkSync(join(root, 'data'), linkConfig);
  writeFileSync(join(linkConfig, 'settings.json'), JSON.stringify({ permissions: { allow: ['Edit(/va*)', 'Edit(/vault/notes/**)'] } }));
  assert.deepEqual(mirrorUserRules({ files: [join(linkConfig, 'settings.json')], ownAllowed: OWN, vaultRoot: real, home: HOME, kit: KIT }), {
    deny: [`Edit(/${linkConfig}/vault/notes/**)`], widenedReads: [], blocking: [{ rule: 'Edit(/va*)', file: join(linkConfig, 'settings.json'), reason: 'covers_vault' }], dropNodeForms: false,
  });
  // A scope that stops inside a name is judged as written: where one link of that name leads says nothing of
  // the other names that start the same way (link-notes-old, say).
  symlinkSync(join(real, 'notes'), join(root, 'link-notes'));
  const notes = mirror([`Read(/${root}/link-notes*)`, `Read(/${root}/link-notes/**)`], real);
  assert.deepEqual(notes.deny, [`Read(/${root}/link-notes*)`]);
  assert.deepEqual(notes.widenedReads, [`Read(/${root}/link-notes/**)`], 'the link leads into the vault: a mirrored deny could take the round\'s own reads');
});

test('a rule both files hold is mirrored or recorded once, in the order the files list them', () => {
  const dir = configDir({
    'settings.json': { permissions: { allow: ['WebFetch', 'Read(//etc/**)', 'Bash(node:*)'] } },
    'settings.local.json': { permissions: { allow: ['mcp__claude_ai_Gmail__send_email', 'WebFetch', 'Read(//etc/**)'] } },
  });
  assert.deepEqual(mirrorUserRules({ files: userSettingsFiles({ CLAUDE_CONFIG_DIR: dir }), ownAllowed: OWN, vaultRoot: VAULT, home: HOME, kit: KIT }), {
    deny: ['WebFetch', 'Read(//etc/**)', 'Bash(node:*)', 'mcp__claude_ai_Gmail__send_email'], widenedReads: [], blocking: [], dropNodeForms: true,
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
