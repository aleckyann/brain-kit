# Calendar and meeting notes: the connector sources

A curator round can read two sources besides your Claude Code sessions: your calendar,
through the claude.ai Google Calendar connector, and your meeting notes, through the
claude.ai Google Drive connector. Both are off until you turn them on. Both are best
effort: a round that cannot read one keeps that source's day open and goes on without it.
Neither can write anything through its connector. This page says what each source reads,
how to turn it on, what a round does with your Claude Code settings to reach the
connectors, the states a connector can be in and what to do about each, and how to check
them.

What a round does step by step is in [scheduling.md](scheduling.md); what isolates the
model, and the measurements behind it, is in [security.md](security.md). Every measurement
on this page was taken on 24/09/2026 with Claude Code 2.1.281, the version on the
maintainer's machine, except the two memory switches, measured on 25/09/2026 with the same
version. A later version may behave differently: every round checks what it relies on
again, and `brain-kit doctor --probe` asks the CLI directly.

## What the two sources read

### The calendar

A round lists each calendar in `sources.calendar.calendars` over the days that source has
open (see "One window per source" below). `primary` names your own main calendar; any other
entry is a calendar id as the connector knows it. For each calendar the round gives the
model the exact inputs of the listing:

- `startTime` and `endTime`, covering the whole window, written as instants with an
  explicit offset;
- `eventType: ["DEFAULT"]`, which keeps out-of-office entries, focus time, working
  locations, birthdays and events created from mail out of the round altogether;
- `pageSize: 250`, and `timeZone`, the vault's.

The model must follow every next page the connector announces, with the same inputs plus
the page token.

A calendar counts as read only when the round's own record of the calls shows it: a
listing that started without a page token, covered the window with no slack, carried the
event-type filter and no other input on every page, and followed every advertised next page
to the last one, each page answered without an error and whole. A listing of part of the
day, one without the filter, one of another calendar, or one that stops at its first page
does not read the calendar (incident of 20/08/2026 in [incidents.md](incidents.md)). What
the model says it read is never the evidence.

Events are deduplicated by their id. In someone else's calendar, an event that already
includes you is skipped, since your own listing has it. The documents attached to the
events are the second door to meeting notes, below.

Some calendar settings in the configuration are read by no code of the round:
`sources.calendar.privacy` (`exclude_event_types`, `exclude_keywords`,
`team_personal_events`), `skip_events_with_owner`, `focus_blocks_as_ruler` and `dedup_by`.
The event-type filter is fixed at `DEFAULT` whatever `exclude_event_types` says, and the
privacy rules the model follows are the prompt's own (see "Privacy" below). Only the
`seed-rituals` skill reads `exclude_keywords`, to leave matching titles out of the rituals
table. A keyword you add there filters nothing in a round: `privacy.third_party_keywords`
is the list that `lint` enforces.

### The meeting notes

Meeting notes have two doors (incident of 11/08/2026):

- **The title search.** The round asks the document store for the documents whose title
  contains the literal in `sources.meeting_notes.search_title_contains`, modified after the
  start of the source's window minus `window_hours_before_day` hours (12 by default). The
  model is given the query exactly, `title contains '<literal>' and modifiedTime >
  '<instant>'`, and must follow every next page. The source counts as read only when the
  record shows that search, with both clauses as given and neither negated, answered
  without an error and whole to its last page.
- **The documents attached to the calendar's events**, reached through the calendar
  source's listing in the same round: all of them when `attached_title_prefix` is empty
  (the default), or only those whose title starts with it.

While the calendar source is on, a meeting-notes day closes only when the calendar was also
read over that day in the same round; the title search alone does not close it, and the
watermark line says `second_door_unread`. So the calendar is listed over every day the
meeting notes have open, including days the calendar itself already closed: such a day is
listed again only for its attachments, the parameters say so, and the model is told to
capture nothing new from it. That listing keeps the calendar's own cap of seven days: when
the two sources are further apart, the oldest seven days are listed, and the meeting-notes
days after them wait for a later round.

When the calendar is on but a round will not read it (its connector `needs_auth`,
`failed`, `absent`, `tools_missing` or `unknown` at the first launch, or a user rule that
blocks it), the meeting notes are not offered in that round at all. No search runs, no
model work is spent on them, and their days stay open with the reason
`waiting_for_calendar`: in the log (`source_waiting`, and the `watermark` line), in
`last-run.json` (`waitingFor`, naming the calendar and its state) and in `brain-kit
doctor`. Without that rule, a calendar that stayed away for days would have every round
distil the same notes again, at full model cost, into a new pull request. With the
calendar off, the title search alone closes a meeting-notes day.

For every note, the model reads the whole document, every tab and not only its summary,
and distills it into the vault's log under its literal title in straight quotes; a title
the log already holds is not distilled again. That check reads the log as the round's
checkout has it, the default branch: notes distilled into a pull request that is not merged
yet are not there, so a later round can distil the same notes again into a second pull
request. Merge or close a round's pull request before the next one runs to avoid that. A speaker attribution that looks wrong is a
divergence to confirm, never a fact. Before opening an attached document the model checks
its metadata, and it never opens an audio or video file, nor a document the meeting service
marks as a recording or a full transcription: those are listed by title as not read. The
`never_download` list in the configuration is informational: no code reads it, and that
rule holds whatever it says. A document that does not open for lack of permission is
written as "no access (document store permission)", never as empty (incident of
21/08/2026).

How many documents a round opens is counted and reported (`documents` in `last-run.json`),
never a condition, since the kit cannot know how many there are. `curate.caps.search_docs_opened`
and `curate.caps.attached_notes_opened` bound how many documents one round distils; past
them, the model lists every other note by its literal title as not distilled and reports
the source `partial`, which never moves its mark, so the next round goes on from there.

## Turning each source on

Both sources are off in a new vault (`"enabled": false`): nothing is read until you say
what to read.

**The calendar.** In `brain-kit.config.json`, under `sources.calendar`:

```json
"enabled": true,
"calendars": ["primary"]
```

The rest of the section stays as `init` wrote it. An entry that is blank, or a placeholder
such as `<owner-email>`, names no calendar, and the source stays off.

**The meeting notes.** Open one of your own automatically generated meeting notes, copy the
fixed part of its title exactly as the meeting service writes it, accents included, and set
under `sources.meeting_notes`:

```json
"enabled": true,
"search_title_contains": "<the fixed part of the title, copied>"
```

The language pack's default (`Notes by Gemini` in English, `Anotações do Gemini` in
Portuguese) is only a suggestion. The document search is accent sensitive: a literal
without its accent returns nothing and no error, a quiet day that looks like a day without
meetings (the undated incident "the document search is accent sensitive and fails
silently"). A literal holding a backslash turns the source off, because how the search
language escapes one is not measured.

**Checking.** `brain-kit curate --dry` shows the launch mode and each source's days;
`brain-kit doctor` says why a source is off and what the last round saw; `brain-kit doctor
--probe` asks the CLI for each connector's state now (see the last section).

**A vault made before these sources existed.** `init` used to write your e-mail address into
`sources.calendar.calendars`, with no `enabled` key. Such a vault keeps the calendar off
after an upgrade, and every round says so (`not_enabled`) until you add `"enabled": true`.
The meeting notes had no `enabled` key either, so they stay off. Their old defaults need
checking before you turn them on: `search_title_contains` was `Meeting notes` or `Notas de
reunião`, `attached_title_prefix` was `Notes - `, and `tool_suffixes` did not list
`get_file_metadata`, which the source now needs. `brain-kit update` adds no key to a
configuration.

**The connector settings.** `server_display_name`, `tool_prefix` and `tool_suffixes` default
to the claude.ai connectors as the CLI names them. A `tool_prefix` that is not one MCP
server's prefix (`mcp__<server>__`), a tool outside the source's read tools, or a list
without a tool the source needs turns that source off, and only that source, with the
problem named by the round and by `doctor`; the rest of the vault keeps working.

**Someone else's calendar.** A calendar in `sources.calendar.team_calendars` is read only
when the configuration records two things. `team_authorization` says who authorised reading
the team's calendars and on which day:

```json
"team_authorization": { "by": "human:ana", "at": "2026-09-01" }
```

`by` is a person, written `human:<handle>`, and `at` is a day that exists, YYYY-MM-DD; any
other shape is refused as configuration. `team_calendars_consent_noted: true` records that
the people whose calendars they are have agreed. Without either, the round leaves every team
calendar out, reads your own calendars as usual, and its parameters say how many were left
out and which record is missing; a calendar left out is never one the round has to read, so
this alone never makes a round exit 4, even with the calendar in `curate.sources.required`.
`brain-kit doctor` (check `connectors`) fails while team calendars are listed with no
authorization, naming `sources.calendar.team_authorization`, and warns while consent is not
recorded. With both, the round's parameters print "Team calendars authorised by human:ana on
01/09/2026" beside the calendars it lists. See "Privacy" below.

**The rituals table.** The `seed-rituals` skill, which fills the weekly rhythm table from
your calendar in your own interactive session, reads an empty `calendars` list as
`primary`, while a scheduled round reads an empty list as off. Both are on purpose: the
skill runs in front of you and asks you to confirm every row; the round runs alone.

## Why connector mode loads your user settings, and what it switches off

A round normally runs isolated from your Claude Code settings: no settings file of any kind
is loaded, and no MCP server but the ones passed ([security.md](security.md)). Measured,
that isolated mode cannot see the claude.ai connectors at all. With `--setting-sources ''`,
with or without `--strict-mcp-config`, a run has zero MCP servers, and neither
`ENABLE_CLAUDEAI_MCP_SERVERS=1` nor `--settings '{"disableClaudeAiConnectors": false}'`
brings them back. A claude.ai connector cannot be declared in `--mcp-config` either:
`claude mcp get` shows it as coming from the claude.ai configuration, with its status and
no URL or type.

What brings the connectors is loading your user settings, `--setting-sources user`, and that
brings much more. On the maintainer's machine it gave the run 54 MCP servers, 21 of them
claude.ai connectors (the calendar and the document store connected, with their tools named
`mcp__claude_ai_Google_Calendar__<tool>` and `mcp__claude_ai_Google_Drive__<tool>`); it
also ran a user hook and loaded 10 plugins, 109 skills, 6 agents and every user permission
rule.

So when a connector source has a day to read, the round launches in connector mode: your
user settings are loaded, and everything they bring besides the connectors is switched off,
each part measured on its own:

- **hooks:** `--settings '{"disableAllHooks":true}'` gave zero hook events, with the
  connectors still connected;
- **skills:** `--disable-slash-commands` removes the Skill tool and every skill;
- **built-in tools beyond the pinned set:** `--tools Read,Glob,Grep,Edit,Write,Bash,ToolSearch`
  leaves exactly those (the default set also exposes Task, Workflow, CronCreate,
  RemoteTrigger, SendMessage, Artifact and more), while MCP tools stay available;
- **your allow rules:** a user allow rule stays active in that mode (one allowing
  `Bash(rtk curl *)` let that command run), and the same rule passed in `--disallowedTools`
  denied it, because a deny wins over an allow. So every allow rule in the `settings.json`
  and `settings.local.json` of your user settings folder (`CLAUDE_CONFIG_DIR` when it is
  set, `~/.claude` otherwise) is mirrored as a deny, except a rule the round's own allow
  list already holds, some read rules (below), and a write rule inside the vault, which the
  round's own rules already govern. A path rule (`Edit`, `Write`, `NotebookEdit`,
  `MultiEdit`, or a read rule) is passed in its resolved absolute form, `Edit(//<path>)`,
  never as written: in a settings file `/x` is anchored at that file's folder, but a rule
  on the command line has no settings file, and where the CLI would anchor it there is not
  measured. `~/x` is resolved with the round's home, `/x` with the settings folder, and
  `./x` or `x` with the vault. A write rule that reaches the vault only through a link (a
  home or settings folder that is a link) is mirrored only when it reaches one of the kit's
  protected paths; on the vault's ordinary folders it is left to the round's own rules;
- **memory:** measured on 25/09/2026, the CLI's first event lists the auto-memory folder in
  both launch modes unless `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` are in its environment. Every round sets both.

The round checks all of this from the CLI's first event, before the model does anything:
the permission mode is `dontAsk`, no hook event appeared, the built-in tools are exactly the
pinned set, and no memory folder is listed. Anything else stops the model at once, exit 1.

Some user rules cannot be mirrored without denying the round's own tools, and those refuse
connector mode for the round:

- a bare `Bash`, `Bash(*)`, or a Bash rule that covers one of the kit's own commands;
- an `Edit` or `Write` rule on the vault, or on a folder that holds it;
- a settings file that cannot be read, or one the kit cannot locate (a relative
  `CLAUDE_CONFIG_DIR`, or with it unset a relative `HOME`);
- a rule the kit cannot read with a known meaning: one that splits into several rules, holds
  a parenthesis or a control character in its scope, ends its scope in a backslash or holds
  an odd number of double quotes; a write rule whose scope could climb out of its literal
  prefix (a `..` segment, or `{` alternatives); or a path rule to mirror whose resolved form
  would hold a character no rule can carry (a comma, a parenthesis, a bracket or a
  backslash, in your home or settings folder path, say).

The round then runs isolated, on the transcripts alone. Every connector source gets the
state `blocked_by_user_rules`, and the rule and its file are named in the log, in
`last-run.json` and by `doctor`. A rule for a connector's whole server
(`mcp__claude_ai_Google_Calendar`, say) would, mirrored, deny that source its own read
tools: that source alone is blocked, naming the rule.

What connector mode cannot switch off:

- **Your MCP servers start.** Every server your user settings declare is started for the
  round. Under `dontAsk` their tools run only where an allow rule the round keeps says so,
  and the round keeps none for them.
- **Some user rules that allow reads widen what the model can read.** A read rule (`Read`,
  `Glob`, `Grep`, `LS`) whose scope is disjoint from the vault and from every read the round
  itself allows (the transcripts its plan lists, a read rule of
  `curate.allowed_tools_extra`) is mirrored like any other. A bare one, or one whose scope
  overlaps the vault or those reads, is never mirrored, because the deny would take the
  round's own reads: one that reaches outside the vault is recorded as widening reads
  (`userRules.widenedReads` in `last-run.json`), and `brain-kit doctor` names it (check
  `round-scope`; doctor judges against the whole transcripts folder, so it may name a rule
  a round would mirror). Scope such rules to what you need.
- **Not measured, so not relied on:** `permissions.additionalDirectories` in your user
  settings, managed or policy settings (loaded in both modes), the older per-project
  `allowedTools` in `~/.claude.json`, and the user settings that are not permissions: your
  output style, the `env` block, the model settings. They reach a connector-mode round as
  you wrote them, and the round's first event is not checked for them. Whether your own `~/.claude/CLAUDE.md` reaches a
  connector-mode round could not be asked on 25/09/2026, because the CLI's login had
  expired; the memory switches above are what the CLI offers against it.

The connectors' write tools (`create_event`, `update_event`, `delete_event` and
`respond_to_event` for the calendar; `create_file`, `update_file`, `copy_file`,
`share_file`, `trash_file` and `download_file_content` for the document store) are denied
to every round in connector mode, whatever your configuration or your settings say.
Measured, a tool named in `--disallowedTools` is removed from the session altogether.

## The states of a connector, and what to do

Each connector's state is read from the round's own first event, the one the CLI prints
before the model's first turn, never from a separate listing: on four nights of September
2026 the CLI's listing said connected while the tools were not in the session that needed
them (incident of 05/09/2026).

| State | What it means | What to do |
|---|---|---|
| `connected` | listed as connected, with every tool the source needs in the session | nothing |
| `needs_auth` | the connector needs you to sign in again | reconnect it in your claude.ai connector settings, then run `brain-kit doctor --probe` |
| `failed` | the connector failed to connect | check it in your claude.ai connector settings, and run `brain-kit doctor --probe` again later |
| `pending` | still connecting when the session started | nothing yet: the round keeps the source and its evidence decides; if it keeps coming back pending, treat it as `failed` |
| `absent` | not in the session's server list: never connected in claude.ai, or disabled for Claude Code, and the two cannot be told apart | connect it in claude.ai, make sure it is enabled for Claude Code, then run `brain-kit doctor --probe` |
| `tools_missing` | listed as connected, but a tool the source needs is not in the session | when `doctor` names another prefix the tools were seen under, set `sources.<source>.tool_prefix` to it; otherwise compare the environment the round runs in with one where the tools work (incident of 05/09/2026) |
| `unknown` | a status this version of brain-kit does not know | update brain-kit; until then the source is not read |
| `blocked_by_user_rules` | a rule in your Claude Code user settings refuses connector mode, or would deny the source its own tools | `brain-kit doctor` names the rule and its file: scope it or remove it |

Disabled is a state, not an error (incident of 14/09/2026): a connector disabled for Claude
Code shows as `absent`, exactly like one that was never connected.

On the first launch, a source whose connector is `needs_auth`, `failed`, `absent`,
`tools_missing` or `unknown` makes the round kill the model before its first turn and
launch once more without that source. The second launch is told the source is unavailable,
and to reach it no other way, not through the shell and not through any other tool.
Measured, connector mode printed its first event about 2.8 seconds after it started, and a
launch killed there made no model call: a relaunch costs about three seconds and no model
money. There is never a second relaunch, and `pending` does not cause one.

## Tool names: the CLI's, not the desktop application's

In the CLI, a claude.ai connector's tools are named after the server's display name,
`mcp__claude_ai_<Server>__<tool>`, the spaces of the name written as underscores:
`mcp__claude_ai_Google_Calendar__list_events` for "claude.ai Google Calendar". The desktop
application names the same tools by an identifier of its own, so a prefix copied from a
desktop session never matches a round (incident of 10/08/2026, "three debugging iterations
on the wrong thing"). The defaults in the configuration are the CLI's names. The tools
arrive deferred: the model loads them through ToolSearch before its first call, which is
why ToolSearch is in every round's pinned set.

## Privacy

The policy is written for any profession and any life:

- From someone else's calendar, only events shared with other people count (at least two
  attendees), and nothing about anyone's private life (health, absence, family, personal
  errands) is ever written, not even as a mention.
- The event-type filter is part of the evidence, so an out-of-office entry never reaches
  the model at all.
- Someone else's calendar is read only with `team_calendars_consent_noted: true` and a
  `team_authorization`. Set the first only after those people have agreed: it is the vault's
  record of their consent. Set the second only once reading the team's calendars has been
  authorised: it records who authorised it and on which day.
- `lint` refuses a line a change adds that holds one of the terms in
  `privacy.third_party_keywords` (a list per language pack, about health and private life),
  so a pull request that writes one is refused before it is published. `brain-kit doctor`
  (check `privacy-keywords`) warns when the list is missing or empty, as it is in a vault
  made before the list existed.

## Best effort, the notification, and `doctor --probe`

The two connector sources are listed in `curate.sources.best_effort` by default. A
best-effort source that a round does not read keeps its own day open and never changes the
round's exit code: the transcripts are still curated and proposed. Listed in
`curate.sources.required` instead, a connector source that is off stops every round (exit
1), and one left unread makes the round exit 4.

**One window per source.** Each source reads only its own open days, the days after its own
mark, oldest first and at most seven, and advances only through the days it read
([scheduling.md](scheduling.md), "The watermark"). A calendar two days behind the
transcripts reads its two days, while the transcripts read only theirs. The one exception
is the calendar while the meeting notes are on: it is also listed over the meeting notes'
open days, within its own seven, for their attachments (see "The meeting notes" above).

**The notification.** When a best-effort source's connector state differs from the one the
previous round saw (no earlier state counts as `connected`), `machine.notify_command` runs
once, naming the source, the state and this page. It runs once more when the connector
comes back, and never again while the state stays the same. `pending` is never announced.
The session's status line (the plugin's SessionStart hook) names each connector source that
was not connected in the last round, with the date of that round.

**`brain-kit doctor`**, check `connectors`, says for each connector source listed: that it
is off, and why when it is half configured; the state the last round saw, with that round's
date; the prefix the tools were seen under, when it is not the configured one, naming both
and the setting; other people's calendars listed without the recorded consent; every user
rule that refuses connector mode, with its file; and that the meeting notes wait for the
calendar (`waiting_for_calendar`) when the calendar's last state, or a user rule, keeps it
from being read. A state other than `connected` is a
warning, and a failure only for a source in `curate.sources.required`.

**`brain-kit doctor --probe`** asks the CLI now, without a round. It launches the round's own
connector mode (the same flags, the same allow and deny lists, your user rules mirrored the
same way) with a one-line prompt, kills it at its
first event, before any model call, and reports each connector's state from that event. It
also reports anything in that event that would stop every connector-mode round: a hook, a
built-in tool beyond the pinned set, a memory folder. It writes nothing: no
`last-run.json`, no log, no mark. When your rules refuse connector mode it launches
nothing, as a round would not.

```bash
brain-kit doctor --only connectors --probe
```

## What the evidence cannot show

The evidence is the record of the calls the model made, and some things are not in it:

- The text of a result is not kept, only whether it came back whole (one JSON object),
  whether it advertised a next page, and how many events or files its page listed. So a
  page token the connector accepts that is not the one it advertised, an error written
  inside a result that is not marked as one, a connector that caps a listing without saying
  so, and a next-page key renamed by a later release (which reads as a last page) cannot be
  seen.
- A source reported `empty` whose reads listed something (any listing of a planned calendar
  over the window, any search with both clauses, not only the one that proves the read)
  does not move its mark: the
  watermark line says `inconsistent_empty`, and `listed` in `last-run.json` holds the count
  (so "the search found two, opened none, reported empty" keeps the day open). A source
  reported `ok` closes its day however many of the documents found were opened: how many a
  round opens is never a condition.
- How much of a document the model read: opening it counts, as opening a transcript does.
