# Testing

`node --test` runs the whole suite. It needs Node 24 and git, nothing else, and every test works in a scratch directory with its own state directory.

## Plugin evals

`evals/` holds one `claude plugin eval` case per skill and language. They are not part of `node --test`: each run starts a real Claude session on your own credential and costs money. Run one case at a time:

```bash
claude plugin eval . --case capture-en --runs 1 --no-publish --max-cost-usd 1 --allow-tools "Bash(node:*)"
```

Every skill body is printed by a `!` line (`node .../bin/brain-kit.mjs prompt skill <name>`). In a normal session the skill's own `allowed-tools` grants exactly that command, so the body is rendered before the model reads it. Inside an eval run a skill's `allowed-tools` does not count, so each case declares `Bash(node:*)` in its `allowed_tools` and the operator grants it with `--allow-tools`. The cases themselves stay read-only: no case can write a file.

Measured on 24/09/2026 with Claude Code 2.1.281: the `tool_used: Skill` grader passes (the skill is picked from a request that does not name it), and the body is rendered in a real `claude -p --plugin-dir .` session. On a machine where the eval sandbox cannot start a shell (it failed there with a seccomp error on `/proc/self/setgroups`), no `!` line can run inside the eval, the body never reaches the model and the `llm` grader fails; that result says nothing about the skill.
