---
type: guide
title: Conventions
description: How notes in this vault are named, dated, linked and laid out, so every agent and person writes them the same way.
generated:
  by: process:brain-kit-init
  at: 2026-09-22T00:00:00+00:00
---

# Conventions

## Files

- File names are lowercase, with words joined by hyphens: `weekly-rhythm.md`.
- Every directory has an `index.md` that links the notes inside it. An index carries no frontmatter.
- A new note starts from its collection's template in [templates/](templates/index.md).

## Frontmatter

Every note starts with OKF v0.2 frontmatter:

- `type` (required): what the note is, such as `person`, `project` or `decision`.
- `title` and `description`: a name and one sentence saying what the note holds.
- `generated`: `by` (who wrote it) and `at` (when), an ISO 8601 datetime with its UTC offset, such as `2026-01-31T09:00:00+00:00`.

Actors in `generated.by`: the owner is `human:` followed by their handle; an agent is `brain-kit-curator/` followed by its model; a scheduled run is `process:brain-kit-curate`; the notes `brain-kit init` created carry `process:brain-kit-init`.

A note's own state goes in `stage` (a decision `open` or `done`, a project `active` or `archived`), never in `status`, which the format reserves for a note's life cycle: `draft`, `stable` or `deprecated`.

## Links

- Links are relative to the note that holds them: `../people/index.md`, `other-note.md`.
- Never start a link with a slash, and never use a wiki link in double brackets.

## Tables

The column headings of [pending/follow-ups.md](pending/follow-ups.md), [pending/promises.md](pending/promises.md) and [core/weekly-rhythm.md](core/weekly-rhythm.md) are an interface between the agent and the note. Rename a heading in the configuration and the note together, or not at all.

## The log

[memory/log.md](memory/log.md) has one heading per day, most recent first, and each entry starts with a bold marker: **Capture**, **Promoted**, **Correction** or **Creation**.
