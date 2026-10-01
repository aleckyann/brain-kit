# Incident response

<!-- Maintainers: test/incident-response-doc.test.mjs checks every brain-kit command, flag, path, configuration key and doctor check id this page names against the code. Run it after you rename any of them. -->

Open this page when a secret or someone's personal data is in your vault, when the vault
repository was public, or when the curator did something it should not have. It is written to
be followed in order, once, under stress. Every `brain-kit` command on it exists. Where the kit
has no command for a step, the page says what to do by hand.

While you work, do not paste the secret or the personal data into a chat, an issue, a pull
request comment or a support ticket. Name commits by their hash and files by their path.

Find your case:

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

First find how far it went. Do not type the secret into a command, because your shell keeps a
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

Nothing has left your machine, so you can remove it. If the secret was ever in a synced folder,
a backup or a chat, treat it as pushed and start at section 1 instead.

1. If the secret is in the latest commit only: remove it from the file (or delete the file with
   `git rm <file>`), then `git commit --amend`.
2. If it is in an older commit you have not pushed: `git reset --soft <last good commit>`
   moves HEAD back and keeps your changes staged. Run `git restore --staged <file>`, remove the
   secret from the file or delete the file, then commit again. The unpushed commits become one.
3. Check that `git log --all --oneline -G'<shape>'` prints nothing and that
   `brain-kit lint --rule secrets` finds nothing.
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
   secret.
4. If the pull request came from a curator round, the machine that ran the round still holds it:
   - A proposal never moves the working tree, so the files stay modified there. Put them back:
     `git restore -- <path>` for a tracked file, delete a new one.
   - A local ref keeps the commit. List the refs with `git for-each-ref refs/brain-kit/proposed/`
     and delete the one of that branch with `git update-ref -d <ref>`. The ref is named after
     the branch, with each `/` turned into `-`.
   - Then expire the reflog and collect garbage, as in step 4 of 2a.
5. Find out why the push was not refused. `brain-kit doctor --only hooks-path` says whether this
   clone runs the push gate at all, and [section 3](#3-what-the-kits-own-checks-catch-and-miss)
   says what the gate does not see.

### 2c. The commit is in the default branch

1. Rotate or revoke the secret now. Do not wait for the rewrite.
2. Stop the curator, so that it does not push from the old history while you work:
   `brain-kit schedule uninstall` ([section 6](#6-the-curator-did-something-it-should-not-have)
   has the details). If other people push to this repository, tell them to stop, in one line
   and without details.
3. Work in a fresh clone. The tool is `git filter-repo`, which is not part of git: install it
   from <https://github.com/newren/git-filter-repo> or your package manager. It refuses to
   rewrite a clone that is not fresh, and your old clone stays as the backup until you push.

   ```bash
   git clone https://example.com/ana/vault.git vault-clean
   cd vault-clean
   ```

   Remove a whole file from every commit:

   ```bash
   git filter-repo --invert-paths --path attachments/export.csv
   ```

   Replace text in every file of every commit. Put the rules in a file outside the repository,
   one per line. A rule written as a shape does not contain the secret:

   ```text
   regex:AKIA[0-9A-Z]{16}==>REMOVED
   ```

   ```bash
   git filter-repo --replace-text ../replacements.txt
   ```

   A rule can also be `literal:<the text>==>REMOVED`, but then that file holds the secret:
   delete it when you are done. `--replace-text` does not touch commit messages; use
   `--replace-message` for those. `git filter-repo` removes the `origin` remote on purpose, so
   add it back: `git remote add origin <url>`.
4. Check the result before you push: `git log --all --oneline -G'<shape>'` prints nothing and
   `brain-kit lint --rule secrets` finds nothing. A fresh clone runs no push gate until
   `git config core.hooksPath .githooks` is set in it (`brain-kit doctor --only hooks-path`
   tells you). Set it, and the gate scans the commits the push sends, which after a rewrite are
   all of them.
5. Allow the force push. Branch protection on the default branch normally refuses it: in the
   host's settings, allow force pushes on that branch for the minutes you need, then turn the
   protection back on. Push under your own identity, never the curator's (`git.agent_identity`);
   the hook refuses that identity on the default branch.

   ```bash
   git push --force --all origin
   git push --force --tags origin
   ```

6. Close every open pull request and delete the branches they came from. The host keeps the
   old commits behind each pull request, and the curator will propose again.
7. Every clone and every fork still has the old history, and so do the host's pull request
   references. A `git pull` in an old clone would merge the old history back, and the next push
   would publish the secret again. Tell each holder to delete the clone and clone again, and
   each fork's owner to delete the fork.
8. Ask the host's support for the garbage collection and the cache purge, as in step 3 of 2b.
9. Put the curator back. Clone the vault again where the rounds run; if the new clone is at a
   different path, run `brain-kit machine register --from <old path>` in it. Then run
   `brain-kit doctor` and `brain-kit schedule install`.

#### Where a copy can hide

Go through this list after any rewrite. A copy in one of these places survives it.

- Forks of the repository (the host's fork list), and clones on other machines, in backups and
  in sync folders. Delete the old clone on the curator's machine too, with its
  `refs/brain-kit/proposed/*` refs.
- Pull request descriptions and comments, issues, and the e-mail and chat notifications that
  quoted them.
- CI logs, caches and artifacts. Delete the runs and the caches on the host.
- The curator's state directory, outside the vault (`brain-kit machine show` prints it as
  `state_dir`). Its `logs/` folder holds the round logs. With `--keep-stream` (or `keep_stream`
  in `machine.json`) it also holds `logs/curate-<stamp>.stream.jsonl` and the round's digests,
  which contain what the model read, so a secret that was in a note or a session can be in
  them. Delete those files. Each round removes logs older than `log_retention_days` (30 by
  default) on its own.
- The Claude Code session where you typed or pasted the secret. Its transcript stays on that
  machine, under the folder `transcripts_dir` names (`~/.claude/projects` by default), and the
  curator builds its digests from transcripts.
- The model provider. A session you had with the secret in it, and a curator round that read a
  digest of it, sent that text to the provider. You cannot rewrite their side. Rotation is
  what makes it harmless. Ask the provider's support what it keeps and how to have it deleted,
  and do not count on the answer.

## 3. What the kit's own checks catch and miss

The kit checks for secrets in two places that share the same shapes: the `secrets` rule of
`brain-kit lint`, and the push gate, which applies them to what a push carries. Both are
pattern scanners. Read this section before you trust a clean result.

**What they match.** The six shapes in `src/leak.mjs`, and every regular expression you add to
`privacy.secret_patterns` in `brain-kit.config.json`. Matching ignores case.

- A private key header: the line that opens a PEM key (with or without RSA, OPENSSH, EC, DSA
  or PGP in it).
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
- A secret with no known shape: a password, a database address with the password in it, a
  signed token, a key from a vendor not in the list. Add a regular expression for it to
  `privacy.secret_patterns`; `brain-kit doctor --only config-valid` checks that each one
  compiles. Never put the secret itself in that list: `lint` reports an entry that has the
  shape of a real credential.
- A push that skipped the gate. `git push --no-verify` skips it, so does a clone where
  `core.hooksPath` is not set, and so does an edited hook. The gate runs on your machine.
- History, for `lint`: it reads the working tree only. The gate reads only what one push
  carries. A secret already on the remote from before the gate was installed is found by
  neither; search for it with `git log --all --oneline -G'<shape>'`.
- A secret that is not in a file: a pull request comment, an issue, a CI log, the model
  provider's side.
- Personal data. A name or a diagnosis has no shape; see [section 4](#4-a-third-partys-personal-data-is-in-the-vault).

**A clean result is not proof.** It means that no known shape was found in the files that were
read. It does not mean the vault holds no secret. Rotate on facts, not on a green `lint`.

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
     English skeleton), the index files, `pending/`, open pull requests and branches, and the
     question queue (`brain-kit questions list`).
   - Outside the vault: the curator's state directory (section 2c, "Where a copy can hide"),
     and the sources the data came from, which are your Claude Code sessions, your calendar
     and your meeting notes.
3. **Remove it.**
   - Delete the note and every mention in other notes, in the log and in the indexes. Then run
     `brain-kit validate`: a link to the deleted note is reported as `link-target-exists`, so
     you see what is left.
   - Make the change by pull request and merge it, as for any change to the vault.
   - If the data is sensitive, or the person asks for it, remove it from the history too, with
     the rewrite in 2c: `git filter-repo --invert-paths --path people/ana-example.md`, and a
     `--replace-text` file for the mentions in other notes. The same caveats hold: every clone
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
   - `privacy.third_party_keywords` is a list of phrases. `lint` refuses a line a change adds
     that holds one, and `propose` runs `lint`, so a round cannot publish such a line. It
     matches the phrase literally, so it stops a topic you name, not a person. The list lives
     in `brain-kit.config.json`, inside the repository: do not put the person's name in it if
     removing that name is the goal. `privacy.keyword_exempt_paths` does the opposite and
     exempts paths from the check: make sure it does not cover the note you removed.
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

1. **Make it private now.** On GitHub, use the repository's settings page, or run
   `gh repo edit --visibility private --accept-visibility-change-consequences` in the clone.
   Then check: `gh repo view --json visibility,isPrivate,forkCount,stargazerCount`.
2. **Assume a copy exists.** Treat everything the repository held, in every commit, as
   published for as long as it was public. Making it private takes back no clone, no fork and
   no cache. If the host has an audit log, note when the visibility changed.
3. **Rotate every secret that was ever in it,** not only the ones in the current files. Use
   `git log --all --oneline -G'<shape>'` to find the commits, and think of what the curator saw
   as well. [Section 2c](#2c-the-commit-is-in-the-default-branch) has the rest.
4. **Check the fork and star lists.** On the host: the repository's forks page and its
   stargazers. From the command line: `gh api repos/OWNER/REPO/forks --paginate --jq '.[].full_name'`
   and `gh api repos/OWNER/REPO/stargazers --paginate --jq '.[].login'`. A fork made while it
   was public holds the whole history and may stay public after the original is private. Ask
   its owner to delete it, and ask the host's support about the ones you cannot reach.
5. **Personal data.** If `people/` or any note about someone was in it, go through
   [section 4](#4-a-third-partys-personal-data-is-in-the-vault), and ask your legal adviser
   whether the people concerned must be told. This page does not say.
6. **Run `brain-kit doctor`, and know what it does not check.** It has no check on whether the
   remote is public. The configuration has a key, `privacy.require_private_repo`, which
   defaults to true, but nothing in the kit reads it, so setting it protects nothing.
   Look at the repository's visibility on the host yourself, with the command in step 1. What
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
   - In the repository: `git for-each-ref refs/brain-kit/proposed/` (one local ref for each
     proposal), the branches that start with `git.branch_prefix` (`bot/` by default),
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
5. The curator's working tree still holds the closed proposal's files until the next
   `brain-kit sync` (every round runs it) puts them back. If the content must be gone from the
   machine now, run `git restore -- <path>` and delete the local ref
   `git update-ref -d refs/brain-kit/proposed/<branch with / turned into ->`.

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
   was a phrase, add it to `privacy.third_party_keywords`; if the gate was not running,
   fix that (`brain-kit doctor`). Run `brain-kit lint` again.
3. If the cause is a gap in the kit, open an issue with a minimal example and no real data
   (a vulnerability goes to the advisory in section 8). The kit's own practice is the one to
   copy: each incident gets one regression test under `test/incidents/` and one entry in
   [incidents.md](incidents.md).
