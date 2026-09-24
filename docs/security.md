# What isolates the curator's model

A curator round runs a model with nobody watching, on your machine, with your Claude Code
login, over your vault. This page says what that model can and cannot do, which
measurements those limits rest on, and what is deliberately left open. How a round runs
step by step is in [scheduling.md](scheduling.md); the push gates and the repository's own
security policy are in [SECURITY.md](../SECURITY.md).

Every measurement below was taken on 24/09/2026 with Claude Code 2.1.281, the version on
the maintainer's machine. A later version may behave differently, which is why the round
checks the isolation again at every run and `brain-kit doctor` checks the flags.

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

## What held, and what every round passes

```
--setting-sources ''  --strict-mcp-config  --permission-mode dontAsk  --permission-prompts none
```

- `--setting-sources ''`, with the empty string as its value, loads no settings file at
  all: not yours, not the project's, not the local one. No hook, no rule of yours.
- `--strict-mcp-config` loads no MCP server except those passed on the command line, and
  the round passes none.
- `--permission-mode dontAsk` denies every tool use that no rule of the round allows,
  without asking anyone.
- `--permission-prompts none` makes sure nothing waits for an answer.

With the four together, the disallowed command was denied and listed among the run's
denials, no hook ran, no MCP server was loaded, and the login still worked: it is not a
settings file.

The round does not take the flags on trust. The first event the CLI prints reports the
permission mode, the MCP servers and every hook that fires. If the mode is not `dontAsk`,
if any MCP server appears, or if any hook event appears, the round stops the model at once
and exits 1, before it does any work. `brain-kit doctor` (check `claude-isolation-flags`)
asks the installed CLI's own `--help` for every flag a round passes, so an update that
drops one is caught before a round runs with it. One flag is exempt: `--max-turns` is not
in the help of Claude Code 2.1.281, yet it works (every run of the spike used it).
`--version` cannot probe a flag instead: the CLI prints its version and exits 0 whatever
other flag it is given, an unknown one included.

Also measured: the round's environment reaches the commands the model runs through Bash
(a variable set for `claude` was seen by the kit the model ran). Keep secrets out of the
environment your scheduler gives the round. And in one of two runs the model put `node` in
front of the kit's command on its own; the allowlist grants both forms.

## What the model may do

The allowlist, and nothing else, because `dontAsk` denies everything it does not name:

| Rule | Why |
|---|---|
| `Read`, `Glob`, `Grep` | reading the transcripts the plan lists, and the vault |
| `Edit(./**)`, `Write(./**)` | writing notes, inside the vault only |
| `Bash("<kit>" validate:*)`, `Bash("<kit>" lint:*)`, `Bash("<kit>" propose:*)` | the three kit commands the prompt uses, by the kit's absolute path |
| the same three behind `node` | the form the model sometimes chooses on its own |
| `curate.allowed_tools_extra` | whatever your configuration adds |

Writes are scoped to the vault because a bare `Write` rule was measured letting the model
create a file outside it (`../file`). `Edit(./**)` and `Write(./**)` limit both tools to
the vault's own tree.

The denylist, which wins over any allow rule:

- `Bash(git push:*)`, `Bash(git commit:*)`, `Bash(gh:*)`: the only way to publish is the
  kit's `propose`, which opens a pull request against the default branch and never moves
  your branch, index or working tree;
- `Bash(curl:*)`, `Bash(wget:*)`, `WebFetch`, `WebSearch`: no network of its own;
- `Bash(rm:*)`;
- `Edit` and `Write` on the kit's protected paths: `.githooks`, `.git`, `.github`,
  `.claude`, `.brain-kit`, `brain-kit.config.json`, `.gitignore`, `.gitattributes` and
  `.gitmodules`. A path deny rule wins over `Edit(./**)` and `Write(./**)`. The reason was
  found in review with a real run: a model that edits the vault's pre-push hook and then
  runs the allowed `propose` runs its own code through that hook, and can put the file back
  afterwards. As a second line, a `propose` running inside a round refuses when any
  protected path differs from the last commit;
- `curate.disallowed_tools_extra`: whatever your configuration adds.

There is deliberately no `Bash(node:*)` in the denylist: a deny rule would also block the
allowed `node <kit> propose` form, and `dontAsk` already denies every other `node` command.

## What limits reading instead

Read, Glob and Grep are not restricted by path: the model can read any file your user can.
That allowance is read-only and was kept on purpose, because transcripts live outside the
vault. What limits what the model reads is not the permission system:

- **`include_projects`.** Only the Claude Code projects your configuration lists are ever
  offered to the model, and only the sessions whose messages fall inside the round's
  window. The plan in the prompt names each file, how large it is and where to start
  reading it.
- **The prompt.** It tells the model to sample a long transcript from its end and then in
  slices, never whole, and states what it may not carry into the vault.
- **The cost ceiling.** Every round runs with `--max-turns` and `--max-budget-usd`
  (`curate.max_turns`, default 100, and `curate.budget_usd`, default 5 USD); a
  configuration that leaves them out still gets the same limits. The model is also stopped
  after 60 minutes.

## What the logs hold

The round's log in the state directory holds one line per event: which step ran, how long
the network took, how many files each source offered and how many were read, the model's
exit, cost and turns, the names of the tools it was denied, what the cleanup restored.
It never holds what a tool returned, the model's final text, anything read from a
transcript, or the round's lock token. `last-run.json` follows the same rule. The one
exception is opt-in: `--keep-stream` (or `keep_stream: true` in `machine.json`) keeps the
model's raw output beside the log, and that file contains what the model read. It is
written with owner-only permissions; keep it only while you debug.

## When a round is stopped

`curate` handles SIGINT, SIGTERM, SIGHUP and SIGQUIT: it kills the model's whole process
group, writes `last-run.json`, releases the lock and runs your notify command. A SIGKILL of
`curate` cannot be handled by any program. The model, which runs detached in its own
process group, then keeps running until it ends, and the vault's lock is taken back as
stale only after that.

## Measured and not chosen

- **`--restricted`** also isolates the run, but it removes the Bash tool unless `--tools`
  names it, and the round needs Bash for the kit's three commands. `--setting-sources ''`
  was chosen instead.
- **`--bare`** reads only the `ANTHROPIC_API_KEY` environment variable for credentials.
  That leaves out everyone who uses Claude Code through a subscription login, so it is not
  usable here.
