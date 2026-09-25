# The morning briefing

The morning briefing is one message, in a session of your own, that tells you where your
vault stands today: what is overdue and due, what is coming up, which pull requests wait
for your merge, which notes are due for review, what the curator could not read, and the
questions the vault needs you to answer. The facts in it are computed by the kit; the
judgement (blind spots, the vault against its strategy, the blocks you write yourself) is
the model's. What you answer, and what the briefing learns, becomes one pull request.

It is not the curator. The curator ([scheduling.md](scheduling.md)) runs unattended,
reads your Claude Code sessions, calendar and meeting notes over the days since its last
round, and proposes what they taught the vault. The briefing reads none of those sources
(by default: the optional `today_calendar` block reads today's events from your own
session's calendar connector): it reads the vault and the kit's own state, it asks you
questions, so it always runs in your session with you there, and it writes only what you
told it or what it found in the vault.

Every date on this page is written DD/MM/YYYY.

## How it starts

Two ways, the same briefing:

- **You ask for it.** In a Claude Code session opened inside the vault, with the plugin
  loaded, ask for your morning briefing. The `briefing` skill runs
  `brain-kit prompt briefing` through its `!` line and the model follows what it prints.
- **The desktop task.** A scheduled task of the Claude desktop application starts a
  session on the schedule in `briefing.schedule` (`0 9 * * 1-5` by default) and runs the
  same command for your vault. See [The desktop task](#the-desktop-task) below.

`briefing.enabled` (`true` by default) turns the briefing off in the vault. Set to
`false`, `brain-kit prompt briefing` prints one line instead of the briefing, in the
vault's language, saying the briefing is turned off there (naming the key) and telling
the model to say so and stop; it records no question and exits 0, so a briefing you ask
for and one the desktop task starts both end there. `schedule install --job briefing`
refuses to register a task for such a vault, and `schedule status --job briefing` and
`doctor` say so when a task is still registered. `prompt --check` is not affected.

## What the kit computes

```bash
brain-kit preflight [dir]          # the facts, as text in the vault's language
brain-kit preflight [dir] --json   # the same facts as JSON (version brain-kit.preflight/1)
```

`preflight` only reads: no lock, no fetch, no write. It exits 0, or 2 outside a vault or
with a configuration it cannot use (a `vault.timezone` this system does not know, since
without it there is no today). The briefing's fact blocks are this same computation, as
text; the model is told to present each fact as the block writes it and never to compute
one of its own: no recounting, no turning a date into a weekday or a number of days, no
working out whether something is late.

| Fact | Where it comes from |
|---|---|
| Today and its weekday | the clock, in `vault.timezone`, never the machine's zone |
| The curator's last round | `<state dir>/last-run.json`: when, the exit and what it means, the reason, and for each source its state and whether its mark advanced; a record that cannot be read is said to be unreadable, never "no round yet" |
| Connector states | the states the rounds carry in `last-run.json`, each with the round that saw it |
| Open pull requests | `gh api --paginate` over the repository's open pull requests, every page, with no cap; `gh` absent, failing or printing something else gives "not known" and the reason, never an empty list |
| Notes past their `stale_after` | the same files `validate` judges; a plain date is due on that day in the vault's zone, a date and time with an offset at that instant; a note that cannot be read is named as not verified |
| Pending items by deadline | the tables `briefing.pending` names (below) |
| Git | the branch, how many paths the working tree changes, and how far the default branch is behind and ahead of its remote branch as of the last fetch: the briefing never fetches |
| The vault lock | free, or held by which command |
| The question queue | open, escalated and due for archiving, and every line that cannot be read (below) |

On the one day a plain `stale_after` falls due, `validate` (which reads a plain date as
midnight UTC) and the briefing (which reads it in the vault's zone) can disagree for a few
hours. The briefing states only its own verdict.

### Pending tables and deadlines

`briefing.pending` lists the tables to read, each as `{ file, heading, date_column,
what_column }`: `file` is a key of `taxonomy.files`, `heading` a key of that file's labels
in `taxonomy.columns`, and the two columns are header cells of the table under that
heading. The packs read the open follow-ups (`Deadline`, `What`) and the active promises
(`Condition / deadline`, `What I promised`). Columns are found by their exact header
name, never by their place: a table without the named column is a problem naming the
file, the heading and the column, and none of its rows is counted.

A cell's deadline is the first real calendar date in it, written DD/MM/YYYY (day and
month may have one digit) or YYYY-MM-DD. Each item lands in exactly one bucket, for today
in the vault's zone and `briefing.upcoming_days` days (7 by default):

| Bucket | Deadline |
|---|---|
| overdue | before today |
| due today | today |
| upcoming | after today, at most `upcoming_days` days after it |
| later | after that (a count only) |
| no date | no real date in the cell |

"No date" is a bucket of its own: an item is never dropped. What the kit cannot be sure
of is said next to the item it belongs to:

- a date-shaped text that names no real day (`31/02/2026`) is a problem naming the file
  and the line, and the item goes by the cell's first real date, or to "no date";
- a day and month without a four-digit year (`05/10`, `05/10/26`) is not taken for a
  date and is named as something that may be a date; the kit cannot tell `3/4` the ratio
  from the 3rd of April, and a pair the calendar does not allow (`13/13`) raises nothing;
- a cell with a deadline and any other date-like text (a second full date, an unreal one,
  one without a year) keeps its bucket by the first real date and is named with the
  others, so the briefing says which one is meant.

A table, heading or column that is not there, a heading written twice, a second table
under a heading, and a file in `briefing.never_read` (never opened) are each a problem,
never an exception, and the briefing shows them.

## The blocks

The briefing's content is the vault's own `briefing.blocks`: an ordered list of blocks
from the kit's catalog and blocks you define. The packs ship this list:

```json
["sources", "due", "upcoming", "undated", "open_prs", "stale", "blind_spots", "strategy", "questions"]
```

A configuration that sets the list is taken exactly as written, and nothing it does not
name is ever added. One that predates the setting reads its language pack's list.

| Block | Kind | What it shows |
|---|---|---|
| `sources` | fact | the curator's last round, each source whose mark did not advance with what to do about it, the carried connector states, git and the lock |
| `due` | fact | overdue items and items due today |
| `upcoming` | fact | items due within `briefing.upcoming_days`, and how many fall later |
| `undated` | fact | pending items with no readable deadline |
| `open_prs` | fact | every pull request awaiting your merge |
| `stale` | fact | notes past their `stale_after` |
| `questions` | fact | the escalated questions, then the other open ones, then room for new ones |
| `blind_spots` | judgement | what the vault should know and does not, from the `briefing.read` notes and the headings of the log with the most recent section under them |
| `strategy` | judgement | where the vault stands against the strategy document: the notes linked from `briefing.strategy_doc.index` whose link text contains `strategy_doc.title_contains`; skipped, and said so, when none is configured or found |
| `today_calendar` | judgement | today's events from the calendar connector of your own session, with the calendar source's privacy policy; when that connector is not in the session, the briefing says so and skips the block. Not in the default list |

A fact block is filled by the kit, in the vault's language, and the model only presents
it. A judgement block is an instruction the model follows, with the paths it may read.

### Blocks of your own

A block you define is an object with an id, a title, the notes it reads and your
instruction:

```json
{
  "briefing": {
    "blocks": [
      "sources", "due", "upcoming",
      {
        "id": "reading-group",
        "title": "Reading group",
        "read": ["projects/reading-group.md"],
        "instruction": "Say which book the group reads next, and what Ana still has to prepare before Thursday's meeting."
      },
      "questions"
    ]
  }
}
```

The id is lower case letters and digits, words joined by `-` or `_`, starting with a
letter, and cannot be a catalog id. The `read` paths are relative to the vault. The
model follows your instruction within every rule of the briefing, the never-read list
first.

### What is refused, by name

Nothing is dropped in silence. Each of these is a named problem; the block it concerns is
left out, the briefing opens by saying which and why, `prompt briefing` repeats it on
stderr, `doctor` warns about it and `prompt --check` lists it:

- `briefing.blocks` that is not a list, or an empty list (never replaced by the default
  one: the briefing then says it has no block);
- an unknown id, or an id listed twice (given once, in its first place);
- an entry that is neither an id nor a block object;
- a block of your own with a bad id, an id of the catalog, a missing title or
  instruction, or a `read` path that is empty, outside the vault, inside
  `briefing.never_read`, missing, or not a file.

### `never_read` wins over every block

`briefing.never_read` lists what the briefing keeps out (the packs: the people and
attachments folders, `.brain-kit/`, and the log read whole). What that means, exactly as
built:

- **The kit** never puts the content of a covered path in the prompt: no block reads it,
  a pending table under it is not opened (a problem says so), and an entry of
  `briefing.read` it covers is left out and said. Where the kit must mention a covered
  path, it shows the path marked "(never read)", never its content: a stale note in the
  people folder, say. The kit's own mechanical checks still read the frontmatter of every
  note, covered ones included, as `validate` always has: that is how the stale count
  knows a note's `stale_after`.
- **The model** is told never to open, list or search a covered path, not even to check
  that it exists, even when a block names it, and no configuration turns that rule off.
  It is an instruction to the model, not a sandbox: the session keeps the tools it has
  (yours, when you ask for the briefing in your own session).

An entry ending in `/`, or
without it, covers that folder and everything under it; an entry with a `#` after a file
name (`memory/log.md#full`) forbids reading that file whole, so the log is read by its
headings and the section under the most recent ones. A block's `read` path is checked
against the list before the file system is touched, so a path you keep out is not even
checked for existence, and again by its real path, so a link inside the vault that leads
into a never-read folder is refused too.

## Limits

`briefing.max_words`, `briefing.max_questions`, `briefing.write_caps.captures` and
`briefing.write_caps.pending_changes` are `null` by default: no limit. A number you set is
honoured, and the briefing says so in one line when it stops it from saying, asking or
writing something. Only the limits you set reach the prompt; with all of them `null` the
prompt says there is no limit.

## The question queue

The questions the briefing wants you to answer live in one file of the vault's state
directory, outside the vault: `machine.json`'s `paths.questions_log`, by default
`<state dir>/questions.log`, one JSON object per line, written atomically (a private
temporary file renamed over it, mode 0600). A question asked today and not answered is
asked again tomorrow instead of being lost with the session.

```bash
brain-kit questions list [dir]
brain-kit questions add "<text>" [dir]
brain-kit questions answer <id> [dir]
brain-kit questions archive <id> [--reason "<text>"] [dir]
brain-kit questions sweep [dir]
```

- **One question, one id.** A question's text is normalised (Unicode NFC, lower case,
  punctuation and symbols turned into spaces, runs of white space collapsed, trimmed;
  accents are kept, so "e" and "e" with an accent are different letters), and its id is
  `q-` plus the first 8 hex characters of the SHA-256 of that text. `add` queues nothing
  for a duplicate, and names the question it duplicates: an open question with the same
  normalised text, or one answered within `briefing.questions_dedup_days` (15 by
  default).
- **Asked.** A question counts as asked on a day only when the real
  `brain-kit prompt briefing` render shows it: after the whole text is rendered, only the
  ids that appear in that final text, once per day however many times the briefing is
  rendered. `prompt --check`, `doctor`, `preflight` and `questions list` never count one.
  When the kit cannot record them, the briefing is still printed, ending with a correction
  line that says the questions were not recorded, and the reason goes to stderr; the
  command still exits 0, since the text is for the model (see below).
- **Escalated.** An open question asked on at least `briefing.question_escalate_after`
  days (3 by default) is escalated: the briefing places it first and says so when it asks
  it.
- **Archived, out loud.** An open question created more than
  `briefing.question_max_age_days` days ago (45 by default) is due for archiving: the
  briefing says so, and `questions sweep` archives each such question and prints it. No
  question is archived in silence, and `sweep` with the limit `null` changes nothing and
  says so.
- **Answered only by the command.** The model marks a question answered with
  `questions answer <id>` only after you answered it in that session; it archives one
  only when you ask.
- **Limits.** A key left out of `briefing` takes the language pack's default (15, 3 and
  45 in both packs); a key set to `null` means never: no dedup against an answered
  question, no escalation, no archiving by age.
- **Nothing lost.** A line that cannot be read is kept as it is by every write and reported
  by every subcommand with its line number; `list` and `sweep` then exit 1. The writing
  subcommands take the vault lock and a lock of the queue's own, so two writers never lose
  each other's question.

With `briefing.max_questions` set, the escalated questions come first, then the other open
ones, up to the limit; the rest are said to wait for another day.

## Recording: one pull request

The briefing is text first. When there is something to record (an answer you gave, a fact
you told it, a correction to a note), each item goes into the log under today's heading
with the capture marker and says it came from the briefing, and a change to a pending item
goes into its own table. Then the model runs `validate`, `lint --base worktree` and one
`propose "<summary>" --only <paths>`, naming exactly the files it wrote. With nothing to
record, it writes nothing and proposes nothing, and says so.

`propose` never moves the working tree, so the files it proposed stay changed after it.
It records what it pushed in the proposed-paths ledger (`<git dir>/brain-kit-proposed.json`),
and one comparison reads it everywhere: a file whose bytes are exactly what was pushed is
proposed already. The Stop hook leaves it out and releases, a second `propose` of it
opens no second pull request (exit 0, naming the branch that holds it), and the next
`sync` (so the next curator round, at its step 5) brings it back to the default branch's
content instead of postponing on it; the content lives on the pushed branch. One byte
edited after the push makes the file unproposed work again for all three. After you merge
the pull request, the next round restores the file and fast-forwards the default branch,
so the merged capture is what ends up on disk.

A question is marked answered only after the `propose` that records its answer exited 0
or 3 with the commit pushed. When a curator round holds the vault's lock, the kit's
writing commands exit 75 naming it; the briefing then stops writing, tells you the round
holds the vault and the exact command to run once it is done, and never marks the
question answered.

## What never changes

These rules stay out of configuration: no setting turns them off, and no overlay drops
them without `prompt --check` saying so.

- Nothing in `briefing.never_read` reaches the prompt as content, and the model is told
  never to open, list or search it (an instruction, not a sandbox: see
  [`never_read` wins over every block](#never_read-wins-over-every-block)).
- The vault changes only by pull request, through `propose --only`.
- Uncertainty is said with exactly one of three expressions: not verified, not found,
  don't know.
- Nothing is said to be empty, missing or unchanged unless it was opened in that session
  or a block of the kit says so.

Every date, count and deadline comes from the kit, questions go through the kit's
command, and the limits you set are honoured. Each of these rules is marked in both
packs' prompt (`<!-- rule:<id> -->`), and `prompt --check` fails a pack without one.

## The prompt and its overlay

The prompt is `lang/<code>/prompts/briefing.md` in the vault's language, or the vault's
own overlay at `briefing.prompt` (`.brain-kit/prompts/briefing.md` by default) when that
file exists. An overlay outside the vault is refused. Its placeholders are
`{{signature}}`, `{{today_human}}`, `{{today_iso}}`, `{{kit}}`, `{{vault}}`, `{{blocks}}`,
`{{read}}`, `{{never_read}}`, `{{limits}}`, `{{log}}`, `{{capture_marker}}`, `{{agent}}` and
`{{now_iso}}`.

The desktop task's session does not start in the vault (see [The desktop task](#the-desktop-task)),
and every kit command finds its vault from the working directory. So in the briefing
`{{kit}}` is the kit's command with the vault already in it, `"<kit>/bin/brain-kit.mjs" -C
"<vault>"`, in the prompt and in every block, and `{{vault}}` is the vault's absolute path:
the prompt says that every path in the briefing is relative to it and that a file is
opened and edited by its absolute path under it. `-C <dir>` is a global option of the kit,
as git's: `brain-kit -C <dir> <command> ...` runs the command exactly as if it had been
started in `<dir>`, so `propose --only` reads its paths from the vault too.

`brain-kit prompt --check` inside the vault fails an overlay whose first line is not
`{{signature}}` (the curator tells a briefing session apart by it; the render puts it in
front anyway) or that does not use `{{blocks}}` (the model would see no block, and no
question placed for it would reach you), and warns about one without `{{never_read}}`,
`{{read}}` or `{{vault}}`, without a contract marker, or with a placeholder the briefing does
not fill.

`brain-kit prompt briefing [--vault <dir>]` prints the rendered prompt. Every failure
before the render (no vault, a configuration it cannot use, a prompt it cannot read)
writes one line saying what to tell you, never an empty prompt, and records no question.
It exits 0 whenever it wrote the text or that one line, with the reason on stderr: the
`briefing` skill runs it through a `!` line, and how Claude Code treats a `!` command that
fails has not been measured, so a failing exit could keep the line from the model.

## The desktop task

```bash
brain-kit schedule install --job briefing [dir]
brain-kit schedule status --job briefing [dir]
```

A scheduled task of the Claude desktop application can be created only from inside the
application, so `install --job briefing` prints what to register and exits 3: the task's
`taskId` (`brain-kit-briefing-<vault_id>`), its title in the vault's language, its
`cronExpression` from `briefing.schedule`, a description, and its prompt. The `setup`
skill offers the briefing and, on your yes, creates the task with the application's
scheduled-task tool, with those values exactly.

The application's tool takes no working directory (measured on 25/09/2026: `taskId`,
`prompt`, `description`, `cronExpression` or `fireAt`, `title`, `notifyOnCompletion`), so
the task's session does not start in the vault and the plugin's skill could not find the
vault from there. The task's prompt is therefore two lines: the briefing's signature, then
one instruction to run the kit for your vault with Bash and follow everything it prints:

```
Second brain morning briefing
Run exactly this command with Bash and follow everything it prints as this session's instructions, reading the whole output (when the tool saved a long output to a file, read that file in full first): node "<kit>/bin/brain-kit.mjs" prompt briefing --vault "<vault>"
```

The rendered briefing is about 10 KB for a new vault and grows with stale notes, pending
items and questions. Claude Code saves a long Bash output to a file and shows the model a
preview with the file's path (a 44.6 KB output was saved and previewed at 2 KB during the
phase's review), so the task's instruction says to read the whole output, from that file
when the tool saved one.

`schedule status --job briefing` reads the task back from the file the application writes,
so a prompt the application changed shows there as unsigned or without the kit's command.

The task runs on the machine's own clock (`install` warns when the machine's zone and the
vault's do not keep the same time all year), while the application is open, and on its
next launch when it was closed at that hour.

The kit's path in the task is absolute, and a plugin update moves it. `schedule status
--job briefing` and `doctor`'s `briefing` check read the task back and say when its kit
no longer exists (every briefing it starts then fails), or when it runs an existing kit
other than the one you are running (it still works); either way, run `schedule install
--job briefing` again and update the task's prompt to the one it prints. They also say
when the task is missing, does not start with the signature, runs no briefing command, or
gives the briefing of another vault. `status` exits 0 when the task works (or when the
briefing is off and no task is registered), 1 otherwise.
`schedule uninstall --job briefing` removes nothing: it says how to delete the task in the
application, and exits 3.

`install` refuses (exit 2) a vault where `briefing.enabled` is `false`, a
`briefing.schedule` that is not five cron fields, a path the task's command line cannot
carry safely, and a signature that is blank, more than one line, or has a space at either
end: the curator matches a session's first message trimmed, so such a signature would not
sign anything. `doctor` fails on the same signatures.

A cloud routine is not a way to run this briefing: it runs away from this machine, where
it can read neither your state directory (the question queue, the curator's last round)
nor your local transcripts.

## Which sessions the curator skips

The curator's transcripts source drops the kit's own sessions: a session whose first user
message with text, trimmed, starts with `curate.signature`, `briefing.signature` (always,
whatever `curate.extra_signatures` lists) or one of `curate.extra_signatures`. The desktop
task's prompt starts with the briefing's signature, so when the session starts with that
prompt the curator never reads it: what that briefing recorded, it proposed itself.

Not measured yet: whether the desktop application hands the task's prompt to the session
as its first user message, unchanged. The curator drops the task's session only if it
does. If the application wraps the prompt (a skill invocation line, a header), the session
is read like one of your own: the cost is the one of a briefing you ask for yourself (a
capture the next round may propose again, visible in its diff, nothing lost), and only
when the task's working directory is a project listed in
`sources.transcripts.include_projects`. After the first scheduled run, `brain-kit curate
--dry` shows the transcripts plan and how many sessions it left out as the kit's own.

A briefing you ask for in your own session starts with your own message, so it is your
session and the curator reads it like any other. That is on purpose: when in doubt, a
session stays in, because discarding too much costs the day ([incidents.md](incidents.md),
11/08/2026). The cost is that the next round may propose again a capture that briefing
already proposed; it shows in the pull request's diff, and nothing is lost. Only the first
user message counts: a session that quotes the signature later is still yours.

## doctor

`doctor`'s `briefing` check reports, under one id: a signature it cannot use (a failure),
the briefing turned off (with a task still registered, a warning), each problem of
`briefing.blocks` (a warning: the briefing runs without that block and says why), a
question queue that cannot be read (a failure) or holds lines that cannot be read (a
warning), and the desktop task as `schedule status --job briefing` reads it (not
registered is a warning, since a briefing you ask for still works).
