# Why brain-kit works the way it does

This document explains the reasoning behind the design. It is distilled from the
original vault that brain-kit extracts: a second brain in plain markdown, kept in
git, read on demand by an AI agent and changed only through pull requests. Every
claim here comes from that vault's own history. The dated failures that produced
each guard are in [incidents.md](incidents.md).

## The problem: a giant prompt does not scale, RAG breaks relations

Before the vault existed, the owner's context lived in one large XML block pasted
into the system prompt. Context is finite and expensive. Above roughly 15 to 20
thousand tokens the model's attention dilutes, answers get worse and every call
costs more. Worse, the block was updated by hand and the agent could not write to
it. That is glue, not a brain: it grows until it hurts, and nothing in the system
notices that it has started to hurt.

The obvious alternative is retrieval augmented generation over a vector index. It
solves size and breaks something else. Personal knowledge is relational: a person
connects to a decision, the decision connects to a stated value, the value explains
a departure two quarters later. Chunking a corpus into passages ranked by
similarity is very good at returning the three paragraphs that mention a term and
very bad at returning the chain that explains it. What is lost is exactly the part
a second brain exists for.

So the design starts from a constraint rather than a technology: whatever the agent
reads must be small enough to fit, structured enough to navigate, and honest enough
that the agent can tell what it has not read.

## The bet: a curated LLM wiki in an open format

The middle path is the LLM wiki: a small, curated corpus with an index that fits in
context and links that form the graph. The agent starts at the root index, reads a
one line description per note, decides what to open and walks only the relevant
links. It never loads the whole vault.

The numbers from the original vault, measured on 17/09/2026: 234 markdown files,
220 of them notes with frontmatter, 13 reserved index files and one log, changed
through 88 merged pull requests across 241 commits. Corpus size was about 20
thousand tokens in July 2026 and above 300 thousand by September 2026.

That growth matters, because the architecture declares its own limit. Between 50
and 100 thousand tokens of corpus, the index stops fitting comfortably and the
honest move is a hybrid: keep the wiki for relations, add semantic search for
recall. The original vault crossed that line and never pulled the trigger, which is
a finding, not a recommendation. brain-kit ships the trigger as a documented number
so an adopter can decide deliberately instead of drifting past it.

## Why OKF (Open Knowledge Format)

The vault is written in Open Knowledge Format v0.2, an open specification for
knowledge bases meant to be consumed by language models. The choice is about who
owns the brain. Markdown files plus YAML frontmatter, no runtime, no SDK, no
service: the corpus is readable by any model, any editor and any person, ten years
from now, with `cat`.

OKF also gives the thing a contract. `generated` says who wrote a note and when.
`sources` says what it was based on. `stale_after` says how long it is expected to
hold. `verified` says a human checked it. Those fields turn trust into something
queryable instead of something assumed, and they make it possible to write a
validator that fails a push.

brain-kit is deliberately a stricter producer than the spec. The specification asks
consumers to be lenient; the kit's role is the opposite side of that bargain, so
the validator separates two rulers in its output: `[spec]`, the rules the
specification imposes, and `[house]`, the conventions an adopter chooses. Anyone can
adopt the format without adopting the house rules, and any house rule wearing a spec
label is a bug (the original validator had one: it demanded a plain date where the
canonical spec asks for a datetime with offset, so a conforming vault was failed by
a ruler sold as generic).

## Why git and pull requests are the approval mechanism

The agent never writes to the default branch. It finishes a round, runs the
validator, and if that passes, opens a branch, commits what is pending and opens a
pull request. If the tree is clean there is nothing to propose and the command exits
quietly. If the validator fails, no pull request is born.

Git is not here for version control alone. It is here because a pull request is the
cheapest possible approval interface that still shows the whole change: a diff, one
screen, reviewable on a phone. The human does not have to open an app, log into a
service, or trust a summary written by the same agent that made the change. This is
also why internal links are file relative and never start with a slash: the review
screen renders the vault as a file tree, and a leading slash produced a 404 on every
link in that exact screen (see [incidents.md](incidents.md), 10/08/2026).

Pull requests also make the loop auditable after the fact. The history of the vault
is a history of what the agent proposed and what a human accepted, with dates, which
is what made the 73 lessons behind this kit recoverable at all.

## Why the agent never verifies its own work

`verified` is only ever written as a result of a human merge. The agent proposes
through pull requests and only through pull requests. The owner commits directly,
because a pull request from the owner to the owner is theatre.

The asymmetry is the point. If the agent could set its own trust signal, the signal
would be self praise and the field would be worth nothing. Keeping it human keeps
approval cheap (one diff, one tap) and keeps the meaning intact. In practice most
notes stay unverified for a long time, and that is information: it says which parts
of the brain have been read by a person and which have only been asserted by a
model.

The same principle shows up in the smaller rules. A round may not declare a document
empty unless it opened that document in this round. "Empty", "does not exist" and
"no record" are three different verification results, each with a timestamp, and
"attachment not accessible" is a fourth label that belongs to permissions and not to
content. Collapsing those states throws away the only evidence a later reader has.

## Why the log is append-only and the index is the map

Every new fact enters the log first, grouped by date, newest on top, with a marker
at the start of the line: captured for raw material, promoted when it became a note,
correction, creation. The log is raw memory; the notes are compiled memory. Nothing
is deleted: obsolete notes get a deprecated status and stay, because history is the
raw material of every lesson in this kit.

The index is the map. Each folder has one, each entry carries a one line
description, and the root index lists every first level folder. This is what makes
selective reading possible: the agent pays for the index, not for the corpus. An
index that grows too large to hold is the signal that the corpus has crossed into
hybrid territory.

Paths carry identity and nothing else. A job title, a category or a state never
belongs in a file name, because renaming breaks every edge in the graph and
scatters the history of one entity across two files. A change of role is a diff in
the same file plus a line in the log. Mutable attributes live in frontmatter, and a
list of everything with a given attribute is a view built in the index, never a
directory.

## Why silent failure is treated as the enemy

A guard that stops work must exit with a failure code and say so out loud. A
scheduled service that reports success after running for four seconds is a dead
round, not a quiet night.

This is the most expensive lesson in the collection, because the failure mode is
invisible by construction. Four consecutive days of curation were lost while the
scheduler reported "Finished" every morning, each log file 95 bytes long. A run died
six seconds in on an expired token and the service still reported success, because
the exit code being propagated belonged to a redirection block and not to the
process. A filter meant to ignore the agent's own transcripts ate a whole day of
human work and the night looked calm.

So brain-kit turns every one of those into a named guard with its own file, its own
dated comment and its own test that reproduces the incident: `dirty-tree` exits 75
and lists the files, `exit-propagation` captures the real return code before any
command substitution, `cli-stub` measures the binary before trusting it, `network`
refuses to believe a wait that returned in under 100 milliseconds, `read-evidence`
counts actual tool results per source so a round cannot claim to have read what it
never opened. Every cap announces itself: whoever truncates a list says how much was
cut and what fell off.

## Why arithmetic lives in code and judgment lives in the prompt

Date windows, deduplication by id, caps and discard filters are deterministic code,
computed before the model runs and injected into the prompt as literal text. The
model decides what counts as a new fact. It never does date arithmetic.

The reason is diagnostic, not philosophical. A model that gets a date window subtly
wrong produces a plausible round with the wrong day in it, at 09:30, unattended,
and nobody notices for a week. The same logic in code either produces the right
window or crashes, and a crash is a message. The original scanner even guards
against its date utility returning an empty string.

The complementary half of the rule: the script does not know what a meeting is, and
the prompt does not know what a lock is. Business policy (what is worth promoting,
what counts as a source, what must never be written down) lives in the prompt, so
changing policy does not mean touching the scheduler. And nearly every guard carries
a comment with the date and the symptom of the day it was born, which is what stops
the next person from deleting it for looking paranoid.

## What the evidence says (including the study against us)

The architecture document of the original vault claimed that a 2026 study measured
the wiki approach beating RAG. That sentence was true and incomplete, and this kit
exists partly to correct it in public.

The study (arXiv 2605.18490) does find that a curated wiki synthesizes better across
documents than chunk retrieval. It also finds that the wiki used roughly 21 times
more tokens per query, and that the advantage disappeared when the evaluation used
combined evaluators rather than a single one. Read honestly, the result says: if
your questions are relational and span documents, curation pays; if your questions
are lookups, you are paying 21 times too much for the privilege.

That is the fair case against this design, and it is the reason the corpus ceiling
of 50 to 100 thousand tokens is written down as the declared limit of the
architecture rather than buried. brain-kit is for knowledge that is small, dense and
relational, maintained by an agent and approved by a person. It is not a document
warehouse, and anyone whose corpus is a warehouse should use search.

The rule underneath is more general than this one study: an empirical claim about
the outside world ships with the caveat, never with just the favourable conclusion.
Verify before asserting, read the specification at the source rather than in a blog
post, and when a claim about someone else's tool turns out to be false, correct it
in place with a date saying the previous version was wrong.

## The seventeen principles

1. **Open format over tooling.** Markdown, files and YAML, with no runtime, no SDK
   and no npm dependency inside the vault, so the brain is never hostage to a model
   vendor or a lockfile.
2. **Selective reading through the index.** The agent starts at the root index,
   reads one line per note and decides what to open, never loading the whole vault.
3. **The path is the identity.** Only the stable attribute of an entity goes in the
   file name; a change is a diff in the same file plus a line in the log, never a
   rename.
4. **State lives in frontmatter, never in a folder.** A folder is a collection or a
   domain; a mutable attribute is a field, and the list of everything with that
   value is a view in the index.
5. **The structure only grows by addition.** Folders and notes are created, rarely
   deleted and almost never renamed; obsolete becomes a deprecated status.
6. **Provenance is a field, not a promise.** `generated` is mandatory, `sources`
   says where it came from, `stale_after` says how long it holds, and a note that
   crosses sources anchors each claim in a footnote.
7. **The agent never verifies itself.** `verified` is born only from a human merge;
   the agent proposes through pull requests and only through pull requests.
8. **Stricter producer than the spec.** Leniency is the reader's duty, so the
   validator separates the `[spec]` ruler from the `[house]` ruler in its output.
9. **Closed vocabularies of uncertainty.** Not verified, not found and I do not know
   are distinct; empty, does not exist and no record are verification results with a
   timestamp; no access is a label of its own.
10. **Every cap announces itself.** Whoever truncates says how much was cut and what
    was left out, in the log or in the round's answer.
11. **Silent failure is the enemy.** A guard that blocks work exits with a failure
    code and notifies; a green service that ran for seconds is a dead round.
12. **Arithmetic in code, judgment in the model.** Windows, deduplication, caps and
    filters are deterministic code injected as literal text; the model never does
    date arithmetic.
13. **When in doubt, include.** Discard filters err towards sweeping too much:
    including too much costs context, discarding too much costs the day.
14. **A live source is read, not copied.** Calendars and document stores are read on
    demand; the vault keeps the meaning, never the event.
15. **Mechanism in code, policy in the prompt, incident in a comment.** The script
    does not know what a meeting is, the prompt does not know what a lock is, and
    almost every guard carries the date and the symptom of the day it was born.
16. **Least reading privilege per actor.** Each scheduled agent has a closed list of
    what it may read and an explicit list of what it must never read.
17. **The machine proposes, the human decides, and the trigger is an event.** A new
    mandatory daily habit kills the mechanism, so the trigger comes from the event,
    and every decision is born with a give up criterion.
