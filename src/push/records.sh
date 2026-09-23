#!/usr/bin/env bash
# brain-kit push enumeration: asks GIT what a push contains, and writes the
# answer as the record stream `brain-kit push-gate` scans (the protocol is
# RECORD_PROTOCOL in src/commands/scan-blobs.mjs).
#
# Usage, and the only caller: `brain-kit push-gate` (src/commands/push-gate.mjs)
# runs this with
#   bash <this file> <remote-name> <remote-url>
# and the pre-push reference lines git gave the hook on standard input. The
# record stream goes to standard output and NOTHING else does: every message
# goes to standard error. Exit 0 means the stream is the whole push; any
# other status means it is not, and the caller refuses without parsing it.
#
# WHY THIS IS A FILE OF ITS OWN (22/09/2026). This is the enumeration that
# used to be the second half of .githooks/pre-push, moved here unchanged so
# that the maintainer's gate and the gate brain-kit ships to other people run
# ONE copy of it. It is the most reviewed code in this repository: every
# comment below records a hole a previous round of review found in it, and
# the history of those rounds, (a) to (r), is still in the header of
# .githooks/pre-push. Where a comment below says "this loop" or "this file",
# it means this enumeration, wherever it lives. The same knowledge written
# twice is the defect the move exists to remove: one copy is the one
# somebody forgets.
#
# TRUST. This file decides what is scanned at all, so whoever can write the
# copy that runs decides what passes. push-gate runs the copy beside its own
# module, which for the maintainer's gate is the installed snapshot under the
# git directory (.githooks/install-gate): never the working tree, never the
# commit being pushed. A push that carries its own src/push/records.sh is
# scanned, not obeyed.
#
# Portability: bash 3.2 and a POSIX userland, the same bar as the hook.
set -u

# Also exported by the maintainer's hook. Set here as well because this
# file asks git what the push contains, and a caller that forgot to export
# it would have every one of the reads below answered by a `git replace`
# stand-in instead of the object git push really sends (see the hook's own
# note above its export).
GIT_NO_REPLACE_OBJECTS=1
export GIT_NO_REPLACE_OBJECTS

# The stream is the only thing on the caller's standard output, so it is
# kept on a descriptor of its own: fd 3 is the stream, and fd 1 is pointed
# at standard error for everything else. A stray line from any command
# below then lands where a person reads it, instead of inside the stream,
# where it would be a malformed record at best and a record at worst.
exec 3>&1 1>&2

if [ "$#" -ne 2 ] || [ -z "$1" ]; then
  echo "pre-push: the push enumeration expects exactly two arguments, <remote-name> <remote-url>, with a non-empty remote name; refusing rather than guessing which remote this push goes to." >&2
  exit 2
fi

ZERO='0000000000000000000000000000000000000000'
TAB="$(printf '\t')"
failed=0

# Scratch files. `mktemp -d` with an explicit template behaves the same in
# GNU and BSD userlands. Failing to create it refuses the push: no scratch
# space, no scan.
#
# The trap only cleans up here: the refusal half of the announcement is the
# hook's own EXIT trap, and this file's status is what reaches it.
records_exit() {
  if [ -n "${TMP_DIR:-}" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap records_exit EXIT

if ! TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/brain-kit-prepush.XXXXXX")"; then
  echo "pre-push: could not create a temporary directory; refusing to push." >&2
  exit 1
fi
LIST_FILE="$TMP_DIR/list"
PATHS_RAW="$TMP_DIR/paths.raw"
PATHS_FILE="$TMP_DIR/paths"
PAIRS_FILE="$TMP_DIR/pairs"
if ! printf '' > "$PAIRS_FILE"; then
  echo "pre-push: could not create the scan work list under $TMP_DIR; refusing to push." >&2
  exit 1
fi

# Seventh round, (k). Called wherever a record is appended to the work list.
# A partial work list is the most dangerous shape this hook can produce:
# truncated at a record boundary it parses perfectly, scans the prefix,
# finds nothing in it and exits 0, with every blob past the truncation
# never examined. Refusing here, rather than setting a flag and carrying on,
# also keeps a half-written list from ever reaching `scan-blobs` at all.
work_list_write_failed() {
  echo "pre-push: could not write the scan work list under $TMP_DIR; a partial list would scan part of this push and pass the rest unexamined; refusing to push." >&2
  exit 1
}

# Turns `git diff-tree --raw -z` output on standard input into one
# `<mode> <path>` record per entry, NUL-terminated, on standard output.
# Each raw entry is two NUL-terminated fields, an info field beginning with
# a colon and then the path; rename and copy detection is off (--no-renames
# below), which is what keeps that count at two. Anything else refuses: an
# info field that does not begin with a colon is the stray commit id some
# git versions print despite --no-commit-id, and an input that ends between
# the two fields is a truncated read. Neither may be guessed at, because a
# mis-paired record is a path scanned as if it were something else, or not
# scanned at all.
emit_diff_entries() {
  local info path rest mode
  while IFS= read -r -d '' info; do
    case "$info" in
      :*) ;;
      *)
        echo "pre-push: git diff-tree --raw produced a field that is not a tree entry; refusing rather than guessing which paths this commit changed." >&2
        return 1
        ;;
    esac
    if ! IFS= read -r -d '' path; then
      echo "pre-push: git diff-tree --raw output ended in the middle of an entry; refusing rather than scanning part of this commit." >&2
      return 1
    fi
    rest="${info#:}"
    mode="${rest#* }"
    mode="${mode%% *}"
    printf '%s %s\0' "$mode" "$path" || return 1
  done
  return 0
}

# The same, for `git ls-tree -r -z` (a root commit, which has no parent to
# diff against). Each entry is one NUL-terminated field: `<mode> <type>
# <sha>` then a TAB then the path. The split is at the FIRST tab, so a path
# that itself contains a tab survives intact.
emit_tree_entries() {
  local entry meta path mode
  while IFS= read -r -d '' entry; do
    case "$entry" in
      *"$TAB"*) ;;
      *)
        echo "pre-push: git ls-tree produced an entry with no path in it; refusing rather than guessing what this commit contains." >&2
        return 1
        ;;
    esac
    meta="${entry%%$TAB*}"
    path="${entry#*$TAB}"
    mode="${meta%% *}"
    printf '%s %s\0' "$mode" "$path" || return 1
  done
  return 0
}

# 18/09/2026: a ref the remote does not have yet (remote_sha = zero) used to
# scan `git rev-list "$local_sha"`, the entire history. That is right for a
# brand new repository's first push, but wrong for any later new ref: pushing
# the release tag v0.0.1, which points at an already-published commit, made
# this re-scan all history and refuse the push over a fixture that lives in
# commits already public on the remote. Re-scanning published commits
# protects nothing and blocks routine pushes.
#
# 18/09/2026, second lesson: the first fix scoped every ref, new or update, to
# `--not --remotes=origin`, trusting the local refs/remotes/origin/* tracking
# refs as a stand-in for what the remote has. Those tracking refs are only a
# cache, last written by this clone's own previous push or fetch. A remote
# rewound or rewritten from another clone can leave that cache claiming
# commits the remote does not hold any more, and excluding by it would let a
# leak inside one of those commits reach the remote unscanned. Only two
# sources are authoritative, because both come from asking the remote itself,
# right now: the live push negotiation git already ran for us (the remote_sha
# on stdin, for a ref the remote already has) and a live `git ls-remote`
# against the remote (for a ref the remote does not have yet). The tracking
# refs are never trusted for exclusion again. `query_remote` below runs that
# `ls-remote` at most once per hook invocation, so a push carrying several new
# refs (e.g. `git push --tags`) does not repeat the network call. If the
# remote cannot be reached to ask, fail closed: scan the whole history rather
# than assume it is safe to skip anything.
remote_name="$1"
# 22/09/2026: ASK THE DESTINATION, NOT THE NAME. `git ls-remote <name>`
# asks the remote's FETCH url, and git does not always push there: a
# `pushurl`, a second `url` (git then runs this hook once per url) and a
# `url.<base>.pushInsteadOf` rewrite all send the push somewhere else, and
# git hands that real destination to the hook as its second argument. The
# exclusions below were computed from the fetch url, so a new branch whose
# commits the fetch url already held was excluded commit by commit and
# reached the destination unscanned, with "nothing matched", on this gate
# and on every version of it before. Measured with a pushurl pointing at an
# empty repository. The destination is what receives the objects, so it is
# the only answer to "what does the remote already have". The name is used
# only when git gave no url at all, which a hook never sees; a caller that
# passes an empty url gets the name's fetch url, the old behaviour, rather
# than an ls-remote of nothing that would fall back to a full scan.
remote_url="${2:-$remote_name}"
remote_url_given=0
if [ -n "$2" ]; then
  remote_url_given=1
fi
remote_queried=0
remote_reachable=0
remote_rewritten=0
remote_exclusions=()

query_remote() {
  [ "$remote_queried" -eq 1 ] && return 0
  remote_queried=1
  local raw sha ref resolved asked
  # 22/09/2026, the same day: THE URL GIT GAVE IS REWRITTEN AGAIN. git hands
  # this hook the destination after its own rewriting, and ls-remote treats
  # that url as a FETCH url and applies `url.<base>.insteadOf` to it once
  # more. The documented way to read from a mirror and push upstream
  # (`url.<mirror>.insteadOf = <upstream>` with an identity
  # `url.<upstream>.pushInsteadOf = <upstream>`) therefore had ls-remote ask
  # the mirror, and a branch only the mirror held reached upstream unscanned
  # with "nothing matched". A chain (a pushurl that one insteadOf maps to a
  # url a second insteadOf maps elsewhere) does the same. So ls-remote is
  # first asked where it WOULD go, and when that is not the url git is
  # pushing to, nothing it could say is about the destination: the remote
  # is treated as unknown and the whole history is scanned. Overriding the
  # rule with `-c url.<dest>.insteadOf=<dest>` was measured and does not
  # work: it ties with a rule whose value is the whole url, and the user's
  # rule wins. Only when git gave a url; the name fallback is a fetch url
  # by definition.
  if [ "$remote_url_given" -eq 1 ]; then
    asked="$(git ls-remote --get-url "$remote_url" 2>/dev/null)"
    if [ "$asked" != "$remote_url" ]; then
      remote_rewritten=1
      return 0
    fi
  fi
  if ! raw="$(git ls-remote --heads --tags "$remote_url" 2>/dev/null)"; then
    remote_reachable=0
    return 0
  fi
  remote_reachable=1
  while IFS=$'\t' read -r sha ref; do
    [ -z "$sha" ] && continue
    resolved="$(git rev-parse -q --verify "${sha}^{commit}" 2>/dev/null)"
    if [ -z "$resolved" ]; then
      resolved="$(git rev-parse -q --verify "${sha}^{}" 2>/dev/null)"
    fi
    [ -n "$resolved" ] && remote_exclusions+=("^$resolved")
  done <<< "$raw"
}

# The whole history of a ref, scanned when nothing authoritative can narrow
# it down. It must never learn to exclude by the local tracking refs: this
# is the branch the second lesson's own test does not reach, and putting a
# `--not --remotes=<remote>` back here is a one-line edit that walks a leak
# onto the remote with the rest of the suite still green. An empty result
# here is only safe when the command that produced it succeeded, which is
# the third lesson, so the status is read.
full_history() {
  if ! git rev-list "$1"; then
    echo "pre-push: could not list the history of $1 (git rev-list failed); refusing rather than scanning nothing." >&2
    return 1
  fi
  return 0
}

ref_number=0

# THE FIFTH TIME, AND IT IS THIS LOOP'S OWN CONDITION.
#
# `while read ... ; do` stops when `read` returns non-zero, and `read`
# returns non-zero for a final line that has no newline after it, AFTER
# having assigned the fields it managed to read. So an input whose last
# line is unterminated is one whose last reference is silently dropped:
# not one channel of it, all six, with exit 0 and no output at all. This
# is the same shape as the four empty-means-nothing findings this file's
# own history already records, and it is the widest of them, because it
# skips a whole reference rather than one thing about one.
#
# Measured on this gate before the guard: an unterminated line naming a
# reference that matches a pattern exits 0 and says nothing, while the
# same line with a newline after it refuses. Git itself terminates every
# line it writes here, so this is latent rather than live, and it is
# guarded anyway, because "the producer always does X" is what the other
# four findings all assumed about something.
#
# `|| [ -n "${local_ref:-}" ]` runs the body one last time for that
# partial line. A partial line with fewer than four fields leaves the
# later variables empty, and an empty destination name is something the
# engine refuses outright rather than scans, so a truncation cannot turn
# into a reference that passes.
while read -r local_ref local_sha remote_ref remote_sha || [ -n "${local_ref:-}" ]; do
  # (q). Every reference gets a NUMBER, and from here down this file names
  # references by that number and never by their text. The number is what
  # makes a finding actionable without printing the thing that was found:
  # "reference #2 of this push" tells the maintainer which line of their
  # own push to look at, and tells a log reader nothing. Numbering starts
  # at 1 and counts the lines git wrote on this hook's standard input, in
  # the order git wrote them, which is the order the maintainer's own
  # refspecs produced.
  ref_number=$((ref_number + 1))
  ref_label="reference #$ref_number of this push"

  # (q). THE DESTINATION NAME IS A CHANNEL, and it is emitted before every
  # other record for this reference, because it is the one field that
  # reaches the remote whatever else this line turns out to carry. It is
  # the DESTINATION ($remote_ref), not the source: see the note above the
  # record protocol in scan-blobs for why the source is deliberately not
  # scanned. Deletions included, and that is not a formality: a deletion
  # transmits its destination name with no objects behind it at all, and
  # git does not require the ref to exist remotely first, so
  # `git push origin :refs/heads/<a name>` publishes that name to the
  # receiving end (its logs, its receive hooks) and nothing else. It is
  # the cheapest leak this gate has ever had to cover, which is exactly
  # why it is covered before the deletion skip below rather than after it.
  printf 'ref\0%s\0%s\0' "$ref_number" "$remote_ref" >> "$PAIRS_FILE" || work_list_write_failed

  # A deletion carries no OBJECTS, so there is genuinely nothing more here
  # to read: it is the skipping side of this gate's own rule, and like the
  # other one (a gitlink, in scan-blobs) it says so out loud rather than
  # passing in silence. A skip nobody can see reads exactly like a scan
  # that found nothing, and this gate has shipped that confusion before.
  # The destination NAME of this same deletion was recorded just above and
  # is scanned like any other, so this skip is about objects only.
  if [ "$local_sha" = "$ZERO" ]; then
    echo "pre-push: skipping the objects of $ref_label: this push deletes that reference, and a deletion carries no objects, so there is nothing here to read. Its destination name is still scanned." >&2
    continue
  fi


  # The tip itself, for `scan-blobs` to examine as an object rather than as
  # a commit: an annotated tag carries a message and a tagger identity that
  # exist nowhere in any commit (seventh round, (h)).
  printf 'tip\0%s\0' "$local_sha" >> "$PAIRS_FILE" || work_list_write_failed

  # (p). Everything below this point is about COMMITS: a range, a history,
  # a diff against parents. None of it is meaningful for a ref that names
  # a blob or a tree, and `git rev-list` does not say so, it exits zero
  # and prints nothing, which this loop used to read as an empty range and
  # a clean push. So the question is asked outright, before any command
  # whose silence could be mistaken for an answer.
  #
  # `^{}` peels a chain of tag objects down to the object it finally
  # names, and returns that object whatever kind it is; an empty result
  # means git could not resolve the ref at all. Either way this loop does
  # NOT refuse here and does not pass anything either: the `tip` record
  # above already names the object, and scan-blobs reads it by type, scans
  # a blob's content and a tree's paths and contents, and refuses a type
  # it does not know or an object it cannot read. The refusal belongs
  # there, once, rather than in two places that could come to disagree.
  peeled=""
  peel_type=""
  peeled="$(git rev-parse -q --verify "${local_sha}^{}" 2>/dev/null || true)"
  if [ -n "$peeled" ]; then
    peel_type="$(git cat-file -t "$peeled" 2>/dev/null || true)"
  fi
  if [ "$peel_type" != "commit" ]; then
    echo "pre-push: $ref_label does not point at a commit (it names $(if [ -n "$peel_type" ]; then echo "a $peel_type"; else echo "an object this clone cannot resolve"; fi)), so there is no commit range to scan here; the object itself is examined directly." >&2
    continue
  fi

  if [ "$remote_sha" != "$ZERO" ]; then
    # The remote already has this ref, and git just told us so, live, as part
    # of this very push negotiation. Scan exactly what is new since then.
    #
    # 18/09/2026, third lesson: remote_sha is authoritative about what the
    # remote has, but that says nothing about what THIS clone has. A clone
    # that is stale-behind (another clone pushed, or force-pushed, without
    # this one ever fetching) can be asked to range over a remote_sha whose
    # object it does not possess at all. `git rev-list A..B` then fails
    # ("Invalid revision range") with empty stdout, which used to look
    # exactly like "nothing to scan": the loop below ran zero times, `failed`
    # stayed 0, and the push went through completely unscanned. An empty
    # result must never be read as "safe"; only a range that actually
    # computed is. Capture the exit status and fail closed into a full scan
    # when the range itself could not be computed.
    if ! commits="$(git rev-list "$remote_sha..$local_sha" 2>/dev/null)"; then
      echo "pre-push: the remote's reported commit for $ref_label ($remote_sha) is unknown to this clone; scanning the entire history of that reference instead of trusting that range." >&2
      if ! commits="$(full_history "$local_sha")"; then
        exit 1
      fi
    fi
  else
    # A ref the remote does not have yet: ask the remote directly what it
    # holds (once per hook run) instead of trusting the local tracking refs.
    query_remote
    if [ "$remote_reachable" -eq 1 ]; then
      # The ${arr[@]+"${arr[@]}"} form, not "${arr[@]}": an empty array under
      # `set -u` aborts the script in bash 3.2 (fifth lesson, (f)).
      if ! commits="$(git rev-list "$local_sha" ${remote_exclusions[@]+"${remote_exclusions[@]}"})"; then
        echo "pre-push: could not list what $ref_label adds to remote '$remote_name' (git rev-list failed); refusing rather than scanning nothing." >&2
        exit 1
      fi
    elif [ "$remote_rewritten" -eq 1 ]; then
      echo "pre-push: the url this push goes to for remote '$remote_name' is rewritten by a url.<base>.insteadOf rule when it is asked what it holds, so the answer would describe another repository; scanning the entire history of $ref_label instead." >&2
      if ! commits="$(full_history "$local_sha")"; then
        exit 1
      fi
    else
      echo "pre-push: could not query remote '$remote_name' (git ls-remote failed); scanning the entire history of $ref_label instead of trusting the local tracking refs." >&2
      if ! commits="$(full_history "$local_sha")"; then
        exit 1
      fi
    fi
  fi

  while IFS= read -r commit; do
    [ -z "$commit" ] && continue

    # The commit's own message and identities, scanned by `scan-blobs`
    # (seventh round, (h)); it reads them itself, in one batched git call,
    # and dedupes a commit reachable from more than one pushed ref.
    printf 'commit\0%s\0' "$commit" >> "$PAIRS_FILE" || work_list_write_failed

    if git rev-parse -q --verify "$commit^" >/dev/null 2>&1; then
      # `-m` (fourth lesson, (a)): without it a merge commit diffs to nothing
      # and is never scanned. With it diff-tree emits one diff per parent, so
      # any path differing from any parent is listed, and the dedupe below
      # keeps a path from being scanned once per parent.
      #
      # `--diff-filter=d` (fifth lesson, (d)): exclude deletions, keep every
      # other kind of change, typechanges included.
      #
      # `--raw` rather than `--name-only` (seventh round, (h) and (j)): the
      # entry's destination MODE has to travel with its path, because a
      # gitlink is the one entry with nothing in this repository to read.
      # `--no-renames` keeps every raw entry at exactly one path, whatever
      # diff.renames is set to in this clone's configuration.
      #
      # Some git versions print the commit id as a field of its own here
      # despite --no-commit-id. That is NOT harmless and the old comment
      # here was wrong to call it so: it would shift the field pairing for
      # every entry of that commit. `emit_diff_entries` refuses on a field
      # that is not a tree entry, so such a git version would refuse loudly
      # rather than mis-pair quietly, which is the right way round.
      if ! git diff-tree -m -r -z --no-renames --no-commit-id --raw --diff-filter=d "$commit" > "$LIST_FILE"; then
        failed=1
        echo "pre-push: could not list the files of $commit (git diff-tree failed); refusing instead of scanning nothing." >&2
        continue
      fi
      if ! emit_diff_entries < "$LIST_FILE" > "$PATHS_RAW"; then
        failed=1
        echo "pre-push: could not read what $commit changed; refusing instead of scanning nothing." >&2
        continue
      fi
    else
      # Root commit: it has no parent to diff against, so every file it
      # introduces is new to the remote.
      if ! git ls-tree -r -z "$commit" > "$LIST_FILE"; then
        failed=1
        echo "pre-push: could not list the files of $commit (git ls-tree failed); refusing instead of scanning nothing." >&2
        continue
      fi
      if ! emit_tree_entries < "$LIST_FILE" > "$PATHS_RAW"; then
        failed=1
        echo "pre-push: could not read what $commit contains; refusing instead of scanning nothing." >&2
        continue
      fi
    fi

    # Dedupe without an associative array (fifth lesson, (f)). `sort -zu`
    # keeps the NUL separation, so paths with spaces or newlines survive. The
    # dedupe is an optimisation, not a safety property: if sort cannot do it,
    # or produces nothing out of something, scan the raw list instead,
    # duplicates included. Noisier, never blinder. The copy's own status is
    # read, because a fallback that fails silently is the hole it replaced.
    if ! LC_ALL=C sort -zu < "$PATHS_RAW" > "$PATHS_FILE" 2>/dev/null; then
      if ! cat "$PATHS_RAW" > "$PATHS_FILE"; then
        failed=1
        echo "pre-push: could not build the file list of $commit; refusing instead of scanning nothing." >&2
        continue
      fi
    elif [ -s "$PATHS_RAW" ] && [ ! -s "$PATHS_FILE" ]; then
      if ! cat "$PATHS_RAW" > "$PATHS_FILE"; then
        failed=1
        echo "pre-push: could not build the file list of $commit; refusing instead of scanning nothing." >&2
        continue
      fi
    fi

    while IFS= read -r -d '' entry; do
      [ -z "$entry" ] && continue
      mode="${entry%% *}"
      path="${entry#* }"
      # Handed to `brain-kit scan-blobs` below, once for the whole push:
      # NUL-terminate every field so a path carrying a space, or even a
      # literal newline, still round-trips exactly.
      printf 'blob\0%s\0%s\0%s\0' "$commit" "$mode" "$path" >> "$PAIRS_FILE" || work_list_write_failed
    done < "$PATHS_FILE"
  done <<< "$commits"
done

# A push git described with no references at all. Nothing is updated, so
# nothing is published and nothing is the right answer; it is the skipping
# side of this gate's own rule and it says so, because every other time
# this gate has let an empty result stand in silence it turned out to be
# standing in for something. It is also the one line that would appear if
# git ever handed this hook an empty list for a push that does something.
if [ "$ref_number" -eq 0 ]; then
  echo "pre-push: git listed no references for this push, so there is nothing here to scan; the patterns file is still checked below." >&2
fi

# The stream is handed over ONLY when it is the whole push. A caller reads
# this file's status before its output, and a failed enumeration writes no
# stream at all, so there are two independent reasons a prefix of a push is
# never scanned as if it were all of it.
if [ "$failed" -ne 0 ]; then
  exit 1
fi
if ! cat "$PAIRS_FILE" >&3; then
  echo "pre-push: could not hand the scan work list to the scanner; a partial list would scan part of this push and pass the rest unexamined; refusing to push." >&2
  exit 1
fi
exit 0
