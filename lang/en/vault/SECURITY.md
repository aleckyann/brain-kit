---
type: guide
title: Security and personal data
description: What the curator saves by default, how this vault treats data about third parties, how to remove it on request, and what to do if a secret gets in.
generated:
  by: process:brain-kit-init
  at: 2026-09-22T00:00:00+00:00
---

# Security and personal data

## What the curator saves

By default the curator saves everything it learns, personal and sensitive information included (health, family, relationships, finances, anything intimate), yours and other people's. To save less, set `privacy.sensitive` in `brain-kit.config.json`, giving each of `owner`, `people` and `outsiders` one of `save`, `summary` or `skip`, and list in `privacy.never_topics` the subjects never to record. That setting is an instruction to the curator, not a guarantee: read each pull request before you merge it.

## Third-party data

[people/](people/index.md) holds notes about other people: what they said, what they care about, how you work together. That is personal data about someone who never agreed to be written about, and by default the curator records it in full, sensitive subjects included. Under privacy laws such as the LGPD and the GDPR, data about their health, sex life, religious beliefs or political opinions, among other categories these laws list, are sensitive personal data, and you, as the vault's owner, answer for keeping them. Keep it to what you need, keep this repository private, and never copy a note about a person into anything shared.

## Removal on request

When someone asks to be removed:

1. Delete their note and every mention of them in other notes and in the log.
2. Open a pull request with the removal, and merge it.
3. If the repository was ever shared or published, the data is still in its history: rewrite the history or recreate the repository, and ask anyone holding a copy to delete it.
4. The curator records again whatever a session, an event or a document it reads still holds. Their note is gone, so they count as `outsiders`: to keep their sensitive subjects out from then on, set `privacy.sensitive.outsiders` to `skip` (it applies to everyone without a note), or list the subject in `privacy.never_topics`; the step-by-step page below says what else keeps it from coming back.

## If a secret gets in

A password, token or private key committed here is compromised the moment it is pushed, even to a private repository.

1. Revoke or rotate the secret first, at its source. Removing it from the file does not undo the exposure.
2. Remove it from the file and from the history.
3. Two checks look for credential shapes, and they read different things. `brain-kit lint` reads the working tree: every file git tracks or would add, as it stands now. The pre-push gate reads what a push carries, every commit it would send, and refuses the push if one holds a credential shape. Add your own shapes to `privacy.secret_patterns` in the configuration.

The step-by-step page, in the order to do things when stress is high (a secret in a commit, a repository that was public by mistake, someone's personal data to remove, a curator that did something it should not), is `docs/incident-response.md` in the brain-kit repository: https://github.com/aleckyann/brain-kit/blob/main/docs/incident-response.md
