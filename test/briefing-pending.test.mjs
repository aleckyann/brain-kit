// The pending tables read into deadline buckets (src/briefing/pending.mjs).
// Review Focus 1 and 2 of phase 4: a deadline cell in every shape a person
// writes lands in exactly one bucket, "no date" is a bucket and never
// silence, and today is the vault's today at every edge (its zone, just
// after midnight, a Monday, a deadline equal to today).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_ROOT } from '../src/version.mjs';
import { validateConfig } from '../src/config.mjs';
import { bucketOf, inNeverRead, parseDeadline, pendingBuckets, pendingSettings } from '../src/briefing/pending.mjs';
import { makeVault, writeVaultFile } from './helpers/vault-fixture.mjs';

const UTC3 = 'America/Argentina/Buenos_Aires';
const FOLLOWUPS = 'pending/follow-ups.md';
const PROMISES = 'pending/promises.md';

function pack(lang) {
  return JSON.parse(readFileSync(join(KIT_ROOT, 'lang', lang, 'config.defaults.json'), 'utf8'));
}

const FRONT = '---\ntype: pending\ntitle: Follow-ups\ndescription: Things to do.\ngenerated:\n  by: human:ana\n  at: 2026-09-22T00:00:00+00:00\n---\n';

// A follow-ups note whose Open table holds one row per deadline cell, in
// order, the What cell naming the row.
function followups(rows, { resolved = [] } = {}) {
  const line = ([what, deadline]) => `| 20/09/2026 | ${what} | Ana | ${deadline} | next |`;
  return `${FRONT}\n# Follow-ups\n\n## Open\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n${rows.map(line).join('\n')}\n\n## Resolved\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n${resolved.map(line).join('\n')}\n`;
}

function promises(rows) {
  const line = ([what, deadline]) => `| 20/09/2026 | Ana | ${what} | ${deadline} | open |`;
  return `${FRONT}\n# Promises\n\n## Active\n\n| Made on | To whom | What I promised | Condition / deadline | Status |\n|---|---|---|---|---|\n${rows.map(line).join('\n')}\n\n## Done / renegotiated\n\n| Made on | To whom | What I promised | Condition / deadline | Status |\n|---|---|---|---|---|\n`;
}

function buckets(files, { config = {}, today = '2026-09-25', tz = 'UTC' } = {}) {
  const root = makeVault({ files, config });
  const loaded = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
  return { root, result: pendingBuckets({ root, config: loaded, today, tz }) };
}

function whats(items) {
  return items.map((item) => item.what);
}

// Every item lands in exactly one bucket: the four lists and the later
// count add up to the rows, and no row appears twice.
function assertPartition(result, rowCount) {
  const listed = [...result.overdue, ...result.today, ...result.upcoming, ...result.undated];
  assert.equal(listed.length + result.later, rowCount, 'every row lands in a bucket');
  const keys = listed.map((item) => `${item.file}:${item.line}`);
  assert.equal(new Set(keys).size, keys.length, 'no row lands in two buckets');
}

// ------------------------------------------------------------ parseDeadline

test('parseDeadline: DD/MM/YYYY, D/M/YYYY and YYYY-MM-DD read as the same day', () => {
  assert.deepEqual(parseDeadline('05/10/2026'), { deadline: '2026-10-05', invalid: [], incomplete: [], others: [] });
  assert.deepEqual(parseDeadline('5/10/2026'), { deadline: '2026-10-05', invalid: [], incomplete: [], others: [] });
  assert.deepEqual(parseDeadline('2026-10-05'), { deadline: '2026-10-05', invalid: [], incomplete: [], others: [] });
  assert.deepEqual(parseDeadline('31/12/2026'), { deadline: '2026-12-31', invalid: [], incomplete: [], others: [] });
});

test('parseDeadline: a date inside text is found', () => {
  assert.equal(parseDeadline('call Ana by 05/10/2026, after the board').deadline, '2026-10-05');
  assert.equal(parseDeadline('until 2026-10-05 (soft)').deadline, '2026-10-05');
});

test('parseDeadline: with two dates the FIRST real one is the deadline, whatever the shapes', () => {
  assert.equal(parseDeadline('05/10/2026 or 12/10/2026').deadline, '2026-10-05');
  assert.equal(parseDeadline('12/10/2026 or 05/10/2026').deadline, '2026-10-12', 'first by position, not the earliest');
  assert.equal(parseDeadline('2026-10-12, else 05/10/2026').deadline, '2026-10-12');
  assert.equal(parseDeadline('05/10/2026, else 2026-10-01').deadline, '2026-10-05');
});

test('parseDeadline: a date that is not real is reported and never taken; a real one after it still is', () => {
  assert.deepEqual(parseDeadline('31/02/2026'), { deadline: null, invalid: ['31/02/2026'], incomplete: [], others: ['31/02/2026'] });
  assert.deepEqual(parseDeadline('2026-02-30'), { deadline: null, invalid: ['2026-02-30'], incomplete: [], others: ['2026-02-30'] });
  assert.deepEqual(parseDeadline('2026-13-01'), { deadline: null, invalid: ['2026-13-01'], incomplete: [], others: ['2026-13-01'] });
  assert.deepEqual(parseDeadline('00/10/2026'), { deadline: null, invalid: ['00/10/2026'], incomplete: [], others: ['00/10/2026'] });
  assert.deepEqual(parseDeadline('31/02/2026 or 05/03/2026'), { deadline: '2026-03-05', invalid: ['31/02/2026'], incomplete: [], others: ['31/02/2026'] });
  assert.deepEqual(parseDeadline('05/03/2026 or 31/02/2026'), { deadline: '2026-03-05', invalid: ['31/02/2026'], incomplete: [], others: ['31/02/2026'] });
});

test('parseDeadline: the leap day exists only in a leap year', () => {
  assert.equal(parseDeadline('29/02/2028').deadline, '2028-02-29');
  assert.deepEqual(parseDeadline('29/02/2026'), { deadline: null, invalid: ['29/02/2026'], incomplete: [], others: ['29/02/2026'] });
  assert.deepEqual(parseDeadline('29/02/2100'), { deadline: null, invalid: ['29/02/2100'], incomplete: [], others: ['29/02/2100'] });
  assert.equal(parseDeadline('2000-02-29').deadline, '2000-02-29');
});

test('parseDeadline: no date, or digits that only look like one, is no deadline and no problem', () => {
  for (const cell of ['', 'someday', 'after the board meeting', '10/2026', '123/10/2026', '05/10/20266', '12026-10-05', '2026-10-5', 'Q4']) {
    assert.deepEqual(parseDeadline(cell), { deadline: null, invalid: [], incomplete: [], others: [] }, cell);
  }
  assert.deepEqual(parseDeadline(undefined), { deadline: null, invalid: [], incomplete: [], others: [] });
});

test('parseDeadline: a day and month with no four-digit year is named, never taken for a date', () => {
  assert.deepEqual(parseDeadline('até 05/10'), { deadline: null, invalid: [], incomplete: ['05/10'], others: ['05/10'] });
  assert.deepEqual(parseDeadline('05/10/26'), { deadline: null, invalid: [], incomplete: ['05/10/26'], others: ['05/10/26'] });
  assert.deepEqual(parseDeadline('5/1 or 12/12'), { deadline: null, invalid: [], incomplete: ['5/1', '12/12'], others: ['5/1', '12/12'] });
  assert.deepEqual(parseDeadline('05/10/2026'), { deadline: '2026-10-05', invalid: [], incomplete: [], others: [] }, 'no part of a full date is incomplete');
  assert.deepEqual(parseDeadline('1/2/3'), { deadline: null, invalid: [], incomplete: [], others: [] });
});

test('pendingBuckets: a date with no year is a problem naming the file and line, and the item is undated', () => {
  const { result } = buckets({ [FOLLOWUPS]: followups([['no year', 'até 05/10'], ['with a real one too', '05/10 or 12/10/2026']]), [PROMISES]: promises([]) });
  assert.deepEqual(whats(result.undated), ['no year']);
  assert.equal(result.later, 1, 'the cell with a real date is bucketed by it');
  assert.deepEqual(result.problems, [
    { code: 'date_without_year', detail: { path: FOLLOWUPS, line: 16, value: '05/10' } },
    { code: 'ambiguous_deadline', detail: { path: FOLLOWUPS, line: 17, deadline: '2026-10-12', others: ['05/10'] } },
  ], 'a cell whose deadline was found names the date it did not take');
});

test('parseDeadline: others lists every date-like text but the chosen one, in the cell\'s order', () => {
  assert.deepEqual(parseDeadline('05/10 or 12/10/2026').others, ['05/10']);
  assert.deepEqual(parseDeadline('12/10/2026, else 05/10').others, ['05/10']);
  assert.deepEqual(parseDeadline('05/10/2026 or 12/10/2026').others, ['12/10/2026']);
  assert.deepEqual(parseDeadline('31/02/2026, 05/03/2026 or 2026-03-09, maybe 1/4').others, ['31/02/2026', '2026-03-09', '1/4']);
  assert.deepEqual(parseDeadline('05/10 or 12/10/2026 or 2026-12-01').others, ['05/10', '2026-12-01'], 'a yearless date before a full one keeps its place');
  assert.deepEqual(parseDeadline('05/10/2026').others, []);
  assert.deepEqual(parseDeadline('by 05/10/2026 at the latest').others, []);
});

test('pendingBuckets: a deadline cell holding more than one date keeps its bucket and is named (ruling R-T4)', () => {
  const rows = [
    ['yearless and full', '05/10 or 12/10/2026'],
    ['two full', '26/09/2026 or 01/12/2026'],
    ['unreal and full', '31/02/2026, really 27/09/2026'],
    ['single', '28/09/2026'],
  ];
  const { result } = buckets({ [FOLLOWUPS]: followups(rows), [PROMISES]: promises([]) });
  assert.deepEqual(whats(result.upcoming), ['two full', 'unreal and full', 'single'], 'each keeps the bucket of its first real full date');
  assert.equal(result.later, 1, '12/10/2026 is past the window');
  assert.deepEqual(result.problems, [
    { code: 'ambiguous_deadline', detail: { path: FOLLOWUPS, line: 16, deadline: '2026-10-12', others: ['05/10'] } },
    { code: 'ambiguous_deadline', detail: { path: FOLLOWUPS, line: 17, deadline: '2026-09-26', others: ['01/12/2026'] } },
    { code: 'ambiguous_deadline', detail: { path: FOLLOWUPS, line: 18, deadline: '2026-09-27', others: ['31/02/2026'] } },
  ], 'the single-date cell is not named');
});

// ------------------------------------------------------------ bucketOf

test('bucketOf: the boundaries of today and of the upcoming window', () => {
  const today = '2026-09-25';
  assert.equal(bucketOf('2026-09-24', today, 7), 'overdue');
  assert.equal(bucketOf('2025-01-01', today, 7), 'overdue');
  assert.equal(bucketOf('2026-09-25', today, 7), 'today', 'a deadline equal to today is due today, not overdue and not upcoming');
  assert.equal(bucketOf('2026-09-26', today, 7), 'upcoming');
  assert.equal(bucketOf('2026-10-02', today, 7), 'upcoming', 'the last day of the window is in it');
  assert.equal(bucketOf('2026-10-03', today, 7), 'later', 'the day after the window is not');
  assert.equal(bucketOf('2026-09-26', today, 0), 'later', 'no upcoming days: tomorrow is later');
  assert.equal(bucketOf('2026-09-26', today, 1), 'upcoming');
  assert.equal(bucketOf('2026-09-27', today, 1), 'later');
  assert.equal(bucketOf(null, today, 7), 'undated');
  // Across a month and a year end.
  assert.equal(bucketOf('2027-01-03', '2026-12-27', 7), 'upcoming');
  assert.equal(bucketOf('2027-01-04', '2026-12-27', 7), 'later');
});

// ------------------------------------------------------------ pendingBuckets

test('pendingBuckets: every shape of deadline cell lands in exactly one bucket, and no date is a bucket', () => {
  const rows = [
    ['dmy overdue', '24/09/2026'],
    ['iso today', '2026-09-25'],
    ['text upcoming', 'by 30/09/2026 at the latest'],
    ['two dates', '26/09/2026 or 01/12/2026'],
    ['no date', 'when the board decides'],
    ['empty cell', ''],
    ['not real', '31/02/2026'],
    ['not real then real', '31/02/2026, really 27/09/2026'],
    ['later', '2026-12-01'],
  ];
  const { result } = buckets({ [FOLLOWUPS]: followups(rows), [PROMISES]: promises([]) });
  assert.deepEqual(whats(result.overdue), ['dmy overdue']);
  assert.deepEqual(whats(result.today), ['iso today']);
  assert.deepEqual(whats(result.upcoming), ['two dates', 'not real then real', 'text upcoming'], 'sorted by deadline');
  assert.deepEqual(whats(result.undated), ['no date', 'empty cell', 'not real']);
  assert.equal(result.later, 1);
  assert.equal(result.upcomingDays, 7);
  assertPartition(result, rows.length);
  assert.deepEqual(result.undated.map((item) => item.deadline), [null, null, null]);
  assert.deepEqual(result.undated.map((item) => item.raw), ['when the board decides', '', '31/02/2026']);
  const twoDates = result.upcoming.find((item) => item.what === 'two dates');
  assert.deepEqual(twoDates, { file: FOLLOWUPS, line: 19, what: 'two dates', deadline: '2026-09-26', raw: '26/09/2026 or 01/12/2026' });
});

test('pendingBuckets: an unreal date is a problem naming the file and the line', () => {
  const rows = [['fine', '24/09/2026'], ['bad', '31/02/2026'], ['bad then good', '30/02/2026 or 01/10/2026']];
  const { result } = buckets({ [FOLLOWUPS]: followups(rows), [PROMISES]: promises([]) });
  assert.deepEqual(result.problems, [
    { code: 'invalid_date', detail: { path: FOLLOWUPS, line: 17, value: '31/02/2026' } },
    { code: 'ambiguous_deadline', detail: { path: FOLLOWUPS, line: 18, deadline: '2026-10-01', others: ['30/02/2026'] } },
  ]);
  const text = readFileSync(join(makeVault({ files: { [FOLLOWUPS]: followups(rows) } }), FOLLOWUPS), 'utf8').split('\n');
  assert.match(text[16], /\| bad \|/, 'line 17 of the file is the row reported');
  assert.deepEqual(whats(result.undated), ['bad']);
  assert.deepEqual(whats(result.upcoming), ['bad then good']);
});

test('pendingBuckets: both default tables are read, promises by their own columns, and the other tables are not', () => {
  const { result } = buckets({
    [FOLLOWUPS]: followups([['follow overdue', '20/09/2026']], { resolved: [['resolved long ago', '01/09/2026']] }),
    [PROMISES]: promises([['promise today', '25/09/2026'], ['promise undated', 'once the contract is signed']]),
  });
  assert.deepEqual(whats(result.overdue), ['follow overdue'], 'the Resolved table is not a pending table');
  assert.deepEqual(result.today.map((item) => [item.file, item.what]), [[PROMISES, 'promise today']]);
  assert.deepEqual(result.undated.map((item) => [item.file, item.what]), [[PROMISES, 'promise undated']]);
  assert.deepEqual(result.problems, []);
});

test('pendingBuckets: a row with every cell blank is not an item; a row with only a what is undated', () => {
  const text = `${FRONT}\n## Open\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n|  |  |  |  |  |\n| | lonely | | | |\n`;
  const { result } = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) });
  assert.deepEqual(whats(result.undated), ['lonely']);
  assertPartition(result, 1);
});

test('pendingBuckets: the section runs to the next heading of the same level; a deeper one stays inside', () => {
  const text = `${FRONT}\n## Open\n\nSome prose.\n\n### This week\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n| x | nested | y | 24/09/2026 | z |\n\n## Elsewhere\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n| x | outside | y | 24/09/2026 | z |\n`;
  const { result } = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) });
  assert.deepEqual(whats(result.overdue), ['nested']);
});

test('pendingBuckets: a heading or a table inside a code block is not one', () => {
  const text = `${FRONT}\n\`\`\`\n## Open\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n| x | fenced | y | 24/09/2026 | z |\n\`\`\`\n`;
  const { result } = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) });
  assert.deepEqual(result.overdue, []);
  assert.deepEqual(result.problems.map((p) => p.code), ['heading_missing']);
});

// ------------------------------------------------------------ missing structure

test('pendingBuckets: a file the taxonomy gives no path is a problem, never an exception', () => {
  const { result } = buckets({ [PROMISES]: promises([['kept', '24/09/2026']]) }, { config: { taxonomy: { files: { followups: null } } } });
  assert.deepEqual(result.problems, [{ code: 'not_configured', detail: { file: 'followups' } }]);
  assert.deepEqual(whats(result.overdue), ['kept'], 'the other table is still read');
});

test('pendingBuckets: a file that does not exist is a problem', () => {
  const { result } = buckets({ [PROMISES]: promises([]) });
  assert.deepEqual(result.problems, [{ code: 'file_missing', detail: { path: FOLLOWUPS } }]);
});

test('pendingBuckets: a heading the configuration does not declare, and one the file does not carry, are each a problem', () => {
  const undeclared = buckets({ [FOLLOWUPS]: followups([]), [PROMISES]: promises([]) }, {
    config: { briefing: { pending: [{ file: 'followups', heading: 'nowhere_heading', date_column: 'Deadline', what_column: 'What' }] } },
  }).result;
  assert.deepEqual(undeclared.problems, [{ code: 'heading_not_configured', detail: { file: 'followups', heading: 'nowhere_heading' } }]);

  const text = `${FRONT}\n# Follow-ups\n\n## Opened\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n| x | a | y | 24/09/2026 | z |\n`;
  const absent = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) }).result;
  assert.deepEqual(absent.problems, [{ code: 'heading_missing', detail: { path: FOLLOWUPS, heading: '## Open' } }]);
  assert.deepEqual(absent.overdue, [], 'a table under another heading is not guessed to be this one');
});

test('pendingBuckets: a heading with no table under it is a problem', () => {
  const text = `${FRONT}\n## Open\n\nNothing yet.\n\n## Resolved\n\n| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n| x | old | y | 24/09/2026 | z |\n`;
  const { result } = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) });
  assert.deepEqual(result.problems, [{ code: 'table_missing', detail: { path: FOLLOWUPS, heading: '## Open' } }]);
  assert.deepEqual(result.overdue, [], 'the next section\'s table is not borrowed');
});

test('pendingBuckets: a missing date column or what column is a problem naming it, and the table is not read', () => {
  const noDeadline = `${FRONT}\n## Open\n\n| Logged | What | With whom / where | Due | Next step |\n|---|---|---|---|---|\n| x | a | y | 24/09/2026 | z |\n`;
  const first = buckets({ [FOLLOWUPS]: noDeadline, [PROMISES]: promises([]) }).result;
  assert.deepEqual(first.problems, [{ code: 'column_missing', detail: { path: FOLLOWUPS, heading: '## Open', column: 'Deadline', line: 12 } }]);
  assert.deepEqual([first.overdue, first.undated], [[], []], 'no item is guessed into a bucket, not even undated');

  const noWhat = `${FRONT}\n## Open\n\n| Logged | Task | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n| x | a | y | 24/09/2026 | z |\n`;
  const second = buckets({ [FOLLOWUPS]: noWhat, [PROMISES]: promises([]) }).result;
  assert.deepEqual(second.problems, [{ code: 'column_missing', detail: { path: FOLLOWUPS, heading: '## Open', column: 'What', line: 12 } }]);
  assert.deepEqual(second.overdue, []);
});

test('pendingBuckets: the heading written twice, or a second table under it, is read once and said', () => {
  const table = (what) => `| Logged | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|\n| x | ${what} | y | 24/09/2026 | z |\n`;
  const twice = `${FRONT}\n## Open\n\n${table('first')}\n## Open\n\n${table('second')}`;
  const repeated = buckets({ [FOLLOWUPS]: twice, [PROMISES]: promises([]) }).result;
  assert.deepEqual(whats(repeated.overdue), ['first']);
  assert.deepEqual(repeated.problems, [{ code: 'heading_repeated', detail: { path: FOLLOWUPS, heading: '## Open' } }]);
  const two = `${FRONT}\n## Open\n\n${table('first')}\nThen another list:\n\n${table('second')}\n${table('third')}`;
  const extra = buckets({ [FOLLOWUPS]: two, [PROMISES]: promises([]) }).result;
  assert.deepEqual(whats(extra.overdue), ['first']);
  assert.deepEqual(extra.problems, [{ code: 'tables_ignored', detail: { path: FOLLOWUPS, heading: '## Open', count: 2 } }]);
});

test('pendingBuckets: the same table named twice is read once and said', () => {
  const entry = { file: 'followups', heading: 'open_heading', date_column: 'Deadline', what_column: 'What' };
  const { result } = buckets({ [FOLLOWUPS]: followups([['once', '24/09/2026']]) }, { config: { briefing: { pending: [entry, entry] } } });
  assert.deepEqual(whats(result.overdue), ['once']);
  assert.deepEqual(result.problems, [{ code: 'duplicate_entry', detail: { path: FOLLOWUPS, heading: '## Open' } }]);
});

test('pendingBuckets: a file under briefing.never_read is never opened', () => {
  // The path is a DIRECTORY: opening it would be an `unreadable` problem
  // (EISDIR), so `never_read` proves it was not opened at all.
  const root = makeVault({ files: { [PROMISES]: promises([]) }, config: { briefing: { never_read: ['pending/follow-ups.md'] } } });
  mkdirSync(join(root, FOLLOWUPS));
  const config = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
  const result = pendingBuckets({ root, config, today: '2026-09-25', tz: 'UTC' });
  assert.deepEqual(result.problems, [{ code: 'never_read', detail: { path: FOLLOWUPS } }]);

  config.briefing.never_read = [];
  assert.deepEqual(pendingBuckets({ root, config, today: '2026-09-25', tz: 'UTC' }).problems.map((p) => p.code), ['unreadable'],
    'the same directory, not listed, is opened and fails');
});

test('inNeverRead: a directory entry covers what is under it; a file entry, with or without a fragment, covers that file', () => {
  const list = ['people/', 'memory/log.md#full', 'notes/secret.md'];
  assert.equal(inNeverRead('people/ana.md', list), true);
  assert.equal(inNeverRead('people/sub/ana.md', list), true);
  assert.equal(inNeverRead('peoplex/ana.md', list), false);
  assert.equal(inNeverRead('memory/log.md', list), true);
  assert.equal(inNeverRead('memory/log.md.bak', list), false);
  assert.equal(inNeverRead('notes/secret.md', list), true);
  assert.equal(inNeverRead('notes/secret.mdx', list), false);
  assert.equal(inNeverRead('pending/follow-ups.md', list), false);
  assert.equal(inNeverRead('pending/follow-ups.md', undefined), false);
  assert.equal(inNeverRead('pending/follow-ups.md', ['./pending/']), true);
  // Without the trailing slash, a folder entry still covers the folder.
  assert.equal(inNeverRead('people/ana.md', ['people']), true);
  assert.equal(inNeverRead('people', ['people']), true);
  assert.equal(inNeverRead('peoplex/ana.md', ['people']), false);
  assert.equal(inNeverRead('people/ana.md', ['people//']), true);
});

// ------------------------------------------------------------ today at the edges

test('today at the edges: a run just after midnight in the vault\'s zone is that zone\'s new day', () => {
  const files = { [FOLLOWUPS]: followups([['due 24', '24/09/2026'], ['due 25', '25/09/2026']]), [PROMISES]: promises([]) };
  // 00:05 of 25/09 at UTC-3 is 03:05 UTC.
  const after = buckets(files, { today: new Date('2026-09-25T03:05:00Z'), tz: UTC3 }).result;
  assert.deepEqual([whats(after.overdue), whats(after.today)], [['due 24'], ['due 25']]);
  // 23:55 of 24/09 at UTC-3 is already 25/09 in UTC: the vault's day is still 24/09.
  const before = buckets(files, { today: new Date('2026-09-25T02:55:00Z'), tz: UTC3 }).result;
  assert.deepEqual([whats(before.overdue), whats(before.today), whats(before.upcoming)], [[], ['due 24'], ['due 25']]);
  const utc = buckets(files, { today: new Date('2026-09-25T02:55:00Z'), tz: 'UTC' }).result;
  assert.deepEqual(whats(utc.today), ['due 25'], 'the same instant is 25/09 in UTC');
  // A zone ahead of UTC: 00:30 of 25/09 in Tokyo is 15:30 UTC of 24/09.
  const tokyo = buckets(files, { today: new Date('2026-09-24T15:30:00Z'), tz: 'Asia/Tokyo' }).result;
  assert.deepEqual(whats(tokyo.today), ['due 25']);
});

test('today at the edges: on a Monday the weekend\'s items are overdue, none lost', () => {
  const rows = [['friday', '25/09/2026'], ['saturday', '26/09/2026'], ['sunday', '2026-09-27'], ['monday', '28/09/2026'], ['tuesday', '29/09/2026']];
  const { result } = buckets({ [FOLLOWUPS]: followups(rows), [PROMISES]: promises([]) }, { today: new Date('2026-09-28T12:00:00Z'), tz: UTC3 });
  assert.deepEqual(whats(result.overdue), ['friday', 'saturday', 'sunday']);
  assert.deepEqual(whats(result.today), ['monday']);
  assert.deepEqual(whats(result.upcoming), ['tuesday']);
  assertPartition(result, rows.length);
});

test('today at the edges: a deadline equal to today is due today in every shape', () => {
  const rows = [['dmy', '25/09/2026'], ['short', '25/9/2026'], ['iso', '2026-09-25'], ['in text', 'end of 25/09/2026']];
  const { result } = buckets({ [FOLLOWUPS]: followups(rows), [PROMISES]: promises([]) });
  assert.deepEqual(whats(result.today), ['dmy', 'short', 'iso', 'in text']);
  assert.deepEqual([result.overdue, result.upcoming], [[], []]);
});

test('today: a Date is read in the zone given; a string is taken as the vault\'s day; anything else is refused', () => {
  const root = makeVault({ files: { [FOLLOWUPS]: followups([]), [PROMISES]: promises([]) } });
  const config = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
  assert.throws(() => pendingBuckets({ root, config, today: '25/09/2026', tz: 'UTC' }), TypeError);
  assert.throws(() => pendingBuckets({ root, config, today: 20260925, tz: 'UTC' }), TypeError);
});

// ------------------------------------------------------------ settings and languages

test('pendingSettings: the configuration\'s own values, else its language pack\'s defaults', () => {
  const en = pack('en');
  assert.deepEqual(pendingSettings({ lang: 'en', briefing: {} }), { entries: en.briefing.pending, upcomingDays: 7 });
  assert.deepEqual(pendingSettings({ lang: 'en', briefing: {}, taxonomy: en.taxonomy }).entries, en.briefing.pending);
  const columns = structuredClone(en.taxonomy.columns);
  columns.followups.columns = ['When', 'Task', 'Who', 'Due', 'Then'];
  assert.deepEqual(pendingSettings({ lang: 'en', briefing: {}, taxonomy: { columns } }).entries, en.briefing.pending,
    'the defaults name columns by label, whatever the vault\'s contract');
  const own = [{ file: 'promises', heading: 'active_heading', date_column: 'Condition / deadline', what_column: 'What I promised' }];
  assert.deepEqual(pendingSettings({ lang: 'en', briefing: { pending: own, upcoming_days: 3 } }), { entries: own, upcomingDays: 3 });
  assert.deepEqual(pendingSettings({ lang: 'pt-BR', briefing: {} }).entries, pack('pt-BR').briefing.pending);
  assert.deepEqual(pendingSettings({ lang: 'en', briefing: { upcoming_days: 0 } }).upcomingDays, 0);
});

test('pendingBuckets: with no briefing.pending, an inserted column changes nothing: columns are found by name', () => {
  // The review's case: a learned contract with Priority inserted before What.
  const text = `${FRONT}\n## Open\n\n| Logged | Priority | What | With whom / where | Deadline | Next step |\n|---|---|---|---|---|---|\n| x | high | Send the report | Ana | 24/09/2026 | z |\n| x | low | Call the bank | bank | 2026-09-25 | z |\n`;
  const columns = structuredClone(pack('en').taxonomy.columns);
  columns.followups.columns = ['Logged', 'Priority', 'What', 'With whom / where', 'Deadline', 'Next step'];
  const { result } = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) }, { config: { taxonomy: { columns } } });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(whats(result.overdue), ['Send the report']);
  assert.deepEqual(whats(result.today), ['Call the bank']);
  assert.deepEqual(result.undated, []);
});

test('pendingBuckets: with no briefing.pending, a renamed column is a problem naming it, and no row is bucketed, not even undated', () => {
  const text = `${FRONT}\n## Open\n\n| When | Task | Who | Due | Then |\n|---|---|---|---|---|\n| x | renamed | y | 24/09/2026 | z |\n`;
  const columns = structuredClone(pack('en').taxonomy.columns);
  columns.followups.columns = ['When', 'Task', 'Who', 'Due', 'Then'];
  const { result } = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) }, { config: { taxonomy: { columns } } });
  assert.deepEqual(result.problems, [
    { code: 'column_missing', detail: { path: FOLLOWUPS, heading: '## Open', column: 'Deadline', line: 12 } },
    { code: 'column_missing', detail: { path: FOLLOWUPS, heading: '## Open', column: 'What', line: 12 } },
  ]);
  assert.deepEqual([result.overdue, result.today, result.upcoming, result.undated, result.later], [[], [], [], [], 0]);
  // Naming the columns in briefing.pending reads it.
  const named = buckets({ [FOLLOWUPS]: text, [PROMISES]: promises([]) }, {
    config: { taxonomy: { columns }, briefing: { pending: [{ file: 'followups', heading: 'open_heading', date_column: 'Due', what_column: 'Task' }] } },
  }).result;
  assert.deepEqual([named.problems, whats(named.overdue)], [[], ['renamed']]);
});

test('the default pending roles name real headings and columns of each pack\'s own taxonomy', () => {
  for (const lang of ['en', 'pt-BR']) {
    const defaults = pack(lang);
    assert.equal(defaults.briefing.upcoming_days, 7, lang);
    assert.deepEqual(defaults.briefing.pending.map((p) => [p.file, p.heading]), [['followups', 'open_heading'], ['promises', 'active_heading']], lang);
    for (const entry of defaults.briefing.pending) {
      const contract = defaults.taxonomy.columns[entry.file];
      assert.ok(contract.columns.includes(entry.date_column), `${lang}: ${entry.date_column}`);
      assert.ok(contract.columns.includes(entry.what_column), `${lang}: ${entry.what_column}`);
      assert.equal(typeof contract.labels[entry.heading], 'string', `${lang}: ${entry.heading}`);
    }
  }
  assert.deepEqual(pack('en').briefing.pending.map((p) => p.date_column), ['Deadline', 'Condition / deadline']);
  assert.deepEqual(pack('en').briefing.pending.map((p) => p.what_column), ['What', 'What I promised']);
});

test('pendingBuckets: a pt-BR vault reads its own headings and columns from the pack defaults', () => {
  const pt = pack('pt-BR');
  const config = {
    lang: 'pt-BR',
    taxonomy: { files: pt.taxonomy.files, columns: pt.taxonomy.columns },
  };
  const text = `${FRONT}\n# Acompanhamentos\n\n## Abertos\n\n| Registrado | O que | Com quem / onde | Prazo | Próximo passo |\n|---|---|---|---|---|\n| 20/09/2026 | Ligar para Ana | Ana | até 24/09/2026 | ligar |\n| 20/09/2026 | Sem data | Ana | quando der | - |\n`;
  const promessas = `${FRONT}\n## Ativas\n\n| Feita em | Para quem | O que prometi | Condição / prazo | Situação |\n|---|---|---|---|---|\n| 20/09/2026 | Ana | Mandar o relatório | 2026-09-25 | aberta |\n`;
  const root = makeVault({ files: { 'pendencias/acompanhamentos.md': text, 'pendencias/promessas.md': promessas }, config });
  const loaded = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
  delete loaded.briefing.pending;
  const result = pendingBuckets({ root, config: loaded, today: '2026-09-25', tz: UTC3 });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(whats(result.overdue), ['Ligar para Ana']);
  assert.deepEqual(whats(result.today), ['Mandar o relatório']);
  assert.deepEqual(whats(result.undated), ['Sem data']);
});

test('pendingBuckets: CRLF line endings and a byte-order mark keep the line numbers', () => {
  const text = `﻿${followups([['crlf', '24/09/2026']]).replace(/\n/g, '\r\n')}`;
  const root = makeVault({ files: { [PROMISES]: promises([]) } });
  writeVaultFile(root, FOLLOWUPS, text);
  const config = JSON.parse(readFileSync(join(root, 'brain-kit.config.json'), 'utf8'));
  const result = pendingBuckets({ root, config, today: '2026-09-25', tz: 'UTC' });
  assert.deepEqual(result.overdue.map((item) => [item.what, item.line]), [['crlf', 16]]);
});

// ------------------------------------------------------------ schema

test('the schema accepts briefing.pending and upcoming_days, and refuses a malformed entry', () => {
  const base = JSON.parse(readFileSync(join(KIT_ROOT, 'test', 'fixtures', 'config', 'valid.json'), 'utf8'));
  const good = structuredClone(base);
  good.briefing.pending = pack('en').briefing.pending;
  good.briefing.upcoming_days = 0;
  assert.deepEqual(validateConfig(good), []);
  const missing = structuredClone(good);
  missing.briefing.pending = [{ file: 'followups', heading: 'open_heading', date_column: 'Deadline' }];
  assert.ok(validateConfig(missing).some((e) => e.startsWith('$.briefing.pending[0].what_column')), validateConfig(missing).join('\n'));
  const extra = structuredClone(good);
  extra.briefing.pending = [{ ...good.briefing.pending[0], color: 'red' }];
  assert.ok(validateConfig(extra).some((e) => /pending\[0\]\.color: unknown key/.test(e)));
  const negative = structuredClone(good);
  negative.briefing.upcoming_days = -1;
  assert.ok(validateConfig(negative).some((e) => e.startsWith('$.briefing.upcoming_days')));
  const empty = structuredClone(good);
  empty.briefing.pending = [{ ...good.briefing.pending[0], date_column: '' }];
  assert.ok(validateConfig(empty).some((e) => e.startsWith('$.briefing.pending[0].date_column')));
});
