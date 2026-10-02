# Incident response

<!-- Maintainers: test/incident-response-doc.test.mjs checks every brain-kit command, flag, path, configuration key and doctor check id this page names against the code. Run it after you rename any of them. -->

Open this page when a secret or someone's personal data is in your vault, when the vault
repository was public, or when the curator did something it should not have. It is written to
be followed in order, once, under stress. Every `brain-kit` command on it exists. Where the kit
has no command for a step, the page says what to do by hand.

While you work, do not paste the secret or the personal data into a chat, an issue, a pull
request comment or a support ticket. Name commits by their hash and files by their path.

In every case, do [section 1](#1-the-rule-of-the-first-minutes) first. It takes a minute.
Then find your case:

- A password, token or key is in a commit: [section 2](#2-a-secret-is-in-a-commit).
- Someone's personal data is in the vault: [section 4](#4-a-third-partys-personal-data-is-in-the-vault).
- The vault repository was public: [section 5](#5-the-vault-repository-became-public-by-mistake).
- The curator did something you did not allow: [section 6](#6-the-curator-did-something-it-should-not-have).
- A pull request from a round is wrong: [section 7](#7-a-bad-pull-request-from-a-round).
- You think the kit has a flaw: [section 8](#8-a-flaw-in-the-kit-itself).

## 1. The rule of the first minutes

Anything that reached a remote is already copied. A push to a private repository, a branch you
deleted a minute later, a pull request you closed: the host still serves the commits by hash,
and clones, forks, caches and notifications may hold them. Act as if someone has read it.

Do three things, in this order:

1. **Rotate or revoke the secret.** Do it where it was issued, then put the new one wherever
   the old one was used. This is the only step that closes the exposure. The other two only
   limit the damage. Do not start with the history.
2. **Rewrite the history.** Sections 2 and 4 say how. It removes the readable copy you
   control. It does not take back what was already copied.
3. **Tell people.** Everyone who holds a clone or a fork, the owner of the service the secret
   opened, and, for personal data, whoever your legal adviser says must hear of it.

Rotate first even if you are not sure anyone read it. Rotating costs minutes. Write down the
time you found it and each thing you did, as you go; [section 9](#9-after-the-incident) needs it.

Personal data differs in one way: you cannot rotate it. For it, the removal in section 4 comes
first, and the history rewrite follows when the data is sensitive.

## 2. A secret is in a commit

If it was ever pushed, or you are not sure, rotate now ([section 1](#1-the-rule-of-the-first-minutes)).
Then find how far it went. Do not type the secret into a command, because your shell keeps a
history. Search by its shape:

```bash
git fetch --prune
git log --all --oneline -G'AKIA[0-9A-Z]{16}'   # use the shape of your secret
git branch -r --contains <hash>                # remote branches that hold a commit
```

The second command lists every commit on any branch that adds or removes a line matching the
shape, so the commit that added the secret and the one that removed it both show. The third
lists the remote branches (as of your last fetch) that contain a commit.
`brain-kit lint --rule secrets` names the file and line of a match in your working tree and
never prints the matched text.

| How far it went | Go to |
|---|---|
| Only in a commit on your machine | [2a](#2a-the-commit-was-never-pushed) |
| On a branch or in an open pull request, a curator's included | [2b](#2b-the-commit-is-on-a-branch-or-in-a-pull-request) |
| Merged into the default branch | [2c](#2c-the-commit-is-in-the-default-branch) |

### 2a. The commit was never pushed

No remote has it, so you can remove the commit. But "never pushed" is not "never left your
machine". If the secret was ever in a synced folder, a backup, a chat, or a file that a Claude
session or a curator round read (the text of what they read went to the model provider), treat
it as exposed: rotate it now ([section 1](#1-the-rule-of-the-first-minutes)).

1. If the secret is in the latest commit only: remove it from the file and run
   `git add <file>` (or run `git rm <file>`), then `git commit --amend`. Without the `git add`
   the amend reuses the old staged copy and the secret stays in the commit. If git says the amend
   would leave the commit empty, the commit only added that file: run `git reset HEAD~1` and
   delete the file.
2. If it is in an older commit you have not pushed: `git reset --soft <last good commit>`
   moves HEAD back and keeps your changes staged. Run `git restore --staged <file>`, remove the
   secret from the file or delete the file, run `git add <file>` for a file you edited, then
   commit again. The unpushed commits become one.
3. Check that `git log --all --oneline -G'<shape>'` prints nothing and that
   `brain-kit lint --rule secrets` finds nothing. `git show HEAD` must not show the secret
   either.
4. The old commit is still in `git reflog`, and its object stays in `.git` until the reflog
   entry expires, which takes weeks (git's defaults are 30 to 90 days). To drop it now:

   ```bash
   git stash list                        # the next command also empties the stash: save what you need first
   git reflog expire --expire=now --all
   git gc --prune=now
   ```

   This removes every recovery point, not only this one. Run it when your branches are as you
   want them.

### 2b. The commit is on a branch or in a pull request

1. Rotate or revoke the secret now ([section 1](#1-the-rule-of-the-first-minutes)).
2. Close the pull request without merging and delete its branch:
   `gh pr close <number> --delete-branch`. Do not put the secret in the closing comment. For a
   branch with no pull request, delete it on the host's branch list. A
   `git push origin --delete <branch>` also works, but the vault's pre-push hook runs `lint` on
   your working tree before every push, deletions included, so it is refused while your
   checkout still holds the secret.
3. The commits stay reachable by hash on the host after the branch is gone, and on GitHub a
   pull request keeps its own reference to its commits. Ask the host's support to run garbage
   collection on the repository and to drop the cached views of the pull request and of the
   commits. Give them the repository, the pull request number and the commit hashes. Never the
   secret. GitHub says it helps only where rotating the credential cannot remove the risk, so
   support may decline for a secret you have already rotated. That is one more reason to rotate
   first.
4. **Clean every clone that fetched the branch:** yours, the curator's machine, anyone's. A
   `git fetch` makes a remote-tracking ref (`refs/remotes/origin/<branch>`) that keeps the
   commit alive after the host has deleted the branch, and the page's own first command,
   `git fetch --prune`, makes one. In each clone run `git fetch --prune`, then check that
   `git branch -r --contains <hash>` prints nothing. Only then expire the reflog and collect
   garbage, as in step 4 of 2a: while that ref exists, the commit survives them.
5. **If the pull request came from the curator,** its machine keeps different things depending
   on how the proposal was made. This is the one place the page says it; sections 6 and 7 point
   here.
   - **A scheduled round** puts the files it proposed back to the default branch's content
     when it ends, and makes no local ref. Check that `leftovers` in `last-run.json` is
     empty. The pushed commit stays in that vault's `.git` as an object until step 4 and the
     garbage collection have run there.
   - **A `propose` outside a round** (an interactive session, the morning briefing) leaves the
     files modified in the working tree and makes a local ref that keeps the commit. Put the
     files back: `git restore -- <path>` for a tracked file, delete a new one. List the refs
     with `git for-each-ref refs/brain-kit/proposed/` and delete the one of that branch with
     `git update-ref -d <ref>`. The ref is named after the branch, with each `/` turned into
     `-`. Then do step 4 and the garbage collection.
6. Find out why the push was not refused. `brain-kit doctor --only hooks-path` says whether this
   clone runs the push gate at all, and the
   [appendix](#appendix-what-the-secret-checks-match-and-miss) says what the gate does not see.

### 2c. The commit is in the default branch

1. Rotate or revoke the secret now. Do not wait for the rewrite.
2. Stop the curator, so that it does not push from the old history while you work:
   `brain-kit schedule uninstall` ([section 6](#6-the-curator-did-something-it-should-not-have)
   has the details). If other people push to this repository, tell them to stop, in one line
   and without details.
3. Work in a fresh clone, with the procedure GitHub documents for this. The tool is
   `git filter-repo`, version 2.47 or later (it needs the `--sensitive-data-removal` option). It
   is not part of git: install it from <https://github.com/newren/git-filter-repo> or your
   package manager. In that mode it first fetches every ref from `origin`, including the ones
   outside branches and tags, so the rewrite reaches them too, and it records what it changed
   for the support request below. It refuses to rewrite a clone that is not fresh, and your old
   clone stays as the backup until you push.

   ```bash
   git clone https://example.com/ana/vault.git vault-clean
   cd vault-clean
   ```

   Remove a whole file from every commit:

   ```bash
   git filter-repo --sensitive-data-removal --invert-paths --path attachments/export.csv
   ```

   Replace text in every file of every commit. Put the rules in a file outside the repository,
   one per line. A rule written as a shape does not contain the secret:

   ```text
   regex:AKIA[0-9A-Z]{16}==>REMOVED
   ```

   ```bash
   git filter-repo --sensitive-data-removal --replace-text ../replacements.txt
   ```

   A rule can also be `literal:<the text>==>REMOVED`, but then that file holds the secret:
   delete it when you are done. `--replace-text` does not touch commit messages; use
   `--replace-message`, which takes the same rule syntax, for those. Keep the output of the run:
   you need it in step 8. Without `--sensitive-data-removal` the tool removes the `origin`
   remote on purpose; whichever way it ran, look at `git remote -v`, and if there is no
   `origin`, add it back with `git remote add origin <url>`.
4. Check the result before you push: `git log --all --oneline -G'<shape>'` prints nothing and
   `brain-kit lint --rule secrets` finds nothing. A fresh clone runs no push gate until
   `git config core.hooksPath .githooks` is set in it (`brain-kit doctor --only hooks-path`
   tells you). Set it, and the gate scans the commits the push sends, which after a rewrite are
   all of them.
5. Allow the force push. Branch protection on the default branch normally refuses it: in the
   host's settings, allow force pushes on that branch now, and turn the protection back on right
   after the push in step 6. Push under your own identity, never the curator's
   (`git.agent_identity`); the hook refuses that identity on the default branch.
6. Push, from the clone the rewrite produced and from no other. `git push --force --mirror
   origin` makes the remote match this clone exactly. It deletes on the remote every ref this
   clone lacks, so a branch pushed after the clone was made would be lost (step 2 asked everyone
   to stop pushing; keep it that way until this push is done), and it publishes every ref it
   finds here. Check, in this folder (`vault-clean`, not your old working clone, where you may
   find yourself after the host's settings page):

   ```bash
   git log --all --oneline -G'<shape>'   # must print nothing
   git for-each-ref refs/remotes/        # must print nothing
   ```

   If the first prints commits, stop: this is not the rewritten clone, or the rewrite is not
   finished. If only the second prints refs, they are this clone's remote-tracking refs, which
   `--mirror` would publish on the host; the first check has shown they hold no leak. Remove
   them, and run the second check again:

   ```bash
   git for-each-ref --format='%(refname)' refs/remotes/ | xargs -n 1 git update-ref --no-deref -d
   ```

   When both checks print nothing, push, the way GitHub documents it:

   ```bash
   git push --force --mirror origin
   ```

   If the push lists `refs/pull/...` refs as rejected, the host does not let you change them;
   only support can (step 8). Then turn the branch protection back on.
7. Close every open pull request and delete the branches they came from. The host keeps the
   old commits behind each pull request, and the curator will propose again. Every clone and
   every fork still has the old history, and so do the host's pull request references. A
   `git pull` in an old clone would merge the old history back, and the next push would
   publish the secret again. Tell each holder to save any uncommitted work, then delete the
   clone and clone again, and each fork's owner to delete the fork. A collaborator who has a
   branch made from the old history must rebase it onto the new history, not merge.
8. Ask the host's support for the garbage collection and the cache purge, as in step 3 of 2b.
   For this rewrite send them the repository, the number of pull requests it changed
   (`grep -c '^refs/pull/.*/head$' .git/filter-repo/changed-refs`), the "First Changed
   Commit(s)" the tool printed (also in `.git/filter-repo/first-changed-commits`), and the list
   of orphaned LFS objects if the run printed one. Support may decline if rotating the secret
   already removes the risk, as in step 3 of 2b.
9. Put the curator back, on the machine where the rounds run. The old clone there may hold the
   only copy of uncommitted notes, stashes, and the files a session's `propose` left modified,
   so do not delete it yet.
   - In the old clone run `git status` and `git stash list`, and copy out what you want to
     keep. Check what you copy for the secret.
   - Move the old clone aside: `mv vault vault-old` (use your own folder names). That is all
     `brain-kit machine register --from` asks for, since it refuses while the vault is still at
     the old path.
   - Clone the vault again, best at the same path: the curator's state (its logs, its marks) is
     kept under a name made from that path, so nothing needs registering. At another path, run
     `brain-kit machine register --from <old path>` in the new clone.
     If this machine has no state for the vault any more (it was rebuilt, or you deleted the
     whole state directory), there is nothing to carry over: run
     `brain-kit machine register --new` in the new clone instead. It writes a fresh
     `machine.json` and no watermark, so the first round reads only yesterday; set each
     source's mark with `brain-kit watermark set <source> <YYYY-MM-DD>` if you know the last
     day it had swept.
   - In the new clone run `git config core.hooksPath .githooks` (a fresh clone has no gate),
     then `brain-kit doctor` and `brain-kit schedule install`.
   - When `brain-kit doctor` is green on the new clone, delete the moved-aside old clone. It
     holds the old history.

#### Where a copy can hide

Go through this list after any rewrite. A copy in one of these places survives it.

- Forks of the repository (the host's fork list), and clones on other machines, in backups and
  in sync folders. The old clone on the curator's machine too, with any
  `refs/brain-kit/proposed/*` refs it holds: delete it once step 9 says it is safe to.
- Pull request descriptions and comments, issues, and the e-mail and chat notifications that
  quoted them.
- CI logs, caches and artifacts. Delete the runs and the caches on the host.
- The curator's state directory, outside the vault (`brain-kit machine show` prints it as
  `state_dir`). It survives a new clone of the vault. Its `logs/` folder holds the round logs.
  With `--keep-stream` (or `keep_stream` in `machine.json`) it also holds
  `logs/curate-<stamp>.stream.jsonl` and the round's digests, which contain what the model read,
  so a secret that was in a note or a session can be in them. Delete those files. Each round
  removes logs older than `log_retention_days` (30 by default) on its own, but you uninstalled
  the schedule. Two more copies sit there. `questions.log` is the briefing's question queue, one
  line of JSON per question, with the text of each: `brain-kit questions archive` keeps that
  text and no command deletes a question, so open the file and delete the line. And a
  `digests/` folder is the transcript text of a round that was killed outright (SIGKILL, a power
  cut): the next round would sweep it, and with the schedule uninstalled no next round runs, so
  delete the folder yourself.
- The Claude Code session where you typed or pasted the secret. Its transcript stays on that
  machine, under the folder `transcripts_dir` names (`~/.claude/projects` by default), and the
  curator builds its digests from transcripts.
- The model provider. A session you had with the secret in it, and a curator round that read a
  digest of it, sent that text to the provider. You cannot rewrite their side. Rotation is
  what makes it harmless. Ask the provider's support what it keeps and how to have it deleted,
  and do not count on the answer.

## 3. What the kit's own checks catch and miss

The kit checks for secrets in two places that share six key shapes: the `secrets` rule of
`brain-kit lint`, and the push gate, which applies them to what a push carries. Both are
pattern scanners.

**A clean result is not proof.** It means that no known shape was found in the files that were
read. It does not mean the vault holds no secret. Rotate on facts, not on a green `lint`.

The [appendix](#appendix-what-the-secret-checks-match-and-miss) lists what they match, where they
run and what they cannot see. Read it before you trust a clean result.

## 4. A third party's personal data is in the vault

This is the case where a person asks you to remove what the vault holds about them, or where
you find data you should not hold (someone's health, family or private life). The kit helps you
find and remove it. It does not tell you what you owe the person.

**What the person is owed.** Ask your own legal adviser, before you answer the person: what you
must remove, by when, what you must confirm to them, and whether anyone else must be told.
This page does not say, and it promises no legal outcome. Keep a dated record of what you
found and what you did.

1. **Stop the spread.** If the repository was shared or public, go to
   [section 5](#5-the-vault-repository-became-public-by-mistake) as well. If the curator keeps
   writing it back, pause it with `brain-kit schedule uninstall` until step 4 is done. Do not
   copy the data into an e-mail or a ticket to discuss it.
2. **Find every copy.** A name is not a secret, so here you may type it.
   - `grep -rIn -i "<name>" .` in the working tree. Try each spelling, nickname, e-mail
     address and phone number.
   - `git log --all --oneline -S"<name>"` for the commits that add or remove the text, and
     `git log --all --oneline -i --grep="<name>"` for commit messages.
   - `brain-kit lint --rule privacy`. It does not search for a name. It reports a link from
     outside `privacy.confidential_dirs` into a confidential note, a note marked with the field
     `privacy.confidential_field` names that sits outside those directories, and, when run
     against a change (`--base worktree` or `--base merge-base`), a line the change adds that
     holds a phrase from `privacy.third_party_keywords`. With `--base all` it does not check
     the phrases, and says so.
   - Look in the places a note about a person leaks into: the log (`memory/log.md` in the
     English skeleton), the index files, `pending/`, and open pull requests and branches.
   - Outside the vault: the curator's state directory, which holds the briefing's question
     queue (`questions.log`; `brain-kit questions list` shows it), the round logs and, if
     they were kept, the streams and digests, and any `digests/` folder a killed round left
     (section 2c, "Where a copy can hide"); and the sources the data came from, which are your
     Claude Code sessions, your calendar and your meeting notes.
3. **Remove it.**
   - Delete the note and every mention in other notes, in the log and in the indexes. Then run
     `brain-kit validate`: a link to the deleted note is reported as `link-target-exists`, so
     you see what is left.
   - Make the change by pull request and merge it, as for any change to the vault.
   - In the state directory, open `questions.log` and delete the line of any question that
     holds the data (`brain-kit questions archive` keeps the text, and no command deletes a
     question), and delete the stream, digest and log files that hold it.
   - If the data is sensitive, or the person asks for it, remove it from the history too, with
     the rewrite in 2c: `git filter-repo --sensitive-data-removal --invert-paths --path people/ana-example.md`,
     and a `--replace-text` file for the mentions in other notes. The same caveats hold: every clone
     and fork keeps the old history, and the host needs the cache purge.
   - Search again in a fresh clone.
4. **Stop it coming back.** The curator reads your Claude Code sessions, and your calendar and
   meeting notes when you turned them on. It will write the same fact again whenever it reads a
   day whose source still holds it, unless the source or the settings change. The options:
   - Edit the source: delete or change the calendar event, the meeting document or the
     transcript, if you are allowed to. It is the only change that removes the data where it
     starts.
   - `sources.transcripts.include_projects` lists the Claude Code projects a round may read,
     and `sources.transcripts.exclude_path_patterns` leaves paths out. Take the project out.
   - `sources.calendar.enabled` and `sources.meeting_notes.enabled` turn a source off. Under
     `sources.calendar`, `calendars` and `team_calendars` choose which calendars are read, and
     someone else's calendar is read only while `team_authorization` records who allowed it.
   - `privacy.sensitive` and `privacy.never_topics` decide what the curator records about
     personal and sensitive subjects, and by default it records everything. Once the note is
     deleted (step 3) the person counts as `outsiders`: set `privacy.sensitive.outsiders` to
     `skip`, which applies to everyone without a note, or list the subject in
     `privacy.never_topics`. Both are an instruction to the model, not a filter: keep reading
     what each round proposes.
   - `privacy.third_party_keywords` is a list of phrases, empty by default. `lint` refuses a
     line a change adds that holds one, and `propose` runs `lint`, so a round cannot publish
     such a line. It matches the phrase literally, so it stops a topic you name, not a person.
     The list lives in `brain-kit.config.json`, inside the repository: do not put the person's
     name in it if removing that name is the goal. `privacy.keyword_exempt_paths` does the
     opposite and exempts paths from the check: make sure it does not cover the note you
     removed.
   - `privacy.confidential_dirs` is where notes about people must live for the link rule to
     protect them.
   - `briefing.never_read` lists paths the morning briefing never opens.
   - `sources.calendar.privacy` (`exclude_event_types`, `exclude_keywords`,
     `team_personal_events`) filters nothing in a round: [connectors.md](connectors.md) says
     so. Do not rely on it.
   - Days the curator already read are not read again. Do not run `brain-kit watermark reopen`
     for a day whose source still holds the data ([section 7](#7-a-bad-pull-request-from-a-round)).
5. **Tell the person what your legal adviser says to tell them.**

## 5. The vault repository became public by mistake

1. **Save the fork and star lists, then make it private. Do both within a minute.** GitHub
   detaches the public forks and erases the stars and watchers when a public repository goes
   private, so once you change it these lists can no longer be read, and only the host's
   support can say who forked it. Run these in a clone, and write the files outside the
   repository:

   ```bash
   gh repo view --json forkCount,stargazerCount
   gh api 'repos/{owner}/{repo}/forks' --paginate --jq '.[].full_name' > ../forks.txt
   gh api 'repos/{owner}/{repo}/stargazers' --paginate --jq '.[].login' > ../stargazers.txt
   gh repo edit --visibility private --accept-visibility-change-consequences
   gh repo view --json visibility,isPrivate
   ```

   The first command gives the counts, to check the files against. The last confirms the new
   visibility. If you prefer the settings page, save the two lists first all the same.
2. **Assume a copy exists.** Treat everything the repository held, in every commit, as
   published for as long as it was public. Making it private takes back no clone, no fork and
   no cache. If the host has an audit log, note when the visibility changed.
3. **Rotate every secret that was ever in it,** not only the ones in the current files. Use
   `git log --all --oneline -G'<shape>'` to find the commits, and think of what the curator saw
   as well. [Section 2c](#2c-the-commit-is-in-the-default-branch) has the rest.
4. **Go through the lists you saved.** `forks.txt` and `stargazers.txt` are who may hold a
   copy. A fork made while the repository was public holds the whole history and stays public
   after the original is private. Ask its owner to delete it, and ask the host's support about
   the ones you cannot reach.
5. **Personal data.** If `people/` or any note about someone was in it, go through
   [section 4](#4-a-third-partys-personal-data-is-in-the-vault), and ask your legal adviser
   whether the people concerned must be told. This page does not say.
6. **Run `brain-kit doctor`, and know what it does not check.** It has no check on whether the
   remote is public. The configuration has a key, `privacy.require_private_repo`, which
   defaults to true, but nothing in the kit reads it, so setting it protects nothing.
   Look at the repository's visibility on the host yourself, with the last command in step 1. What
   `doctor` does check after an incident like this one: `hooks-path` (the push gate runs in
   this clone), `config-valid` (your secret patterns compile) and `privacy-keywords`.

   ```bash
   brain-kit doctor --only hooks-path,config-valid,privacy-keywords
   ```

## 6. The curator did something it should not have

This covers a round that wrote outside the vault, pushed to the default branch, opened a pull
request with content you did not expect, or ran a command you did not allow.

1. **Stop it first.**

   ```bash
   brain-kit schedule uninstall
   brain-kit schedule status
   ```

   `uninstall` removes the entry the kit installed (a systemd user timer, a launchd agent or a
   cron block), so no new round starts; `brain-kit schedule uninstall --dry` prints what it would
   do. Three things it does not do:
   - It does not stop a round that is running now. Find it with `ps aux | grep '[c]urate'` and
     send it SIGTERM (a plain `kill <pid>`). Never `kill -9`: the model runs in a process group
     of its own and keeps running after a SIGKILL of the round (see "When a round is stopped"
     in [security.md](security.md)).
   - It does not touch the morning briefing, which is a task inside the Claude desktop
     application. `brain-kit schedule uninstall --job briefing` removes nothing and tells you
     to delete the task there.
   - It does not touch a job that you or an older setup scheduled for this vault. Look at
     `systemctl --user list-timers` and `crontab -l`.

   If the misbehaving thing was an interactive session with the plugin, close the session.
2. **Copy the evidence before it ages.** Each round removes logs older than `log_retention_days`
   (30 by default). `brain-kit machine show` prints the state directory (`state_dir`). In it:
   - `last-run.json`, the last round: `exit` and `reason`, `denials` (the tools the model was
     refused), `isolation` (whether the first event proved the isolation), `proposed` (every
     pull request it opened, with branch and paths), `leftovers`, `warnings`, `mode` and
     `userRules`. [scheduling.md](scheduling.md) ("Reading last-run.json and the logs") says
     what each field holds.
   - `logs/curate-YYYY-MM-DD.log`, the dated round log, one line per event: `model_result` (the
     denials and the isolation verdict), `cleanup`, `exit`. It never holds what a tool returned.
   - `logs/curate-<stamp>.stream.jsonl`, the model's raw output, exists only if the round ran with
     `--keep-stream` (or `keep_stream` in `machine.json`). Without it the round keeps no
     record of what the model ran, only of what it was denied and what it proposed.
   - In the repository: the branches that start with `git.branch_prefix` (`bot/` by default),
     `git for-each-ref refs/brain-kit/proposed/` (step 5 of 2b says which proposals leave one;
     what a scheduled round proposed is in `proposed` of `last-run.json`),
     `git log --format='%h %an %ae %s' <default branch>` to see what was committed under
     `git.agent_identity`, and the pull requests on the host.
   - The scheduler's own log. For systemd:
     `journalctl --user -u brain-kit-curate-<vault_id>.service`, with `vault_id` from
     `brain-kit machine show`.
3. **Revoke what the round could use.**
   - GitHub: `gh auth status` shows the login `propose` used to push and open pull requests.
     Revoke that token or authorization in your GitHub settings, and log in again later with
     the narrowest scope that works.
   - Claude Code: sign out of it on that machine, and sign in again when you are ready.
   - Connectors: if `mode` in `last-run.json` is `connectors`, disconnect the Google Calendar
     and Google Drive connectors in your claude.ai settings.
   - Anything in the environment your scheduler gives the round. The commands the model runs
     see that environment ([security.md](security.md)), so rotate any secret that was in it.
4. **Tell a control failing from a control working.** The allowlist in [security.md](security.md)
   exists to keep an unattended model inside a narrow set of actions: read the vault and the
   digests of the sessions the round offers; write only inside the vault, and never to the
   protected paths (`.githooks`, `.git`, `.github`, `.claude`, `.brain-kit`,
   `brain-kit.config.json`, `.gitignore`, `.gitattributes`, `.gitmodules`, `.mcp.json`); run
   only `validate`, `lint` and `propose`; no `git push`, `git commit` or `gh`; no `curl`, `wget`
   or web tools; no `rm`. The only way to publish is `propose`, which opens a pull request and
   never moves your branch, and the pre-push hook refuses a push under the curator's identity
   to the default branch.
   - **A control working** looks like a name in `denials` (the model tried, and was refused),
     a round that stopped itself with exit 1 because the first event did not match what the
     round pins, or a `propose` or a push that was refused. No harm was done. Still read
     the names: a model that keeps trying something you never allowed may have been told to by
     text in a session, a calendar event or a document it read. Look at what it read that day.
   - **A control failing** looks like a file changed outside the vault, a commit by the
     curator's identity on the default branch, a pull request that changes paths you did not
     expect (compare the files on the host with `proposed`), a command in the kept stream that
     is neither on the allowlist nor in `denials`, a changed protected path, or an `isolation`
     that was not proven in a round whose model ran. That is a flaw in the kit or in how it was
     set up. Keep the evidence and report it ([section 8](#8-a-flaw-in-the-kit-itself)).
5. **Repair.** Close the pull requests you do not want (section 7). If it pushed to the default
   branch, decide between a revert by pull request and the rewrite in
   [2c](#2c-the-commit-is-in-the-default-branch). If a secret or personal data is in what it
   wrote, go to section 2 or 4. If it wrote outside the vault, look at what your user can write
   to.
6. **Start it again** only when you understand the cause: `brain-kit doctor`, then
   `brain-kit schedule install`.

## 7. A bad pull request from a round

1. Close it and delete its branch: `gh pr close <number> --delete-branch`. If it holds a secret
   or personal data, use sections 2b and 4 instead; closing is only the first step.
2. The round has already moved its watermark: a round advances it on exit 0 or 3, so the
   next round will not read that day again. To make the curator read the day again:

   ```bash
   brain-kit watermark show
   brain-kit watermark reopen transcripts 2026-09-20
   ```

   `reopen <source> <YYYY-MM-DD>` moves the mark back so that the given day, and every day after
   it, is read again by the next round. The source is `transcripts`, `calendar` or
   `meeting_notes`, and the date is in the vault's time zone. Run `watermark show` first to
   see where each mark stands.
3. Before you reopen, remove the cause. If you do not, the next round makes the same pull
   request: a wrong note or setting, a source that holds something that should not be
   captured (section 4), or an instruction that needs changing. A reopen re-reads every day from
   the date you give, not only the bad one.
4. The next round runs at the next window in `curate.schedule` (09:30, 14:00 and 20:00 by
   default). To see what it would do first, run `brain-kit curate --check`, which stops before
   the model.
5. If the content of the closed pull request must be gone from the machines now, do steps 4 and
   5 of [2b](#2b-the-commit-is-on-a-branch-or-in-a-pull-request): `git fetch --prune` in every
   clone first, then the clean-up on the curator's machine, which differs for a scheduled round
   and for a `propose` made outside one.

## 8. A flaw in the kit itself

Report it as [SECURITY.md](../SECURITY.md) says: through a private security advisory on GitHub
(the Security tab of the repository). Do not open a public issue for a secret or a leak, and do
not put real data in the report. Say which version (`brain-kit --version`), what you did, what
you expected and what happened, with an example built from fake data (the fictional owner Ana,
the domain example.com). A flaw that is not a vulnerability, such as a command that misleads
you in an incident, can be an ordinary issue on the same terms.

## 9. After the incident

1. Add a dated entry to your own vault, in the log, saying what happened, how you found out,
   what you rotated, removed and told, and what you changed so it cannot happen the same way
   again. Write the date as DD/MM/YYYY. Do not write the secret or the data in it. Make it by
   pull request like any other change.
2. If the cause was a shape the checks did not know, add it to `privacy.secret_patterns`; if it
   was a phrase, add it to `privacy.third_party_keywords`; if it was a kind of subject the
   curator should not have recorded, set `privacy.sensitive` or add it to
   `privacy.never_topics`; if the gate was not running, fix that (`brain-kit doctor`). Run
   `brain-kit lint` again.
3. If the cause is a gap in the kit, open an issue with a minimal example and no real data
   (a vulnerability goes to the advisory in section 8). The kit's own practice is the one to
   copy: each incident gets one regression test under `test/incidents/` and one entry in
   [incidents.md](incidents.md).

## Appendix: what the secret checks match and miss

This is the detail behind [section 3](#3-what-the-kits-own-checks-catch-and-miss): the `secrets`
rule of `brain-kit lint`, and the push gate, which applies the same shapes to what a push
carries.

**What they match.** The six shapes in `src/leak.mjs`, and every regular expression you add to
`privacy.secret_patterns` in `brain-kit.config.json`. Matching ignores case.

- A private key header: the line that opens a PEM key (with or without RSA, OPENSSH, EC or DSA
  in it).
- A GitHub classic token (starts with ghp_) and a GitHub fine-grained token (starts with
  github_pat_).
- An Anthropic API key (starts with sk-ant-).
- An AWS access key id (AKIA followed by 16 capital letters or digits).
- A Slack token (starts with xoxb-, xoxa-, xoxp-, xoxr- or xoxs-).

A finding names the file, the line and the pattern. It never prints the matched text.

**Where they run.**

- `brain-kit lint`, when you run it. It reads every file git tracks or would add, dot-files such
  as `.env` included and files git ignores left out, every line, as the working tree stands now.
  It reads no history. Fenced code in a note is read too, because a secret in an example is
  still a secret. It skips the paths in `lint.secrets.exclude_paths`. By default a match is an
  error and the run exits 1.
- `brain-kit propose`. Before it pushes, it runs `validate` and `lint --base worktree` on the
  tree the pull request would hold, and stops with exit 1 on a failure. The curator's model
  publishes only through it.
- The vault's pre-push hook, `.githooks/pre-push` (from `templates/githooks/pre-push`). It runs
  `validate`, then `lint --base all`, then `brain-kit push-gate`, which scans everything the
  push carries: every commit it sends (file contents, file names, message, author, committer
  and raw headers), annotated tags, and the names of the references the push writes or
  deletes. It never prints what matched. `brain-kit init` installs the hook; `init --adopt` does
  unless a hook of yours is already there; `brain-kit update --install-hook` does later.
- CI: the kit ships no CI for your vault. This repository's own CI runs the test suite, which
  scans the kit's own files for the same shapes. A check nobody can skip would be
  `brain-kit lint --base all` as a required status check on your host. You would set that up
  yourself; the kit does not. [SECURITY.md](../SECURITY.md) explains why a client-side hook
  cannot be that check.

**What they cannot see.**

- A file they do not read: one git ignores, one over 100 MiB (reported as unread, never as
  clean), the inside of a submodule or a nested repository, and anything compressed,
  encrypted or binary (an archive, an office document, most PDFs).
- A value written another way: encoded in base64, split across a line break, or written with
  spaces between the letters. [SECURITY.md](../SECURITY.md) records the measurements.
- A secret that none of the six shapes describes. Tried against `brain-kit lint`, these are
  not matched: the header of an armored PGP private key (it ends in PRIVATE KEY BLOCK), the
  header of an encrypted PKCS#8 key (it says ENCRYPTED PRIVATE KEY), GitHub tokens that start
  with gho_, ghs_, ghu_ or ghr_, an AWS secret access key (it has no prefix), and a key from a
  vendor not in the list (a Stripe live key, for example). Nor is a password, a database
  address with the password in it, or a signed token. Add a regular expression for each to
  `privacy.secret_patterns`, for example `gh[ousr]_[A-Za-z0-9]{36}` for the four GitHub token
  kinds. `brain-kit doctor --only config-valid` checks that each one compiles. Never put the
  secret itself in that list: `lint` reports an entry that has the shape of a real credential.
- A push that skipped the gate. `git push --no-verify` skips it, so does a clone where
  `core.hooksPath` is not set, and so does an edited hook. The gate runs on your machine.
- History, for `lint`: it reads the working tree only. The gate reads only what one push
  carries. A secret already on the remote from before the gate was installed is found by
  neither; search for it with `git log --all --oneline -G'<shape>'`.
- A secret that is not in a file: a pull request comment, an issue, a CI log, the model
  provider's side.
- Personal data. A name or a diagnosis has no shape; see [section 4](#4-a-third-partys-personal-data-is-in-the-vault).
