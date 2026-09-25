---
name: briefing
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill briefing), Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt briefing)
description: "Use when the person asks for their morning briefing from the brain-kit vault: facts from the kit, the vault's own blocks, open questions, and one pull request for what gets recorded."
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill briefing`

!`node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt briefing`
