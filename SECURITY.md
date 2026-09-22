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
outside the repository. It scans seven channels of every push: file content, file names,
commit messages, annotated tag messages, author and committer identities, the
destination NAME of every reference the push writes to, and the whole raw HEADER BLOCK of
every commit and every annotated tag object.

The header block is scanned AS A BLOCK, not as a further list of named fields. Six earlier
channels were each added by naming one more field, and twice the naming was still
incomplete in the round that did it; a block covers the headers nobody enumerated at the
same time as the ones they did. Every byte of an object is scanned exactly once, by the
most specific channel that covers it: the identity spans the author, committer and tagger
channels read are removed from the block before it is scanned, so one leak is reported
once, by the channel that names the remedy, and the identity exemption below still decides
the case it was built for. A pushed reference that names a
blob or a tree rather than a commit is scanned too, as an object: its content, or its
paths and their contents. It fails
closed: a missing, empty, unreadable or invalid pattern list refuses
the push rather than passing it, and so does a blob it cannot read. It never prints what
it matched.

Every git call the gate makes refuses replacement objects, with `--no-replace-objects` on
the scanner's own calls and `GIT_NO_REPLACE_OBJECTS` exported by the hook. `git replace`
installs a ref under `refs/replace/` and every ordinary git read then reports the
replacement wherever the original was asked about, while `git push` sends the object that
is really there; measured on 19/09/2026, that made the gate scan a clean stand-in while
the remote received a commit whose content matched an active pattern, with exit 0 and no
output, using one ordinary command and no edit to the gate.

The reference-name channel scans the DESTINATION name, which is the field that decides
where a reference lands and the only one that crosses the wire; the source name stays on
the machine, and scanning it would refuse
`git push origin <a local branch>:refs/heads/<a clean name>`, which is the remedy this
channel's own finding asks for. That remedy is complete for a BRANCH, whose name exists
nowhere but the reference. For an annotated TAG the reference name alone was not enough, because
the tag object records the name it was created under in its own `tag` header and carried
it to the remote inside the object; the header block channel is what closes that, and it
is why renaming an annotated tag on the way out no longer publishes the old name. Deletions are scanned too: a deletion carries no objects,
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
- **It is a literal pattern scanner, so content that does not look like the pattern passes.**
  Measured on 19/09/2026, all three accepted with exit 0 and landed on the bare remote: the
  same name base64-encoded, split across a line break, and written with a space between
  every letter. Anything compressed, encrypted or encoded is in the same position. This is
  not a defect to be fixed by a longer pattern list; it is what a pattern list is. The gate
  is a guard against the accident, a name left in a note, and not against somebody who has
  decided to publish.
- **The gate can be skipped on purpose.** `--no-verify` exists, so does pushing from a
  second clone, and so does editing the installed copy by hand. Nothing client-side can
  prevent any of them.
- **Push options are invisible to the gate, which puts them in the same class as
  `--no-verify`.** `git push --push-option=<text>` sends that text to the receiving end,
  where it reaches the server's hooks and logs. Git does not pass push options to a
  `pre-push` hook at all, so there is nothing for this gate to read and no client-side gate
  of this shape could read it either. Measured both halves on 19/09/2026: nothing about
  them in the hook's environment, and the text arriving intact at a receiving hook. The
  difference from `--no-verify` is that this one does not look like a bypass while you type
  it.
- **A reference already on the remote under a matching name cannot be removed through the
  gate.** A deletion transmits its destination name, so the gate refuses it, and the only
  ways out are the hosting provider's own interface, a clone without the gate, or a
  deliberate bypass. That is the accepted cost of closing leak-by-deletion.
- **The gate can only scan what git hands a `pre-push` hook, and that is a short list.**
  Measured on 19/09/2026 with a hook that printed everything it received: the remote's
  name, the remote's URL, and one line per reference with the local and remote names and
  hashes. Nothing else. Whatever else a push puts on the wire, the protocol capability
  list, a user agent over HTTP or SSH, a proxy or credential helper's own traffic, never
  reaches this hook and so cannot be scanned by it from here.
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
- **Write a pattern the way you would write the name.** The pattern list and every
  channel are decoded the same way: UTF-8 where the bytes are UTF-8, and any other byte
  as itself. A name with an accent, written the ordinary way, matches that name. Until
  22/09/2026 the channels were decoded one byte per character and only a pattern written
  as its mojibake matched; a list written that way should be rewritten.
- **A file over 100 MiB is not read, and refuses the push.** That is the one ceiling both
  this gate and the adopting vault's template share, and it is the largest file the
  most common git host accepts in an ordinary push. The refusal says the file was too
  large; it never calls it clean.

The only way to close the first two is a check the person pushing cannot skip, which means
a server-side hook or a required status check. This repository has neither today.
