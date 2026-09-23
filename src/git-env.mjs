import { run } from './exec.mjs';

// The variables that make git act on a repository other than the one its
// working directory is in (`git rev-parse --local-env-vars`; this list is
// what it prints, and the live output is added to it at run time). With
// GIT_DIR exported, as dotfiles setups, some CI wrappers, every git hook
// and `rebase --exec` do, a git command run in a vault reads, configures
// or commits into THAT other repository instead. Anything the kit asks
// git about a vault is asked with these removed, so the answer is about
// the vault and nothing else.
//
// GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM are not on the list, on
// purpose: they choose which configuration files are the person's own,
// they do not move git to another repository.
export const LOCAL_GIT_VARS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
]);

export function withoutLocalGitVars(env, names = LOCAL_GIT_VARS) {
  const clean = { ...env };
  for (const name of names) delete clean[name];
  return clean;
}

// The fixed list plus whatever the installed git itself lists, so a git
// newer than this file that adds a variable still has it removed. The
// listing is asked with the fixed list already removed; a git that cannot
// answer leaves the fixed list, never an empty one.
export function localGitVarNames(env = process.env) {
  const listed = run('git', ['rev-parse', '--local-env-vars'], { env: withoutLocalGitVars(env) });
  const extra = listed.status === 0 ? listed.stdout.split(/\s+/).filter((name) => /^GIT_[A-Z0-9_]+$/.test(name)) : [];
  return [...new Set([...LOCAL_GIT_VARS, ...extra])];
}
