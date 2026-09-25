---
type: llm
weight: 1
---

The model loads the matching skill. Its response states the steps it follows, or will follow once the calendar connector is in the session: read the last four weeks of the configured calendars with `list_events`, explicit `startTime` and `endTime`, and every `nextPageToken` page; take as rituals the events that recur (a shared `recurringEventId`, or the same title at least three times); write each title literally, in straight quotes, with `|` escaped as `\|`, never duplicating a title already in the table; show the rows and wait for the person's confirmation before writing; then `validate`, `lint` and `propose "<summary>" --only <the rituals file>`. Without the calendar connector's tools it says so and stops, never working around it, and it does not claim to have read the calendar or written the table.
