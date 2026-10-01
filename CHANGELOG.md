# Changelog

## Unreleased

- The `SECURITY.md` that `init` writes into every vault now points to `docs/incident-response.md` (by its absolute address, since a vault does not hold the kit's
  docs), in both languages, because that is where the lint finding for a secret and the push
  gate send a person. A vault created earlier gets the paragraph with `brain-kit update`;
  `examples/minimal-vault` was refreshed the same way, and `test/vault-security-template.test.mjs`
  fails if the pointer disappears.
- `docs/incident-response.md` exists. It says what to do, in order (rotate first, rewrite the
  history second, tell people third), when a secret or a third party's personal data is in a
  vault, when the repository was public, and when the curator did something it should not
  have. It ships in the package, `SECURITY.md` points to it, and
  `test/incident-response-doc.test.mjs` fails when a command, flag, path, configuration key or
  `doctor` check id it names is renamed or removed.
- `examples/minimal-vault/` is a small fictional vault (an owner called Ana, one person, one
  organization, one project, one decision and a three-entry log), built with `init` and then
  written by hand, so a reader can see what a vault looks like without running anything. Its
  README gives the `init` command and the `validate` and `lint` commands. It is not in the npm
  package, and `test/example-vault.test.mjs` keeps it valid: it copies the folder to a scratch
  directory, runs the real CLI over it, and fails when `validate` or `lint` finds anything, when
  a note carries `verified`, or when the folder holds an absolute path, an address outside
  example.com or a `.git` entry.
- The READMEs (English and Portuguese) now show the path from a clean machine to the first
  pull request, which no document did: a person who followed only the README in a clean
  room found everything else fast and stopped at "what do I do after `init`". There is a
  new section, "Your first vault", right after the install: `gh auth login`, install the
  kit and the plugin, `brain-kit init ~/my-brain` (it asks its questions in a terminal;
  `--from-answers <file>` and `--yes` are for where there is none), the first commit,
  `gh repo create my-brain --private --source . --push` (private because the vault holds
  notes about people; with `--push` because a repository created without it is empty and
  `propose` cannot work), `brain-kit doctor` and what a healthy result looks like (the
  warnings about the scheduled curator are fine at that point), Claude Code in the vault,
  one fact in the log, `brain-kit propose "<summary>" --only <path>`, and the merge on
  GitHub. Three of its commands are the ones `init` prints at its end.
- The READMEs also open with what the kit is, and the phase history that filled their first
  lines moved to the Status section with every fact kept; the Requirements come before the
  install; the commands after the install are written `brain-kit ...`, with one sentence
  on how to run from a clone without installing; the install snippet packs with
  `npm pack --silent` (it printed about 200 `npm notice` lines) and says what to do when
  `npm i -g` fails with `EACCES` (`npm config set prefix ~/.local`); and
  `BRAIN_KIT_LANG` is documented next to `init --lang`.
- The `setup` skill (both languages) creates the repository with
  `gh repo create <name> --private --source <dir> --push` after the first commit, and says
  that without `--push` the remote is empty and `propose` cannot work. Its machine checks
  (Node, git, a logged-in `gh`, `claude`) no longer include the `doctor`, which refuses to
  run outside a vault and so checked nothing before the vault existed; the `doctor` runs
  after `init`, and again at the end.
- The `curate-session` skill (both languages) no longer stops when `sync` postpones because
  the working tree has uncommitted changes: that is exactly the state of a session that
  edited notes, and the `Stop` hook sends the session to this skill only then. If that is
  the only reason and every file `sync` lists is the session's own, the skill goes on,
  because `propose` fetches the base itself; any other refusal still stops it.
- The plugin manifest no longer declares `userConfig.lang`. Nothing read it (the language
  comes from `BRAIN_KIT_LANG`, `LC_ALL`, `LC_MESSAGES` and `LANG`, and a vault's own), yet
  its default was `pt-BR`, its description promised an effect, and installing the plugin
  printed "1 userConfig option not yet set" and told the person to configure it. The
  plugin has no options now; `claude plugin validate --strict` still passes.
- The npm package now ships the documents its own README and messages point to:
  `docs/scheduling.md`, `docs/connectors.md`, `docs/briefing.md`, `docs/security.md`,
  `docs/testing.md` and `docs/validator-parity.md` (the README inside the package cited
  five of them, the `doctor` and the curator cited `docs/connectors.md`, and none was
  there). A new test fails when a shipped file cites a `docs/` file the package does not ship;
  the release checklist and `docs/superpowers/` stay maintainer-only, and the CHANGELOG now
  links the checklist by its address on GitHub.
- `test/stranger-docs.test.mjs` pins all of this: the order and content of the READMEs
  (and that the two say the same), the sentences added to the two skills in both languages,
  the manifest without options, and the packaged-docs guard. The grading criteria of the
  `setup` eval follow the skill's new order.
### What the kit tells a first-time user is true (01/10/2026)

A stranger followed only the README in a clean room and was misled in several places by the
kit's own output. These are the fixes in the code and the messages (both language packs).

- `propose --dry` no longer promises what the real run refuses. Before it said "Would
  propose" and exited 0 over a remote that publishes no branch yet (the usual state right
  after `gh repo create` without `--push`), a remote that publishes other branches but not
  the base, a `gh` that is not installed and a `gh` that is not logged in; the real run then
  stopped (exit 1 on the first two) or published its branch and ended without a pull request
  (exit 3 on the last two). Now the dry run asks the remote what it publishes (a read-only
  `git ls-remote`, judged by the same function as the real run's fetch, so it refuses with
  the same sentence and the same exit code 1) and `gh auth status`, and refuses with exit 3
  when `gh` is absent or logged out, naming `gh auth login`. A remote that cannot be asked is
  said to be unverified, exit 1, never "Would propose". It also names the branch the real run
  would make (with `-2` when a push url already holds the stamped one). It still writes
  nothing.
- `doctor` has a new check, `gh-auth` (after `gh-present`): it runs `gh auth status` and
  fails, naming `gh auth login`, when `gh` is installed but holds no login. Until now a
  logged-out `gh` read `ok` and the first `propose` ended exit 3 with the branch pushed and
  no pull request. With no `gh` at all the check is skipped (and says so), because
  `gh-present` already reports that. The id is accepted by `--only`.
- `doctor`'s `include-projects` failure says how to fix it. The empty-list message now names
  the key, the form of an entry (a directory under the transcripts folder, with this
  vault's own entry written out), that `"all"` is accepted but means every project on the
  machine, and the section of `docs/scheduling.md` that explains it ("Before the first
  round", which now also says how Claude Code names a project's directory). A vault's own
  project, whose folder Claude Code only makes when a session first runs there, is `ok`
  with a note that it has no sessions yet, also when the default projects folder itself is
  not there; every other failing case still fails, including a missing name that is not the
  vault's own and a projects folder named by `transcripts_dir` or moved by
  `CLAUDE_CONFIG_DIR`.
- `doctor` writes its report in the vault's language, as `validate`, `lint`, the hooks and
  `prompt` do: the `lang` of `brain-kit.config.json`. Outside a vault, with a configuration
  it cannot read or with a language the kit has no pack for, the locale still decides.
- `init` writes `sources.transcripts.include_projects` with the one project that is the new
  vault itself (the name Claude Code gives the directory of the vault's own path, from one
  function, `claudeProjectName`), so the first `doctor` has nothing to fail on. Only into an
  empty list, only while a round reads transcripts, never `"all"`, and nothing for a path
  too long to be named as it is spelt. `init --adopt` does the same.
- `init` ends with the commands that lead to a first pull request, in order and in five
  lines, and runs none of them: `gh auth status` (then `gh auth login` if it says no),
  `gh repo create <name> --private --source . --push` (with the repository answered, or the
  vault's folder name, as the default name) and `claude` in the vault. Printed only over a
  vault whose checks passed and, when init committed, whose commit was made; not for an
  adopted vault, which has a repository of its own.
- Outside a vault, `doctor`, `validate`, `lint`, `propose` and `curate` end their "no vault
  found" message with "To create one: brain-kit init <dir>", and `curate` no longer says it
  looked for the configuration "or" a root index when both are required.
- `schedule install --job briefing --dry` is accepted (the usage line lists `--dry`) and says
  that for the briefing job nothing is written anyway; the run is the normal run of that job,
  exit 3 included. `status` still takes no `--dry`.
- `curate --dry` no longer exits 0 over a round that would refuse. For a required source that
  is unknown, off, or has nothing to read (no project listed, none of the listed ones there),
  it says "a real round would refuse to run now (exit 1)" with the round's own sentence, the
  problem in words instead of the code `no_projects`, and exits 1. The same words replace the
  codes in the warning it prints for a source that is only best effort. The other refusals of
  a round (an over-cap first day, a file it cannot read: exit 4) are still previewed with exit
  0, as before.
- `propose` in a repository with no remote of the name it reads the default branch from no
  longer says "the default branch is published to remote origin" as if something had set it
  up. It says the repository has no remote called that, and how to create one:
  `gh repo create <name> --private --source . --push`.

## 0.0.7 (tagged `v0.0.7`, not on npm)

No command does anything different in this version. It makes the documentation and the
release process keep up with the development: the READMEs say the true stage, a gate in the
suite and in CI stops them falling behind a release, and every tag now gets a GitHub Release
with its CHANGELOG section. It is the first version published by the new release workflow.

- The READMEs and the documentation were brought to the stage of 0.0.6 (01/10/2026): the
  status of each phase and the point Phase 5 has reached, the tag and npm situation (every
  version from 0.0.2 on is a git tag only; npm has only the 0.0.1 skeleton), an install
  snippet that resolves the latest tag instead of naming a version, and two sentences
  that spoke of work as still to come after it had landed (`SECURITY.md` and
  `docs/validator-parity.md`).
- Every tag now carries its specification, and the documentation cannot fall behind a
  release (01/10/2026). Until 0.0.6 there was no GitHub Release at all, the newest tag was
  lightweight (no message), and nothing related the version in `package.json` to the
  CHANGELOG or to the READMEs, which is how the READMEs still described the stage of 0.0.2
  four releases later. `scripts/release-notes.mjs` (maintainer tooling, not in the
  package) runs nine checks, each with a stable id: `package-version` (a valid version in
  `package.json`, which every other check is relative to), `changelog-section` (exactly one
  `## <version>` heading, with text, at most 120000 characters, and no code fence left
  open), `changelog-order` (version headings strictly descending, each once, `## Unreleased`
  once and only above them, and nothing but `## Unreleased` above the first version heading,
  so a `## [Unreleased]` cannot hide entries), `status-stamp`, `status-latest-tag`,
  `install-literals` and, only for a tag, `tag-version`, `tag-annotated` and
  `unreleased-empty`.
- `test/release-docs.test.mjs` tests each check against hand-built fixtures and runs the
  checks, without a tag, over the repository's own files, so they run on every `npm test`
  and in CI on every push. An ordinary commit passes them; a version bump that left the
  CHANGELOG heading, the READMEs' stamp or their latest-tag sentence behind does not. The
  forcing function is the stamp: both READMEs carry `<!-- status-reviewed: 0.0.7 -->` right
  under their Status heading, and bumping the version fails the suite until a person has
  re-read that section and changed the stamp. No fenced code block of either README may
  name a literal tag or tarball (the install snippets resolve the latest tag themselves).
- `.github/workflows/release.yml` publishes the GitHub Release when a tag `v*` is pushed:
  it runs the checks on the tag (which must be annotated, with a subject), takes the
  CHANGELOG section of the version as the body with a last line `Full diff` to the previous
  tag, and uses the tag's subject as the title. It fetches the annotated tag object again
  before the check, because `actions/checkout` rewrites a pushed annotated tag as a
  lightweight one. The tag and the token reach the shell only through `env`. A re-run of the job edits the Release instead of creating a second one. It
  does not wait for CI, and attaches nothing.
- [`releasing.md`](https://github.com/aleckyann/brain-kit/blob/main/docs/releasing.md), in the
  repository's docs folder, is the maintainer checklist (six version fields, the CHANGELOG as the
  specification, the Status re-read and re-stamp, annotated tag, what to do when the
  workflow fails), and `CONTRIBUTING.md` points to it. None of the new files is in the npm
  package.

## 0.0.6 (tagged `v0.0.6`, not on npm)

### The curator sees through the envelope the desktop application wraps a task's prompt in (01/10/2026)

- On the first real briefing run on the desktop application, the session's first user
  message was not the task's prompt: the application wraps it in an envelope (an opening
  `<scheduled-task name="..." file="...">` tag, one paragraph of its own wording, a blank
  line, the prompt as registered, a closing tag). The self-trace filter compared the start
  of the message with the signatures, so it kept the briefing's own session, and the next
  round would have read it back as the person's work
  ([docs/incidents.md](docs/incidents.md), 01/10/2026). Every test had passed because none
  wrapped the prompt.
- `startsWithSignature`, still the one predicate the curator, `schedule status --job
  briefing` and `doctor` share, now looks through the envelope. A first message that
  starts with the opening tag is the kit's own when the tag's `name` starts with
  `brain-kit-briefing-` (this also drops the briefing of another vault on the same machine,
  whose signature this vault does not know) or when the prompt inside, the text after the
  first blank line that follows the tag (or right after the tag when the application leaves
  its paragraph out), starts with one of the signatures. The paragraph's wording is never
  matched, attributes may come in any order with single or double quotes, and the closing
  tag may be missing. Nothing else counts: a signature anywhere else in the message, the
  tag quoted in the middle of a text and the envelope of the person's own other scheduled
  task (another name, an unsigned prompt) leave the session in. The tag is read in one
  bounded pass over the first 16 KB of the message, so a first message of megabytes costs
  nothing, and a tag that is not finished inside it is no envelope.
- The signature must still be the prompt's first line ([docs/briefing.md](docs/briefing.md),
  "Which sessions the curator skips" and both READMEs now say what was measured instead of
  "not measured yet"). `schedule status` and `doctor` read the task from its file, where
  the prompt is not wrapped, and say what they said before: they agree with the curator on
  that prompt, and stay strict on a task named with the kit's prefix whose prompt lacks the
  signature (`unsigned`), which the curator drops by name while the application wraps it.
- One limit is deliberate and documented: a session of yours whose first message is the
  kit's own envelope pasted whole (or only its opening tag), with a question after it, is
  skipped as the kit's own. A word of your own in front keeps it in.
- The message that counts the sessions the curator left out
  (`sources.transcripts.dropped_self_trace`) now says an envelope counts too, and the two
  `unsigned` messages of `schedule status` and `doctor` say the curator "may not be able
  to" tell the sessions apart instead of "cannot", in both languages; keys and
  placeholders are unchanged.
- The task id prefix `brain-kit-briefing-` is defined once, in `src/briefing/task-id.mjs`,
  and `src/commands/schedule.mjs` re-exports it.

## 0.0.5 (tagged `v0.0.5`, not on npm)

### The model reads a digest of each transcript, never the transcript (01/10/2026)

- A round now writes a digest of each transcript its plan keeps before the model starts,
  and hands the model those instead of the transcripts
  ([docs/incidents.md](docs/incidents.md), 01/10/2026: on the first real round on a real
  vault, transcripts of 386 to 512 KB with lines of more than 100 KB were refused by the
  Read tool whole and in slices, the required source could never be proven read, and the
  round exited 4). A digest holds only the messages whose own time falls inside the
  source's window, in order of time, one line each (`[HH:MM user] <text>`,
  `[HH:MM assistant] <text>`, the date in front when the window spans several days, on the
  vault's clock): a user message's text and the assistant's text blocks, never a tool call,
  a tool result or a thinking block. What Claude Code writes on its own is filtered by its
  own marks and tags: a line marked `isMeta`, `isCompactSummary` or
  `isVisibleInTranscriptOnly`, a user line whose `origin.kind` is not a person's, and,
  from a user line, every block of the tags Claude Code writes itself, wherever it stands
  and with its attributes (`system-reminder`, its `id` form included, `task-notification`,
  `teammate-message`, `cross-session-message`, `fetched-web-content`, `ide_selection` and
  the rest listed in [docs/security.md](docs/security.md), "The digests"), and a block that
  is then blank or starts with `[SYSTEM NOTIFICATION - NOT USER INPUT]` or `Stop hook
  feedback:`; what the person typed as a slash command (`/name args`) or a `!` command
  stays. Each message is cut at 1 800 characters with ` [...]`.
- A digest is bounded by what Read prints for it, line numbers included: under 24 000
  UTF-8 bytes. Every token covers at least one byte, so a digest is under Read's 25 000
  tokens whatever its script (Chinese, emoji or a pasted blob as much as prose), and far
  under its 256 KB and 2 000 lines: it is always read whole. For prose that is about 22 000
  characters.
- A digest holds whole days. When a source's days do not all fit, the round offers the
  oldest days every digest holds whole and leaves the others open for the next round: the
  transcripts mark stops at the last day offered whole. Each digest's first line, the
  prompt's transcripts block, the round's output, `last-run.json` (warnings and reason)
  and the end of the round's reason say which days stay open. Only a first day that alone
  does not fit is cut, keeping its most recent messages, and the first line, the block,
  the output, the warnings and the reason say what was left out (`cut: the first N
  messages and M characters were left out`, in the vault's language), a cut of one
  message included.
- The round grants `Read(//<digest>)` for each digest and no longer grants any transcript.
  A transcript counts as read when its digest was read whole, in one successful Read with
  no offset past its first line and no limit short of its last; a Read or a Grep of the
  transcript itself never counts. `last-run.json` still says how many transcripts of how
  many were read, in the same terms.
- The digests live in `digests/<instant>-<hex>/` in the state directory, each file 0600 in
  a folder of 0700, and are deleted when the round ends, on a failure, an exit 4 or a
  signal as on a success, first of the round's cleanup steps, none of which can skip
  another; the next round deletes what a round killed outright left, as soon as it holds
  the lock, and only what bears a round's own name. With `--keep-stream` they are written
  beside the kept stream (`logs/curate-<instant>-<hex>.digests/`) and age out with the
  logs. No digest text goes into the log, `last-run.json` or a notification. `--dry`
  writes none and says how many a round would write; `--check` writes none.
- A state directory whose path holds a character no read rule can name exactly (a vault
  folder named `Notes (old)` gives its name to the state directory) stops the round before
  the model with exit 1, `digest_dir_unsafe`, and `doctor` fails a new check,
  `digest-dir`, before any round does. Both name the fix that reaches the scheduled round:
  rename the vault's folder, run `brain-kit machine register --from <its previous path>`
  and `brain-kit schedule install` again.
- `doctor`'s `round-scope` and `connectors` checks now take the digest folders, not the
  transcripts folder, as the round's own reads when they mirror the person's user rules,
  as a round does.
- The curate prompt's rule `sample-from-end`, in both languages, now speaks of the digests:
  the kit already sampled each transcript, a digest holds whole days, the model reads each
  digest whole with no offset or limit, and reading the digest is reading the transcript.
  The transcripts block of the parameters says the same and lists each session by its
  digest. No contract marker was added or removed. A vault with its own curate overlay
  gets the new block, which the kit writes, but not the rule's new wording: copy it by
  hand into the overlay's `sample-from-end` paragraph. Until then such a round reads
  nothing and exits 4: `brain-kit prompt --check` now warns about an overlay that names
  `sampleLine` or tells the model to pass an offset to a transcript, and the reason of a
  round that exits 4 says so when its model tried to read a transcript itself.

## 0.0.4 (tagged `v0.0.4`, not on npm)

### A document the connector answers "not found" for (30/09/2026)

- The `failed` state of the sources-line rule, in both languages, no longer covers a document filed as not verified. Its text said "something the block lists could not be read", and the model followed it for two not-found attachments (a real round, 30/09/2026), so a rule that said "never a failure of the source" was contradicted by the line that decided the mark.
- The curate prompt's rule `no-access-label`, in both languages, now covers a document the
  connector answers "not found" for, which is its answer both for a deleted attachment and
  for one never shared with the reader ([docs/incidents.md](docs/incidents.md),
  30/09/2026). Such a document is not verified, with its own exact reason, `not found by
  the connector (deleted attachment or no access)` (`não encontrado pelo conector (anexo
  apagado ou sem acesso)`); like one with no access, it is never empty, never missing and
  never a failure of the source, so with everything else read the source is reported `ok`
  and its days close, and the final message lists it by title. A real round had reported
  the whole meeting-notes source `failed` over two such attachments, and its mark did not
  move. The permission label is unchanged, byte for byte, and now goes only to a document
  the connector refuses for permission. The meeting-notes source's prompt block
  (`sources.meeting_notes.no_access`) says the same, and no longer files "Requested entity
  was not found" under the permission label. No contract marker was added, so an overlay
  that passes `prompt --check` still does. A vault with its own curate overlay gets the
  source block, which the kit writes, but not the rule's new sentences: copy them by hand
  into the overlay's `no-access-label` paragraph. No code reads the label text.

### An expired login says what to do (30/09/2026)

- A round whose Claude Code login has expired exits 69 with `reasonCode` `auth_expired`
  ([docs/incidents.md](docs/incidents.md), 30/09/2026). The CLI still starts on an
  expired login and ends with a result that is an error, at no cost and in one turn; the
  round used to record `model_failed` with `-` for its detail. Now, when the result is an
  error and its text holds a known login failure (`Failed to authenticate`, `OAuth session
  expired`, `could not be refreshed`, `Invalid API key`, `authentication_error`, `API Error: 401`, in any
  case) or it carries an `api_error_status` of 401, the reason, in the vault's language,
  quotes the CLI's text, says to run `claude` and log in with `/login`, and says the day
  is not lost. No watermark moves, `last-run.json` records the code, the notify command
  is called once, and nothing is retried. A model's text that only mentions a login, in
  a run that did not end in an error, never counts.
- Every model failure whose run ended in an error result now carries the first 300
  characters of that result's text, on one line with the round's token hidden, instead
  of `-` (`model_failed`) or only the markers found (`model_unavailable` from the
  stream; text the CLI printed on its standard error is still reported by its markers).
- `doctor`'s `last-run` check fails on an `auth_expired` round instead of warning that
  the next window retries. [docs/scheduling.md](docs/scheduling.md) has a new section,
  "When the login expires".

## 0.0.3 (tagged `v0.0.3`, not on npm)

### The SessionStart line says nothing about the legacy lock (28/09/2026)

- The SessionStart line no longer mentions the legacy lock, whether it is held, free or
  cannot be used ([docs/incidents.md](docs/incidents.md), 28/09/2026). What that hook
  writes reaches every session that loads the plugin, including a legacy job's own round
  when the job starts Claude Code without isolating the person's settings; that round, a
  child of the lock's holder, read "held by another process" as a competing writer and
  ended without reading its sources. The hook no longer probes the file at all. The lock
  is still enforced by every writer and by the Stop hook's release, and still reported by
  `doctor` (`legacy-lock`), `preflight` and so the briefing's facts, and the Stop hook's
  release line. The vault-lock sentence is unchanged. The two message keys only the
  removed sentence used (`hook.session_start.legacy_lock_held` and
  `hook.session_start.legacy_lock_unusable`) are gone from both language packs.

### A list item written under the wrong key (incidents of 26/09 and 30/09/2026)

- `validate` names a list item that hangs under another key. When the line of a declared
  extension field already holds its value and list items are indented under it, below a
  list they were written for (a new `sources` entry added after `confidential: true`, at
  the end of the frontmatter), the `extension-fields` rule reports
  `frontmatter-dangling-items` with the first item's line, the field it hangs under, the
  list above that holds entries like the items, and the fix: move the items to the end of
  that list, before the next top-level key. The list named is the one EVERY item of the
  group belongs to, not merely the nearest one or the first item's: a source goes to
  `sources` (the list whose first entry shares the most of the item's fields), never to a
  `tags` list written in between, and a tag goes to a list of scalars. It used to report
  only that the field's shape could not be read. The finding keeps the generic one's class
  and blocks exactly where it did; every other unreadable shape still gets the generic
  finding, and so does the same shape when no list above holds the items' kind, when the
  items belong to different lists (a tag, then a source) or something that is no item sits
  among them, when the items are plain values under a field that takes any text (a
  `string`, or an `enum` with no values for the note's type), where `author: Ana` then
  `  - and Bruno` is one legal folded value, and when the items are not indented where that
  list's own markers are. Moved as they are, such items are no entry of the list: at the
  depth of its entries' fields a source even reads as a field of the entry above, and the
  note passed with the source unread. The reader accepts and declines the same shapes as
  before.
- The curate prompt tells the round, in both languages, to put a new item of a frontmatter
  list such as `sources` at the end of that list, before the next top-level key. No
  contract marker was added, so an overlay that passes `prompt --check` still does. A vault
  with its own curate overlay does not get the sentence: copy it by hand to the place where
  the overlay tells the round to create or change notes.

### Known gaps found while moving the reference vault onto the kit (26/09/2026)

- `machine register` rebinds a vault that moved; it cannot create the state of an
  already adopted vault on a machine that never had it (a second clone, a new machine),
  and `init --adopt` refuses an adopted vault. Until then, `machine.json` is written by
  hand in the kit's format.
- The kit ships no CI workflow template for a vault, which the approved design lists.
- A custom briefing block's `read` accepts files only; the global `briefing.read` accepts
  folders.
- The `today_calendar` block names the calendar tools by the CLI's prefix; the desktop
  app names them differently, so the block skips itself there. A custom block that names
  the tool by its suffix (`list_events`) works around it.
- The `strategy` block reads every note the index links under a matching title, not only
  the most recent one.
- The privacy rule's structural clauses (a link into a confidential folder, a confidential
  mark outside one) judge the whole vault in every base, so a vault with such links from
  before cannot keep a narrow confidential boundary; a vault that is private as a whole
  can declare `confidential_dirs: ["."]`.
- `curate.promotion_map` and the `hooks.*` keys are read by no code.
- The calendar source asks for `DEFAULT` events only, so focus blocks never reach a round.
- `verify` refuses in a checkout whose local git identity is the agent's.
- A pre-release version (`0.1.0-rc.1`) breaks the hooks' vault sentinel, which accepts
  `x.y.z` only.

## 0.0.2 (tagged `v0.0.2` on 26/09/2026, not on npm)

The first version the reference vault installed, from the tag. It holds every phase
below, 1 to 5a.

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

### Phase 4: the morning briefing

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
  with a correction line. Every path that wrote the text or its one line exits 0, the
  reason on stderr, because the skill's `!` line runs it and a failing `!` command is
  unmeasured. A generic, domain-neutral prompt in both
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
  signatures, so a session that starts with the desktop task's prompt never reaches the
  curator (whether the application delivers the prompt unchanged as the first user message
  is not measured yet: if it wraps it, the session is read like the person's own); a briefing asked for
  in the person's own session starts with their message and is curated (in doubt,
  include). `schedule status --job briefing` and `doctor` judge a task signed with the
  filter's own predicate.
- `brain-kit doctor` gains `briefing`: signatures it cannot use, `briefing.blocks`
  problems, a question queue that cannot be read or holds unreadable lines, and the
  desktop task as `schedule status --job briefing` reads it.
- A global `-C <dir>` runs any command exactly as if brain-kit had been started in
  `<dir>`, as git's. The briefing names every kit command with it (`{{kit}}` renders as
  `"<kit>" -C "<vault>"`) and gives the vault's path as `{{vault}}`, since the desktop
  task's session does not start in the vault.
- `propose` records what it pushed, outside a round, in the proposed-paths ledger
  (`<git dir>/brain-kit-proposed.json`, the round record's format). A file whose bytes are
  exactly what was pushed is proposed already: the Stop hook leaves it out, a second
  `propose` of it opens no second pull request, and `sync` (so the next round) brings it
  back to HEAD instead of postponing on it. One byte edited after the push makes it
  unproposed work again. The comparison is the round cleanup's, extracted. Each entry comes
  with a local ref at the pushed commit (`refs/brain-kit/proposed/<branch>`), and only an
  entry whose ref still holds its commit counts, so what `sync` brings back to HEAD stays
  reachable on the machine, even when the pushed branch is gone; `sync` names the ref and
  the recovery command, and removes the ref once the default branch holds its content.
- The briefing marks a question answered only after the `propose` that records its answer
  pushed, and a kit command refused with 75 (a round holds the vault) stops the writing
  and is told to the owner with the commands to run later.
- `docs/briefing.md` (what the briefing is and is not, the facts and where each comes
  from, the blocks, custom blocks, the limits, the question queue, the overlay, the
  desktop task, which sessions the curator skips, and what never changes).
- `BRAIN_KIT_E2E_BRIEFING=1 node --test test/e2e-briefing.test.mjs` runs the real skill
  once against a throwaway vault (never in CI), asserting from the stream and the queue:
  the skill ran and the real render counted its question, every default block's heading
  in order, the escalated question first, the queue changed through the kit's command, at
  most one pull request with `--only`, no tool use naming a `never_read` path, and an old
  log section's marker never handed to the model.

### Phase 5a: moving a vault from a legacy setup

- `brain-kit watermark import --from <file> [--sources <id,...>] [dir]` carries over the
  mark of a legacy setup that kept one date in a file of its own. The file's one line, a
  day written YYYY-MM-DD (a final LF or CRLF allowed) not after yesterday in the vault's
  zone, becomes the last day swept of every enabled source (the ones a round reads), or of
  the ones `--sources` names. Every check runs before the first write; a refusal exits 2,
  quotes the start of the file and changes nothing; the file is only read. It prints one
  line per source, the day and the mark it replaced, and no "closed unread" line: it
  trusts the legacy job for every day up to the imported one.
- A bridge to a legacy `flock` lock. `machine.json` `paths.legacy_lock` (an absolute path,
  `null` to turn it off, set with `machine set`) makes every command that takes the vault
  lock also hold an exclusive flock(2) on that file, taken without waiting right after the
  vault lock and let go with it: util-linux `flock` locks a descriptor the writer keeps
  open, so the kernel releases it when the writer ends, crash included. A held legacy lock
  postpones the writer with exit 75 naming the file. A bridge that cannot be used (not
  Linux, no `flock`, the file's directory missing, a `machine.json` that cannot be read)
  refuses with exit 1 and says how to repair it; a round records every lock refusal that
  is not "held" as `lock_unusable`, never `lock_held`. A `propose` joined to the round
  never asks a second time, and `machine set` and `machine register` leave the bridge
  out, so it can always be turned off. The Stop hook stands down while another process
  holds the file, and names a bridge that cannot be used in its release line too;
  `preflight` (and so the briefing) and the SessionStart line say when another process
  holds it or when it cannot be used, never "free" while it is held; `doctor` gains
  `legacy-lock`: off, on, on and held right now, or on and unusable.
- `curate.budget_usd: null` runs a round with no cost cap: no `--max-budget-usd` is
  passed. A key left out keeps the default of 5 USD, and `0` is refused as configuration
  before any round (the schema validator now implements `exclusiveMinimum`). `curate
  --check`, `--dry` and the round say which cap applies, `last-run.json` records
  `budgetUsd`, and `doctor` gains `cost-cap`.
- `curate.max_turns: null` runs a round with no turn limit (no `--max-turns`; a key left
  out keeps 100), and `curate.timeout_minutes` replaces the fixed hour after which every
  round's model was killed: a number of minutes (above 0, at most 35791, the longest
  Node's timer holds) keeps that kill, and `null`, both packs' default, or the key left
  out sets no time limit, since the owner never asked for one. `0` is refused as
  configuration for both. The round, `--check` and `--dry` say both limits,
  `last-run.json` records `maxTurns` and `timeoutMinutes`, and `doctor` gains `turn-cap`
  and `time-cap`. **Upgrading:** a vault created before phase 5a has no
  `curate.timeout_minutes` key, so its rounds go from the 60-minute kill to no time limit;
  set `curate.timeout_minutes` (60 keeps the old kill) to keep a cap. With none, a round
  that hangs stops the later windows under systemd and launchd until it is stopped
  (`docs/scheduling.md`, "A round that hangs").
- `docs/scheduling.md` gains "Moving from a legacy lock", with what the bridge does not
  cover, and the rules of `watermark import`.
- `sources.transcripts.include_projects` takes the string `"all"` besides a list: every
  project directory under the transcripts directory at the time of the round, minus the
  directories `exclude_path_patterns` covers whole, the file patterns still applied. It is
  the owner's explicit choice, written in the configuration; any other string is refused as
  configuration, and a list holding "all" names a directory called `all`. "all" that finds
  no project directory (`all_empty`), like a list none of whose projects exists, reads
  nothing: the transcripts source counts as failed, never as empty, and its mark never moves
  on it, required or best effort. Required, the round refuses (exit 1); best effort, the
  round goes on with its other sources and does not exit 4 for them, and their days stay
  open. `doctor`'s `include-projects` says `all (N project(s) today)`.
- A project directory a round cannot list no longer lets the transcripts mark advance
  (before, it was only a warning, and the round closed days whose sessions in it nobody
  read). It is unread, like a file that cannot be read: with the transcripts required the
  round stops before the model (exit 4), the reason and `last-run.json` name it, and every
  round stops there until it can be listed or leaves the configuration, since its sessions
  could be on any day. `doctor`'s `include-projects` already said so; now it is true. So is
  a project reached through a link the round cannot follow (into a directory it cannot enter,
  to a volume that is not mounted, a loop): under "all" it was left out in silence, under a
  list called missing, and the mark moved on either way. A link the round can follow is a
  project like any other; a listed name that is simply not there still only warns.
- `sources.calendar.team_authorization: { "by": "human:<handle>", "at": "YYYY-MM-DD" }`
  records who authorised reading the team's calendars and on which day, and is now the one
  gate on them: it replaces `team_calendars_consent_noted`, which is no longer read (`true`
  authorises nothing). The calendar source checks it, never the configuration's
  validation, so no command refuses to run over it: one that is missing, not in that form
  or dated on a day that does not exist records nothing. The round then leaves every team
  calendar out, reads the owner's own, and says how many and why in its parameters; it
  never exits 4 for that alone. With one, the parameters print "Team calendars authorised
  by <by> on DD/MM/YYYY". `doctor` (check `connectors`) fails while team calendars are
  listed and no authorization records anything, naming the key and what is wrong with it,
  and warns while `team_calendars_consent_noted` is still in the configuration, naming
  both keys. A calendar listed both in `calendars` and in `team_calendars` is now someone
  else's, read only with the authorization, unless it is the owner's own (`primary`, or the
  id `owner.email` or `briefing.calendar_id` names), which is always read as the owner's;
  phase 3 planned it as the owner's, so it reached the model with no authorization. `doctor`
  warns on each one listed in both. The seed-rituals skill and the curate prompt's privacy
  rule now speak of the recorded authorization, not of consent. **Upgrading:** a vault made
  before this change carries
  `team_calendars_consent_noted` (`init` wrote `false`); remove it, and record a
  `team_authorization` to keep reading team calendars.

## 0.0.1 (published on npm on 18/09/2026)

Phase 0: package skeleton, CLI router with exit codes, language packs (pt-BR reference, en),
config and machine schemas, maintainer anti-leak pre-push gate, Claude Code plugin manifest
and hook wiring (hooks are no-ops until Phase 1), CI, rationale and incidents docs.

The package is published on npm as `second-brain-kit` because the registry refused
`brain-kit`; the command, plugin and repository keep the name `brain-kit`.
