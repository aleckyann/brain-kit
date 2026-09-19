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
outside the repository. It scans six channels of every push: file content, file names,
commit messages, annotated tag messages, author and committer identities, and the
destination NAME of every reference the push writes to. A pushed reference that names a
blob or a tree rather than a commit is scanned too, as an object: its content, or its
paths and their contents. It fails
closed: a missing, empty, unreadable or invalid pattern list refuses
the push rather than passing it, and so does a blob it cannot read. It never prints what
it matched.

The reference-name channel scans the DESTINATION name, which is the field that decides
where a reference lands and the only one that crosses the wire; the source name stays on
the machine, and scanning it would refuse
`git push origin <a local branch>:refs/heads/<a clean name>`, which is the remedy this
channel's own finding asks for. That remedy is complete for a BRANCH, whose name exists
nowhere but the reference; for an annotated TAG it is not, because the tag object carries
its own name in a header (see the limits below). Deletions are scanned too: a deletion carries no objects,
but it still transmits its destination name, and git does not require that name to exist
on the remote first, so pushing a deletion of a reference that was never there publishes
the name and nothing else. A name that matched is never printed, by either half of the
gate, and the reference is identified by its position in the push instead.

**Install it once per clone with `.githooks/install-gate`**, and re-run that script
whenever the gate itself changes. Do NOT point `core.hooksPath` at `.githooks`: the file
there is the source the installer copies from, and the gate refuses to run from inside the
working tree.

Both halves of the gate, the hook and the engine it runs, are installed into
`<git common dir>/brain-kit-gate/` and reached through `core.hooksPath`. That directory is
never part of any tree, so no checkout can remove it, no orphan branch can leave it
behind, and no pushed branch can replace it; an uncommitted edit in the working tree does
not reach it either, and the installer refuses to install an engine containing a symbolic
link, because a link is a file whose content still lives where it points. Nothing is read
out of the objects being pushed except the objects being scanned. The snapshot is
refreshed only by re-running the installer, never automatically, because an automatic
refresh would read the gate back out of the working tree on every push; so it can go
stale. The gate names the snapshot it ran on every refusal, and on a clean push only when
that snapshot is stale: the stamp records a dirty source tree, or this is the brain-kit
checkout and its HEAD or its `.githooks/pre-push` no longer matches what was installed.
Printing it on every push instead made it a line people stopped reading, which is the
opposite of what saying it is for.

A refresh never leaves the clone ungated: the installed gate is moved aside, the new one
renamed into place, and the old one removed last, so a refresh that fails leaves the gate
that was already working rather than none.

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
- **A commit or tag header other than the ones named above is not scanned.** The gate
  reads a commit's message, author and committer, and a tag object's message and tagger.
  Any other header travels with the object unexamined. Two shapes of this were measured on
  19/09/2026, both accepted with exit 0 and both readable off the bare remote afterwards: a
  commit object carrying an extra header written by hand, and, with ordinary commands only,
  the `tag` header inside an annotated tag object, which records the name the tag was
  created under even when it is pushed to a different one.
- **Push options are invisible to the gate.** `git push --push-option=<text>` sends that
  text to the receiving end, where it reaches the server's hooks and logs. Git does not
  pass push options to a `pre-push` hook at all, so no client-side gate of this shape can
  see one. Measured both halves on 19/09/2026: nothing in the hook's environment, and the
  text arriving intact at a receiving hook.
- **The gate can be skipped on purpose.** `--no-verify` exists, so does pushing from a
  second clone, and so does editing the installed copy by hand. Nothing client-side can
  prevent any of them.
- **The gate is only as trustworthy as where its code comes from, and this is settled
  now.** Running the engine found in the working tree let an uncommitted edit weaken it.
  Running the engine the push itself carries was worse: it handed arbitrary code execution
  to whatever a branch contained, and the code a branch carried read the environment
  variable naming the private pattern list. Both were reproduced against this repository on
  19/09/2026. Both are closed by installing the hook and the engine outside the working
  tree, where neither a checkout, an uncommitted edit nor a pushed branch can reach them,
  and by refusing to install an engine that contains a symbolic link: `cp -R` preserves a
  link rather than flattening it, so a link was a file the installer believed it had
  copied while its content stayed in the working tree, and a reviewer walked a leak
  through exactly that way on 19/09/2026.
- **An installed snapshot can be older than the checkout it came from.** That is
  deliberate; the gate names the snapshot whenever it is stale or whenever it refuses,
  and `.githooks/install-gate` refreshes it.
- **A bare or mirror clone cannot be gated.** Both the installer and the hook resolve
  everything they do against a working tree, and a bare clone has none. The installer
  says so rather than claiming the directory is not a repository.
- **An author or committer identity that is EXACTLY the identity the push is made under is
  exempt from the identity channel**, and the gate says so when that happens. A commit
  cannot be re-authored away from the person making it, so refusing there would leave only
  the pattern list or `--no-verify`. The exemption is exact in both directions: a
  different name refuses, and so does a name that merely CONTAINS the pushing identity.
  It is read from the git configuration FILES, with `git -c` and the `GIT_CONFIG_*`
  environment overrides stripped, so the identity it keys on cannot be chosen per
  invocation by a flag that leaves no trace.
- **Content the pattern list does not describe is not found.** The list is the whole of
  the gate's knowledge, and keeping it current is a person's job, not the tool's.

The only way to close the first two is a check the person pushing cannot skip, which means
a server-side hook or a required status check. This repository has neither today.
