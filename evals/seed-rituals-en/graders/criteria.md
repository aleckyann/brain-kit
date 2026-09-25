---
type: llm
weight: 1
---

The model loads the matching skill. Its response names the steps the skill takes: read the last four weeks of the configured calendars with `list_events`, explicit `startTime` and `endTime`, and every `nextPageToken` page; take as rituals the events that recur (a shared `recurringEventId`, or the same title at least three times); write each title literally, in straight quotes, with `|` escaped as `\|`, never duplicating a title already in the table; show the rows and wait for the person's confirmation before writing; then `validate`, `lint` and `propose "<summary>" --only <the rituals file>`. A faithful run may stop at the first gate: when there is no vault or no calendar connector in the session, saying what is missing and stopping, while naming what the skill will do, meets this criterion. It never works around a missing connector, and it does not claim to have read the calendar or written the table.
