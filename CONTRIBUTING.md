# Contributing

- Node.js >= 24, no runtime dependencies. If a change needs a package, open an issue first.
- Tests: `npm test` (node:test). Every guard gets a test named after the incident that
  created it, under `test/incidents/YYYY-MM-DD-<slug>.test.mjs`.
- Code, identifiers and docs in English. Message packs: `lang/pt-BR` is the reference,
  `lang/en` must mirror it key for key (a test enforces parity).
- Never commit personal data: no real names of third parties, no real e-mail addresses
  outside example domains. Example data uses the fictional owner "Ana" and `example.com`.
- Commits use conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`).
- Shell commands in code are always argument arrays (`execFileSync`), never strings.
- Maintainers: install the anti-leak push gate once per clone with `.githooks/install-gate`,
  and re-run it whenever the gate changes. It installs the hook AND the engine outside the
  working tree; pointing `core.hooksPath` at `.githooks` does not work on purpose. The
  gate stays quiet on a clean push and names its snapshot when that snapshot is stale or
  when it refuses, so a line from it is a line worth reading. See SECURITY.md.
