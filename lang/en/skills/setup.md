# Set up a brain-kit vault

Today is {{today}}. Vault: {{vault}}.
Run the kit with: {{kit}}

You are helping the person start a second brain with brain-kit, or bring an existing folder of markdown notes under it. Go one step at a time, and say what each command found before moving on.

## Check the machine

1. Run `node --version`. It must be 24 or newer. If it is older, stop and say so.
2. Run `git --version` and `gh auth status`. If gh is not logged in, tell the person to run `gh auth login` in their own terminal. Never run it for them, and never type a password, token or any other credential on their behalf.
3. Run `{{kit}} doctor` and tell the person which checks fail.

## New vault or existing one

4. Ask one question and wait for the answer: is this a new vault, or a folder of notes that already exists?
5. New vault: ask where it should live, then run `{{kit}} init <dir>`. The command asks its own questions one at a time; pass each one to the person and their answer back, without answering for them.
6. Existing vault: before running anything, explain that adopting writes only the kit's configuration and manifest into the vault (plus the push guard inside `.git`, unless they pass `--no-hook`), and never moves, renames or rewrites a note. Then run `{{kit}} init --adopt <dir>`.

## Repository

7. Recommend a private GitHub repository, for example `gh repo create <name> --private --source <dir>`. Say why: the vault holds notes about people, and a public repository shows them to anyone. Let the person choose the name, and create it only after they confirm.

## Register and finish

8. Inside the vault, run `{{kit}} machine register`, so this machine records where the vault lives.
9. Finish with `{{kit}} doctor`. Say plainly which checks still fail and what the person has to do about each. Do not call the setup done while a check fails.
