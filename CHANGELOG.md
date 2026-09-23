# Changelog

## Unreleased

Nothing below is on npm yet. It runs from a clone of the repository.

### Phase 1, slice 1A: the validator

- `brain-kit validate [path] [--json] [--only-problems]` checks a vault against OKF v0.2
  and reports the format's own conformance apart from the vault's house rules, so a vault
  that conforms to the format but departs from its own rules is told exactly that.
- A zero-dependency reader for frontmatter and markdown, with its limits declared in the
  output rather than hidden: it is a regular-expression reader, not a YAML parser.
- Checked against the original vault this kit is extracted from: every divergence from the
  validator that vault used before was traced to a known defect of the old one.

### Phase 1, slice 1B: the linter, the leak scanner and the push gates

- `brain-kit lint [path] [--rule ...] [--base auto|worktree|merge-base|all] [--json]` with
  eight rules: `index-completeness`, `orphans`, `columns`, `tables`, `style`, `secrets`,
  `privacy` and `attribution`.
- The `secrets` rule reads every file a push could publish, dot-files such as `.env`
  included and ignored files excluded, and is never narrowed by `--base`. Content and
  patterns are decoded the same way, so a pattern with accented letters matches.
- A leak scanner that fails closed when it cannot read its pattern list, never prints what
  it matched, and announces every ceiling it hits.
- The maintainer's push gate now lives outside the working tree, installed per clone by
  `.githooks/install-gate`. It scans seven channels of every object a push carries: file
  content, file names, commit messages, annotated tag messages, author and committer
  identities, reference names, and object headers. It reads the objects git will send,
  not a replaced stand-in, and says on every clean push that it ran.
- A template pre-push hook for a vault, which runs `validate` and `lint` and refuses a push
  to the default branch by the vault's automation identity.

### Phase 1, slice 1D: the gate that ships

- One push enumeration behind one command, `brain-kit push-gate`, which both gates call.
- The template hook for a vault now runs `validate`, `lint --base all`, then `brain-kit
  push-gate --patterns config` over the objects the push carries, then the automation
  guard. A credential that ever reached a commit is refused whatever the working tree
  shows: in the history, in a tip hidden by an uncommitted edit, or on a branch that is
  not checked out. Its patterns are the generic credential shapes plus
  `privacy.secret_patterns` from the working tree's configuration, from every pushed tip,
  and from the default branch the clone knows, so a branch that deletes a pattern and then
  violates it is still refused. `brain-kit` is found on PATH only; the vault carries no
  package. Nothing installs the hook into a vault yet.

## 0.0.1 (published on npm on 18/09/2026)

Phase 0: package skeleton, CLI router with exit codes, language packs (pt-BR reference, en),
config and machine schemas, maintainer anti-leak pre-push gate, Claude Code plugin manifest
and hook wiring (hooks are no-ops until Phase 1), CI, rationale and incidents docs.

The package is published on npm as `second-brain-kit` because the registry refused
`brain-kit`; the command, plugin and repository keep the name `brain-kit`.
