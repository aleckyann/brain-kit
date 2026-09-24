---
type: llm
weight: 1
---

The model loads the matching skill. Its response states the steps: `validate --json` for the notes whose `stale_after` has passed; read each one and its sources; update only what changed; re-stamp `generated` and `stale_after` by the vault's `stale_policy`; never write `verified`; leave stale a note whose source could not be read; `propose "<summary>" --only <paths>` with only the reviewed notes. It does not claim to have edited notes it had no tool to edit.
