# Multi-agent worktree discipline (repo-agnostic)

## Status

Standing operating rule for any repo where more than one agent (or agent +
human) works concurrently against the same `.git` directory.

## Rules

1. **One agent per worktree.** Never point two concurrently-running agents at
   the same checked-out worktree. A second agent that needs to work in
   parallel gets its own worktree, not a second cwd into the first agent's.

2. **Never `git stash` in a multi-worktree repo.** `refs/stash` is a single
   ref shared across every worktree of the same repo — a stash pushed from
   one worktree is popped/dropped/listed from all of them. A second agent's
   `git stash pop` can silently apply (and then delete) the first agent's
   stashed work onto an unrelated tree. Use a throwaway commit, `git diff >
   patch-file`, or a dedicated branch instead of stashing whenever more than
   one worktree exists.

3. **Create worktrees with `git worktree add` before editing**, not after.
   Decide the worktree's path and branch up front and create it as the first
   step, so no agent ever starts editing inside the primary checkout "just
   for now" and forgets to move.

4. **Keep `/tmp` tmpfs clean of `orca-test-*`.** Test runs that scaffold
   fixture directories under `/tmp/orca-test-*` must not accumulate across
   agent runs — a stale fixture from a prior run can leak state into the
   next run's assertions and tmpfs is finite. Sweep old ones before a test
   run, e.g.:
   ```
   find /tmp -maxdepth 1 -name 'orca-test-*' -mmin +60 -exec rm -rf {} +
   ```

## Why this is repo-agnostic

None of the above depends on Orca's own architecture — it applies to any
repo where multiple agents might be dispatched into worktrees of the same
clone. Check it before dispatching an agent, not after a stash collision.
