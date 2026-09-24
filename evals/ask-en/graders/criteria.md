---
type: llm
weight: 1
---

The model loads the matching skill. It reads from `index.md` down, only the notes it needs, and answers with the paths it relied on, flagging notes that are unverified or past `stale_after`. When the answer is not there, it says which state applies (not verified, not found, don't know) instead of inventing one.
