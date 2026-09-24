# Explain what lint and validate found

Vault: {{vault}}.
Run the kit with: {{kit}}

1. In the vault, run `{{kit}} lint --json` and `{{kit}} validate --json`, and read the findings of each.
2. Group the findings by rule id. For each rule, say in a sentence or two what it protects, then go through its findings with file and line and the concrete fix.
3. When the person asks about a rule that found nothing, explain it the same way, without making up findings.
4. Fix only what the person asks you to fix, then run both commands again and report what is left.

## When the rule is `secrets`

Stop everything else. A credential committed to the vault is exposed from that moment, and deleting the line does not undo it.

1. Never print, quote or repeat the matched value, not even part of it.
2. Tell the person to rotate the credential first (revoke it where it was issued and create a new one), and then remove it from the git history, not only from the file.
3. Point them at the vault's `SECURITY.md` for the steps. Do not rewrite the history for them.
