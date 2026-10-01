# Example vault

This is a small, valid brain-kit vault, kept here so you can see what one looks like without running `init`. It belongs to Ana, a fictional solo consultant, and holds one person, one organization, one project, one decision, a log with three entries and two pending items, all about a website audit she is doing for a small design studio. Start at `index.md` and read down, the way an agent does. It takes about five minutes.

It was made with the kit's own `init`, in an empty scratch directory (never run `init` inside another repository, because it runs `git init` and sets `core.hooksPath` there), and then edited by hand. Afterwards the `.git` directory and `.githooks` were removed (`brain-kit update --accept .githooks/pre-push` told the manifest), the notes were written and linked from the `index.md` files, and `brain-kit.config.json` was edited in the five places the answers file has no key for: `curate.enabled` and `briefing.enabled` are `false`, `curate.sources.required` is empty, `git.agent_identity.email` is on `example.com`, and `validate.ignore_paths` lists this `README.md`, which describes the example and is not a note of the vault. The em dash that `init` writes into `lint.style.forbidden_chars` is spelled as the JSON escape `\u2014` (the same value), because this repository's tests accept no literal one, and the time stamps on the files `init` wrote carry the day it ran. The answers file, saved as `answers.json`, and the command:

```json
{
  "lang": "en",
  "name": "Ana",
  "handle": "ana",
  "title": "Ana's second brain (example)",
  "repo": null,
  "private": true,
  "timezone": "UTC",
  "email": "ana@example.com"
}
```

```sh
BRAIN_KIT_STATE_DIR=scratch/state brain-kit init scratch/vault --from-answers answers.json
```

To check it, from a clone of the kit repository (write `node bin/brain-kit.mjs` for `brain-kit` if it is not installed):

```sh
brain-kit -C examples/minimal-vault validate
brain-kit -C examples/minimal-vault lint --base all
```

Both exit 0 with no finding (`--base all` makes `lint` read every note, not only what changed since the last merge). The test suite runs the same checks on a copy of this folder (`test/example-vault.test.mjs`), so a change to a rule or a template that makes the example invalid fails the suite until the example is fixed. The folder is not part of the npm package.

What is deliberately missing: no connectors (transcripts, calendar, meeting notes and the morning briefing are off, so nothing here needs a login), no git history (copy the folder out of the repository and run `git init` there to try `propose` or `curate`), no machine state (the `machine.json` that `init` writes lives in the state directory, outside any vault), no push-gate hook (`.githooks/pre-push` only means something in a clone with `core.hooksPath` set, and `brain-kit update --install-hook` installs it), and no `verified` stamp on any note, because that stamp enters only when a person merges a pull request.

All names in this vault are fictional: Ana, Ben Okafor, Example Studio and every `example.com` address are invented.
