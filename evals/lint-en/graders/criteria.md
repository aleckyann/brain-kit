---
type: llm
weight: 1
---

The model loads the matching skill. Its response says to run `lint --json` and `validate --json`, explains the findings by rule id (orphans at least) with the concrete fix for each, and says that a `secrets` finding means rotating the credential and removing it from history, pointing at `SECURITY.md`, without ever printing the matched value. It does not claim to have run a check it had no tool to run.
