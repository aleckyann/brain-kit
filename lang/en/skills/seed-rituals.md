# Seed the rituals table from the calendar

Today is {{today}}. Vault: {{vault}}.
Run the kit with: {{kit}}

You are proposing the rows of the vault's weekly rhythm table from the person's calendar: the commitments that repeat, whether a class, a law office's weekly docket meeting, a lab's supervision or a reading group. Curation uses this table to turn an event's title into the note it feeds, so the title goes in literally, as the calendar has it. Nothing enters the vault until the person has seen and confirmed each row.

## The connector

1. This runs in your session with the person, with this session's calendar connector. You only read the calendar: never create, change, delete or answer an event. The tool you use is that connector's `list_events` (on the command line, named with the prefix in `sources.calendar.tool_prefix` in `brain-kit.config.json`; other clients may use another prefix). It usually arrives deferred: load it with `ToolSearch` before calling it.
2. If the calendar tools are not in this session, say so and stop. Never work around it: no shell, no other API, no exported file, and never ask for a password or token. If a call fails, report the error exactly as it came and stop; conclude nothing the error does not say.

## Read the last four weeks

3. Run `{{kit}} sync`. If it refuses, stop and say why.
4. In `brain-kit.config.json`, read `sources.calendar.calendars`: the person's calendars. An empty list means `primary`, their main calendar.
5. For each calendar, call `list_events` with all of these parameters, always explicit:
   - `calendarId`: the calendar;
   - `startTime`: 00:00 of the day 28 days before today, and `endTime`: `{{today_iso}}T00:00:00`, both with the vault's UTC offset (for UTC-3, `-03:00`), and `timeZone`: the zone in `vault.timezone`;
   - `eventType: ["DEFAULT"]`, which leaves out time off, focus blocks, working locations and birthdays;
   - `pageSize: 250`.
6. While a result carries `nextPageToken`, call again with the same parameters and `pageToken` set to that value. A calendar is done only when a page comes back without `nextPageToken`: the first page is not the whole calendar.

## Find the rituals

7. A ritual is an event that repeats: its occurrences share one `recurringEventId`, or the same title (`summary`) appears at least three times in the four weeks.
8. Never count as a ritual:
   - an event from someone else's calendar, unless the configuration records consent (`sources.calendar.team_calendars_consent_noted: true`), and even then only the events the person takes part in;
   - a private event: marked private on the calendar, or with a title carrying a word from `sources.calendar.privacy.exclude_keywords`. Leave it out without copying its title anywhere.
9. For each ritual, note:
   - the title exactly as the calendar has it, letter for letter, never translated or summarised;
   - the cadence, read from the dates (every week, every other week, Monday to Friday, once a month);
   - the start and end time, in the vault's time zone;
   - the owner: the organiser (`organizer`), by name; when `organizer.self` is `true`, it is the person; when the event carries only an e-mail, ask the person what name to write;
   - the fixed attendees, those present in every occurrence: how many, and their names only when the person agrees.

## The table

10. The file is the one at `taxonomy.files.rituals` in `brain-kit.config.json`. Read its table's header row: those columns, in that order, are the ones you fill. Never assume the columns; when one matches nothing in step 9, ask the person what goes there. If the file has no table, say so and stop.
11. In the title column, write the literal title in straight quotes, with every `|` written as `\|`. An event called `Reading group | Ana` becomes `"Reading group \| Ana"`. That escaped form, quotes included, is the key: unescape it only to compare against the calendar, and keep it escaped to write and to search the table.
12. A title already in the table never goes in again: search for its escaped form, quotes included, in the file's raw text, without parsing the table. Older titles without quotes do not match that search: show them to the person when you ask for confirmation.
13. Ask the person which note each ritual feeds. The answer goes in its column as a link relative to the rituals file's folder, to a note that exists; with no note, write "none yet" (or the text at `taxonomy.columns.rituals.labels.feeds_none`).

## Confirm and propose

14. Show every proposed row, already in the table's format, and say which titles were left out because the table already has them. Ask for confirmation and wait: the person may approve, correct or refuse each row.
15. Write only the confirmed rows, at the end of the table, and re-stamp the file's frontmatter with `generated: { by: {{agent}}, at: <ISO 8601 datetime with its UTC offset> }`, with `<model>` replaced by the model you are running as. Never write `verified`.
16. Run `{{kit}} validate` and `{{kit}} lint` and fix what they report, until both pass.
17. Run `{{kit}} propose "<one-line summary>" --only <the rituals file>`, with that file alone. Give the person the pull request link and stop. Never merge it.
