# Fill the rituals table from the calendar

Today is {{today}}. Vault: {{vault}}.
Run the kit with: {{kit}}

You are proposing the rows of the vault's weekly rhythm table from the person's calendar: the commitments that repeat, whether a class, a law office's weekly docket meeting, a lab's supervision or a reading group. Curation uses this table to link an event's title to the note it feeds, so the title goes in literally, as the calendar has it. Nothing enters the vault until the person has seen and confirmed each row.

## The connector

1. This runs in your session with the person, with this session's calendar connector. You only read the calendar: never create, change, delete or answer an event. The tool you use is that connector's `list_events` (on the command line, named with the prefix in `sources.calendar.tool_prefix` in `brain-kit.config.json`; other clients may use another prefix). It usually arrives deferred: load it with `ToolSearch` before calling it.
2. If the calendar tools are not in this session, say so and stop. Never work around it: no shell, no other API, no exported file, and never ask for a password or token. If a call fails, report the error exactly as it came and stop; conclude nothing the error does not say.

## The file

3. Run `{{kit}} sync`. If it refuses, stop and say why.
4. The file is the one at `taxonomy.files.rituals` in `brain-kit.config.json`. If that key is `null`, the file does not exist or it has no table, say so and stop, before reading the calendar. Read the table's header row: those columns, in that order, are the ones you fill. Never assume the columns; when one matches nothing that step 10 notes, ask the person what goes there.

## Read the last four weeks

5. In `brain-kit.config.json`, read `sources.calendar.calendars`: the person's calendars. An empty list means `primary`, their main calendar. This skill never reads the calendars in `sources.calendar.team_calendars`.
6. For each calendar, call `list_events` with all of these parameters, always explicit:
   - `calendarId`: the calendar;
   - `startTime`: 00:00 of the day 28 days before today, and `endTime`: `{{today_iso}}T00:00:00`, both with the vault's UTC offset (for UTC-3, `-03:00`), and `timeZone`: the zone in `vault.timezone`;
   - `eventType: ["DEFAULT"]`, which leaves out time off, focus blocks, working locations, birthdays and events created from Gmail;
   - `pageSize: 250`.
7. While a result carries `nextPageToken`, call again with the same parameters and `pageToken` set to that value. A calendar is done only when a page comes back without `nextPageToken`: the first page is not the whole calendar.

## Find the rituals

8. Count each event once, by its `id`, even when it appears on more than one calendar. A ritual is an event that repeats: its occurrences share one `recurringEventId`, or the same title (`summary`) appears at least three times in the four weeks.
9. Never count as a ritual:
   - an event from someone else's calendar, unless the configuration records consent (`sources.calendar.team_calendars_consent_noted: true`), and even then only the events the person takes part in;
   - a private event: marked private on the calendar, or with a title carrying a word from `sources.calendar.privacy.exclude_keywords`, or a title holding a phrase from `privacy.third_party_keywords` (the list `lint` refuses on an added line). Leave it out without copying its title anywhere.
10. For each ritual, note:
   - the title exactly as the calendar has it, letter for letter, never translated or summarised;
   - the cadence, read from the dates (every week, every other week, Monday to Friday, once a month);
   - the start and end time, in the vault's time zone;
   - the owner: the organiser (`organizer`), by name; when `organizer.self` is `true`, it is the person; when the event carries only an e-mail, ask the person what name to write;
   - the fixed attendees, those present in every occurrence: how many, and their names only when the person agrees, never an e-mail; when the event carries only e-mails, ask for the names.

## The rows

11. In the title column, write the literal title in straight quotes, with every `|` written as `\|`. An event called `Reading group | Ana` becomes `"Reading group \| Ana"`. That escaped form, quotes included, is the key: unescape it only to compare against the calendar, and keep it escaped to write and to compare against the table.
12. A title already in the table never goes in again. Read the file with the Read tool and compare the key, as exact text, with each row's title cell, without its surrounding spaces (the first cell in the kit's table; a cell ends only at a `|` with no `\` before it). Never run this search as a regular expression or through Grep: in a regular expression, `\|` and other characters become syntax, and the search misses the row or hits the wrong one. Older titles without quotes do not match this comparison: show them to the person when you ask for confirmation.
13. Ask the person which note each ritual feeds. A note outside every directory in `privacy.confidential_dirs` goes in as a link relative to the rituals file's folder, to a note that exists. A note inside one of them goes in as its path in backticks, never as a link, the path taken from the vault root: `lint` refuses a link into a confidential directory. With no note, write the text at `taxonomy.columns.rituals.labels.feeds_none` ("none yet" by default).

## Confirm and propose

14. Show every proposed row, already in the table's format, and say which titles were left out because the table already has them. Ask for confirmation and wait: the person may approve, correct or refuse each row.
15. Write only the confirmed rows, at the end of the table, and re-stamp the file's frontmatter with `generated: { by: {{agent}}, at: <ISO 8601 datetime with its UTC offset> }`, with `<model>` replaced by the model you are running as. Never write `verified`.
16. Run `{{kit}} validate` and `{{kit}} lint` and fix what they report, until both pass. A finding on a title is never fixed by rewording the title: drop the row, with the person.
17. Run `{{kit}} propose "<one-line summary>" --only <the rituals file>`, with that file alone. Give the person the pull request link and stop. Never merge it.
