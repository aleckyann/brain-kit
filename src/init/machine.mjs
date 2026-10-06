import { chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE_FILENAME } from '../config.mjs';
import { STATE_FILES, ensureStateDir, vaultIdFor } from '../state.mjs';
import { isWindows } from '../platform.mjs';
import { resolveClaudeBin } from './answers.mjs';
import { makeDirs, recordMode, writeNew } from './skeleton.mjs';

// The machine.json a vault gets on a machine that has never had state for it,
// and the one way it is written. Two commands do this and must not drift
// apart: `brain-kit init` (a new vault, or an adopted one) and
// `brain-kit machine register --new` (a vault that is already configured,
// opened on another machine).
//
// What init writes is only what the machine decides: the vault's identity
// and path, the claude found on PATH, and where the state lives. Every other
// key (model, network_check, notify_command, transcripts_dir, path_extra,
// log_retention_days, keep_stream) is absent, and the kit's default applies
// until `brain-kit machine set` writes one.

export const MACHINE_FILE_MODE = 0o600;

// `canonical` is the vault's real path, `stateDir` the physical path of its
// state directory.
export function buildMachine(canonical, stateDir, env) {
  return {
    vault_id: vaultIdFor(canonical),
    canonical_path: canonical,
    claude_bin: resolveClaudeBin(env),
    state_dir: stateDir,
    paths: {
      watermark: join(stateDir, STATE_FILES.WATERMARK),
      last_run: join(stateDir, STATE_FILES.LAST_RUN),
      log_dir: join(stateDir, STATE_FILES.LOG_DIR),
      questions_log: join(stateDir, STATE_FILES.QUESTIONS_LOG),
    },
  };
}

export function machineText(machine) {
  return `${JSON.stringify(machine, null, 2)}\n`;
}

// Creates the state directory (0700) and writes machine.json into it, a new
// file at 0600: created exclusively, so a machine.json that is already there
// is an error and never overwritten, and its mode set again after the write,
// so the process umask decides nothing. Everything created is recorded in
// `ledger`, for the caller to undo with rollback() when a later step fails.
// A state directory that already existed with another mode is tightened, and
// its old mode recorded in the ledger. Returns that old mode (null when the
// directory did not exist), so the caller can say it tightened it.
export function writeMachineFile(ledger, { stateDir, machine }) {
  const machinePath = join(stateDir, MACHINE_FILENAME);
  let priorMode = null;
  try {
    const st = statSync(stateDir);
    // On Windows the mode is no measure of who may open it (src/platform.mjs):
    // there is no old mode to tell, and the ACL is set below either way.
    if (st.isDirectory() && !isWindows()) priorMode = st.mode & 0o7777;
  } catch {
    // Absent: it is created below.
  }
  makeDirs(ledger, stateDir);
  if (priorMode !== null && priorMode !== 0o700) recordMode(ledger, stateDir, priorMode);
  ensureStateDir(stateDir, { tighten: true });
  writeNew(ledger, machinePath, machineText(machine), MACHINE_FILE_MODE);
  chmodSync(machinePath, MACHINE_FILE_MODE);
  return priorMode;
}
