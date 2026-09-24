---
name: capture
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill capture)
description: Use when the person says something new, changes their mind, or a fact conflicts with the brain-kit vault, and it should be written down now as a dated entry in the vault log without compiling notes.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill capture`
