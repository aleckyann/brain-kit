---
type: guide
title: Security and personal data
description: How this vault treats data about third parties, how to remove it on request, and what to do if a secret gets in.
generated:
  by: process:brain-kit-init
  at: 2026-09-22T00:00:00+00:00
---

# Security and personal data

## Third-party data

[people/](people/index.md) holds notes about other people: what they said, what they care about, how you work together. That is personal data about someone who never agreed to be written about. Keep it to what you need, keep this repository private, and never copy a note about a person into anything shared.

## Removal on request

When someone asks to be removed:

1. Delete their note and every mention of them in other notes and in the log.
2. Open a pull request with the removal, and merge it.
3. If the repository was ever shared or published, the data is still in its history: rewrite the history or recreate the repository, and ask anyone holding a copy to delete it.

## If a secret gets in

A password, token or private key committed here is compromised the moment it is pushed, even to a private repository.

1. Revoke or rotate the secret first, at its source. Removing it from the file does not undo the exposure.
2. Remove it from the file and from the history.
3. Two checks look for credential shapes, and they read different things. `brain-kit lint` reads the working tree: every file git tracks or would add, as it stands now. The pre-push gate reads what a push carries, every commit it would send, and refuses the push if one holds a credential shape. Add your own shapes to `privacy.secret_patterns` in the configuration.
