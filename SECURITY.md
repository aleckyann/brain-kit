# Security

brain-kit generates and curates a vault that may contain personal data about third parties
(colleagues, customers) and runs an AI agent without a human in the room. The design
choices that follow from that are documented in `docs/rationale.md`; the operational ones
land with the code in later phases (allowlist per subcommand, no credentials in the vault,
machine-specific paths and executables kept outside the repository, lint for secrets and
privacy on the write path).

Report a vulnerability through a private security advisory on GitHub (Security tab of the
repository). Do not open a public issue for a secret or a leak.

## The push gate, and what it does not cover

This repository runs its own pre-push gate against a personal pattern list that lives
outside the repository. It scans five channels of every commit a push carries: file
content, file names, commit messages, annotated tag messages, and author and committer
identities. It fails closed: a missing, empty, unreadable or invalid pattern list refuses
the push rather than passing it, and so does a blob it cannot read. It never prints what
it matched.

**Install it once per clone with `.githooks/install-gate`**, and re-run that script
whenever the gate itself changes. Do NOT point `core.hooksPath` at `.githooks`: the file
there is the source the installer copies from, and the gate refuses to run from inside the
working tree.

Both halves of the gate, the hook and the engine it runs, are installed into
`<git common dir>/brain-kit-gate/` and reached through `core.hooksPath`. That directory is
never part of any tree, so no checkout can remove it, no orphan branch can leave it
behind, and no pushed branch can replace it; an uncommitted edit in the working tree does
not reach it either. Nothing is read out of the objects being pushed except the objects
being scanned. The snapshot is refreshed only by re-running the installer, never
automatically, because an automatic refresh would read the gate back out of the working
tree on every push; so it can go stale, and the gate prints which snapshot it ran on every
push to make that visible rather than silent.

It is a client-side hook, so the limits below are properties of the mechanism rather than
defects in this implementation. They are written down because a guard whose limits are
unstated gets trusted past them.

- **A clone nobody installed the gate into has no gate at all.** Git skips a
  `core.hooksPath` hook that does not exist, silently and with no exit code to notice, and
  `git clone` does not copy the git directory the gate lives in. Installing is a deliberate
  act per clone and nothing reminds you. What this setup DOES close, and an earlier version
  of this file wrongly said could not be closed: an orphan branch, or a checkout predating
  the gate, no longer removes it, because it does not live in the working tree. Verified on
  19/09/2026 both ways, by pushing a file matching an active pattern from an orphan branch:
  accepted with exit 0 and no output when `core.hooksPath` pointed inside the working tree,
  refused when it pointed outside it.
- **The gate can be skipped on purpose.** `--no-verify` exists, so does pushing from a
  second clone, and so does editing the installed copy by hand. Nothing client-side can
  prevent any of them.
- **Reference names are not scanned.** A branch or tag name itself never reaches the
  scanner, only the objects the push carries.
- **The gate is only as trustworthy as where its code comes from, and this is settled
  now.** Running the engine found in the working tree let an uncommitted edit weaken it.
  Running the engine the push itself carries was worse: it handed arbitrary code execution
  to whatever a branch contained, and the code a branch carried read the environment
  variable naming the private pattern list. Both were reproduced against this repository on
  19/09/2026. Both are closed by installing the hook and the engine outside the working
  tree, where neither a checkout, an uncommitted edit nor a pushed branch can reach them.
- **An installed snapshot can be older than the checkout it came from.** That is
  deliberate, and the gate prints the snapshot's date and source commit on every push so
  the staleness is visible; `.githooks/install-gate` refreshes it.
- **An author or committer identity that is EXACTLY the identity the push is made under is
  exempt from the identity channel**, and the gate says so when that happens. A commit
  cannot be re-authored away from the person making it, so refusing there would leave only
  the pattern list or `--no-verify`. The exemption is exact: anybody else's name matching
  the same pattern still refuses.
- **Content the pattern list does not describe is not found.** The list is the whole of
  the gate's knowledge, and keeping it current is a person's job, not the tool's.

The only way to close the first two is a check the person pushing cannot skip, which means
a server-side hook or a required status check. This repository has neither today.
