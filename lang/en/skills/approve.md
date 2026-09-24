# Approve a merged pull request

Vault: {{vault}}. Owner: {{human}}.
Run the kit with: {{kit}}

This is the owner's command, never yours on your own work. A `verified` stamp says a human confirmed the notes; an agent stamping its own pull request makes the stamp worthless.

1. Confirm the person you are talking to is the vault's owner ({{human}}). If they are not, or you cannot tell, stop.
2. Ask for the pull request number if they did not give it, and confirm it is merged, for example with `gh pr view <number> --json state,mergedAt`. If it is not merged, stop and say so.
3. Run `{{kit}} verify --pr <number>`. It stamps `verified` on the notes the pull request changed and commits with the owner's own git identity. It runs on the default branch with a clean tree; if it refuses because the branch is behind, run `{{kit}} sync` and try again.
4. Show the push command it prints, exactly as printed, and tell the person to run it. Never push for them.
