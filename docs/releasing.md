# Releasing

The maintainer's checklist for cutting a version of brain-kit. It is not shipped in the
npm package.

Two promises sit behind it. Every tag says what was done in it: the CHANGELOG section of
the version is the specification of the tag, and the Release workflow publishes that
section as the body of the GitHub Release. And the documentation cannot fall behind a
release: the version in `package.json` must be the one the Status section of both READMEs
was last re-read for. `scripts/release-notes.mjs` checks both, `test/release-docs.test.mjs`
runs the checks on every `npm test` (and so in CI, on every push), and
`.github/workflows/release.yml` runs them again on the tag before it publishes anything.

An ordinary commit is never stopped by this. What stops is a version bump that left the
CHANGELOG heading, the READMEs' stamp or their latest-tag sentence behind, and a CHANGELOG
or README that was broken.

## Checklist

1. **Bump the six version fields**: `package.json`, `.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json`, `lang/en/config.defaults.json` (`kit_version`),
   `lang/pt-BR/config.defaults.json` (`kit_version`), and the CHANGELOG heading. Steps 1 to
   3 go into the same commit, named `chore: version X.Y.Z`: a commit that bumps the version
   without the CHANGELOG section, the stamp and the latest-tag sentence fails the suite.
2. **Write the specification.** In `CHANGELOG.md`, rename `## Unreleased` to
   ``## X.Y.Z (tagged `vX.Y.Z`, not on npm)``. The section must say what was done in this
   version: what a person who uses the kit sees change, why, and what is left out on
   purpose. It becomes the body of the Release, so write it for a reader who has not seen
   the commits, and put a placeholder such as `<folder>` in backticks with its command
   (GitHub reads it as an HTML tag: an element it does not know vanishes from the
   Release body and one it knows is drawn instead of shown; `changelog-raw-html` checks). Entries left
   under `## Unreleased` fail the tag check, so move them all; an empty `## Unreleased`
   heading above the new section is fine.
3. **Re-read the Status section of BOTH READMEs against reality** (`README.md` and
   `README.pt-BR.md`): the phase table, the point the current phase has reached, and the
   sentence about the latest tag and npm. Fix whatever is no longer true, then re-stamp both
   files with `<!-- status-reviewed: X.Y.Z -->` (the comment sits right under the Status
   heading) and update the sentence ``The latest tag is `vX.Y.Z`.`` and its Portuguese
   counterpart. The stamp is a claim that a person did this reading, and bumping the version
   without it fails the suite on purpose. Code blocks in the READMEs never name a tag or a
   tarball; the install snippets find the latest tag themselves.
4. **Run the gate and the suite**: `node scripts/release-notes.mjs check`, then
   `npm test`. The first prints one line per problem, `<check id>: <what is wrong and the
   fix>`, or `release check ok`.
5. **Push main and wait for CI to be green on GitHub.** The Release workflow does not wait
   for CI, so this is the step that keeps a broken tree from being tagged.
6. **Create an annotated tag**:

   ```bash
   git tag -a vX.Y.Z -m "brain-kit X.Y.Z: <one-line summary of what was done>"
   node scripts/release-notes.mjs check --tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The subject line becomes the title of the Release. A lightweight tag is refused, and so
   is an annotated one with an empty subject. The second command is the same check the
   workflow runs, run before the push.
7. **Let the Release workflow publish.** It runs only on the push of a tag named `v*`. It
   first fetches the annotated tag object again (on a tag push `actions/checkout` rewrites
   the tag as a lightweight one), then checks the tag (`check --tag`), builds the body from the CHANGELOG section of the version
   plus a last line `Full diff: <compare link>` to the previous tag, and creates the Release
   with `--verify-tag`. If a Release for the tag already exists it edits it with the same
   title and body, so running the job again is safe.
8. **Check the result**: `gh release view vX.Y.Z` shows the title and the body.
9. **Install locally** from the tag, as in "Installing a fixed version" in the README.

## The checks

| Id | What it refuses |
|---|---|
| `package-version` | `package.json` without a valid `X.Y.Z` version; every other check is relative to it, so it is reported alone |
| `changelog-section` | no `## X.Y.Z` heading (a suffix after the version is fine), two of them, a section with no text, a section over 120000 characters (GitHub refuses a Release body over 125000), or a CHANGELOG that ends inside an unclosed code fence |
| `changelog-order` | version headings not strictly descending by semver, a version twice, `## Unreleased` twice or below a version heading, any other level-two heading above the first version heading (`## [Unreleased]`, `## Unreleased (next)`, `## Unreleased:`) |
| `changelog-raw-html` | in the `## X.Y.Z` section only (older sections are history), text outside code fences and inline code spans that GitHub would read as an HTML tag (an element it does not know vanishes from the Release body, one it knows is drawn instead of shown): `<word>`, `<word attr>`, `</word>` or `<!--`. A placeholder such as `<folder>` goes in backticks, together with the command it belongs to. Autolinks (`<https://...>`, `<name@example.com>`), a backslash escape and a `<` followed by a space or a digit are fine |
| `status-stamp` | a README without exactly one `<!-- status-reviewed: X.Y.Z -->`, or one whose version is not the one in `package.json` |
| `status-latest-tag` | a Status section without the latest-tag sentence for this version, in either language |
| `install-literals` | a literal tag (`v1.2.3`) or tarball name in a fenced code block of either README |
| `tag-version` | with `--tag`: a tag that is not `v` plus the version in `package.json` |
| `tag-annotated` | with `--tag`: a tag that does not exist, is lightweight, or has an empty subject |
| `unreleased-empty` | with `--tag`: entries left under `## Unreleased` |

## When the workflow fails

Read the failing step's output first: a failed check prints its id and the fix.

The job runs the files of the tagged commit, the script and the workflow included, and a
re-run of a job uses that same commit. So a re-run helps only when the cause lies outside
the tree: a network error, a GitHub outage, an expired token. Run the job again from the
Actions page; nothing needs to be re-tagged, and the Release is created or edited, never
duplicated.

When the cause is in the tagged tree (an empty CHANGELOG section, a stale stamp, a broken
workflow file) or in the tag itself (lightweight, empty subject), a fix committed after the
tag is not in the re-run. For a version nobody has installed yet:

```bash
gh release delete vX.Y.Z --yes          # only if the workflow got as far as creating it
git push origin :refs/tags/vX.Y.Z       # delete the tag on GitHub
git tag -d vX.Y.Z                       # and here
```

then land the fix, wait for CI to be green and tag again from step 6. If the version was
already installed by anyone, do not move its tag: release the next patch version instead.
