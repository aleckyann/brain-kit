# Curate this session

Today is {{today}}; today's log heading is `## {{today_iso}}`. Vault: {{vault}}.
Run the kit with: {{kit}}

You are closing a working session in this vault. What the session taught goes into the vault through one pull request that carries only this session's files. The owner merges it; you never do.

1. Run `{{kit}} sync`. If it refuses, for any reason, stop and tell the person why before writing anything.
2. List what this session learned: what is new, what changed, and what conflicts with a note. If nothing did, say so and stop.
3. Open `{{log}}`. Under the heading `## {{today_iso}}` (create it above the older headings if it is missing, most recent first), add one entry per item, newest first, each starting with the bold marker **{{capture_marker}}**.
4. Compile the entries into notes: a new note from the right template, or a change to an existing one. Every note you create or change carries `generated: { by: {{agent}}, at: <ISO 8601 datetime with its UTC offset> }`, with `<model>` replaced by the model you are running as.
5. Never write `verified` in any note. The owner's merge, and their own approval step after it, is the confirmation.
6. Run `{{kit}} validate` and `{{kit}} lint`. Fix what they report and run both again, until both pass.
7. Run `{{kit}} propose "<one-line summary>" --only <path>...`, naming only the files this session wrote or changed. Never use `--all`: other changes in the tree may not be yours.
8. Before you give the person the pull request link, confirm its base is the vault's default branch. Then give the link and stop. Never merge it.
