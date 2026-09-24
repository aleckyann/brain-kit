---
name: lint-en
description: Understand the problems the validator reported in the vault, orphan notes among them, and how to fix them.
tags: [lint, en]
runs: 1
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill, "Bash(node:*)"]
---

brain-kit validate complained about a bunch of things in my vault, orphans among them. What does that mean and how do I fix it?
