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

This repository runs its own pre-push hook (`.githooks/pre-push`) against a personal
pattern list that lives outside the repository. It scans five channels of every commit a
push carries: file content, file names, commit messages, annotated tag messages, and
author and committer identities. It fails closed: a missing, empty, unreadable or invalid
pattern list refuses the push rather than passing it, and so does a blob it cannot read.
It never prints what it matched.

It is a client-side hook, so the limits below are properties of the mechanism rather than
defects in this implementation. They are written down because a guard whose limits are
unstated gets trusted past them.

- **A working tree that does not carry the hook file has no gate at all.** Git skips a
  `core.hooksPath` hook that does not exist, silently and with no exit code to notice. An
  orphan branch, a checkout predating the hook, or a fresh clone that has not set
  `core.hooksPath` will push whatever it carries. Verified on 19/09/2026 by checking out an
  orphan branch, which removes the hooks directory from the working tree, committing a
  file matching an active pattern, and pushing it: exit 0, no output, and it reached the
  remote.
- **The hook can be skipped on purpose.** `--no-verify` exists, and so does pushing from a
  second clone. Nothing client-side can prevent either.
- **Reference names are not scanned.** A branch or tag name itself never reaches the
  scanner, only the objects the push carries.
- **A tip that carries the hook but not the engine is refused rather than scanned.** The
  gate runs the scanner the push carries, not the one in the working tree, so an
  uncommitted edit cannot weaken it. The cost of that choice is that a tip without the
  engine cannot be pushed at all, and the refusal says so.
- **Content the pattern list does not describe is not found.** The list is the whole of
  the gate's knowledge, and keeping it current is a person's job, not the tool's.

The only way to close the first two is a check the person pushing cannot skip, which means
a server-side hook or a required status check. This repository has neither today.
