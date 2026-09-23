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
  guard. A match the push carries is refused whatever the working tree shows: in the
  history, in a tip hidden by an uncommitted edit, or on a branch that is not checked out.
  Its patterns are the generic credential shapes plus `privacy.secret_patterns` from the
  working tree's configuration, from every pushed tip, from every configuration the push
  carries that no remote-tracking reference holds yet, and from the default branch the
  clone knows. A branch that deletes a pattern and then violates it is refused whenever one
  of those still declares it. The configuration file's own content is read for credential
  shapes only, so a literal inside it is not refused. `brain-kit` is found on PATH only;
  the vault carries no package. `brain-kit init` installs it into a new vault, `brain-kit
  init --adopt` into an existing one, and `brain-kit update --install-hook` later.
- Every refusal the push gate makes for a match, in both gates, ends with what to do:
  rotate the credential, remove it from history, and follow `SECURITY.md`.
- `brain-kit init [dir] [--lang en|pt-BR] [--yes] [--from-answers <file>]` makes a new
  vault in an empty or new directory: the language skeleton, the configuration, the hook,
  a manifest of what the kit wrote, a git repository, and `machine.json` in the state
  directory, outside the vault. It refuses, writing nothing, a directory that is not empty,
  is a repository or is a vault; it never waits on a stdin that is not a terminal; it undoes
  everything it created when it fails halfway; and it commits only when told to, after
  `validate` and `lint` pass.
- `brain-kit init --adopt [dir]` brings an existing vault under the kit. It infers the
  configuration from the notes (collections and domains, per-type enums, table headings,
  the log, the stale policy, the confidentiality field and the directories that hold marked
  notes, plain dates) and prints every inference; then it writes only the configuration and
  a manifest recording every existing file as the person's, by path, plus `machine.json` outside the
  vault. The vault must be a git repository: a folder that is not one is refused, with
  nothing written, and told to write its `.gitignore` and run `git init` first; without git
  installed it says git is missing. The configuration is inferred from the same list the
  manifest records, so a folder or note git ignores contributes nothing to it. The manifest
  lists only what git would publish (tracked files, and untracked files that are not
  ignored), so a file the person ignored is never named in it. Then it installs the push gate, unless a
  hook of the person's own, a `core.hooksPath` pointing elsewhere or hooks in `.git/hooks`
  are already there: those are left exactly as they are, and it prints the one line that
  adds the gate to that hook. `--no-hook` skips the gate and says so. It never changes a
  note and never commits, and refuses a `.brain-kit` that is a link or a file before writing
  anything.
  `brain-kit --help` and init's refusal of a non-empty directory or a repository point to
  it. The manifest records the vault's language at its top level (optional, so an older
  manifest still reads). `validate` now refuses a `privacy.confidential_field` that names no
  declared boolean extension, since a misspelt one silently switched the privacy rule off.
- `brain-kit update [dir] [--check | --accept <path> | --install-hook]` refreshes the files
  the kit manages (the root contract files, the hook, and, in a vault `init` makes from now
  on, `.gitignore`) by checksum: one you have not edited is replaced
  with this kit's version; one you edited is never overwritten, and a newer version is
  written beside it as `<name>.brain-kit-new`; your notes are never touched. `--accept`
  records that you have dealt with an offered version, or that you removed a managed file on
  purpose. A seeded entry of the manifest (a note the person owns, from `init` or `adopt`)
  carries no hash, since `update` never reads one and the manifest is committed; a managed
  entry must carry one. A manifest with seeded hashes, written before, still reads, and the
  hashes are dropped the next time it is written. Line endings are compared as LF and kept as each file has them. It refuses,
  writing nothing, a manifest it cannot read or write safely, a kit older than the
  configuration's `kit_version`, and a `lang` that is not the language the vault was made
  in (the language the manifest records); after a run it sets `kit_version` to the running
  kit's. A new vault's `.gitignore` ignores offered and temporary files. `--install-hook`
  installs the push gate into a vault that does not have it, with the same care for a hook
  of the person's own; it exits 0 when installed or already there, 3 when it left something
  as it was, 1 when no gate can run there.
- `brain-kit doctor [dir] [--json] [--only <id,...>]` reports, check by check, whether this
  machine and this vault are ready for the kit: `node-version`, `git-present`,
  `default-branch-known`, `hooks-path`, `brain-kit-on-path`, `config-valid`,
  `manifest-valid`, `machine-valid`, `state-dir-resolves`, `state-dir-mode`, `kit-version`,
  `gh-present`, `claude-present` and `gitignore-node-modules`. It exits 1 when any check
  fails, and names the command that fixes each failure it can: a missing gate names
  `brain-kit update --install-hook`, and a manifest `update` would refuse is reported
  before `update` is run.
- The default output language of every command now follows the locale (`LC_ALL`, then
  `LC_MESSAGES`, then `LANG`; a value starting with `pt` is Portuguese) and falls back to
  English; it used to be Portuguese unless `BRAIN_KIT_LANG` said otherwise. `BRAIN_KIT_LANG`
  still wins, and an unsupported value is reported once.

### Phase 1, slice 1C: the git loop

- Two guards for every command that writes to a vault. The lock is a file in the state
  directory naming the holder's pid, host, command and start time; a second writer is
  refused at once, naming the holder, and a lock is replaced only when its host is this
  machine and its process no longer exists, by a rename that exactly one of several
  racing writers can win. The session snapshot records which paths were already dirty when
  a session began, and later splits what is dirty into what was there before and what
  changed since, without stashing, staging or writing anything in the vault.

## 0.0.1 (published on npm on 18/09/2026)

Phase 0: package skeleton, CLI router with exit codes, language packs (pt-BR reference, en),
config and machine schemas, maintainer anti-leak pre-push gate, Claude Code plugin manifest
and hook wiring (hooks are no-ops until Phase 1), CI, rationale and incidents docs.

The package is published on npm as `second-brain-kit` because the registry refused
`brain-kit`; the command, plugin and repository keep the name `brain-kit`.
