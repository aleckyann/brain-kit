---
name: review-stale
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill review-stale)
description: "Use when notes in the brain-kit vault are past their stale_after date, or the person asks to review what may be out of date."
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/brain-kit.mjs" prompt skill review-stale`
