---
name: approve
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill approve)
description: Use after the owner merged a brain-kit pull request and wants the merged notes stamped verified.
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill approve`
