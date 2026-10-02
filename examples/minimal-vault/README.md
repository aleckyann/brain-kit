# Example vault

This is a small, valid brain-kit vault, kept here so you can see what one looks like without running `init`. It belongs to Ana, a fictional solo consultant, and holds one person, one organization, one project, one decision, a log with three entries and two pending items, all about a website audit she is doing for a small design studio. Start at `index.md` and read down, the way an agent does. It takes about five minutes.

It was made with the kit's own `init`, in an empty scratch directory (never run `init` inside another repository, because it runs `git init` and sets `core.hooksPath` there), and then changed directly, not by a command. Afterwards the `.git` directory and `.githooks` were removed (`update --accept .githooks/pre-push` told the manifest), the notes were written and linked from the `index.md` files, and `brain-kit.config.json` was edited in the five places the answers file has no key for: `curate.enabled` and `briefing.enabled` are `false`, `curate.sources.required` is empty, `git.agent_identity.email` is on `example.com`, and `validate.ignore_paths` lists this `README.md`, which describes the example and is not a note of the vault. Its `privacy` section was later brought to what `init` writes since 02/10/2026: `sensitive` at `save` for the three audiences, no `never_topics`, and an empty `third_party_keywords` in place of the eight phrases the pack used to ship (`update` adds and removes no key). The em dash that `init` writes into `lint.style.forbidden_chars` is spelled as the JSON escape `\u2014` (the same value), because this repository's tests accept no literal one, and the time stamps on the files `init` wrote carry the day it ran. The answers file, saved as `answers.json`, and the command (`path/to/kit` is your clone of the kit repository):

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
BRAIN_KIT_STATE_DIR=scratch/state node path/to/kit/bin/brain-kit.mjs init scratch/vault --from-answers answers.json
```

To check it, from the root of a clone of the kit repository:

```sh
node bin/brain-kit.mjs -C examples/minimal-vault validate
node bin/brain-kit.mjs -C examples/minimal-vault lint --base all
```

Both exit 0 with no finding (`--base all` makes `lint` read every note, not only what changed since the last merge). The test suite runs the same checks on a copy of this folder (`test/example-vault.test.mjs`) and also runs `update --check` on it, so a change to a rule, or to a template of a file the kit manages, fails the suite until the example is fixed. The folder is not part of the npm package.

What is deliberately missing: no connectors (transcripts, calendar, meeting notes and the morning briefing are off, so nothing here needs a login), no git history (to try `propose`, copy the folder out of the repository, run `git init -b main` there, commit everything, add any remote named `origin`, change a note, and run `propose "a summary" --only <the note> --dry`, which prints what it would do; `curate` is switched off here, and it needs the state directory that `init` writes on the machine that made a vault, so it does not run on a copy), no machine state (the `machine.json` that `init` writes lives in the state directory, outside any vault), no push-gate hook (`.githooks/pre-push` only means something in a clone with `core.hooksPath` set, and `brain-kit update --install-hook` installs it), and no `verified` stamp on any note, because that stamp enters only when a person merges a pull request.

All names in this vault are fictional: Ana, Ben Okafor, Example Studio and every `example.com` address are invented.
