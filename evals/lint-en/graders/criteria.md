---
type: llm
weight: 1
---

A right response runs the kit's checks with `--json`, explains each finding by rule id with its file, line and concrete fix, and if a secret turns up tells the person to rotate the credential and remove it from history, pointing at `SECURITY.md`, without ever printing the matched value.
