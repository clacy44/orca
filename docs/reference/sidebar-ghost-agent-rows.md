# Sidebar ghost agent rows — the 2026-08-27 "3 agents" symptom

## Status

FIX 1 and FIX 5 shipped on `feat/sidebar-resumed-session-collapse`
(`f200efed35`, `9a0850c5ba`); FIX 2 (the host-side liveness join) shipped
on the same branch (`38d74b359d`, `e456f903fb`).
FIX 3 and FIX 4 are diagnosed but deferred.

## Symptom

Owner screenshot: the workspace sidebar for "Personal VPS → ubuntu" showed
"3 agents" as three identical rows (aged 2d, 2d, 1d) for what was, on the
VPS, exactly **one** live terminal (tab `16725f64...`, `ptyId`
`serve-20014095-...`) and one persisted tab. That terminal ran a Claude Code
session that had been resumed three times (`claude --resume`/`--continue`
across two serve restarts).

## Root cause

`last-status.json` rows written by the agent-hooks server are never retired
when a tab closes on a path other than the renderer's own `closeTab` IPC —
in particular `closeMobileSessionTab`, the only close path on a headless
serve host (no renderer IPC ever fires there). A still-running agent process
kept resurrecting its row as a live sidebar entry for up to the 7-day
hydration TTL. The sidebar's `buildWorktreeAgentRows` worktree-attributed
fallback then turned *any* status entry with no matching tab into a live
row — staleness only decayed the row's dot to idle, it never hid the row —
so each of the three resume-cycle hook rows surfaced as its own "agent,"
all sharing the resumed session's terminal title.

## Fixes, by commit

- **FIX 1 — host retire-on-close (`f200efed35`).** Wires
  `dropAgentHookStatusForTab` through the runtime's whole-parent-close
  commit points (the 4 branches inside `closeMobileSessionTab` where a
  closing parent takes its tab with it) so the hook row — and late-write
  suppression — retires regardless of who initiated the close.
  `agentStatus:getSnapshot`/`worktree.ps` omit the row sooner; no wire shape
  change.
- **FIX 5 — renderer tabless guard (`9a0850c5ba`).** The worktree-attributed
  fallback now skips a tabless status entry unless it is still fresh or its
  orchestration parent is a currently-open tab (an orchestration worker
  whose own tab hasn't attached yet). This can only remove rows the
  fallback would previously have shown — never add one — so old clients are
  unaffected. Also fixes the "1 agents" pluralization.
- **FIX 2 — producer-side liveness join at every publication point
  (`38d74b359d`).** `attachAgentRowsToSummaries` already dropped a
  tabless/disconnected hook row before it reached `worktree.ps`; the other
  two publication surfaces did not apply the same join. The predicate is
  extracted into `isRetainedHistoryAgentRow`
  (`src/main/agent-hooks/retained-history-agent-row.ts`) and applied,
  unchanged, at all three surfaces: the `agentStatus:getSnapshot` IPC
  snapshot (`filterRetainedHistoryAgentStatusRows`), and the per-tab agent
  status carried on mobile/paired session-tab snapshots
  (`toMobileSessionTabsResult`'s `getHookRowsForPane` closure plus the
  ptyId-scan fallback in `getFreshRetainedAgentStatusForMobileTab`). This is
  a meaning change (fewer rows published on all three surfaces) but never
  adds a row that wasn't published before; `last-status.json` still retains
  the dropped rows for hydration/history.

## Deferred

- **FIX 3 — collapse a resume chain to one row.** Multiple
  `providerSession.id`/`transcriptPath` entries from the same resumed
  session should collapse to a single published row, re-anchoring
  `buildSubagentChildRows` lineage to the survivor. Not implemented; risks
  regressing `paired-reconnect-sidebar-agent-count.test.ts` (STA-3107),
  which pins the exact seam this touches.
- **FIX 4 — client-side orphan sweep.** `web-session-tabs-sync.ts` should
  sweep `agentStatusByPaneKey` when a mirrored tab leaves
  `tabsByWorktree` by a path other than the mirror patch itself, so a stale
  client-side entry can't outlive its tab even if a future host-side gap
  reopens. Not implemented.

FIX 1/2/5 alone hide the ghost-row symptom in production; FIX 3/4 are
defense-in-depth for reproduction paths not yet observed live.
