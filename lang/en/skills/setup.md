# Set up a brain-kit vault

Today is {{today}}. Vault: {{vault}}.
Run the kit with: {{kit}}

You are helping the person start a second brain with brain-kit, or bring an existing folder of markdown notes under it. Go one step at a time, and say what each command found before moving on.

## Check the machine

1. Run `node --version`. It must be 24 or newer. If it is older, stop and say so.
2. Run `git --version` and `gh auth status`. If gh is not logged in, tell the person to run `gh auth login` in their own terminal. Never run it for them, and never type a password, token or any other credential on their behalf.
3. Run `{{kit}} doctor` and tell the person which checks fail.

## New vault or existing one

`init` never asks anything here: without a terminal it takes every answer from a file. You ask the questions yourself, in the chat, and write the file.

4. Ask one question and wait for the answer: is this a new vault, or a folder of notes that already exists? For a new one, also ask where it should live.
5. Ask for each answer below, one at a time, waiting for each reply, and offer a sensible default when there is one:
   - `lang`: `pt-BR` or `en`;
   - `name`: the person's first name, and `handle`: a short lowercase id, such as `ana`;
   - `title`: the vault's title;
   - `repo`: the GitHub repository as `owner/name`, or `null` if there is none yet;
   - `private`: must be `true`; the kit refuses a vault whose repository will not be private;
   - `timezone`: an IANA zone, such as `America/New_York`;
   - `email` is optional (`null` is fine). Leave `commit` out: the first commit is the person's to make.
6. Write the answers as one JSON object to a file in a temporary directory outside the vault, for example `{"lang": "en", "name": "Ana", "handle": "ana", "title": "Ana's brain", "repo": null, "private": true, "timezone": "America/New_York", "email": null}`. Show it to the person before running anything.
7. New vault: run `{{kit}} init <dir> --from-answers <file>`.
8. Existing vault: first explain what adopting writes. It writes only `brain-kit.config.json` and `.brain-kit/manifest.json` into the vault, and never moves, renames or rewrites a note. It also installs the push gate: it writes `.githooks/pre-push` into the vault and sets `core.hooksPath` in the repository's git config, unless the person already has a hook of their own or a `core.hooksPath` pointing elsewhere; that one it leaves exactly as it is and prints the line to add the gate to it. With `--no-hook` it skips the gate altogether. Then run `{{kit}} init --adopt <dir> --from-answers <file>`.
9. Delete the answers file once `init` has finished. Use `--yes` instead of a file only if the person explicitly accepts every default.

## Repository

10. Recommend a private GitHub repository, for example `gh repo create <name> --private --source <dir>`. Say why: the vault holds notes about people, and a public repository shows them to anyone. Let the person choose the name, and create it only after they confirm.

## Register and finish

11. Inside the vault, run `{{kit}} machine register`, so this machine records where the vault lives. Right after `init`, it says the vault is already registered and there is nothing to do: that is expected, not a problem.
12. Finish with `{{kit}} doctor`. Say plainly which checks still fail and what the person has to do about each. Do not call the setup done while a check fails.
