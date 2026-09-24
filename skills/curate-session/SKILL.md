---
name: curate-session
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill curate-session)
description: Use at the end of a working session in a brain-kit vault, or when asked to curate: sync, capture what was learned, compile it into notes, validate, lint and open a pull request with only this session's files.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill curate-session`
