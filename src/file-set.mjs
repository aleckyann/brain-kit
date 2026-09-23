// The set of files `validate` and `lint` judge: the one place that decides
// it, for both commands.
//
// INSIDE A REPOSITORY, WHAT GIT PUBLISHES; OUTSIDE ONE, THE FOLDER. The
// adopter's push gate runs both commands on every push, and both used to
// judge the folder walk whatever git said, so one note git ignores (a
// local draft, a scratch file) failed them and refused every push of a
// branch that did not carry it. Inside a repository the set is now the
// walk's files that git also lists as publishable (src/git.mjs,
// publishablePaths: tracked, plus untracked files git does not ignore),
// the same list the `secrets` rule and `adopt` already read. Outside one
// there is no git to ask, and the set is the walk, as it always was.
//
// Why the walk AND git's list, rather than git's list alone: the walk is
// still the one truth about what belongs to the vault (src/vault.mjs,
// defect 4), and it carries exclusions git knows nothing about. A path
// must pass both: the walk's own rules (dot-paths, node_modules,
// validate.ignore_paths, a symbolic link out of the vault or to a
// directory) and git's (ignored, or held by another repository: a
// submodule, or an untracked directory with a repository of its own,
// which git lists as one entry rather than its files). Each command still
// walks ONCE and asks git ONCE, and hands both results here.
//
// PROVE THE LIST DESCRIBES THIS VAULT BEFORE BELIEVING IT. A vault root
// can sit inside a repository that ignores it whole: a home directory
// kept under git with everything ignored, or a tree extracted into a
// directory some repository ignores. git answers "nothing is published"
// there, with status zero, and the checks would judge nothing and pass.
// The vault's own index.md is the proof: the walk found it (it is half of
// the vault sentinel, src/vault.mjs), so a list that does not carry it is
// not a list of this vault, and the set is the walk, said as such.
import { publishablePaths } from './git.mjs';
import { hasDotSegment } from './vault.mjs';

const ROOT_INDEX = 'index.md';

// Asks git once, and turns a failure into a value rather than an escape,
// so each command decides how to refuse over it. Neither git's own message
// nor the command line is kept, only the exit status, so no absolute path
// can ride out on it.
//
// `{ listed }` inside a repository whose list carries the vault's own
// index.md; `{ listed: null, reason: 'outside-repo' }` outside one;
// `{ listed: null, reason: 'vault-not-listed' }` inside a repository whose
// list does not carry it (see this module's header); `{ failure }` when
// git could not produce the list at all.
export function listPublishable(root, { list = publishablePaths } = {}) {
  let listed;
  try {
    listed = list(root);
  } catch (error) {
    return { failure: { status: error.status ?? null } };
  }
  if (listed === null) return { listed: null, reason: 'outside-repo' };
  if (!listed.files.includes(ROOT_INDEX)) return { listed: null, reason: 'vault-not-listed' };
  return { listed };
}

// The set the note-reading rules judge (every validate rule, and every
// lint rule but `secrets`), from the one walk and the one listing:
//
//   { source: 'git', files, unpublished }  the walk's non-dot files git
//                                          lists; `unpublished` counts the
//                                          ones it does not, so the report
//                                          can say they were not read.
//   { source: 'walk', reason, files }      the walk's non-dot files.
//   { source: 'walk', reason: 'listing-failed', failure, files }
//                                          git could not list. `files` is
//                                          the walk's, and each caller
//                                          must refuse over `failure`:
//                                          validate exits 1 without
//                                          judging anything, and lint
//                                          reports a defect, so its run is
//                                          degraded whatever the note
//                                          rules find in the walk (which
//                                          they still read, so the other
//                                          rules keep reporting, as they
//                                          did before this set existed).
//
// Dot-paths are dropped here whatever the walk was asked for: lint walks
// them outside a repository for the `secrets` rule alone.
export function noteFileSet(walked, listing) {
  const candidates = walked.filter((path) => !hasDotSegment(path));
  if (listing.failure) return { source: 'walk', reason: 'listing-failed', failure: listing.failure, files: candidates, unpublished: 0 };
  if (listing.listed === null) return { source: 'walk', reason: listing.reason, files: candidates, unpublished: 0 };
  const published = new Set(listing.listed.files);
  const files = candidates.filter((path) => published.has(path));
  return { source: 'git', files, unpublished: candidates.length - files.length };
}

// The one line each command prints about the set it judged, through the
// translator it was given. Both commands say the same thing about the
// same decision, so the sentence lives with the decision.
export function fileSetMessage(t, fileSet, noteCount) {
  if (fileSet.source === 'walk') {
    if (fileSet.reason === 'vault-not-listed') return t('file_set.walk_vault_not_listed', { count: noteCount });
    if (fileSet.reason === 'listing-failed') return t('file_set.walk_listing_failed', { count: noteCount });
    return t('file_set.walk_outside_repo', { count: noteCount });
  }
  if (fileSet.unpublished > 0) return t('file_set.git_with_unpublished', { count: noteCount, unpublished: fileSet.unpublished });
  return t('file_set.git', { count: noteCount });
}
