---
type: llm
weight: 1
---

A right response uses the kit's validate to list the notes whose `stale_after` has passed, reads each one and its sources, updates only what changed, re-stamps `generated` and `stale_after` by the vault's `stale_policy`, never writes `verified`, and proposes with `--only` naming only the reviewed notes.
