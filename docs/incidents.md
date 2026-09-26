# Incidents that shaped brain-kit

Every guard in this kit exists because something broke in the original vault, at a
known date. This file keeps the incident next to the rule so nobody removes a guard
for looking paranoid. Entries are grouped by theme and dated DD/MM/YYYY.
Names of people, companies and tools were removed on purpose.

Seventy three lessons were extracted from the original vault, written up as seventy
two entries: the four day curation outage of September 2026 produced two lessons about
the same incident and is written up once, under 13/09/2026. Three entries were added
since, each dated: the leak gate that blocked its own release tag (18/09/2026), the
selection of transcripts by modification time (24/09/2026), and the settings a headless
run inherits (24/09/2026), which the kit's own build produced. Seventy five entries
follow. Where a lesson carries no date of its own, the entry says "Undated" and explains
why.

## Format and links

### 10/08/2026: every internal link returned 404 on the review screen
**What happened.** Internal links were written with a leading slash, the form the
specification calls recommended. On the code forge, which is the screen where the
owner approves pull requests, including from a phone, every one of them resolved to
a 404. The migration touched 697 links in 184 files (PR #26). The format's own
reference catalogue had migrated its bundles for the same reason (152 links in 40
files).
**Rule.** Choose the link form by the interface where the human reviews, not by the
form the specification calls recommended. Links in the body are file relative;
`resource` in the frontmatter keeps the leading slash because it is an identity, not
a rendered link. Then lock it in the validator so it cannot come back on its own,
and make the graph viewer resolve links the same way the validator does.
**Where it lives in brain-kit.** `brain-kit validate` (`link_style` in config,
`[house]` ruler), `brain-kit visualize` sharing the same resolver,
`test/rules-house.test.mjs` (the `link-style` cases) (Phase 1).

### 10/08/2026: a claim about someone else's tooling was simply false
**What happened.** The conventions document asserted that the format's publisher
shipped an OKF conformance suite. It did not. The claim was checked against the
public repository only because the owner asked, and the line was corrected in place
with a date.
**Rule.** A claim about a third party's tool is checked in that third party's own
repository, and the correction goes dated into the note itself, recording that the
previous version was wrong.
**Where it lives in brain-kit.** `brain-kit lint` rule `attribution`, plus the
correction discipline documented in [rationale.md](rationale.md) (Phase 1).

### 22/07/2026: the agent denied a specification that existed
**What happened.** The owner pointed at the open knowledge format published by a
large cloud vendor and the agent denied its existence before checking anything. The
same document later claimed the wiki approach beat retrieval augmented generation
without the cost caveat the cited study itself carries.
**Rule.** Verify before asserting and never hallucinate to please. Read the
specification at the source, not in a blog post. Every empirical claim about the
outside world ships with the study's caveat, not only with the favourable
conclusion.
**Where it lives in brain-kit.** [rationale.md](rationale.md), section "What the
evidence says"; the generated vault's `ARCHITECTURE.md` carries the caveat from
`init` (Phase 1).

### Undated: a folder was almost created for what was really an attribute
**What happened.** Family members were about to get their own folder, which would
have created a second collection for a class of entity that already had one. It
became a frontmatter field plus a section in the existing index instead. The lesson
carries no date because it was a design decision caught before it shipped, not a
production failure.
**Rule.** Before creating a folder, ask whether what distinguishes these items is a
class of entity or an attribute of one. An attribute is a frontmatter field plus a
section in the index, never a directory.
**Where it lives in brain-kit.** `taxonomy` and `frontmatter` sections of
`brain-kit.config.json`, enforced by `brain-kit validate` (Phase 1).

### 22/07/2026: job titles were in the file names
**What happened.** People's notes carried their role in the file name, and team
notes aggregated several entities in one file. A promotion therefore meant a rename,
which breaks every edge in the graph and scatters one person's history across two
files.
**Rule.** The path carries stable identity only. Role and state live in frontmatter
with a dated history section. A change is a diff in the same file plus a line in the
log, never a rename or a move.
**Where it lives in brain-kit.** `brain-kit validate` (path and frontmatter rules),
`brain-kit lint` rule `orphans` for the leftovers a rename leaves behind (Phase 1).

### Undated: the specification's enum collided with the domain's own status
**What happened.** The specification's v0.2 `status` enum (draft, stable,
deprecated) collided with a status the vault already used for domain meaning
(project active, decision open). One migration renamed the domain field and kept
both. No date is recorded; the collision was found while adopting v0.2.
**Rule.** When the specification closes an enum, the domain state changes name, not
place. An archived project can carry both a domain state and a deprecated spec
status.
**Where it lives in brain-kit.** `frontmatter.extensions` in the config (declared
fields with their own enums), `brain-kit validate` (Phase 1).

### 10/08/2026: one paragraph mixed four kinds of source
**What happened.** A log entry written on 05/08/2026 about an internal screen mixed,
in a single paragraph, notes generated by an assistant, something a third party
said, a decision made by the owner and a caveat that had never been confirmed.
Traceability depended entirely on the honesty of whoever wrote it.
**Rule.** A note that crosses more than one source is born with an id in each
`sources` entry and a footnote with the same key on each claim, including on the
claims that stayed unconfirmed.
**Where it lives in brain-kit.** `brain-kit lint` rule `attribution`, footnote
requirement in the curate prompt (Phase 1 and Phase 2).

### Undated: the era of the giant prompt
**What happened.** The predecessor of the vault was a large XML block in the system
prompt, updated by hand, which the agent could not write to. Above roughly 15 to 20
thousand tokens the model's attention diluted. The lesson predates the vault's git
history, so no single date applies.
**Rule.** Context is finite and expensive. The strategy is an index plus selective
reading, not a big block of glue. When the index itself stops fitting, the corpus
has crossed into hybrid territory (50 to 100 thousand tokens).
**Where it lives in brain-kit.** The vault skeleton produced by `brain-kit init`
(root index listing every folder, one line description per note), documented in
[rationale.md](rationale.md) (Phase 1).

### 17/09/2026: the validator's own templates failed the validator
**What happened.** Templates containing placeholders between angle brackets were
rejected by the date and enum checks, so the kit of templates could not pass the
ruler it defined. The exemption that fixed it was written inside checks labelled
`[spec]`, and the staleness report counted 48 real dates while reporting on 50
notes, calling the result green.
**Rule.** The validator needs an explicit placeholder exemption, but the exemption
is a house convention and may not live inside a `[spec]` check, nor hide that the
green report counted fewer real dates than notes.
**Where it lives in brain-kit.** `brain-kit validate` with the placeholder pattern
in config and staleness reported in an `[info]` block outside the exit code
(Phase 1).

### Undated: the validator is a regex, and says so
**What happened.** The validator parses frontmatter with regular expressions and not
with a YAML parser, so `verified` written as a block mapping is not recognised. The
vault works around it by using an inline mapping or a list with a hyphen. No
incident date: the limitation was found and documented in the code itself.
**Rule.** When a tool has a known limitation, it is declared in a comment in the
tool's own code and the writing convention adapts to it. A silent limitation becomes
a bug for the next person.
**Where it lives in brain-kit.** `brain-kit validate` (the regex limitation is kept
and documented; a real parser is Phase 7).

### Undated: a house rule was wearing the specification's badge
**What happened.** A `[spec]` labelled check demanded `stale_after` as a plain
`YYYY-MM-DD` date and rejected a datetime with offset, which is exactly the
normative form in the specification. A vault that followed the specification was
failed by a ruler sold as generic. Found during the 17/09/2026 audit of the vault,
so the defect itself has no incident date.
**Rule.** Every `[spec]` label is audited against the canonical specification,
category by category. A house rule wearing a spec badge fails the conforming
adopter.
**Where it lives in brain-kit.** `brain-kit validate`, with two rulers that never
share a badge: the specification ruler is fixed in code and cites the section it
reads, and the house ruler is driven entirely by the vault's own config.
`stale_after` is settled by the format itself, not by a setting: section 5 says
every timestamp-valued key is an ISO 8601 datetime with an explicit UTC offset,
so a plain date is a finding, at `should` level, citing section 5.5. A vault
still mid-migration off plain dates declares that with
`validate.timestamp_deviation: "allow"`, which marks those four timestamp-form
findings as warnings and can never touch a `must`. An earlier version of this
document offered `validate.stale_after_format` here instead: that setting was
read by no code, and it promised exactly the leniency this slice removed.

### Undated: staleness as a build failure would break the build by itself
**What happened.** Treating `stale_after` alerts as continuous integration failures
would make the build go red purely with the passage of time, without anyone changing
anything. A build that breaks on its own is a build people switch off.
**Rule.** Staleness is a report for the curator to re-verify, never a build failure.
It goes out in an `[info]` block, outside the exit code.
**Where it lives in brain-kit.** `brain-kit validate` `[info]` block, skill
`review-stale` (Phase 1).

### Undated: the style lock blocked every edit
**What happened.** A house rule banned a punctuation character that the legacy
content already contained about a hundred times. The check counted the whole diff,
so every edit, however small, was blocked by inherited text.
**Rule.** A style lock counts only the added lines of the diff
(`git diff -U0`, lines starting with a single `+`), otherwise a new convention is
impossible to adopt on a legacy base.
**Where it lives in brain-kit.** `brain-kit lint --base worktree|merge-base` rule
`style` (Phase 1).

## Git and pull requests

### 10/08/2026: the pull request was opened against yesterday's branch
**What happened.** One variable held two different meanings, the branch to return to
and the branch to target, so the proposal command opened each pull request against
the previous round's curation branch. It failed with "No commits between
curator/yesterday and curator/today" and "Base ref must be a branch".
**Rule.** Separate origin (the current branch, where to go back to) from base (the
repository default, read from `refs/remotes/origin/HEAD`). The loop only reaches the
human if it ends in a pull request against the default branch, and every link in the
chain follows the same rule, including the scheduler unit.
**Where it lives in brain-kit.** `brain-kit propose`,
`test/incidents/2026-08-10-base-ref.test.mjs` (Phase 1).

### 08/09/2026: success left the repository on the wrong branch
**What happened.** On the failure path the proposal command returned to the original
branch; on the success path it did not, leaving HEAD on the freshly created branch.
The next session started on a stale branch, which is the origin of the base ref bug
above.
**Rule.** After the pull request is open, go back to the origin branch, including on
success. Confirm the result before handing over the link
(`gh pr view <branch> --json baseRefName,mergeable`).
**Where it lives in brain-kit.** `brain-kit propose`,
`test/incidents/2026-09-08-return-to-origin.test.mjs` (Phase 1).

### 17/08/2026: the local default branch was four commits behind
**What happened.** A round started writing without fetching, the local default
branch was four commits behind the remote, and the merge collided in the log file,
because the log is append at the top and every round touches the same first line.
**Rule.** `git fetch origin` and `git pull --ff-only` on the default branch before
writing anything. Run the validator again after a rebase, because a wrong date order
in the log is a `[spec]` error.
**Where it lives in brain-kit.** `brain-kit sync`, called first by `curate`
(Phase 1 and Phase 2).

### 25/08/2026: two rounds of the same day curated the same meeting
**What happened.** A round at 13:00 had already created a note from the same meeting
that the 17:00 round was curating from a different source. Two days later a pull
request was born conflicting with an earlier one and had to be closed and its branch
deleted.
**Rule.** `git rev-list --left-right --count main...origin/main` is the first thing
in a round, before reading a single transcript. When two sources of the same meeting
disagree, record the divergence in a table in both notes and leave the decision to
the human. Never choose in silence.
**Where it lives in brain-kit.** `brain-kit sync`, divergence table required by the
curate prompt (Phase 1 and Phase 2).

### 29/07/2026: two curations ran on the same vault at once
**What happened.** On the first production run there was no lock. Two curation
rounds ran over the same working tree and collided. The output happened to come out
coherent, and the agent itself reported the collision.
**Rule.** Whoever calls the proposal command needs an exclusive lock and must abort
on a dirty working tree. The proposal command itself only aborts when the tree is
clean (nothing to propose) and runs `git add -A`: a simplicity choice that pushes
the responsibility onto the caller, and that has to be written down.
**Where it lives in brain-kit.** `src/guards/lock.mjs`, `src/guards/snapshot.mjs`,
`brain-kit propose --only`,
`test/incidents/2026-07-29-concurrent-rounds.test.mjs` (Phase 1 and Phase 2).

### 16/09/2026: a scheduled round nearly swept another session's work into a pull request
**What happened.** A curation round ran while another session was live editing the
scheduler script, its unit files and its test. A blanket `git add -A` would have
swept that unfinished work into the pull request.
**Rule.** Never stash another session's files: that erases their working tree
mid task. Commit by hand on the dated branch with explicit paths. The fingerprint of
this situation is modified files you did not touch, with a modification time of
minutes ago.
**Where it lives in brain-kit.** `src/guards/snapshot.mjs`, `brain-kit propose
--only` as the normal path (`--all` requires confirmation and refuses foreign
files), `test/incidents/2026-09-16-foreign-files.test.mjs` (Phase 1).

### 22/07/2026: who is allowed to write to the default branch
**What happened.** The question was settled early: the owner commits directly,
because a pull request from the owner to the owner is theatre, while the agent is
bound to pull requests. Continuous integration validates every push and a pre-push
hook catches problems locally first.
**Rule.** The asymmetry is deliberate and keeps approval cheap and auditable. The
agent proposes, the human merges, and the merge is both the approval and the
verification.
**Where it lives in brain-kit.** `brain-kit verify` (owner only), pre-push template
refusing an agent push to the default branch, generated CI workflow (Phase 1).

### 18/09/2026: the leak gate blocked its own release tag
**What happened.** The pre-push hook decides how much history to scan by whether
the remote already has the ref being pushed. For a ref the remote does not have
yet, it fell back to scanning everything reachable from that ref, which is right
for a brand new repository's first push. Pushing an annotated release tag that
pointed at an already-published commit hit that same fallback, because the tag
itself was new to the remote even though the commit under it was not. The hook
re-scanned the full twenty-commit history and refused the push over a test
fixture literal (a private key header, used to exercise the generic patterns)
that sat in three commits already public on the remote, with the literal removed
from the tip further back.
**Rule.** Scope the scan to what the remote really has, not to what it is
assumed to have. Re-scanning commits the remote already has cannot prevent a
leak, since that content is already public, and it blocks routine pushes such
as tagging a release. The scope has to come from asking the remote directly,
right now: the live push negotiation for a ref it already has, a live `git
ls-remote` for one it does not. It must never come from the local
`refs/remotes/origin/*` tracking refs, because those are only a cache, last
written by this clone's own previous push or fetch, and a remote rewound or
rewritten from another clone can leave that cache claiming commits the remote
no longer holds, which would let a leak inside one of them through unscanned.
The same day, four more holes in the same hook were found and closed, and they
all had one shape: a scanner that could not see something shrugged instead of
refusing. A range it could not compute looked like nothing to scan. A merge
commit produced no diff at all, so a secret typed in while resolving a conflict,
present in neither parent, went out unexamined. A single NUL byte made the
search skip the whole file as binary. An empty or non-regular patterns file
passed the readability check and silently contributed no personal pattern,
and the search tool's own error status was thrown away, so a pattern that
would not compile read as a clean file. The rule that covers all of them: a
scanner that cannot see something must refuse, never shrug. Distinguish
"looked and found nothing" from "could not look", by capturing exit status
rather than emptiness, and treat the second as a refusal that names what
could not be read and why. Where seeing more is possible, prefer it: diff a
merge against every parent, read a binary blob as text. Where the
configuration itself is the blind spot, check it for real (regular, readable,
non-empty), not merely for existence. Capping how much of a match is printed
is about the message, never about the verdict.
A last sweep the same day found four more of the same kind, and two of them
were about the machine rather than about the version control system. Listing
which kinds of change to keep, instead of which to drop, silently excluded
typechanges, so replacing a symbolic link with an ordinary file carrying a
secret went out unscanned. The scan is a pipeline, and only its last stage's
status was read, so a first stage that failed on an unreadable entry fed the
search an empty stream and the file was called clean. The dedup needed shell
features newer than the shell the project's own continuous integration runs on,
where it would have switched itself off and the first push would have died on
an unbound variable. And the text tools, in a locale that expects characters
rather than bytes, can abort on the invalid sequences a binary file is full of,
which with the previous point read as clean again. Three more rules, same
spirit. Prefer an exclusion list to an inclusion list when listing what to
scan: the excluded set is the one you can enumerate safely, and anything new
the tool learns to report then arrives scanned rather than ignored. Read the
status of every stage of a pipeline, not only the last one, and expect the
benign case (a search that stops early on a match closes the pipe and the
upstream stages report a broken pipe, which is not a failure). And never
require a shell or a userland newer than the one the people and the runners
actually have: pin the scan to bytes with a byte locale, check the versions
your continuous integration runs on, and where a convenience tool may be
missing, degrade to more scanning, never to less.
**Addendum, 22/09/2026: the remote that was asked was not the one pushed to.**
"Ask the remote directly" was obeyed while asking the wrong remote. The
enumeration ran `git ls-remote <remote name>`, which asks the remote's fetch
url, and git does not always push there: a `pushurl`, a second `url` and a
`url.<base>.pushInsteadOf` rewrite all send the push elsewhere. Commits the
fetch url already held were excluded and reached the destination unscanned,
with the gate saying nothing matched. The fix asked the url git hands the
hook, and a review then showed that was still not enough: `ls-remote` treats
that url as a fetch url and applies `url.<base>.insteadOf` to it again, so the
documented idiom of reading from a mirror and pushing upstream (an `insteadOf`
to the mirror, an identity `pushInsteadOf` upstream) had it ask the mirror,
and a branch only the mirror held landed upstream unscanned. The rule,
sharpened: the scope comes from the destination git is pushing to, asked in a
way that rewrites nothing further. Ask where the question would go
(`ls-remote --get-url`), and when that is not the destination, treat the
remote as unknown and scan everything. Both holes predate the gate's move to
Node and were live on every earlier version of it.
**Addendum, 22/09/2026: the reference line has a free-form first field.**
Git hands the hook `<local ref> <local sha> <remote ref> <remote sha>`, and the
local ref is the source expression exactly as it was typed, spaces included.
Read from the left, `git push origin ':/wip main:refs/heads/<name>'` made the
second word of the expression the pushed commit and shifted every field after
it: the gate scanned main's history instead of the commit git sent, never
scanned the real destination name, and printed that name in clear. It needed
no edit and was live on every earlier version of the gate. The rule: parse a
record from the side whose shape is fixed, check every field that has a shape
for that shape, and refuse a record that does not have it. The line is now read
from the right, both object ids must be 40 or 64 lowercase hex characters, and
push-gate compares each line's destination with the name the enumeration
listed for it, so a shifted line is refused even if the parse regresses.
**Addendum, 22/09/2026: the zero id has two lengths.** A repository using
SHA-256 writes the all-zeros id of a new ref or a deletion with 64 characters,
and the enumeration compared against the 40-character form only. Every new
ref there was read as an update from a commit "unknown to this clone" and
scanned in full, which is this entry's own first failure again, and every
deletion was refused as an unreadable object. It failed closed, so nothing
leaked. The rule: a sentinel value is recognised in one place, in every form
the producer writes it.
**Where it lives in brain-kit.** `src/push/records.sh`, the push enumeration
`brain-kit push-gate` runs out of the installed snapshot (moved there from
`.githooks/pre-push` on 22/09/2026): `remote_sha..local_sha` for a ref the
remote already has; `query_remote`'s live `git ls-remote` of the url git is
pushing to, once per run, for one it does not, with the `--get-url` check that
falls back to a full scan when that url would be rewritten; each reference
line read from the right, its object ids checked for their shape; full-history
fallback when the remote cannot be asked or the range fails to compute; `git
diff-tree -m` with a per-commit `sort -zu` dedupe, so merges are diffed against
every parent; `--diff-filter=d`, which drops only deletions, so typechanges
are scanned; every command's status read on its own statement, with no
pipeline; and `${arr[@]+"${arr[@]}"}` expansions, so it needs nothing newer
than bash 3.2, the version the macOS job in `.github/workflows/ci.yml` runs.
Reading blobs and deciding what matches moved to Node (`src/commands/scan-blobs.mjs`,
`src/leak.mjs`), which reads bytes directly, so there is no binary skip and
no locale to depend on, and whose pattern loading refuses a patterns file that
is missing, empty, a directory or unreadable. Tests: `test/pre-push-hook.test.mjs`
("a tag pointing at already-pushed commits is allowed", "a new branch is still
scanned for its own commits", "a stale-ahead tracking ref does not hide an
unpublished commit", "the remote being unreachable makes the hook scan
everything", "an existing ref whose remote_sha is unknown to this clone still
gets scanned", "a merge commit whose resolution introduces a leak is refused",
"a blob with a NUL byte is scanned instead of skipped as binary", "a patterns
file that cannot do its job refuses the push", "a typechange from symlink to
regular file is scanned", "a blob whose object is missing refuses the push
instead of passing") and `test/push-gate.test.mjs` ("a pushurl that differs
from the fetch url: the branch is scanned against the destination and
refused", "a second url: the push to it is scanned against it, not against
the first, and refused", "a pushInsteadOf rewrite: the push is scanned
against the rewritten destination and refused", "the mirror idiom (insteadOf
to a mirror, identity pushInsteadOf upstream) is scanned in full and
refused", "a chained rewrite (a pushurl mapped to a url that a second
insteadOf maps elsewhere) is scanned in full and refused", "a source
expression with a space (:/wip main) is scanned as the commit it names, and
refused", "behind a spaced source expression, a destination name that matches
is refused and never printed", "a reference line whose object ids are not
object ids is refused without being printed", "push-gate refuses a stream
whose reference name is not the destination git sent on that line", "in a
SHA-256 repository a new ref is asked of the remote, not scanned as an update
from an unknown commit", "in a SHA-256 repository a deletion is a deletion:
its name is scanned and nothing is read behind it", "the mirror idiom pushed
BY URL is scanned in full and refused, like the same push by remote name").

## Headless runs, network and scheduling

### 13/09/2026: four days with no curation while the scheduler reported success
**What happened.** From 13/09 to 16/09/2026 four consecutive rounds died on the
dirty working tree guard with exit code 0. The service manager recorded "Finished"
every time, each log file was 95 bytes long, and the high water mark stayed at
11/09. Nobody was told. The same stretch exposed a second cause: a single morning
window meant each dirty tree postponed curation by a full 24 hours, so from 12/09 to
15/09 there was no sweep at all. (This entry merges two lessons about the same
outage.)
**Rule.** A guard that only postpones has to shout: list the offending files in the
log, notify, and exit with a failure code (75, TEMPFAIL). The notification channel is
part of the guard, and a desktop notifier does not exist on a server or in a headless
session, so the guard must not depend on it alone. Run three windows a day as retry,
which is only safe because of the high water mark: without it the retry sweeps the
same target day and opens a second pull request on top of the first. When
investigating why the curator stopped, compare the sizes of the recent logs before
anything else.
**Where it lives in brain-kit.** `src/guards/dirty-tree.mjs` (exit 75, file list
with modification times, notify), `src/guards/watermark.mjs`, `brain-kit schedule`
with daytime windows, `brain-kit doctor` checks `notify` and `last-run`,
[scheduling.md](scheduling.md) ("compare the sizes of the recent logs first"),
`test/incidents/2026-09-13-dirty-tree-silent.test.mjs` (Phase 2).

### 29/07/2026: the exit code came from a date substitution
**What happened.** On the same first production run, the log reported exit 0 even
when the round failed, because `$?` was read after a `$(date)` command substitution
that had already reset it.
**Rule.** Capture the return code immediately after the call, before any command
substitution. A failure that announces itself as a success is worse than the
failure.
**Where it lives in brain-kit.** `src/harness/claude-code.mjs` (the exit code is the
child's own, read from its `close` event and from nowhere else), `src/commands/curate.mjs`
(the exit mapping of step 16, where a timed out run is never 0),
`test/incidents/2026-07-29-exit-code.test.mjs` (Phase 2).

### 11/08/2026: the self-trace filter ate the day's work
**What happened.** The scheduled curator discarded transcripts that contained its
own prompt signature anywhere in the file. A human session that had merely opened
the prompt file was discarded as if it were the curator, and the three working
sessions of the previous day disappeared; the night looked calm.
**Rule.** Recognize your own runs only by the first user message, extracted with a
JSON parser. When in doubt, the transcript stays in: including too much costs
context, discarding too much costs the day. Every scheduled actor that produces
transcripts needs a signature known to the filter, and each signature needs a test.
**Where it lives in brain-kit.** `src/sources/transcripts-claude-code.mjs` (the
self-trace filter: the first user message with text, parsed as JSON, starting with
`curate.signature`, `briefing.signature` or one of `curate.extra_signatures`),
`test/incidents/2026-08-11-self-trace-filter.test.mjs` (Phase 2). The morning briefing's
desktop task is the second scheduled actor: its prompt starts with `briefing.signature`,
which the filter always counts, whatever `curate.extra_signatures` lists, so what that
briefing records it proposes itself and the curator never reads it again. A briefing the
person asks for in their own session starts with their own message and stays in, by the
same rule: in doubt, include; the cost is a capture the next round may propose a second
time, visible in the pull request's diff. `schedule status --job briefing` and `doctor`
judge the task signed with the filter's own predicate, and refuse a signature that is
blank, more than one line or padded with spaces, which could sign nothing
([briefing.md](briefing.md)); `test/incidents/2026-09-25-briefing-self-trace.test.mjs`
(Phase 4). Not measured yet: whether the desktop application hands the task's prompt to the session
as its first user message, unchanged. The curator drops the task's session only if it
does. If the application wraps the prompt (a skill invocation line, a header), the session
is read like one of your own: the cost is the one of a briefing you ask for yourself (a
capture the next round may propose again, visible in its diff, nothing lost), and only
when the task's working directory is a project listed in
`sources.transcripts.include_projects`. After the first scheduled run, `brain-kit curate
--dry` shows the transcripts plan and how many sessions it left out as the kit's own.

### 11/08/2026: the cap threw away exactly the work of the day
**What happened.** The cap on how many transcripts to read sorted candidates by
path. The locale ignored punctuation, unrelated projects sorted first alphabetically,
and the transcripts from the vault itself, which are the actual work of the day, were
the first to be cut (PR #30).
**Rule.** Never sort candidates by name. The original fix sorted by recency, newest
first, and let the oldest fall off; in brain-kit that turned out wrong too (final review
of phase 2, 24/09/2026): a round catching up reads the oldest open days first and closes
every day it reads, so the sessions the cap cut were exactly the oldest days', and those
days were closed with none of their sessions read. The cap now takes whole days, oldest
first, while the distinct transcripts of the days taken stay within the cap (a
transcript belongs to every day, in the vault's time zone, that one of its messages falls
on). The days that do not fit wait for the next round, which the round says on its
output, in the log and in `last-run.json`; the window it curates, and the mark it
advances, end at the last day it took whole. When the first open day alone holds more
transcripts than the cap, the round does not start the model: exit 4, naming the setting,
the day and the counts. Within what is offered, the list runs newest first by the last
message inside the window, never by modification time (24/09/2026 entry below).
**Where it lives in brain-kit.** `src/sources/transcripts-claude-code.mjs` (the cap,
`curate.caps.transcripts`: `daysCovered`, `daysDeferred`, `overCap`, and `dropped.byCap`
in the log), `src/commands/curate.mjs` (the narrowed window, `deferredDays` and the
`cap_exceeded` refusal), `test/incidents/2026-08-11-recency-cap.test.mjs`,
`test/curate.test.mjs` (Phase 2).

### 24/09/2026: selection by modification time turned an old session into a new fact
**What happened.** The curator picked the transcripts of its window by their file
modification time. A session file touched again weeks after its last message was
selected as if it belonged to the day, and the round wrote its content up as new
fact. It happened twice before anyone noticed that the "new" material was weeks old.
**Rule.** Select a transcript by the timestamps of the messages inside the window,
never by when the file was last written. Modification time is only a cheap
pre-filter: a file last modified before the window opened, with a margin for a
clock that disagrees, is not opened, and is counted as not opened rather than as
holding no message in the window. The transcripts a round offers are listed by the last
message inside the window for the same reason, which replaces the modification time
order of the 11/08/2026 entry above.
**Where it lives in brain-kit.** `src/sources/transcripts-claude-code.mjs`,
`test/incidents/2026-09-24-mtime-selection.test.mjs` (Phase 2).

### 11/08/2026: the round fired in the same second the machine woke up
**What happened.** A midnight schedule with catch up enabled fired the round at the
exact moment the laptop resumed: the process started at 07:52:19 and the network only
reached a connected state at 07:52:24. The remote connectors therefore returned
nothing, and calendar and document sources vanished without an error.
**Rule.** Before blaming the connector, compare in the system journal the time the
network came up with the time the process started. The wait for the network has to
happen inside the round.
**Where it lives in brain-kit.** `src/guards/network.mjs` (timed wait inside
`curate`, right after the lock and before sync), `brain-kit doctor` (Phase 2 and
Phase 3).

### 29/08/2026: the network guard returned in 0.02 seconds and waited for nothing
**What happened.** For three nights the network guard called a network manager check
that waits for the manager to initialise, not for connectivity. It returned in 0.02
seconds with exit 0, while the connected state actually arrived 4 to 5 seconds after
the service started (fixed in PR #67).
**Rule.** Wait for the connection, not for the manager's initialisation. Before
believing a network guard protects anything, time it during a resume: a guard that
comes back instantly waited for nothing.
**Where it lives in brain-kit.** `src/guards/network.mjs` (a return under 100
milliseconds is reported as "the guard did not wait"),
`test/incidents/2026-08-29-network-wait.test.mjs` (Phase 2).

### 28/08/2026: a scheduler directive copied from the wrong scope was dead letter
**What happened.** Dependency directives on a network target were added to the
service unit (PR #63) and the blindness continued for three more nights. On
16/09/2026 the cause appeared: that target does not exist in the user scope, so the
directives were inert.
**Rule.** A scheduler directive copied from a system scope example can be dead
letter in the user scope. Check with the scheduler's own listing before debugging
why the guard does not work. The network wait is an explicit step in the engine, and
the test fails if the inert line comes back.
**Where it lives in brain-kit.** `brain-kit schedule install` (units with no network
target dependency, because the wait lives in the engine),
`test/incidents/2026-08-28-user-scope-target.test.mjs` (Phase 2).

### 14/09/2026: the base update ran before the network was up
**What happened.** On 14, 15 and 16/09/2026 the pre-start step that updates the
vault died with "Could not resolve hostname", because the round had been triggered at
resume. Curation then ran from a stale base, and nobody noticed.
**Rule.** The network wait comes before the base update, and the test asserts the
order of the steps.
**Where it lives in brain-kit.** `brain-kit curate` (fixed, tested order: machine
file, lock, network, sync, config), `test/incidents/2026-09-14-order-network-sync.test.mjs`
(Phase 2).

### Undated: updating the base from inside the round rewrites the running script
**What happened.** A checkout performed from inside the round would swap the file
the shell is still reading, mid execution. No incident date: the hazard was caught
in design, which is why the base update was moved into the pre-start step.
**Rule.** Whatever takes the vault to an updated base runs before the interpreter
opens the script; the round itself only records which base it started from.
**Where it lives in brain-kit.** `brain-kit curate` (`sync` before reading config and
prompt), `brain-kit sync` (Phase 2).

### 27/08/2026: a global reinstall moved the binary and the round died in 3 seconds
**What happened.** At 08:59 on 27/08/2026 a global package reinstall moved the CLI
from one binary directory to another. The next day's round died with exit 127 after
3 seconds, and the service manager reported success.
**Rule.** The scheduler unit's `PATH` lists both possible directories for the binary,
so the routine survives the next migration.
**Where it lives in brain-kit.** `brain-kit schedule install` (`path_extra` in the
machine file, then the directory of `claude_bin`, on the unit's `PATH`), `brain-kit
doctor` checks `claude-present` and `claude-real`,
`test/incidents/2026-08-27-binary-moved.test.mjs` (Phase 2).

### 21/08/2026: an expired token, six seconds, and a green service
**What happened.** The round died with an authentication error 6 seconds after
starting. The service manager showed 8 seconds of duration, about 700 MB of peak
memory and a successful status, because the exit code being propagated belonged to
the redirection block rather than to the process.
**Rule.** Propagate the exit code of the real process, never the wrapper's. A green
service lasting seconds, with a peak around 700 MB, is a dead round: read the log and
look for the failure marker before believing the status.
**Where it lives in brain-kit.** `src/harness/claude-code.mjs` (the real process's
exit code), `src/commands/curate.mjs` (an API or login error is exit 69, never 0),
`last-run.json` with duration, turns and cost, `brain-kit doctor` check `last-run` (a
round that exits 0 in under 20 seconds without a model turn is reported as dead),
`test/incidents/2026-08-21-expired-token.test.mjs` (Phase 2).

### 14/09/2026: the CLI binary was a 500 byte stub for two days
**What happened.** At 15:49 on 14/09/2026 a reinstall did not run its post install
step, so the native binary was never fetched and the CLI was dead. The round at 09:32
on 16/09 aborted with "native binary not installed"; the next one, three minutes
later, completed only because the high water mark had not advanced.
**Rule.** The dependency on the CLI goes beyond `PATH`: the native binary has to be
installed. Fingerprint: a launcher of about 500 bytes is a stub, about 213 MB is the
real thing, and `--version` returns error text instead of a number. It can be fixed
offline by running the package's own install script.
**Where it lives in brain-kit.** `src/guards/cli.mjs`, `brain-kit doctor` check
`claude-real`, `test/incidents/2026-09-14-cli-stub.test.mjs` (Phase 2).

### 15/09/2026: fixing one failure mode revealed the next
**What happened.** On 15 and 16/09/2026 the rounds aborted on the dirty tree guard
before ever calling the model, so the CLI breakage from 14/09 stayed invisible until
the first round that got past the guard.
**Rule.** Failure modes stack, and fixing the top one reveals the one underneath.
After fixing a cause, run once end to end and read the log to the final line before
declaring the routine healthy.
**Where it lives in brain-kit.** `brain-kit doctor` (all checks in one pass, named
after their incidents), `brain-kit curate --check` (Phase 2).

### 14/09/2026: the nightly routine never ran at night
**What happened.** The routine scheduled for midnight with catch up enabled never
fired at midnight. It fired at resume: 08:46 on 14/09, 08:36 on 15/09 and 07:13 on
16/09/2026, always before the wireless connection was up. It was eventually moved to
09:30 (PR #88), while the files kept the word "nightly" in their names.
**Rule.** Schedule the routine in the window when the machine is actually on and
connected, never overnight with catch up. And the routine's name should say what it
does, not what time it used to run.
**Where it lives in brain-kit.** `brain-kit schedule install` (daytime windows, names
by function), [scheduling.md](scheduling.md),
`test/incidents/2026-09-14-nightly-never-ran.test.mjs` (Phase 2).

### 17/09/2026: the high water mark, and why it lags by one day on purpose
**What happened.** A machine suspended for several days only gets one catch up fire
at resume, so the days in between would be lost in silence. The mark holds the last
target day swept (yesterday), and on 17/09/2026 it read 2026-09-16 with that day's
pull request already merged, which is the expected state and not a missing round.
**Rule.** The high water mark holds the last target day swept and reopens the window
from there. It advances only on exit 0, so a round that dies halfway leaves the day
open. A mark at D-1 with today's pull request merged is expected behaviour.
**Where it lives in brain-kit.** `src/guards/watermark.mjs`,
`brain-kit watermark show|set|reopen|assume-covered`, `brain-kit doctor` check
`watermark` (Phase 2). `brain-kit watermark import --from <file>` (Phase 5a) carries the
original vault's own mark over: the one day its file holds becomes the last day swept of
every enabled source, or of the ones `--sources` names ([scheduling.md](scheduling.md)).

### 20/08/2026: the round closed a day it had never read
**What happened.** The round recorded that the connectors had not come up, declared
"no curation today" with its first two stages not executed, exited 0 and wrote the
previous day into the high water mark. That day's calendar never reopens through the
window. Still open as a gap in the original vault.
**Rule.** The condition for advancing the mark cannot be the agent's exit code alone.
A round that did not read its sources may not close the day as swept.
**Where it lives in brain-kit.** `src/guards/read-evidence.mjs` (counts tool results
per source), per source high water marks that advance only with exit 0 plus evidence
plus a report, `BRAIN_KIT_SOURCES` final line,
`test/incidents/2026-08-20-watermark-without-sources.test.mjs` (Phase 2); the calendar's
own evidence, a listing that covers the whole window with every page
(`src/sources/calendar-google.mjs`), and a window per source, so a source advances only
through the days it read (`src/commands/curate.mjs`),
`test/incidents/2026-08-20-calendar-partial-read.test.mjs` (Phase 3).

### Undated: the acceptance criterion demanded facts no round could produce
**What happened.** The first run of the external sources landed on a Sunday with zero
events, which exposed that the acceptance criterion required four facts that no round
would ever produce on any day. They had come from a manual sweep done while the
specification was being written. No date is recorded for the criterion itself.
**Rule.** An acceptance criterion measures what the system can produce inside its own
window. A day with no events ending in "no curation today" is a pass, not a failure.
**Where it lives in brain-kit.** `src/guards/empty-window.mjs` (Phase 2).

### Undated: a test suite that would have burned a real round
**What happened.** The scheduler's tests run the round end to end with collaborators
injected through environment variables. If the script ever stopped honouring one of
them, the tests would call the real model, write to the real log and consume a real
round. The hazard was found while writing the tests, so it carries no incident date.
**Rule.** Before any test case, assert the precondition: grep the environment
variables in the target script, and if one is missing, fail right there and execute
nothing else.
**Where it lives in brain-kit.** `test/` harness preconditions for `curate`
(Phase 2).

### 24/09/2026: a headless run inherited the person's own settings
**What happened.** While the kit's scheduled curator was being designed, a spike ran the
model headless with an allowlist and a denylist on the command line and measured what it
did. A plain headless run loaded the person's own Claude Code settings: their permission
mode (`auto`, which approves actions on its own), their hooks, their allow rules and every
MCP server they had configured. Under that, a command in the denylist ran, and so did one
in neither list, with exit 0 and no denial reported. Turning off permission prompts did not
help. Denying everything no rule allows (`dontAsk`) was still bypassed: a hook of the
person's rewrote a command before it ran, and an allow rule of theirs permitted the
rewritten form, so a denied command ran anyway. Loading only the project's settings still
ran a hook from the project's own settings file, in a folder never trusted, and every
vault the kit creates carries such a file enabling the kit's plugin.
**Rule.** An unattended model runs with no settings file loaded at all and no MCP server
but the ones passed, denying everything its own rules do not allow, leaving no session
transcript of its own, and the run proves it: the permission mode, hooks and servers the CLI reports in its first event are checked
before the model does any work, and a mismatch stops it. What held was `--setting-sources
''` (the empty string), `--strict-mcp-config`, `--permission-mode dontAsk` and
`--permission-prompts none`, together; the login keeps working, because it is not a
settings file. Every round adds `--no-session-persistence`, so it writes no transcript of
its own, which also keeps its runs out of the transcripts the next round reads.
**Where it lives in brain-kit.** `src/harness/claude-code.mjs` (the flags on every
round), `src/guards/isolation.mjs` (the check of the first event), `brain-kit doctor`
check `claude-isolation-flags`, [security.md](security.md),
`test/incidents/2026-09-24-inherited-settings.test.mjs` (Phase 2); the pinned built-in
tools, no skills and reads scoped to the vault and the listed transcripts,
`test/incidents/2026-09-24-unscoped-round.test.mjs`, and connector mode, which loads the
person's user settings on purpose and mirrors every allow rule in them as a deny
(`src/curate/user-rules.mjs`), `test/incidents/2026-09-24-user-rules-in-connector-mode.test.mjs`
(Phase 3).

## Connectors

### 10/08/2026: a document was declared empty without being opened
**What happened.** A check reported meeting minutes as empty before the meetings had
even happened. The next day a round cited that report, declared a set of minutes
empty without opening it, and two full documents (one with 18 debate items and 6
assigned tasks, another with 7 tasks) were nearly discarded as noise (fixed in
PR #32 and PR #33).
**Rule.** Empty, does not exist and no record are verification results, and a
verification has a timestamp. Never attest to the state of a document that was not
opened in this round. The reliable link between a meeting and its minutes is the
event's attachment with a file URL, never the title.
**Where it lives in brain-kit.** Closed uncertainty vocabulary in the curate prompt
(Phase 2); the meeting-notes source, `src/sources/meeting-notes-google-drive.mjs`, whose
prompt block says never to call a document empty or missing unless it was opened in this
round and to reach a meeting's notes through the event's attachment, and which counts the
documents opened (`documents` in `last-run.json`),
`test/incidents/2026-08-11-meeting-notes-two-doors.test.mjs` (Phase 3).

### 11/08/2026: half the meeting notes were invisible
**What happened.** Only one door existed: searching the document store by title
prefix. Manually written minutes have free form titles, so they were invisible, and
two internal meetings went by unrecorded with the pointer to their minutes sitting in
the curator's own hands.
**Rule.** Two doors for meeting notes: a title search for the automatically generated
ones and the event's own attachments for the manual ones. Deduplicate by the literal
document title recorded in the log, with the stated limit that this only works
between nights where capture actually happened.
**Where it lives in brain-kit.** `src/sources/meeting-notes-google-drive.mjs` (two
doors: the literal title search and the documents attached to the calendar's events;
deduplicated by the literal title in the log), [connectors.md](connectors.md),
`test/incidents/2026-08-11-meeting-notes-two-doors.test.mjs` (Phase 3).

### 11/08/2026: a meeting note entered the log as a link and nothing else
**What happened.** Meeting notes were recorded in the log as a title plus a link,
with none of the content (fixed in PR #35). Recording the link is not keeping the
content: the source is live and can change or lose its permissions.
**Rule.** A meeting note is a first class source, with the same weight as a
transcript. Every note in the window produces a distillation in the log. Promotion to
a note stays selective; distillation does not.
**Where it lives in brain-kit.** The curate prompt's rule `notes-first-class` (every
note in the window distilled into the log under its literal title) and the meeting-notes
source's prompt block, `src/sources/meeting-notes-google-drive.mjs` (Phase 3).

### 11/08/2026: a squad's daily stand-up was invisible to the vault
**What happened.** Only the owner's own calendar was in scope, so a squad's daily
stand up, which the owner does not attend, never reached the vault at all.
**Rule.** Team calendars are in scope, and there the value is precisely what the
owner does not see. An event that already has the owner among its attendees is
skipped, and deduplication is by event id.
**Where it lives in brain-kit.** `src/sources/calendar-google.mjs` (other people's
calendars in `sources.calendar.team_calendars`, read only with
`team_calendars_consent_noted: true`; events that already include the owner skipped;
deduplicated by event id), `brain-kit doctor` check `connectors` (calendars listed
without the recorded consent), `test/incidents/2026-08-11-other-calendars-consent.test.mjs`
(Phase 3).

### 21/08/2026: thirteen of sixteen attachments came back "not found"
**What happened.** Of 16 minutes attached to the previous day's events, 13 returned
"Requested entity was not found". Permission to see a calendar does not extend to the
documents attached to its events. The count was itself corrected from 11 to 13 the
next day.
**Rule.** An attachment that does not open for permission reasons is reported as "no
access (document store permission)", never as empty and never as a connector failure,
and the list goes into the answer so the human can decide whether to request access.
**Where it lives in brain-kit.** Closed label set in the curate prompt (Phase 2), its
rule `no-access-label`, and the meeting-notes source's prompt block, which gives the exact
reason, `src/sources/meeting-notes-google-drive.mjs` (Phase 3).

### Undated: the document search is accent sensitive and fails silently
**What happened.** The search string for the automatically generated meeting notes
contains an accented word. Without the accent the query returns an empty result set
and no error at all; with the accent it returns results. No incident date: it was
found while calibrating the source.
**Rule.** Copy the accented search string literally, and treat silent source failure
as a risk class of its own. A wrong query does not raise an error, it produces a
quiet night.
**Where it lives in brain-kit.** `src/sources/meeting-notes-google-drive.mjs` (the
literal `search_title_contains`, given to the model exactly; a search without it, or with
it reworded, is not a read), [connectors.md](connectors.md) (copy the title from one of
your own documents, accents included), `test/incidents/undated-accent-sensitive-search.test.mjs`
(Phase 3).

### 03/09/2026: the search found nothing because the event is named after two people
**What happened.** Searching for a mentor's surname returned nothing, because the
recurring event is titled with the two participants' first names instead. The minutes
attached to the event were an empty template dated more than a year earlier, the
actual 55 minute transcript was on the document's second tab, and the automatic
speaker separation kept swapping two colleagues whose names differ by one letter.
**Rule.** Search by the literal event title, read the whole document rather than just
the summary, and treat a speaker separation error as a divergence to confirm, never
as a fact.
**Where it lives in brain-kit.** The meeting-notes source's prompt block,
`src/sources/meeting-notes-google-drive.mjs` (the attachment, never a person's name or a
paraphrase of the event's title, links a meeting to its notes; the whole document and
every tab; a speaker attribution is a divergence to confirm), the divergence table required
by the curate prompt, and the skill `seed-rituals`, which keeps the literal event title
(`skills/seed-rituals/SKILL.md`) (Phase 3).

### Undated: the deduplication key had to be the escaped literal title
**What happened.** Matching recurring meetings by the note they feed would have
merged three different rituals into one item. Without quoting, one ritual's title
matched a longer title that contained it. Parsing the table and unescaping made the
search fail against the very line the curator had written, so the same pending item
was duplicated every night. No single date: these were three variations found while
calibrating the ritual table.
**Rule.** The deduplication key is the literal ritual title, in straight quotes and
with the vertical bar escaped, searched in the raw text. Unescape only to compare
against the calendar; keep it escaped to write and to match in a markdown table. The
column names are an interface between the prompt and the note.
**Where it lives in brain-kit.** `taxonomy` column contract in the config,
`brain-kit lint` rule `columns`, and the skill `seed-rituals`
(`skills/seed-rituals/SKILL.md`, its body in `lang/<code>/skills/seed-rituals.md`), which
writes the title in straight quotes with the bar escaped and compares that key as exact
text, never as a regular expression (Phase 3).

### Undated: a wrong allowlist burned every turn on workarounds
**What happened.** A misconfigured tool allowlist made the agent spend all of its
turns trying to work around the missing tools through the shell, and it died without
producing anything. The failure was found while calibrating the run, so no incident
date is recorded.
**Rule.** External source stages are best effort: record the failure, skip that stage
only and carry on, with shell workarounds forbidden in the prompt. A round without
the calendar is still a valid round.
**Where it lives in brain-kit.** `curate.sources.required` and `best_effort` in the
config (a best-effort source never changes a round's exit code), the curate prompt's rule
`no-workaround`, the relaunch without a source the first launch showed unavailable
(`src/commands/curate.mjs`), `src/guards/read-evidence.mjs`,
`test/incidents/undated-wrong-allowlist-workarounds.test.mjs` (Phase 3).

### 10/08/2026: three debugging iterations on the wrong thing
**What happened.** Three iterations were spent debugging the wrong layer. The tool
name the CLI exposes is built from the server's display name, not from the identifier
the desktop application uses, and without the deferred tool search tool in the
allowlist the agent never loads the schemas in the first place. The signature of a
wrong allowlist is the agent saying it is waiting for permission.
**Rule.** Check the MCP tool names with the CLI's own listing before writing the
allowlist, include the tool search tool, and forbid workarounds in the prompt.
**Where it lives in brain-kit.** `src/guards/connectors.mjs` (each connector's state
from the round's own first event, in place of a parser of the CLI's listing, which phase 3
dropped), the allowlist per kit subcommand plus each source's read tools and ToolSearch
(`src/curate/tools.mjs`, each source's `toolRules`), `brain-kit doctor` check
`connectors` naming the prefix the tools were seen under against the configured one,
[connectors.md](connectors.md) (Phase 3).

### Undated: a smoke test on a cheap model invented a connector problem
**What happened.** A smoke test run on a small, fast model made seven calls to the
tool search with the same query, never invoked the calendar listing once, and then
confabulated that it needed to authenticate. It looked exactly like a connector
outage. No date recorded: this was a test run, not a production round.
**Rule.** Test the environment on the same model tier as production, with a window of
guaranteed data and a mechanical assertion (exit code plus grep), never by reading the
text the model chose to write.
**Where it lives in brain-kit.** `brain-kit curate --check`, `src/guards/read-evidence.mjs`
and each connector source's evidence (`src/sources/calendar-google.mjs`,
`src/sources/meeting-notes-google-drive.mjs`) as the mechanical assertion, and the opt-in
end-to-end round `test/e2e-connectors.test.mjs`, which asserts on the round's record,
never on the model's text (Phase 3).

### 05/09/2026: connected, online, and the tools were not there
**What happened.** For four consecutive nights, from 05/09 to 08/09/2026, the CLI
listed the connectors as Connected while the tool search returned no matching tools.
On 09/09 the same script, rerun by hand from the desktop application, opened a pull
request in 13 minutes, which isolated the cause in the scheduler's environment rather
than in the connectors.
**Rule.** If the connector says connected and the network is up, it is the
invocation's configuration, not an outage and not authentication. Compare the
environment of the two invocations before touching the allowlist.
**Where it lives in brain-kit.** `src/guards/connectors.mjs` (`tools_missing`:
connected, but the tools the source needs are not in the session, with the prefix they
were seen under), `brain-kit doctor` check `connectors` and `brain-kit doctor --probe`,
which asks the round's own launch mode rather than another invocation,
[connectors.md](connectors.md), `test/incidents/2026-09-05-connected-without-tools.test.mjs`
(Phase 3).

### 14/09/2026: disabled is a state, and nobody reports it
**What happened.** The session connector status returned the calendar and document
connectors as disabled, not failed and not needing authentication. The tools simply
did not exist for that session, and nothing anywhere said so. This is a distinct
finding from the blind nights earlier that month.
**Rule.** Disabled is a state, not an error, and nobody reports it. Check the
connector's literal status before investigating authentication, network or allowlist.
The switch becomes the default for new sessions.
**Where it lives in brain-kit.** `src/guards/connectors.mjs` (seven states, the exact
display name, a status it does not know stays `unknown`; a connector disabled for Claude
Code is `absent`), the state-change notification and the session's status line
(`src/commands/curate.mjs`, `src/hooks/session-start.mjs`), `brain-kit doctor` check
`connectors`, [connectors.md](connectors.md),
`test/incidents/2026-09-14-connector-disabled.test.mjs` (Phase 3).

## The Stop hook and the session

### Undated: the hook billed the interactive session for a scheduled round's work
**What happened.** The session Stop hook saw a dirty working tree and demanded the
curation loop from the interactive session, when in fact a scheduled round was
editing the vault at that very moment. No incident date is recorded; the conflict was
found while wiring the three actors together.
**Rule.** An exclusive lock on a file descriptor held by the whole process, with the
Stop hook reading the same path and testing the lock without holding it. That path is
a contract between three processes and must come from a single environment variable.
**Where it lives in brain-kit.** `src/guards/lock.mjs`, `brain-kit hook stop`, lock
path in the machine file (Phase 1 and Phase 2).

### 14/09/2026: the hook blocked an unrelated scheduled task
**What happened.** A scheduled task about something else entirely (maintenance of a
local shell hook that rewrites command output) was blocked by the Stop hook, because
of dirt left behind by an earlier session in the same repository. The false positive
was accepted at the time, since the hook had worked as a safety net, but as a plugin
level hook in user scope it would demand curation in every dirty repository on the
machine.
**Rule.** Before assuming authorship of the dirt, look at each file's modification
time and mark the inherited ones. A hook installed at user scope needs a vault
sentinel, otherwise it holds every unrelated repository hostage.
**Where it lives in brain-kit.** `src/vault.mjs` (the vault sentinel), `brain-kit hook
stop` (fail open before the sentinel, fail closed after; inherited files marked),
`test/hook-stop.test.mjs` (rung 3: a dirty repository that is not a vault releases
silently) (Phase 1).

### Undated: the safety net depended on a tool it never checked for
**What happened.** The Stop hook called a JSON command line tool in three places
without ever checking that it existed, falling back to a silent success. The
companion scanner, by contrast, aborts explicitly when the tool is missing. Found by
reading the code, so no incident date.
**Rule.** A hook that is a safety net may not depend on a tool without a guard. If the
dependency is missing, the hook says so; it does not disappear quietly.
**Where it lives in brain-kit.** `brain-kit hook stop` rewritten in Node, with no
external command line dependency (Phase 1).

## Output folders and orphaned deliverables

### 12/09/2026: finished deliverables sat in a folder nobody watched
**What happened.** On 12/09/2026, discovered on 14/09, a complete piece of work (a
full job description for a senior role) sat in the session output folder for two
nights with nothing capturing it. It happened again on 15/09 with three files from an
internal workshop. On 16/09 adding the folder to the ignore file was not enough: the
validator walks the file system rather than the index, so it kept failing those files
for missing fields, and because the proposal command validates before proposing, no
pull request was born at all. Fourth occurrence of the same failure mode.
**Rule.** A session output folder is not vault content: it stays out of git and out of
validation at the same time, because the validator walks the file system and not the
index. The trade off, that material can disappear silently with only the Stop hook as
a net, is written down rather than assumed.
**Where it lives in brain-kit.** `validate.ignore_paths` (additive) in config,
generated `.gitignore`, `brain-kit hook stop`, `test/vault.test.mjs` (the walk skips
every prefix in `validate.ignore_paths`) (Phase 1).

### 10/08/2026: two orphaned notes survived three weeks as a second version of the truth
**What happened.** After a refactor on 22/07/2026 two notes were left unreferenced,
holding a second version of the same facts. They survived for three weeks and the
validator never said a word, because it only checks that existing links point
somewhere valid, never that a note is reachable.
**Rule.** Every note outside the raw memory folder must be reachable by at least one
link. Until that check exists, orphanhood depends on human auditing, which is exactly
how it survived for three weeks.
**Where it lives in brain-kit.** `brain-kit lint` rule `orphans` (Phase 1).

### Undated: a copy of the vault would have become a second graph
**What happened.** A working copy of the vault inside a hidden directory would appear
in the graph viewer as a whole duplicate graph, because file relative links resolve
inside the copy. That directory holds 192 parked markdown files, and the session
output folder was ignored by the validator but not by the viewer. No date: a
divergence found by comparing the two tools.
**Rule.** The graph generator and the validator both skip dotted directories, and link
resolution is mirrored in the engine and in the browser so the two never diverge. The
list of ignored content folders must be one list, shared by both tools.
**Where it lives in brain-kit.** Shared walk rules between `brain-kit validate` and
`brain-kit visualize`, `ignore_paths` in config (Phase 1).

## Prompts, policy and evidence

### 29/07/2026: the prompt's own frontmatter was read as a command line flag
**What happened.** On the first production run the prompt was passed as an argument.
The frontmatter's leading marker was read by the flag parser as an unknown option and
the round died after 1 second (PR #11, fixed in PR #12).
**Rule.** The prompt goes in through standard input, with the frontmatter stripped
first. Frontmatter is vault metadata, not an instruction. Keeping the prompt as a
vault document is a deliberate choice with a cost: packaging it outside the vault
would take it off the ruler.
**Where it lives in brain-kit.** `brain-kit prompt <name>` and `curate` passing the
rendered prompt on standard input, `prompt --check` (Phase 2).

### Undated: the output filter swallowed the failures it was meant to show
**What happened.** The briefing's preflight filtered the validator's output with a
range expression that swallowed the pass or fail verdict and the broken link list
along with the noise. It was caught in an adversarial review of the prompt, not in
production, so no incident date exists.
**Rule.** An output filter in a scheduled prompt is tested against the real output,
never against the expected one.
**Where it lives in brain-kit.** `brain-kit preflight --json` (structured output
instead of text filtering) (Phase 4).

### Undated: the same known violation would be reported every single week
**What happened.** A violation already recorded as a known exception would have
appeared, in the same sentence, in every Monday report. Weekly noise trains the reader
to ignore the report. Found while designing the briefing.
**Rule.** A violation already declared as a known exception is only mentioned when it
changes.
**Where it lives in brain-kit.** Briefing prompt rules and `brain-kit preflight`
deduplication with counters (Phase 4).

### Undated: five rounds of adversarial review on one prompt
**What happened.** The curator's prompt went through five rounds of adversarial
correction, and the briefing's through two, the second of which died on a session
limit. Each of those rounds removed a real bug that looked, in the text, like an
excess of caution.
**Rule.** Before touching the curator, read the whole prompt: every sentence that
looks paranoid is paying for a real bug. Documenting the paranoia with its incident
next to it is what stops someone from tidying the prompt and reintroducing the bug.
**Where it lives in brain-kit.** This file, the dated comments in `src/guards/`, and
`brain-kit prompt --check` for the markers (Phase 2).

### Undated: copying the calendar into git would have blown the corpus ceiling
**What happened.** When calendars were added as a source, the tempting move was to
copy events into the vault. The calendar is already an append only, queryable log, and
replicating it would push the corpus against the 50 to 100 thousand token ceiling that
defines the architecture. Design decision, no incident date.
**Rule.** A live source is read, not copied. The vault keeps the meaning (a map
translating an event title into the note it feeds), never the event.
**Where it lives in brain-kit.** `src/sources/` interface (read on demand), the ritual
map in the generated vault, skill `seed-rituals` (Phase 3).

### 22/07/2026: two sources of truth, again
**What happened.** When the assistant gained its own persistent memory, the vault was
about to acquire a second source of truth, which is the exact problem the giant XML
block had. The policy was written the same day.
**Rule.** The vault is primary memory and the assistant's internal memory is a cache.
Saving to memory implies recording in the vault; in a conflict the vault wins. No
bidirectional sync.
**Where it lives in brain-kit.** The generated vault's agent contract and the
`curate-session` skill (Phase 1).

### 21/08/2026: a durable preference was stated in a different project's session
**What happened.** In a session about another project entirely, the owner instructed
the agent to always use a particular development mode, in that project and in every
other one. Meanwhile ten memories holding the scanner's failure modes lived only on
the machine, outside the repository, which is why extracting them was a task of its
own.
**Rule.** A durable preference about how the agent works lives in the agent's memory,
not in the vault's log, because it is not a fact about the second brain. But a lesson
about the engineering of the system itself has to come back into the repository,
otherwise it stays on one machine.
**Where it lives in brain-kit.** This file and [rationale.md](rationale.md), which are
that distillation (Phase 0).

### 02/09/2026: a saving that was only ever an estimate
**What happened.** A cloud cost saving of about US$ 735 per month, reported on
03/08/2026, was an estimate and never showed up on an invoice. The real series went
from R$ 10,934.03 in May to R$ 21,787.63 in September 2026, a rise of 99.3% in four
months.
**Rule.** A number without an origin and a date is not a number. When recording a
metric, mark whether it is an estimate or an actual.
**Where it lives in brain-kit.** Provenance fields required by `brain-kit validate`,
metric rules in the curate prompt (Phase 1 and Phase 2).

### 28/08/2026: the house voice was wrong for the audience
**What happened.** While reviewing material that would go to a customer, the owner
defined customer facing writing as modern but enterprise in tone, which contradicted
the single brand voice recorded in the vault. The same review found a legal term used
incorrectly: under the applicable data protection law the correct instrument was an
authorization, not a consent.
**Rule.** Two registers for two audiences is not a contradiction. Use the correct
technical term, and rewrite the wording, never the author's content.
**Where it lives in brain-kit.** Language packs with a voice per audience, skill
`curate-session` (Phase 1).

### 28/08/2026: eighty nine of ninety one notes were placeholders
**What happened.** Of 91 book notes, 89 held nothing but a placeholder, because they
had been created by a bulk migration rather than by reading. The two rich ones were
the two that had turned into working tools. The passive capture channel had fired
exactly once in a month.
**Rule.** The format had proved its value; what was missing was a capture process with
minimal friction. The trigger comes from the event, never from the calendar, and there
is no catch up campaign over the old archive.
**Where it lives in brain-kit.** Skill `capture` (one line in the log), event triggered
loop, `brain-kit lint` rule `orphans` (Phase 1; the book debrief skill is Phase 7).

### 28/08/2026: the reading workflow was designed against the research
**What happened.** The debrief design started from the evidence on study techniques
(Dunlosky et al., 2013), which finds summarising, rereading and highlighting to be of
low efficacy. Importing highlights from a read later tool was left out for that
reason.
**Rule.** Three strong techniques in the debrief script (recall from memory, explain
why it is true, connect it to what is already known), in the human's words and never
the model's. The metric that matters is a note cited in a decision, not books per
month.
**Where it lives in brain-kit.** Skill `debrief` (Phase 7, with the 28/08/2026
specification as its source).

### 22/07/2026: the gate that never gated
**What happened.** The parent decision said the loop should be reviewed before
investing in the next phase. That next phase was assembled on 22/07/2026, the same day
the decision was made. The gate never operated as a gate.
**Rule.** Pre commitment: checkpoints and give up criteria are decided with a cool
head, before execution. Every decision in the vault is born with a give up criterion.
**Where it lives in brain-kit.** Decision template generated by `brain-kit init` (give
up criterion as a required field) (Phase 1).

## Privacy

### Undated: reading a transcript whole blew the context before the work started
**What happened.** Each session transcript is tens of kilobytes and the window brings
in up to 20 of them. Reading them in full exhausted the context before the round
reached its third stage. The rule was set during prompt calibration, so it carries no
incident date.
**Rule.** A large transcript is sampled from the end and then in slices, never read
whole. Video recordings and full transcriptions are never downloaded. Cost and privacy
are rules in the prompt, not left to the model's good sense.
**Where it lives in brain-kit.** `src/sources/transcripts-claude-code.mjs` (the plan
gives each transcript's size and the line to start reading from, near its end, and caps
how many are offered), the curate prompt, `--max-turns` and `--max-budget-usd` on every
round unless the owner sets `curate.max_turns` or `curate.budget_usd` to null for no cap
(Phase 2; null since Phase 5a); for meeting
notes, the source's prompt block, which checks an attached document's metadata first and
never opens a recording or a full transcription
(`src/sources/meeting-notes-google-drive.mjs`) (Phase 3).

### Undated: a colleague's medical appointment was in the calendar window
**What happened.** While calibrating the prompt against real calendar data, a
teleconsultation appeared in a teammate's calendar. Nothing about it belonged anywhere
near the vault. Found in calibration, so no incident date.
**Rule.** A colleague's personal life is never content: out of office entries, health
appointments and any event with no other person from the organisation are dropped
entirely, with neither a mention nor an observation. Ingesting other people's
calendars requires an explicit privacy filter and recorded consent.
**Where it lives in brain-kit.** The privacy policy in the calendar source's prompt
block and the event-type filter in its evidence (`src/sources/calendar-google.mjs`), the
curate prompt's rule `third-party-privacy`, `brain-kit lint` rule `privacy` on the
lines a change adds (`privacy.third_party_keywords`, `src/rules/privacy-keywords.mjs`),
`brain-kit doctor` check `privacy-keywords`, the consent recorded in
`sources.calendar.team_calendars_consent_noted`,
`test/incidents/undated-colleague-health-in-calendar.test.mjs` (Phase 3).

### 18/08/2026: a one sided account became a confirmed pattern
**What happened.** The brain started treating one party's account as a confirmed
pattern of behaviour about a person. The central premise of that account, which had
travelled through two levels of relay before arriving, turned out to be false.
**Rule.** Conduct is not judged without triangulation. One party's account does not
become a confirmed pattern, history is not proof, and the rule applies to the brain
itself, whose files make shallow judgement easier rather than harder.
**Where it lives in brain-kit.** Uncertainty vocabulary and the triangulation rule in
the curate prompt, `brain-kit lint` rule `privacy`, confidential folders declared in
config (Phase 1 and Phase 2), and the meeting-notes source's rule that a speaker
attribution is a divergence to confirm, never a fact (Phase 3).
