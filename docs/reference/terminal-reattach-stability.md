# Terminal reattach stability — the 2026-08-25 incident

## Status

Fixed on `feat/terminal-reattach-stability` (11 commits, `d9804b65d0`..`33f7aba24a`),
merged to integration at `a7f23391e1`, shipped as Artifact 5
(`83019f4dbbddeaa4b6c95feddc77d1530c2a7f77a6c70042c8d5391d310a99b8`) and installed
on the VPS via `orca-install-v3.sh` on 2026-08-25 18:27 UTC.

## Symptoms

1. A dead TUI's mouse-report bytes (`\x1b[<35;col;rowM`, ...) got echoed as
   literal text into a plain shell after reattach — "SGR mouse-report spam."
2. The sidebar/tab bar showed multiple identical tab rows sharing one PTY
   (e.g. three "Terminal 4" rows for one `ptyId`).
3. "Close all tabs" never converged: closing every visible row left a PTY
   alive because a duplicate row still referenced it.
4. A tab whose PTY had died re-spawned a brand-new `serve-<uuid>` process on
   every activation instead of reattaching, so repeat taps on the same tab
   each minted a fresh PTY.

## Root causes

- **RC1 — mode laundering.** `daemon-durable-history-snapshot.ts` copied a
  cold-restore checkpoint's mouse-tracking bits (`?1000/1002/1003h`,
  `?1006/1016h`) forward verbatim on both the rebuild and fast paths, so once
  a TUI died mid mouse-tracking the daemon could never clear it (`#12101`).
  Compounding it, `pty-connection.ts`'s `reattachReplayResetSequence` trusted
  a persisted `isAlternateScreen` flag as a liveness signal even when it came
  from a dead process's stale checkpoint.
- **RC2 — duplicate tab mint.** `persistence.ts:7099-7113`'s
  `persistPtyBinding` minted a fresh tab row for an unknown `tabId` even when
  another row already bound that `ptyId`, instead of rebinding the existing
  row — a close/reactivation race left duplicate rows sharing one PTY.
- **RC3 — non-converging close-all.** `workspace-session-terminal-tab-close.ts`'s
  `ptyIdsToKill` computation excluded a `ptyId` from the kill set whenever
  *any* other tab row still referenced it, so RC2's leftover duplicate rows
  kept the PTY alive forever. Separately, `terminal-tab-bulk-actions.ts`
  (`closeOtherTerminalTabs`/`closeTerminalTabsToRight`) pruned the local tab
  mirror optimistically and void-fired the host close, so a refused or
  failed close was silently swallowed and the tab reappeared on the next
  host snapshot.
- **RC4 — dead-tab re-materialization.** `orca-runtime.ts`'s
  `activateMobileSessionTab` derived "needs a new PTY" purely from liveness
  (`publicTab.status !== 'ready'`), so a tab whose PTY died stayed
  permanently pending and every activation minted a new `serve-<uuid>`,
  including repeat taps on the same tab.

## Fixes, by commit (`feat/terminal-reattach-stability`)

| Commit | Fix |
|---|---|
| `d9804b65d0` | Rebuild branch appends `COLD_RESTORE_SEED_MODE_RESET` after the restore base instead of laundering stale mouse bits forward |
| `0da0c0e8b6` | Reattach reset relies only on `kittyKeyboardModes.isAlternateScreen`, scanned live from the replayed bytes — not the persisted flag |
| `6aa33fde64` | Re-OR's the host-authoritative `isAlternateScreen` back in (it's daemon-set from a *live* reattach snapshot, not a cold-restore artifact) so a bounded SSH/relay replay window doesn't lose mouse tracking on a still-live alt-screen TUI (`#8291`) |
| `4305144c90` | Mouse-clearing logic only fires when the live snapshot itself shows no tracking armed — a genuinely live checkpoint owner keeps its modes |
| `4591bc4edd` | `rehydrateSequences` re-derived from the corrected modes on rebuild, not the pre-correction emulator state |
| `4da0d94306` | `persistPtyBinding` looks up by `ptyId` first and renames the existing row instead of minting a duplicate |
| `20dfa19525` | New `migrateTerminalTabId` module migrates every `*ByTabId`-keyed map on rebind (active selection, unified-tab mirror, leaf layout incl. split siblings, pane incarnation/lane/tombstone state) |
| `3677d7f36a` | Extends the migration to `remoteSessionIdsByTabId` and `sleepingAgentSessionsByPaneKey` (+ embedded `parentTabId`); adds a reflection test that discovers every `*ByTabId` map by iterating the session object's own keys |
| `2a9bcfcd06` / `edca175264` | Close-all's duplicate-collapse guard now treats a row as a duplicate when every `ptyId` it references is already in the closing set, regardless of whether it has its own layout entry |
| `710f141e34` / `471e681f80` / `68f7dda486` | `closeTerminalTab` resolves `Promise<boolean>` (true only once the host confirms), never rejects; every fire-and-forget call site awaits the result and gates PTY kill / local pruning on it |
| `1f293b0be6` | A process-lifetime materialization ledger remembers the `ptyId` a tab's spawn produced; a later activation reattaches instead of re-minting once the live/persisted `ptyId` is unavailable |
| `33f7aba24a` | Regression test updated to the new confirm-then-revoke contract (was pinned to the old optimistic-prune contract) |

## Operator recovery

- **Immediate relief in the affected pane** (not the Claude pane — omit
  `?1049l` there, it would also drop the alt-screen the agent needs):
  ```
  printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1016l'
  ```
  This disarms mouse-reporting/SGR-encoding modes so the shell stops echoing
  motion reports as text.
- **State cleanup**: `orca-install-v3.sh` stops `orca-serve.service` before
  touching any persisted state, backs up and `jq`-cleans
  `~/.config/orca/profiles/local-default/orca-data.json` (collapses
  duplicate rows per `ptyId` keeping the oldest by `createdAt`, drops tabs
  whose `ptyId` has no checkpoint newer than 24h, deletes the matching keyed
  state, repoints `activeTabId`/`activeTabIdByWorktree`, prunes
  `mobileClientTabSelectionsByDeviceId`), removes the holder-less
  `daemon-v32.sock` and terminal-history dirs older than 7 days, then
  installs, restarts, and verifies — rolling back the AppImage, squashfs
  root, `orca-data.json`, and the pairing drop-in together on any
  post-backup failure.

## Standing ops rule

**Never `systemctl restart` an Orca serve unit as a reflex.** The production
unit runs `KillMode=control-group`: a plain restart SIGTERMs the whole
cgroup, including any live TUI inside it, and that TUI dies without ever
emitting `?1003l`/`?1006l` — which is exactly the stale-mode-launder failure
mode RC1 fixes guard against on the *next* reattach. Use the install script's
stop → state-cleanup → restart sequence, or the printf mouse-off line for a
live pane, instead of restarting the unit out of habit.
