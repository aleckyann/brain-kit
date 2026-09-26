# What isolates the curator's model

A curator round runs a model with nobody watching, on your machine, with your Claude Code
login, over your vault. This page says what that model can and cannot do, which
measurements those limits rest on, and what is deliberately left open. How a round runs
step by step is in [scheduling.md](scheduling.md); how a round reaches your calendar and
meeting notes is in [connectors.md](connectors.md); the push gates and the repository's own
security policy are in [SECURITY.md](../SECURITY.md).

Every measurement below was taken on 24/09/2026 with Claude Code 2.1.281, the version on
the maintainer's machine, except the memory switches, measured on 25/09/2026 with the same
version. A later version may behave differently, which is why the round checks the
isolation again at every run and `brain-kit doctor` checks the flags.

## What a plain headless run inherits

The obvious way to run a model unattended is `claude -p`, with the tools it may use in
`--allowedTools` and the ones it may not in `--disallowedTools`. Measured, that is not an
isolation at all. A plain `claude -p` loads your own Claude Code settings, the same ones
your interactive sessions use:

- **your permission mode.** On the maintainer's machine that is `auto`, a mode in which
  Claude Code approves actions on its own;
- **your hooks,** the commands you configured to run on Claude Code's events, including one
  that rewrites every shell command before it runs;
- **your allow rules,** the commands you told Claude Code to always permit;
- **every MCP server you configured,** with their tools.

Under those inherited settings, a command listed in `--disallowedTools` ran, and so did a
command in neither list. Both runs exited 0, and neither reported a denial. Nothing in the
output said the lists had been ignored.

The measurements that followed, one change at a time:

- **`--permission-prompts none` alone** did not help: the inherited mode still decided.
- **`--permission-mode dontAsk` alone** (deny everything no rule allows) was still bypassed.
  A hook of the user's rewrote `curl` into another command before it ran, and a user allow
  rule permitted the rewritten form, so a command the round had denied ran anyway. The
  denylist matched the command as rewritten, not the command the model asked for.
- **`--setting-sources project`** (load only the project's settings) was not enough either:
  a `SessionStart` hook in the project's `.claude/settings.json` ran, in a folder Claude
  Code had never been told to trust. Only the project's allow rules were ignored. Every
  vault `brain-kit init` creates carries a `.claude/settings.json` that enables the
  brain-kit plugin, whose own hooks would then run inside the round.
- **The default tool set** holds more than the round needs: besides Read, Glob, Grep, Edit,
  Write, Bash and ToolSearch, a run exposes Task, Workflow, CronCreate, RemoteTrigger,
  SendMessage, Artifact and more, in every setting-source mode, and a Skill tool that loads
  skills.
- **Memory.** The CLI's first event listed the auto-memory folder in every launch mode
  (measured on 25/09/2026), so a round would read the person's memories and could write
  one outside the vault.

## What held, and what every round passes

```
--setting-sources ''  --strict-mcp-config  --permission-mode dontAsk  --permission-prompts none
--disable-slash-commands  --tools Read,Glob,Grep,Edit,Write,Bash,ToolSearch
--no-session-persistence
```

and, in the model's environment, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`.

- `--setting-sources ''`, with the empty string as its value, loads no settings file at
  all: not yours, not the project's, not the local one. No hook, no rule of yours.
- `--strict-mcp-config` loads no MCP server except those passed on the command line, and
  the round passes none.
- `--permission-mode dontAsk` denies every tool use that no rule of the round allows,
  without asking anyone.
- `--permission-prompts none` makes sure nothing waits for an answer.
- `--disable-slash-commands` removes the Skill tool and every skill.
- `--tools Read,Glob,Grep,Edit,Write,Bash,ToolSearch` leaves exactly those built-in tools,
  while MCP tools stay available. ToolSearch stays because a connector's tools arrive
  deferred, and the model loads them through it before its first call.
- `--no-session-persistence` keeps the round from writing a session transcript of its
  own: nothing of the round is left in your Claude Code history, and its runs stay out of
  the transcripts the next round reads.
- The two memory switches: with both in its environment, the CLI's first event listed no
  memory folder. The round's context is the kit's prompt, not your memories or your global
  instructions. The round sets them over whatever environment it runs in, and stops a
  round whose first event still lists a memory folder.

With these together, the disallowed command was denied and listed among the run's
denials, no hook ran, no MCP server was loaded, and the login still worked: it is not a
settings file.

The round does not take the flags on trust. The first event the CLI prints reports the
permission mode, the MCP servers, the built-in tools, the memory folders and every hook
that fires. If the mode is not `dontAsk`, if any MCP server appears, if the built-in tools
are not exactly the pinned set, if a memory folder is listed, or if any hook event appears,
the round stops the model at once and exits 1. A problem in the first event stops it
before it does any work; a hook event that arrives later (a `PreToolUse` hook, say) kills
it the moment it is seen, and the round says the model had already started, so nothing it
did counts and the day stays open. In connector mode (below) the MCP servers listed are
yours on purpose, so that one check does not apply there; every other one does.

`brain-kit doctor` (check `claude-isolation-flags`) asks the installed CLI's own `--help`
for every flag a round passes in either launch mode, connector mode's `--settings`
included, so an update that drops one is caught before a round runs with it. One flag is
exempt: `--max-turns` is not in the help of Claude Code 2.1.281, yet it works (every run
of the spike used it). `--version` cannot probe a flag instead: the CLI prints its version
and exits 0 whatever other flag it is given, an unknown one included.

Also measured: the round's environment reaches the commands the model runs through Bash
(a variable set for `claude` was seen by the kit the model ran). Keep secrets out of the
environment your scheduler gives the round. And in one of two runs the model put `node` in
front of the kit's command on its own; the allowlist grants both forms.

## What the model may do

The allowlist, and nothing else, because `dontAsk` denies everything it does not name:

| Rule | Why |
|---|---|
| `Read(./**)`, `Glob(./**)`, `Grep(./**)` | reading the vault |
| `Read(//<file>)`, one per transcript the plan lists | reading exactly the sessions the round offers, never their folder |
| `Edit(./**)`, `Write(./**)` | writing notes, inside the vault only |
| `ToolSearch` | loading a connector's deferred tools; it reads no file |
| `Bash("<kit>" validate:*)`, `Bash("<kit>" lint:*)`, `Bash("<kit>" propose:*)` | the three kit commands the prompt uses, by the kit's absolute path |
| the same three behind `node` | the form the model sometimes chooses on its own |
| in connector mode, each available connector source's read tools | `list_events`, `get_event`, `list_calendars` for the calendar; `search_files`, `read_file_content`, `get_file_metadata` for the meeting notes |
| `curate.allowed_tools_extra` | whatever your configuration adds |

Writes are scoped to the vault because a bare `Write` rule was measured letting the model
create a file outside it (`../file`). `Edit(./**)` and `Write(./**)` limit both tools to
the vault's own tree. A rule in `curate.allowed_tools_extra` that grants `Read`, `Glob`,
`Grep`, `Edit`, `Write` or `Bash` with no scope, or with `()` or `(*)`, is a configuration
error: the round refuses to start (exit 2), and `doctor` (check `config-valid`) says so. A
scoped rule that reaches beyond the vault, and any command rule, is allowed as the choice
it is, and `doctor` (check `round-scope`) names it.

The denylist, which wins over any allow rule:

- `Bash(git push:*)`, `Bash(git commit:*)`, `Bash(gh:*)`: the only way to publish is the
  kit's `propose`, which opens a pull request against the default branch and never moves
  your branch, index or working tree;
- `Bash(curl:*)`, `Bash(wget:*)`, `WebFetch`, `WebSearch`: no network of its own;
- `Bash(rm:*)`;
- `Edit` and `Write` on the kit's protected paths: `.githooks`, `.git`, `.github`,
  `.claude`, `.brain-kit`, `brain-kit.config.json`, `.gitignore`, `.gitattributes`,
  `.gitmodules` and `.mcp.json`. A path deny rule wins over `Edit(./**)` and `Write(./**)`.
  The reason was found in review with a real run: a model that edits the vault's pre-push
  hook and then runs the allowed `propose` runs its own code through that hook, and can put
  the file back afterwards. As a second line, a `propose` running inside a round refuses
  when any protected path differs from the last commit. `.mcp.json` declares MCP servers a
  session may start before any permission check, and whether connector mode starts the
  working directory's one is not measured;
- in connector mode, every write tool of the two connectors, and every allow rule of your
  user settings, mirrored ([connectors.md](connectors.md));
- `curate.disallowed_tools_extra`: whatever your configuration adds.

There is deliberately no `Bash(node:*)` in the denylist: a deny rule would also block the
allowed `node <kit> propose` form, and `dontAsk` already denies every other `node` command.

## What limits reading

Reads are scoped to the vault and to the transcripts a round offers. Measured: with
`Read(./**)` plus `Read(//<absolute folder>/**)` allowed, a read of `/etc/hostname` was
denied while the vault and that folder were readable; with `Glob(./**)` and `Grep(./**)`,
a Glob in `/etc` and a Grep of `/etc/hosts` were denied and both worked inside the vault;
and `Read(//<folder with a space>/<accented name>.jsonl)` allowed that exact file and
denied its sibling. So a round allows reading exactly the transcript files its plan lists,
one rule per file: a session of the same project that the plan left out stays unreadable.

A transcript whose path holds a character whose meaning inside a rule is not measured
(`* ? [ ] { } ( ) \ ,` or a control character) is never turned into a rule: the round
stops before the model (exit 4), naming the file, since renaming it or its folder is the
fix (spaces and accents are fine), and `brain-kit machine set transcripts_dir` refuses such
a folder.

Within that, what limits how much the model reads is not the permission system:

- **`include_projects`.** Only the Claude Code projects your configuration lists are ever
  offered to the model, and only the sessions whose messages fall inside the round's
  window. The plan in the prompt names each file, how large it is and where to start
  reading it.
- **The prompt.** It tells the model to sample a long transcript from its end and then in
  slices, never whole, and states what it may not carry into the vault.
- **The cost ceiling.** Every round runs with `--max-turns` (`curate.max_turns`, default
  100) and `--max-budget-usd` (`curate.budget_usd`, default 5 USD); a configuration that
  leaves either key out still gets its default. A cap is a number above 0: `0` is refused
  as a configuration error before any round, like any other invalid value.
  `"budget_usd": null` is how an owner asks for no cost cap at all: the round then passes
  no `--max-budget-usd`, and `curate --check`, `curate --dry`, the round's own output and
  `doctor` (check `cost-cap`) say so, as they say which cap applies otherwise. The model
  is also stopped after 60 minutes.

What can still widen reads, each said by `doctor` or here:

- a scoped rule of yours in `curate.allowed_tools_extra` that reaches outside the vault, or
  any command rule there (a command can read any file your user can): `doctor`, check
  `round-scope`;
- in connector mode, a read rule of your Claude Code user settings that is bare or
  overlaps the vault or the round's own reads, which the round records instead of denying
  (one disjoint from them is mirrored as a deny): `doctor`, check `round-scope`, and
  `userRules.widenedReads` in `last-run.json`;
- the kit's own `validate` and `lint`, which take a directory argument: the model can point
  them at a folder outside the vault and read their findings about the notes there, a
  narrow read path;
- a symbolic link inside the vault that points outside it: whether `Read(./**)` follows one
  is not measured. The model cannot create one.

## Connector mode

The isolated mode above cannot see the claude.ai connectors at all. Measured: with
`--setting-sources ''`, with or without `--strict-mcp-config`, a run has zero MCP servers,
claude.ai connectors included; neither `ENABLE_CLAUDEAI_MCP_SERVERS=1` (or `true`) nor
`--settings '{"disableClaudeAiConnectors": false}'` brings them back; and `claude mcp get`
shows a claude.ai connector as coming from the claude.ai configuration, with its status and
no URL or type, so it cannot be declared in `--mcp-config` either.

What brings them is `--setting-sources user`, which loads your user settings and much more:
on the maintainer's machine, 54 MCP servers (21 of them claude.ai connectors, the calendar
and the document store connected with their tools named
`mcp__claude_ai_Google_Calendar__<tool>` and `mcp__claude_ai_Google_Drive__<tool>`), a user
hook that ran, 10 plugins, 109 skills, 6 agents and every user permission rule.

So a round that has a connector source to read launches with:

```
--setting-sources user  --settings '{"disableAllHooks":true}'  --permission-mode dontAsk
--permission-prompts none  --disable-slash-commands  --tools Read,Glob,Grep,Edit,Write,Bash,ToolSearch
--no-session-persistence
```

and the same memory switches, without `--strict-mcp-config`, which would drop the
connectors. What neutralises the rest was measured one part at a time:
`--settings '{"disableAllHooks":true}'` gave zero hook events with the connectors still
connected; `--disable-slash-commands` and `--tools` did what they do in the isolated mode;
and a user allow rule stayed active (one allowing `Bash(rtk curl *)` let that command run)
until the same rule was passed in `--disallowedTools`, which denied it. So every allow rule
in your user settings is mirrored as a deny, except a rule the round's own allow list
already holds, a read rule that is bare or overlaps the vault or the round's own reads, and
a write rule inside the vault. A mirrored path rule is passed in its resolved absolute form
(`Edit(//<path>)`), never as written, since a rule on the command line has no settings file
to anchor `/x` at. A rule that cannot be
mirrored without denying the round's own tools refuses connector mode for that round: a
bare `Bash`, a Bash rule covering every command or one of the kit's own, an `Edit` or
`Write` rule on the vault or a folder that holds it, or a settings file or rule the kit
cannot read with a known meaning. The round then runs isolated, on the transcripts alone,
and names the rule and its file.

The first event is checked in this mode too (permission mode, hooks, built-in tools,
memory), and it is also where each connector's state is read, before the model's first
turn. A connector that is not there makes the round kill the model and launch once more
without that source. Measured, a launch killed at its first event made no model call: the
first event came about 2.8 seconds after the start.

What this mode leaves open, on purpose or because it is not measured:

- your MCP servers start; under `dontAsk` their tools run only where a rule the round
  keeps allows them, and it keeps none for them;
- a user rule that allows reads over the vault, or over the files the round itself reads,
  widens what the model can read in that round (recorded, and named by `doctor`);
- the user settings that are not permissions (your output style, the `env` block, the
  model settings) reach the round as written, and are not checked;
- `permissions.additionalDirectories`, managed or policy settings, and the older
  per-project `allowedTools` in `~/.claude.json` are not measured;
- whether your `~/.claude/CLAUDE.md` reaches the round could not be asked on 25/09/2026,
  because the CLI's login had expired.

[connectors.md](connectors.md) has the whole of it: which rules are mirrored and which
refuse the mode, the states of a connector, and `brain-kit doctor --probe`, which launches
this mode, kills it at its first event and reports each connector's state without a round.

## What the logs hold

The round's log in the state directory holds one line per event: which step ran, how long
the network took, how many files each source offered and how many were read, the launch
mode and each connector's state, the model's exit, cost and turns, the names of the tools
it was denied, what the cleanup restored. It never holds what a tool returned, the model's
final text, anything read from a transcript, a calendar or a document, or the round's lock
token. `last-run.json` follows the same rule. The one exception is opt-in: `--keep-stream`
(or `keep_stream: true` in `machine.json`) keeps the model's raw output beside the log, and
that file contains what the model read. It is written with owner-only permissions; keep it
only while you debug.

## When a round is stopped

`curate` handles SIGINT, SIGTERM, SIGHUP and SIGQUIT, and the rarer signals that would
end it too (SIGUSR2, SIGALRM, SIGXCPU, SIGXFSZ, SIGVTALRM, SIGPROF, and SIGPWR where the
system has it): it kills the model's whole process group, writes `last-run.json`, releases
the lock and runs your notify command. A SIGKILL of `curate` cannot be handled by any
program. The model, which runs detached in its own process group, then keeps running until
it ends, and the vault's lock is taken back as stale only after that.

## Measured and not chosen

- **`--restricted`** also isolates the run, but it removes the Bash tool unless `--tools`
  names it, and the round needs Bash for the kit's three commands. `--setting-sources ''`
  was chosen instead.
- **`--bare`** reads only the `ANTHROPIC_API_KEY` environment variable for credentials.
  That leaves out everyone who uses Claude Code through a subscription login, so it is not
  usable here.
- **`CLAUDE_CONFIG_DIR` pointed at a folder without your settings,** to reach the
  connectors without loading your rules: rejected, because the login lives in the same
  folder, and a token refresh written through a copy or a link could invalidate your own
  login.
- **Reading each connector's state from `claude mcp list`:** rejected, because on four
  nights in September 2026 that listing said connected while the tools were not in the
  session that needed them. The state comes from the round's own first event.
