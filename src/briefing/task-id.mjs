// The prefix of the id of the morning briefing's desktop task
// (`brain-kit-briefing-<vault_id>`), defined once for the two modules that
// need the literal: src/commands/schedule.mjs, which builds the id and
// re-exports this constant, and src/sources/transcripts-claude-code.mjs,
// whose self-trace filter reads it in the `name` of the envelope the
// desktop application wraps a scheduled task's prompt in (docs/incidents.md,
// 01/10/2026). The transcripts source cannot import schedule.mjs, which
// imports it, so the literal lives here and imports nothing.
export const BRIEFING_TASK_PREFIX = 'brain-kit-briefing-';
