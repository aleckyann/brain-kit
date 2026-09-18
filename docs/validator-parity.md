# Validator parity: the new engine against the original

Date: 18/09/2026.

The original vault's own validator has guarded a real, private second brain for
about two months. `test/parity.test.mjs` (opt-in, skipped unless
`BRAIN_KIT_PARITY_VAULT` names a directory, never run in continuous integration)
runs that original validator and this project's `brain-kit validate` over the
same reference vault and checks that the two agree, file by file.

This document is public. It never names the reference vault's own path, folder
names or filenames, and never quotes note content: a folder name would reveal a
taxonomy, a filename would reveal a person or a company. Every example below,
where one is needed, is invented in this project's own public fixture taxonomy
(`people/`, `projects/`, `decisions/`, `pending/`, `core/`, `memory/`,
`attachments/`, owner "Ana"), never in the reference vault's real one. What
follows carries counts and rule ids, nothing else.

## The two verdicts

**Original validator:** fully conformant. Every one of its 236 markdown files
passed every one of its 17 checks; no stale notes were reported either.

**New validator (`brain-kit validate`, configured to reproduce the reference
vault's house rules):** not conformant. 239 markdown files walked (three more
than the original sees; see defect 3 below), 65 findings total across 55
distinct files:

| Bucket | Count | Blocks the exit code? |
|---|---|---|
| Specification `must` | 3 | yes |
| Specification `should` | 54 | no (every one carries `warning: true`; see below) |
| House | 8 | yes |
| Tool defect (unrecognised finding shape) | 0 | - |

All 54 `should`-level findings are timestamp-form findings, downgraded to
warnings by `validate.timestamp_deviation: allow`, a setting this test's
configuration sets deliberately (the reference vault writes plain dates
throughout, where the specification requires an explicit UTC offset). The exit
code is still non-zero, driven by the 3 `must` findings and the 8 house
findings, neither of which the timestamp deviation setting can touch.

## Every divergence, and why

All 65 findings are accounted for by exactly three of the plan's four expected
defects. The fourth (a shared, single-exported walk versus the original's own,
untested one) has no per-finding shape to count; it is a structural claim, true
by construction of this project's `src/vault.mjs`, and is not double-counted
below.

### Defect 1: `stale_after` required a plain date where the format requires an offset

**46 findings**, one per note that carries a plain `YYYY-MM-DD` `stale_after`
value with no time and no offset. The original accepted this form outright
(its own check requires exactly a plain date and nothing else). The
specification's own text requires every timestamp-valued key, `stale_after`
included, to carry an explicit UTC offset. The new validator applies that
requirement uniformly and downgrades the resulting `should`-level finding to a
non-blocking warning for this vault, via the settled deviation setting.
**Improvement**, exactly as planned: a vault that follows the specification's
plain-date convention is no longer failed by a ruler claiming to speak for the
specification.

### Defect 2: placeholder text was exempted everywhere, not only under the templates directory

**19 findings across 8 files.** The original exempted any value containing an
angle bracket from every dated-field check, anywhere in the tree, and
separately exempted a pipe-separated list of choices from its one house enum
check. The new validator's placeholder exemption is deliberately narrower: it
applies only to files under the vault's configured templates directory, and
only to the `<...>` form.

- **6 files** are plainly templates (placeholder text throughout): five live
  under the vault's configured templates directory, one is a per-collection
  template kept outside it. Each carries a `generated.at` placeholder value in
  the `<...>` form, now reported as a `should`-level timestamp-form finding
  and downgraded to a warning by the same deviation setting as defect 1 (6
  findings). Two of those six also carry a `stale_after` placeholder in the
  same form, also downgraded (2 findings, already included in defect 1's
  count of 46 above, since both defects land on the identical check; the
  causes differ, the bucket does not).
- **2 files** carry a house-configured enum field (the reference vault's own
  house rule restricting one frontmatter field to a closed, five-value
  vocabulary for two note types) set to a pipe-separated placeholder list of
  the allowed choices rather than a real value. One of the two files lives
  under the configured templates directory but uses the pipe-separated form,
  which the configured placeholder pattern (the `<...>` form) does not
  recognise; the other lives outside the templates directory entirely. Both
  are reported as house-level enum findings (2 findings), which block the
  exit code: house findings carry no `warning` concept at all, unlike a
  specification `should`.

**Improvement**: a placeholder value that is not inside the vault's own
configured template convention, or not spelled in the one recognised form, is
now validated like any other note's value, rather than silently exempted
everywhere by a single "contains a `<`" rule that could just as easily hide a
real, malformed value in an ordinary note.

### Defect 3: one directory was excluded from the walk by a hard-coded name

**9 findings across 3 files.** A directory present on disk in the reference
vault, but outside version control (its own `.gitignore` excludes it, and the
original validator's walk also excludes it, by matching its exact name), holds
three markdown files with no frontmatter at all. The original never walks that
directory, by name, so it never saw these three files either way. The new
validator's always-ignored set is dot-entries and `node_modules` only;
everything else is `validate.ignore_paths`, which this run's configuration
deliberately leaves empty so this exact gap would surface. Each of the three
files produced one specification `must` finding (missing `type`, 3 findings)
and two house findings (missing `description`, missing `generated`, 6
findings).

**Improvement**: an adopter who wants a directory like this excluded now
configures it once, explicitly, rather than depending on a name this project
happened to hard-code for one vault. The reference vault itself has not yet
set `validate.ignore_paths` for this, because it has no configuration file for
this kit at all yet (adopting one is a later slice); this run's own
configuration deliberately did not add that entry either, specifically so this
comparison would show the gap rather than configure it away.

### Defect 4: the walk had no shared implementation and no test

Not a per-finding divergence. The original validator rolled its own directory
walk, privately, with no dedicated test of its own; a second private tool in
the same vault (its graph visualiser) implemented the walk independently and
disagreed with it about what belongs to the vault. This project's
`src/vault.mjs` exports one `walkVault` that every tool, including `validate`,
calls, and `test/vault.test.mjs` tests it directly. `test/parity.test.mjs`
itself is also the test this specific comparison never had before.
**Improvement**, structural rather than counted.

### Conclusion

Zero divergences remain unexplained. Every one of the 65 findings the new
validator produces on the reference vault, across all 55 affected files,
traces to one of the three defects above, each a deliberate, planned
improvement over the original. No defect in the new validator was found by
this comparison.

## Accepted divergences (machine-readable)

`test/parity.test.mjs` loads the block below to decide which divergences
between the two validators' output are expected. A finding is excused when it
matches one of these rules; anything else is a hard failure. `kind` is a
closed set the test interprets in code; this document supplies which rules are
active and why, never a file path.

```json
[
  {
    "kind": "downgraded-timestamp-warning",
    "ruler": "spec",
    "reason": "defect-1-timestamp-offset-and-defect-2-placeholder-scope",
    "improvement": true,
    "note": "A specification should-level timestamp finding downgraded to a warning by validate.timestamp_deviation never blocks the exit code. It is expected to differ from the original, which for this vault either required a plain date outright (defect 1) or exempted a placeholder value everywhere in the tree (defect 2)."
  },
  {
    "kind": "placeholder-shaped-value",
    "ruler": "house",
    "id": "extension-fields",
    "reason": "defect-2-placeholder-scope",
    "improvement": true,
    "note": "A house extension-field finding whose value still carries placeholder markup (an angle bracket, or a pipe-separated list of the allowed choices) is expected. The new validator's placeholder exemption is scoped to the configured templates directory and to the angle-bracket form, narrower on purpose than the original's blanket, tree-wide exemption."
  },
  {
    "kind": "excluded-directory",
    "reason": "defect-3-hardcoded-exclusion",
    "improvement": true,
    "note": "Any finding on a file under a directory the original excludes by a hard-coded literal name (present on disk but outside version control) is expected. The new validator's always-ignored set is dot-entries and node_modules only; everything else is validate.ignore_paths, which this comparison's own configuration deliberately leaves empty so this exact gap would surface rather than be configured away."
  }
]
```
