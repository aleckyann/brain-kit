# Contributing

- Node.js >= 22 (24 LTS is the one to develop on; CI runs the suite on both), no runtime
  dependencies. If a change needs a package, open an issue first. The two Node numbers are
  `MINIMUM_NODE_MAJOR` and `RECOMMENDED_NODE_MAJOR`, in `src/node-guard.mjs`;
  `test/node-minimum.test.mjs` fails when a place that states one (package.json, the README,
  the guides and the other docs, the CI matrix) says another.
- Tests: `npm test` (node:test). Every guard gets a test named after the incident that
  created it, under `test/incidents/YYYY-MM-DD-<slug>.test.mjs`.
- Code, identifiers and docs in English, except the two Portuguese documents below. Message
  packs: `lang/pt-BR` is the reference, `lang/en` must mirror it key for key (a test enforces
  parity).
- Never commit personal data: no real names of third parties, no real e-mail addresses
  outside example domains. Example data uses the fictional owner "Ana" and `example.com`.
- Commits use conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`).
- Shell commands in code are always argument arrays (`execFileSync`), never strings.
- Maintainers: install the anti-leak push gate once per clone with `.githooks/install-gate`,
  and re-run it whenever the gate changes. It installs the hook AND the engine outside the
  working tree; pointing `core.hooksPath` at `.githooks` does not work on purpose. The
  gate stays quiet on a clean push and names its snapshot when that snapshot is stale or
  when it refuses, so a line from it is a line worth reading. See SECURITY.md.
- Releasing: no tag without its CHANGELOG section and a re-stamped stage section in the
  README ("Em que pé está") and in both guides (`docs/guia.md` and `docs/guide.md`, "Status"),
  and the tag is annotated. `node scripts/release-notes.mjs check` and `npm test` enforce it;
  the checklist is in [docs/releasing.md](docs/releasing.md).
- Documents: `README.md` is the front door, in Portuguese; the complete guide is
  `docs/guia.md` in Portuguese and `docs/guide.md` in English. When a change makes a sentence
  of one of them untrue, fix it in each of the three that says it.
