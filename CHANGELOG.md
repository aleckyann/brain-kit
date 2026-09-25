# Changelog

## Unreleased

Nothing below is on npm yet. It runs from a clone of the repository.

### Phase 1, slice 1A: the validator

- `brain-kit validate [path] [--json] [--only-problems]` checks a vault against OKF v0.2
  and reports the format's own conformance apart from the vault's house rules, so a vault
  that conforms to the format but departs from its own rules is told exactly that.
- A zero-dependency reader for frontmatter and markdown, with its limits declared in the
  output rather than hidden: it is a regular-expression reader, not a YAML parser.
- Checked against the original vault this kit is extracted from: every divergence from the
  validator that vault used before was traced to a known defect of the old one.

### Phase 1, slice 1B: the linter, the leak scanner and the push gates

- `brain-kit lint [path] [--rule ...] [--base auto|worktree|merge-base|all] [--json]` with
  eight rules: `index-completeness`, `orphans`, `columns`, `tables`, `style`, `secrets`,
  `privacy` and `attribution`.
- The `secrets` rule reads every file a push could publish, dot-files such as `.env`
  included and ignored files excluded, and is never narrowed by `--base`. Content and
  patterns are decoded the same way, so a pattern with accented letters matches.
- A leak scanner that fails closed when it cannot read its pattern list, never prints what
  it matched, and announces every ceiling it hits.
- The maintainer's push gate now lives outside the working tree, installed per clone by
  `.githooks/install-gate`. It scans seven channels of every object a push carries: file
  content, file names, commit messages, annotated tag messages, author and committer
  identities, reference names, and object headers. It reads the objects git will send,
  not a replaced stand-in, and says on every clean push that it ran.
- A template pre-push hook for a vault, which runs `validate` and `lint` and refuses a push
  to the default branch by the vault's automation identity.

### Phase 1, slice 1D: the gate that ships

- One push enumeration behind one command, `brain-kit push-gate`, which both gates call.
- The template hook for a vault now runs `validate`, `lint --base all`, then `brain-kit
  push-gate --patterns config` over the objects the push carries, then the automation
  guard. A match the push carries is refused whatever the working tree shows: in the
  history, in a tip hidden by an uncommitted edit, or on a branch that is not checked out.
  Its patterns are the generic credential shapes plus `privacy.secret_patterns` from the
  working tree's configuration, from every pushed tip, from every configuration the push
  carries that no remote-tracking reference holds yet, and from the default branch the
  clone knows. A branch that deletes a pattern and then violates it is refused whenever one
  of those still declares it. The configuration file's own content is read for credential
  shapes only, so a literal inside it is not refused. `brain-kit` is found on PATH only;
  the vault carries no package. `brain-kit init` installs it into a new vault, `brain-kit
  init --adopt` into an existing one, and `brain-kit update --install-hook` later.
- Every refusal the push gate makes for a match, in both gates, ends with what to do:
  rotate the credential, remove it from history, and follow `SECURITY.md`.
- `brain-kit init [dir] [--lang en|pt-BR] [--yes] [--from-answers <file>]` makes a new
  vault in an empty or new directory: the language skeleton, the configuration, the hook,
  a manifest of what the kit wrote, a git repository, and `machine.json` in the state
  directory, outside the vault. It refuses, writing nothing, a directory that is not empty,
  is a repository or is a vault; it never waits on a stdin that is not a terminal; it undoes
  everything it created when it fails halfway; and it commits only when told to, after
  `validate` and `lint` pass.
- `brain-kit init --adopt [dir]` brings an existing vault under the kit. It infers the
  configuration from the notes (collections and domains, per-type enums, table headings,
  the log, the stale policy, the confidentiality field and the directories that hold marked
  notes, plain dates) and prints every inference; then it writes only the configuration and
  a manifest recording every existing file as the person's, by path, plus `machine.json` outside the
  vault. The vault must be a git repository: a folder that is not one is refused, with
  nothing written, and told to write its `.gitignore` and run `git init` first; without git
  installed it says git is missing. The configuration is inferred from the same list the
  manifest records, so a folder or note git ignores contributes nothing to it. The manifest
  lists only what git would publish (tracked files, and untracked files that are not
  ignored), so a file the person ignored is never named in it. Then it installs the push gate, unless a
  hook of the person's own, a `core.hooksPath` pointing elsewhere or hooks in `.git/hooks`
  are already there: those are left exactly as they are, and it prints the one line that
  adds the gate to that hook. `--no-hook` skips the gate and says so. It never changes a
  note and never commits, and refuses a `.brain-kit` that is a link or a file before writing
  anything.
  `brain-kit --help` and init's refusal of a non-empty directory or a repository point to
  it. The manifest records the vault's language at its top level (optional, so an older
  manifest still reads). `validate` now refuses a `privacy.confidential_field` that names no
  declared boolean extension, since a misspelt one silently switched the privacy rule off.
- `brain-kit update [dir] [--check | --accept <path> | --install-hook]` refreshes the files
  the kit manages (the root contract files, the hook, and, in a vault `init` makes from now
  on, `.gitignore`) by checksum: one you have not edited is replaced
  with this kit's version; one you edited is never overwritten, and a newer version is
  written beside it as `<name>.brain-kit-new`; your notes are never touched. `--accept`
  records that you have dealt with an offered version, or that you removed a managed file on
  purpose. A seeded entry of the manifest (a note the person owns, from `init` or `adopt`)
  carries no hash, since `update` never reads one and the manifest is committed; a managed
  entry must carry one. A manifest with seeded hashes, written before, still reads, and the
  hashes are dropped the next time it is written. Line endings are compared as LF and kept as each file has them. It refuses,
  writing nothing, a manifest it cannot read or write safely, a kit older than the
  configuration's `kit_version`, and a `lang` that is not the language the vault was made
  in (the language the manifest records); after a run it sets `kit_version` to the running
  kit's. A new vault's `.gitignore` ignores offered and temporary files. `--install-hook`
  installs the push gate into a vault that does not have it, with the same care for a hook
  of the person's own; it exits 0 when installed or already there, 3 when it left something
  as it was, 1 when no gate can run there.
- `brain-kit doctor [dir] [--json] [--only <id,...>]` reports, check by check, whether this
  machine and this vault are ready for the kit: `node-version`, `git-present`,
  `default-branch-known`, `hooks-path`, `brain-kit-on-path`, `config-valid`,
  `manifest-valid`, `machine-valid`, `state-dir-resolves`, `state-dir-mode`, `kit-version`,
  `gh-present`, `claude-present` and `gitignore-node-modules`. It exits 1 when any check
  fails, and names the command that fixes each failure it can: a missing gate names
  `brain-kit update --install-hook`, and a manifest `update` would refuse is reported
  before `update` is run.
- The default output language of every command now follows the locale (`LC_ALL`, then
  `LC_MESSAGES`, then `LANG`; a value starting with `pt` is Portuguese) and falls back to
  English; it used to be Portuguese unless `BRAIN_KIT_LANG` said otherwise. `BRAIN_KIT_LANG`
  still wins, and an unsupported value is reported once.

### Phase 1, slice 1C: the git loop

- Two guards for every command that writes to a vault, kept in the repository: the lock in
  its git common directory, so every environment, symbolic link and linked worktree of one
  vault finds the same one, and the session snapshot in each working tree's own git
  directory, so two linked worktrees keep two; outside a repository they refuse. The lock names the holder's pid,
  host, command and start time, and its machine, boot and process namespace where the
  platform has them; a second writer is refused at once, naming the holder. A lock is
  replaced only when its holder is provably dead (same machine after a reboot, or same
  boot and namespace with the process gone), by a rename that exactly one of several
  racing writers can win. The session snapshot records every path git reports in any
  state, ignored ones included, as raw bytes, and later splits what is dirty into what was
  there before and what changed since, without stashing, staging or writing anything in
  the vault.
- The state directory of a vault reached through a symbolic link is now the one derived
  from its real path, so `machine.json` is found whichever path a command starts from.
- `machine.json` no longer names a lock or a snapshot path (`paths.lock` and
  `paths.snapshot` are gone from the schema and from what `init` writes); an older file
  carrying them still reads, and the two keys are ignored.
- Inside a git repository, `validate` and every `lint` rule read what git publishes
  (tracked files, plus untracked files git does not ignore), the list the `secrets` rule
  already read, so a note git ignores no longer fails them and no longer refuses every push
  through the adopter's gate. Outside a repository they read the folder, as before, and
  each run says which of the two it read. A vault inside a repository that ignores it whole
  is read from the folder, since that repository's list does not describe it; when git
  cannot produce its list, `validate` exits 1 without judging anything and `lint` is
  degraded.
- The frontmatter reader reads a `verified` (or `sources`) list whose entries are inline
  mappings, the form the format's own section 5.2 uses, so a conformant note written that
  way no longer reports its `by` and `at` missing.
- `brain-kit sync [dir]` brings the default branch level with its remote before anything
  is written: it fast-forwards a branch that is behind, refuses one that diverged naming
  both counts, and resolves the default branch through the same ladder as the push gate.
- `brain-kit propose "<summary>" (--only <path>... | --all [--yes]) [--dry]` turns the listed
  paths into a pull request against the default branch. The commit is built from the
  remote tip with only the given paths, so HEAD, the index and the working tree never move
  and no other session's file is swept in; the push goes to the URL the remote's raw
  configuration names, pinned so that a `pushInsteadOf` rule cannot redirect it, and a git
  that would send it anywhere else is refused before anything is pushed. Without `gh`, or when the pull request cannot be opened against the
  right base, it exits 3 with the commit in place and says what to run.
- `brain-kit machine show|set|register [dir]` reads and edits `machine.json`, and
  registers a vault that was moved.
- `brain-kit verify --pr <number> | --files <path>...` is the owner's command after a
  merge: it stamps `verified` on the notes the merged pull request changed, commits with
  the owner's own identity, refuses the agent's, and prints the push command.

### Phase 1, slice 1E: the plugin surface

- The Claude Code plugin's two hooks are real. `SessionStart` records which paths were
  already dirty when a session began, in the working tree's git directory, and keeps that
  record across compaction and resume; only a new session (startup or clear) writes a new
  one. It adds one line of context: the vault, how many paths were already dirty, and
  whether another writer holds the lock.
- The `Stop` hook asks the session to curate only what this session changed, and never
  blocks outside a vault (another person's dirty repository ends as if the plugin were
  not there), in a copy away from the path registered in `machine.json`, while a live
  writer holds the lock, or a second time in a row. A lock left by a process that is
  provably dead does not switch it off. A snapshot of another session, or none, counts
  every dirty path as the session's and says so. It lists up to 20 paths, says how many
  it left out, and never changes the working tree. `.claude/worktrees/` is never counted.
- Seven skills: `setup`, `curate-session`, `capture`, `ask`, `lint`, `review-stale` and
  `approve`. Each body lives in the language packs and is printed by the new
  `brain-kit prompt skill <name>`, so the model reads it in the vault's own language;
  each skill grants itself exactly that one command. Outside a vault every skill but
  `setup` opens by telling the model to write nothing. `brain-kit prompt --check`
  verifies every skill has a body in every language with known placeholders only.
- A read-only subagent, `vault-reader` (Read, Grep, Glob), for questions that need more
  than a few notes.
- `evals/`: one `claude plugin eval` case per skill and language. How to run them, and
  what was measured, is in `docs/testing.md`.
- `init` seeds `.claude/settings.json` in a new vault, holding only the marketplace and
  plugin entries so a clone offers to install the plugin, and `update` keeps it current;
  `init --adopt` does not write it. A new vault's `.gitignore` ignores `.claude/worktrees/`.
- The plugin no longer declares a `vault_dir` option: nothing reads it, since the vault is
  always found from the working directory.

### Phase 2: the scheduled curator

- `brain-kit curate [dir] [--dry] [--check] [--keep-stream]` runs one curator round in a
  fixed, tested order: the machine file, the vault lock, a timed wait for the network,
  sync, and only then the configuration and prompt as synced, the window from the
  watermark, a clean tree, the round's own snapshot, a check that the Claude Code CLI is a
  real program, the sources, and the model. Afterwards it checks what the model read,
  brings the files it proposed back to the default branch when they are exactly what was
  pushed, writes `last-run.json` and a log that never holds content, and runs
  `machine.notify_command` on any non-zero exit. Every way a round can fail has its own
  exit code: 1 failed, 2 bad setting, 3 proposed but the pull request is not open, 4 a
  required source not read, 69 no network or model unavailable, 75 postponed. `--dry`
  shows what a round would do and writes nothing; `--check` runs every step up to the
  model.
- The transcripts source selects Claude Code sessions by the timestamps of their messages,
  not by file modification time, from the projects `sources.transcripts.include_projects`
  lists; drops the curator's own runs by their first user message only; caps by whole
  days, oldest first, leaving the days that do not fit for the next round (a first day
  that alone passes the cap stops the round with exit 4 before the model); counts a file
  with no conversation (no user or assistant line) apart, without blocking its day, while
  a conversation none of whose messages carries a readable timestamp stops the round; and gives the model each
  file's size and the line to start reading from (`sampleLine`).
- A generic, domain-neutral curate prompt in both language packs, written from scratch,
  which a vault may override with `.brain-kit/prompts/curate.md` (never outside the vault).
  `brain-kit prompt curate` prints it and `prompt --check` verifies it.
- The watermark: per source, the last day swept. A round reads the open days oldest first
  and whole, at most seven at a time and as many as fit in the transcripts cap, and advances a source only on exit 0 or 3, with every offered
  file read and the model's `BRAIN_KIT_SOURCES` line reporting it; a day is never closed
  unread. `brain-kit watermark show|set|reopen|assume-covered [dir]` shows it and moves it
  by hand, taking the vault lock to write.
- `brain-kit schedule install|uninstall|status [dir] [--platform systemd|launchd|cron] [--dry]`
  installs the round in daytime windows only (07:00 to 22:59; 09:30, 14:00 and 20:00 by
  default), named `brain-kit-curate-<vault_id>` by what it does, with no dependency on a
  network target, missed windows not caught up where the platform allows it, and a `PATH`
  that holds `machine.path_extra`, the CLI's directory, node's and the system's, plus the
  directories where the installing shell finds `brain-kit` and `gh`, which the round's
  `propose` runs (refused, exit 2, when either is found nowhere). The CLI itself is
  recorded by its absolute path in `claude_bin`: a CLI that moves is reported by the
  round's CLI check (exit 1) until `claude_bin` is updated. systemd user units are the
  reference; launchd and cron are rendered too. `status` says whether the entry is
  installed, current and enabled, and prints the next fire times and the last round as
  DD/MM/YYYY HH:MM.
- Isolation: every round runs the model with `--setting-sources ''`,
  `--strict-mcp-config`, `--permission-mode dontAsk` and `--permission-prompts none`, so
  none of the person's settings, hooks, allow rules or MCP servers reach it (a plain
  headless run was measured inheriting all of them), with an allowlist of the kit's own
  `validate`, `lint` and `propose` and a denylist for publishing, the network and the
  kit's protected files. The round stops the model before it does any work when the CLI's
  first event reports anything else, and kills it at once on a hook event that arrives
  later. The model runs in its own process group, killed as a whole on timeout or
  interruption, and the `propose` it runs joins the lock the round holds.
- `brain-kit doctor` checks the curator: `claude-real` (not a launcher stub, a real
  version), `claude-isolation-flags` (the installed CLI's help lists every flag a round
  passes, but `--max-turns`, which 2.1.281 hides from its help and which works),
  `include-projects`, `watermark` (days behind per source; more than three warns),
  `last-run` (a round that exited 0 in under 20 seconds without a model turn is a dead
  round), `schedule` (installed, current, enabled, next fire times) and `notify`; and
  `brain-kit-on-path` also checks that the scheduled round's own `PATH` reaches
  `brain-kit` and `gh`. Each names the command that fixes what it finds.
- `docs/scheduling.md` (the round step by step, the windows, the watermark, the exit codes
  and what to do for each, `last-run.json` and the logs) and `docs/security.md` (what
  isolates the model and the measurements behind it).

### Phase 3: calendar and meeting-notes sources

- Every round now runs with `--disable-slash-commands` and `--tools
  Read,Glob,Grep,Edit,Write,Bash,ToolSearch`: no skill, and no built-in tool beyond those
  seven (the default set also exposes Task, Workflow, CronCreate and more, measured on
  24/09/2026 with Claude Code 2.1.281); the CLI's first event must show exactly that set.
  Reads are scoped: the vault (`Read(./**)`, `Glob(./**)`, `Grep(./**)`) and one
  `Read(//<file>)` per transcript the plan lists, where phase 2 allowed a bare `Read` that
  could reach any file on disk. A transcript whose path no read rule can name exactly
  stops the round before the model (exit 4), and `machine set transcripts_dir` refuses such
  a folder; an allow rule in `curate.allowed_tools_extra` with no scope is a configuration
  error (exit 2). Every round sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and
  `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, and stops when its first event still lists a memory
  folder (measured on 25/09/2026). `.mcp.json` joins the protected paths.
- Connector mode. The isolated mode cannot see the claude.ai connectors, so a round with a
  connector source to read loads the person's user settings, which is what makes them
  appear, and switches off everything else they bring: hooks
  (`--settings {"disableAllHooks":true}`), skills, the built-in tools beyond the pinned
  set, and every user allow rule, mirrored as a deny. A rule that cannot be mirrored
  without denying the round's own tools refuses the mode: every connector source is then
  `blocked_by_user_rules`, the round runs isolated on the transcripts alone, and the rule
  and its file are named. Each connector's state (`connected`, `needs_auth`, `failed`,
  `pending`, `absent`, `tools_missing`, `unknown`) is read from the round's own first
  event; one that is not there makes the round kill the model before its first turn and
  launch once more without it, never twice.
- The calendar source (`sources.calendar`), off until `enabled: true` and `calendars` name
  what to read (`primary` for the owner's main calendar). A calendar is read only when the
  round's record shows a listing that covers the source's whole window with
  `eventType: ["DEFAULT"]`, exactly the inputs the prompt gives and every page. Other
  people's calendars are read only with `team_calendars_consent_noted: true`, and only
  their events shared with other people count. The connector's write tools are denied to
  every round. `init` no longer writes the owner's e-mail into `calendars`.
- The meeting-notes source (`sources.meeting_notes`), off until `enabled: true`: the literal
  title search (`search_title_contains`, to be copied from one of the person's own
  documents with its accents; the packs suggest `Notes by Gemini` and `Anotações do
  Gemini`) with its modification bound and every page, and the documents attached to the
  calendar's events as a second door, each checked through its metadata first, recordings
  and full transcriptions never opened. The documents opened are counted, never a
  condition. Past `curate.caps.search_docs_opened` or `attached_notes_opened` the source is
  reported `partial`, which never moves its mark. The connector's write tools are denied to
  every round.
- The round reads each source over its own open days and advances each only through the
  days it read, so a source that is ahead never reads a covered day again. The model's last
  line names every source offered: `BRAIN_KIT_SOURCES: transcripts=... calendar=...
  meeting_notes=...`, with `unavailable` for a connector source and `partial` for the
  meeting notes. A best-effort source never changes the exit code; a required one that is
  off stops the round (exit 1), and one left unread makes it exit 4. A listed source that
  is half configured is said on every round. `last-run.json` gains `mode`, `relaunched`,
  `notConfigured`, `userRules`, `connectorStates` and, per connector source, `state`,
  `observedPrefix`, `expected`, `reported`, `rules` and `documents`; the log gains
  `source_off`, `source_no_day`, `source_blocked`, `connectors`, `relaunch`,
  `connector_state_changed`, `notify_state` and `model_result`. A best-effort source whose
  connector state changed is announced once through `machine.notify_command`, naming
  `docs/connectors.md`, and once more when it comes back. The session's status line names
  each connector source that was not connected in the last round, with that round's date.
  The curate prompt gains the rules `no-workaround`, `notes-first-class`,
  `no-access-label` and `third-party-privacy`.
- `lint` rule `privacy` refuses a line a change adds that holds one of
  `privacy.third_party_keywords` (a list per language pack about someone else's health and
  private life), matched as a whole phrase, case-insensitively, accents significant, outside
  `privacy.keyword_exempt_paths`; a line already there never counts, and a run over the
  whole vault (`--base all`) says the keywords were not checked. `propose` refuses such a
  line through its own gate.
- The eighth skill, `seed-rituals`: in the person's own session, it reads the last four
  weeks of their calendar, finds the recurring events and proposes the rows of the weekly
  rhythm table, each title literal and escaped, written only after the person confirms.
- `brain-kit doctor` gains `connectors` (each connector source listed: off and why, the
  state the last round saw with its date, a tool prefix other than the configured one,
  other people's calendars without recorded consent, a user rule that refuses connector
  mode, with its file), `round-scope` (an allow rule of the vault's, or a read rule of the
  person's user settings in connector mode, that reaches beyond the vault), and
  `privacy-keywords` (a missing or empty list). `claude-isolation-flags` also requires
  `--disable-slash-commands`, `--tools` and connector mode's `--settings`. `doctor --probe`
  launches the round's own connector mode with a one-line prompt, kills it at its first
  event before any model call, and reports each connector's state, writing nothing. A
  check may now report several lines under its id.
- `docs/connectors.md` (what each connector source reads, how to turn it on, why connector
  mode loads the user settings and what it switches off, the states and what to do for
  each, the privacy policy); `docs/security.md` (scoped reads, the pinned tools, connector
  mode and its measurements); `docs/scheduling.md` (one window per source, the three
  sources in the last line, the new `last-run.json` fields and log events).
- `BRAIN_KIT_E2E_CONNECTORS=1 node --test test/e2e-connectors.test.mjs` runs one real round
  through the person's own connectors (never in CI), asserting on the round's record: each
  source read with its mark advanced, or its state recorded with its mark unmoved, and no
  write tool called.
- Upgrading a vault made before phase 3: the calendar stays off, and every round says so
  (`not_enabled`), until `sources.calendar.enabled` is `true`; the meeting notes stay off,
  and their old defaults need checking before they are turned on; there is no privacy
  keyword list, which `doctor` reports. `brain-kit update` adds no configuration key.
- After the phase review: while the calendar is on, a round that will not read it offers
  the meeting notes no work at all, and their days stay open (`waiting_for_calendar`, in the
  log, `last-run.json` and `doctor`), instead of distilling the same notes every round; the
  calendar's listing for the meeting notes keeps its seven-day cap. A connector source
  reported `empty` whose reads listed events or files keeps its day open
  (`inconsistent_empty`; `listed` in `last-run.json`). A mirrored user path rule is passed in
  its resolved absolute form, never as written; a user read rule disjoint from the vault
  and the round's own reads is mirrored too; a scope ending in a backslash or with an odd
  number of double quotes, a relative `HOME`, or a path rule whose resolved form no rule can
  carry refuses connector mode. `privacy.third_party_keywords` match across typographic
  apostrophes and runs of whitespace. `prompt --check` warns about a curate overlay without
  `{{sources_line}}`.

### Phase 4: the morning briefing (in review)

- `brain-kit preflight [dir] [--json]` computes every fact the briefing states, in the
  vault's time zone, and only reads (no lock, no fetch, no write): today and its weekday;
  the curator's last round from `last-run.json`, with each source's state and whether its
  mark advanced, and the connector states the rounds carry; every open pull request, from
  `gh api --paginate` with no cap, or "not known" with the reason when `gh` is absent or
  fails; the notes past their `stale_after`, by civil date in the vault's zone; the
  pending items of the tables `briefing.pending` names, read by column name and bucketed
  (overdue, due today, within `briefing.upcoming_days`, later as a count, no date) by the
  first real full date in the cell, a date that is not real, a day and month without a
  year ("may be a date") and a second date-like text each named next to its item, and a
  missing table, heading or column a named problem; git, with how far the default branch
  is behind its remote as of the last fetch; the vault lock; and the question queue.
  `--json` is `brain-kit.preflight/1` with stable keys.
- `brain-kit questions list|add|answer|archive|sweep [dir]` keeps the briefing's queue in
  the state directory (`questions.log`, one JSON object per line, written atomically, mode
  0600): one id per normalised text (NFC, lower case, punctuation to spaces, accents
  kept), no duplicate of an open question or of one answered within
  `briefing.questions_dedup_days` (15), escalation after `briefing.question_escalate_after`
  askings (3), archiving past `briefing.question_max_age_days` (45) only by `sweep`, which
  prints each question it archives. A key left out takes the pack's default and `null`
  means never. A line that cannot be read is kept and reported, never dropped. Writers take
  the vault lock and a queue lock of their own.
- `brain-kit prompt briefing [--vault <dir>]` renders the briefing from the vault's own
  `briefing.blocks`: the catalog's fact blocks (`sources`, `due`, `upcoming`, `undated`,
  `open_prs`, `stale`, `questions`), filled by the kit, and judgement blocks
  (`blind_spots`, `strategy`, `today_calendar`), plus blocks the person defines (a title,
  the notes to read, an instruction). An unknown id, a duplicate, an empty list or a
  custom block reading a missing path, a path outside the vault or one in
  `briefing.never_read` is a named problem, and the block is left out and said.
  `never_read` wins over every block: the kit never puts a covered path's content in the
  prompt, a path it must mention (a stale note) is shown "(never read)", and the model is
  told never to open, list or search one (an instruction, not a sandbox; the stale count
  reads every note's frontmatter, as `validate` does). With `briefing.enabled` false the
  render is one line saying the briefing is turned off in the vault, nothing is recorded,
  and the exit is 0. The real render, and only it, records the questions it shows as
  asked today, after the whole text is rendered; when that fails, the text is printed
  with a correction line and the exit is 3. A generic, domain-neutral prompt in both
  packs, with the contract markers `never-read`, `facts-from-kit`, `closed-uncertainty`,
  `never-empty-unopened`, `questions-by-command`, `propose-only` and `honour-limits`; an
  overlay at `briefing.prompt` replaces it, and `prompt --check` fails one without
  `{{signature}}` as its first line or without `{{blocks}}`. `briefing.max_words`,
  `briefing.max_questions` and every `briefing.write_caps` value default to `null`, no
  limit; a limit set is honoured and said when it bites.
- The ninth skill, `briefing`, prints the rendered briefing through its `!` line in the
  person's own session inside the vault; what it records becomes one pull request through
  `propose --only`, and nothing to record means no pull request.
- `brain-kit schedule install --job briefing [dir]` prints the desktop application's
  scheduled task (`brain-kit-briefing-<vault_id>`, the vault's title, the cron from
  `briefing.schedule`, and a two-line prompt: the briefing's signature, then the exact
  `node "<kit>" prompt briefing --vault "<vault>"` command) and exits 3, since such a
  task can be created only from inside the application, whose tool takes no working
  directory; the `setup` skill offers it and creates it. `status --job briefing` reads the
  task back: missing, unsigned, running no briefing command, a kit path a plugin update
  removed, another vault, or another kit that still works. `install` refuses a signature
  that is blank, more than one line or padded with spaces.
- The transcripts source always counts `briefing.signature` among the kit's own
  signatures, so the desktop task's sessions never reach the curator; a briefing asked for
  in the person's own session starts with their message and is curated (in doubt,
  include). `schedule status --job briefing` and `doctor` judge a task signed with the
  filter's own predicate.
- `brain-kit doctor` gains `briefing`: signatures it cannot use, `briefing.blocks`
  problems, a question queue that cannot be read or holds unreadable lines, and the
  desktop task as `schedule status --job briefing` reads it.
- `docs/briefing.md` (what the briefing is and is not, the facts and where each comes
  from, the blocks, custom blocks, the limits, the question queue, the overlay, the
  desktop task, which sessions the curator skips, and what never changes).
- `BRAIN_KIT_E2E_BRIEFING=1 node --test test/e2e-briefing.test.mjs` runs the real skill
  once against a throwaway vault (never in CI), asserting from the stream and the queue:
  the skill ran and the real render counted its question, every default block's heading
  in order, the escalated question first, the queue changed through the kit's command, at
  most one pull request with `--only`, no tool use naming a `never_read` path, and an old
  log section's marker never handed to the model.

## 0.0.1 (published on npm on 18/09/2026)

Phase 0: package skeleton, CLI router with exit codes, language packs (pt-BR reference, en),
config and machine schemas, maintainer anti-leak pre-push gate, Claude Code plugin manifest
and hook wiring (hooks are no-ops until Phase 1), CI, rationale and incidents docs.

The package is published on npm as `second-brain-kit` because the registry refused
`brain-kit`; the command, plugin and repository keep the name `brain-kit`.
