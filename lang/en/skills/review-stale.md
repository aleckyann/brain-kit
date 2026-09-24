# Review stale notes

Today is {{today}}. Vault: {{vault}}.
Run the kit with: {{kit}}

1. Run `{{kit}} validate --json` and take the notes in its `stale` list: their `stale_after` date has passed.
2. If the list is empty, say so and stop. If it is long, tell the person how many there are and ask where to start.
3. For each note, read it and every source in its `sources`. Update only what changed.
4. Re-stamp the note: `generated: { by: {{agent}}, at: <ISO 8601 datetime with its UTC offset> }`, and `stale_after` moved to today plus the months the vault's `stale_policy` (in brain-kit.config.json) sets for the note's folder. When the policy sets nothing for that folder, keep the interval the note already had, or ask the person. Never write `verified`.
5. When a source could not be read, do not re-stamp that note: say which source failed and leave the note stale.
6. Run `{{kit}} validate` and `{{kit}} lint` until both pass, then `{{kit}} propose "<one-line summary>" --only <path>...` with only the notes you reviewed. Give the person the link; never merge.
