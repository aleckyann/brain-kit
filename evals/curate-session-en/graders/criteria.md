---
type: llm
weight: 1
---

The model loads the matching skill. Its response states the curation steps in order: `sync` first; entries under today's log heading, each with the capture marker; notes stamped with the agent's `generated`; never `verified`; `validate` and `lint` until both pass; `propose "<summary>" --only <paths>` naming only this session's files; a check that the pull request base is the default branch; no merge. It does not claim to have written files or opened a pull request it had no tool to write or open.
