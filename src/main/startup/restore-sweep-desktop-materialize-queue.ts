// S10-21c B6 (design §2 S9; D-R153-b6 review fixes F1/F2/F3/F4/F5/F6): desktop materialization
// (T2 CODE; acceptance gated on Field Drill B1, design doc §5 — see that section before treating
// T2 as met). The sweep records each successful Layer-2 restore's surface here; later, after the
// renderer has hydrated its tabs, the host drains the queue through the EXISTING
// `notifier.revealTerminalSession` primitive (verified `attach-main-window-services.ts:385-424` —
// rejects on an identity mismatch, resolves only on an exact worktreeId/tabId/leafId/ptyId match)
// instead of new renderer-store surgery.
//
// [D-R153-b6 F1] Unlike an earlier draft of this module, an entry is NEVER left in the queue
// once it is resolved: a successful reveal deletes it, and a dead pty (per the runtime-supplied
// `isPtyLive` predicate, mirroring the template's `this.ptysById.get(candidate.ptyId)` at
// orca-runtime.ts:5231) is skipped AND deleted too — so a later renderer-graph epoch change
// (reload / graph teardown / headless promotion) can never re-issue a reveal for a pane that
// already materialized or whose pty has since exited; only a genuinely still-queued, still-live
// pane is retried.
//
// [D-R153-b6 F2] Every drain outcome is EVIDENCE, not just a console line: each resolution writes
// an `agent_audit` `sweep_note` row for that pane (`auditSweepNote`, the sweep's own existing
// evidence primitive). [S10-21c B-final, D-R157-b6c finding 6] Those rows are the evidence that
// SURVIVES a packaged build, where nothing forwards `console` — the one summary line each drain
// call also logs (below) is a convenience view for a dev/journal-forwarded run, not itself the
// evidence Field Drill B1 (design §5) relies on.
//
// Split into its own module (queue + drain both), mirroring restore-sweep-daemon-survived-
// delivery.ts's split, so restore-registered-agent-panes.ts's own recording call site stays a
// couple of lines and orca-runtime.ts's own `materializeRestoredAgentPanes()` stays a thin
// delegator. On serve (no notifier installed) `drainDesktopMaterializeQueue` is a no-op.
//
// Explicitly NOT touched by anything in this module: `src/renderer/src/store/slices/
// terminals.ts`'s hydration sanitizer / `reconnectPersistedTerminals` — that renderer-tab-
// recreation approach was DEFERRED (design doc §3) in favour of this reveal-primitive approach.
import { parsePaneKey } from '../../shared/stable-pane-id'
import { runtimeWorktreeIdsEqual } from '../runtime/runtime-worktree-id-equality'
import type { TerminalRevealIdentity } from '../../shared/terminal-reveal-identity'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-types'
import type { RuntimeEnsureAgentSessionResult } from '../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../shared/tui-agent'
import type { ResumableTuiAgent } from '../../shared/agent-session-resume'
import type { AgentLaunchSessionRow } from '../runtime/orchestration/agent-launch-sessions'
import { parseProcessIncarnation } from '../runtime/orchestration/agent-process-identity'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { auditSweepNote } from '../runtime/orchestration/restore-sweep-audit'
import type { RestoreSweepDeps } from './restore-sweep-types'

/** One successful Layer-2 restore's surface — everything the drain needs to drive
 * `notifier.revealTerminalSession` for this pane, captured at record time so the drain never
 * re-derives it from mutable runtime state. `title`/`launchAgent` [D-R153-b6 F4] are captured
 * here too, for the same reason — a fresh tab materialized with neither comes back untitled and
 * without agent chrome (the renderer only stamps a title on a fresh tab, and only builds the
 * agent-chrome branch of `store.createTab` when `launchAgent` is present). */
export type RestoredPaneMaterializeSurface = {
  paneKey: string
  agentId: string
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  title: string | null
  launchAgent: TuiAgent
  // [D-R153-b6 F5] The BARE incarnation (`parseProcessIncarnation(...)?.incarnationId`), never
  // the composite `agents.process_incarnation` value — the template's own field (`agent-process-
  // identity.ts`'s `ProcessIdentity.incarnationId`) means the bare form; this field is unused by
  // anything downstream today (never forwarded to the renderer), but a shape mismatch here would
  // be a trap for the next reader who wires it up.
  // [S10-21c B-final F1, D-R159 finding 1] OPTIONAL: an unparseable `agents.process_incarnation`
  // (measured on-box to be the COMMON case pre-fix, and possible even post-fix for a genuinely
  // legacy row) must never refuse the whole Layer-2 surface over an unused field. [S10-21c
  // B-final L7, D-R160 low 7] The field is not inert, though: its PRESENCE gates the reveal
  // primitive's own identity assertion (`attach-main-window-services.ts:388-392` builds
  // `expectedIdentity` only when this field is present, and enforces it only when built) — but
  // omitting it loses nothing, because the drain re-checks the same four fields
  // (worktreeId/tabId/leafId/ptyId, this file's own drain, :265-273) either way.
  expectedProcessIdentity?: { terminalHandle: string; incarnationId: string }
}

/** Runtime-held state: one queue entry per pane. No separate "already materialized" tracker —
 * [D-R153-b6 F1] a resolved entry (revealed, or dropped as dead) is deleted outright, so queue
 * membership alone is "still pending". */
export type DesktopMaterializeQueueState = {
  queue: Map<string, RestoredPaneMaterializeSurface>
}

export function createDesktopMaterializeQueueState(): DesktopMaterializeQueueState {
  return { queue: new Map() }
}

export function enqueueRestoredPaneForMaterialization(
  state: DesktopMaterializeQueueState,
  surface: RestoredPaneMaterializeSurface
): void {
  state.queue.set(surface.paneKey, surface)
}

/** [S10-21c B6, design §2 S9] Called after a successful Layer-2 restore
 * (`restoreOneRegisteredPane`'s `result.rebound === true` arm) — Layer 1 never queues here,
 * since the renderer never lost that pane's tab in the first place (same leaf, no rebind). An
 * incomplete surface (missing ptyId or a process incarnation that doesn't parse — not expected
 * given a successful rebind, but not proven unreachable) is audited
 * (`desktop_materialize_refused: incomplete_surface`, [D-R153-b6 F2] no longer console-only) and
 * dropped rather than queued half-built. [S10-21c B-final, D-R157-b6c finding 3] The WHOLE body
 * below `newPaneKey` is now inside the try: a throwing accessor (`getOrchestrationDb`,
 * `getOrchestrationCompatibilityHostId`, `getTerminalProcessIncarnation`) used to escape
 * uncaught into the caller's own per-candidate catch (restore-registered-agent-panes.ts), which
 * writes a Layer-3 `sweep_row_threw` audit for a Layer-2 restore that had ALREADY COMMITTED —
 * this function's own doc comment already promised that never happens. `db`/`hostId` are read
 * via `auditSweepNoteSafe` (never-throws) so the catch below can still leave an evidenced note
 * even when the accessor that threw is the very one that would have supplied `db`. */
export function recordDesktopMaterialize(
  deps: RestoreSweepDeps,
  agentId: string,
  created: RuntimeEnsureAgentSessionResult,
  launchRow: AgentLaunchSessionRow
): void {
  // Pure property access on already-validated inputs — never throws — so it stays available to
  // the catch below even when an accessor that runs after it throws.
  const newPaneKey = created.terminal.paneKey ?? launchRow.pane_key
  let db: OrchestrationDb | null = null
  let hostId = ''
  try {
    db = deps.getOrchestrationDb()
    hostId = deps.getOrchestrationCompatibilityHostId()
    const newTerminalHandle = created.terminal.handle
    const newProcessIncarnation = deps.getTerminalProcessIncarnation(newTerminalHandle)
    const launchAgent = launchRow.agent_type as ResumableTuiAgent
    const parsed = parsePaneKey(newPaneKey)
    const ptyId = created.terminal.ptyId
    const parsedIdentity = parseProcessIncarnation(newProcessIncarnation)
    if (!parsed || !ptyId) {
      auditSweepNoteSafe(
        db,
        hostId,
        newPaneKey,
        agentId,
        'desktop_materialize_refused: incomplete_surface'
      )
      return
    }
    // [S10-21c B-final F1, D-R159 finding 1] An unparseable incarnation is NOT a refusal — the
    // consumer only tests `expectedProcessIdentity` for presence (attach-main-window-services.ts
    // :388-392), so gating the whole surface on it disabled S9 for every real worktree pty
    // (finding 1's measured population). Note it, carry the field undefined, still enqueue.
    if (!parsedIdentity) {
      auditSweepNoteSafe(
        db,
        hostId,
        newPaneKey,
        agentId,
        'desktop_materialize: incarnation_unparsed'
      )
    }
    // [D-R153-b6 F6] The restore already committed above (`db.rebindRestoredPane`) — a throw here
    // is an audited note, never a failed restore, same shape as `notifyRebindDelivery`'s own
    // wrapping (restore-registered-agent-panes.ts, the call site just above this one).
    deps.recordRestoredPaneForDesktopMaterialization({
      paneKey: newPaneKey,
      agentId,
      worktreeId: created.terminal.worktreeId,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      ptyId,
      title: created.terminal.title,
      launchAgent,
      ...(parsedIdentity
        ? {
            expectedProcessIdentity: {
              terminalHandle: newTerminalHandle,
              incarnationId: parsedIdentity.incarnationId
            }
          }
        : {})
    })
  } catch (err) {
    auditSweepNoteSafe(
      db,
      hostId,
      newPaneKey,
      agentId,
      `desktop_materialize_note_failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Minimal structural shape of the runtime's `notifier` this module needs. The runtime's own
 * `RuntimeNotifier` type is not exported (orca-runtime.ts keeps it file-local) and this module
 * needs only these fields — the runtime passes `this.notifier` in directly. `viewMode` is
 * deliberately NOT threaded here [D-R153-b6 F4, forced deviation]: `AgentLaunchSessionRow` carries
 * no view-mode column to source it from, and the renderer already resolves a sensible default
 * (`initialAgentTabViewModeProps`) whenever `viewMode` is omitted — the same thing every other
 * `revealTerminalSession` caller in orca-runtime.ts already relies on. */
export type DesktopMaterializeNotifier = {
  revealTerminalSession?(
    worktreeId: string,
    opts: {
      ptyId: string
      title?: string | null
      launchAgent?: TuiAgent
      tabId?: string
      leafId?: string
      presentation?: RuntimeTerminalPresentation
      expectedProcessIdentity?: { terminalHandle: string; incarnationId: string }
    }
  ):
    | Promise<{ tabId?: string; title?: string | null; identity?: TerminalRevealIdentity }>
    | { tabId?: string; title?: string | null; identity?: TerminalRevealIdentity }
    | void
}

/** [D-R155-b6b finding 2] Every audit write the drain makes is best-effort: neither a throwing
 * `db.writeAgentAudit` nor an absent `db` (the caller's `getOrchestrationDb()` failed — see
 * `orca-runtime.ts#materializeRestoredAgentPanes`) may take the drain down with it, since
 * `index.ts`'s end-of-sweep call site has no catch of its own around it. `db === null` means
 * "skip audits, still drain" — never a thrown error. */
function auditSweepNoteSafe(
  db: OrchestrationDb | null,
  hostId: string,
  paneKey: string,
  agentId: string,
  reasonCode: string
): void {
  if (!db) {
    return
  }
  try {
    auditSweepNote(db, hostId, paneKey, agentId, reasonCode)
  } catch (error) {
    console.warn('[restore-sweep] desktop materialize audit write failed', {
      paneKey,
      reasonCode,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** Reveals one pane. On success, deletes the queue entry [D-R153-b6 F1] and audits
 * `desktop_materialize: revealed tab=<tabId>` — [D-R155-b6b finding 5] OUTSIDE the reveal `try`,
 * so a db write failure on this path is never misclassified by the `catch` below as a refusal for
 * a pane that was, in fact, revealed. On a rejection or an identity mismatch the entry stays
 * queued (retried on the next drain) and is audited with one of three distinct codes
 * [D-R155-b6b finding 3]: `identity_mismatch` for a genuine mismatch (this function's own local
 * check, or the primitive's own `terminal_reveal_identity_mismatch`), `reveal_timeout` for the
 * primitive's 10s timeout — the EXPECTED outcome when the end-of-sweep trigger races a renderer
 * that has not hydrated yet — and `reveal_error <message>` for anything else (`runtime_unavailable`,
 * a renderer-side reply error, ...), so a durable record never reads "identity mismatch" for a
 * defect that was not one. [S10-21c B-final, D-R157-b6c finding 4] `<message>` is bounded to 200
 * chars: the primitive wraps the renderer's own reply verbatim (`reject(new Error(reply.error))`),
 * and `agent_audit.reason_code` is unbounded TEXT in an append-only table (no DELETE/UPDATE path)
 * — a pathological or very large renderer error must not mint a row that can never be removed.
 * `resolveTitle` [D-R155-b6b finding 4] is used ONLY when the recorded `surface.title` is null —
 * the record-time value still wins. */
async function materializeOnePane(
  state: DesktopMaterializeQueueState,
  notifier: DesktopMaterializeNotifier,
  resolveTitle: (ptyId: string) => string | null,
  db: OrchestrationDb | null,
  hostId: string,
  paneKey: string,
  surface: RestoredPaneMaterializeSurface
): Promise<'revealed' | 'refused'> {
  try {
    const reveal = await notifier.revealTerminalSession!(surface.worktreeId, {
      ptyId: surface.ptyId,
      title: surface.title ?? resolveTitle(surface.ptyId),
      launchAgent: surface.launchAgent,
      tabId: surface.tabId,
      leafId: surface.leafId,
      presentation: 'background',
      expectedProcessIdentity: surface.expectedProcessIdentity
    })
    const identity = reveal && 'identity' in reveal ? reveal.identity : undefined
    if (
      !identity ||
      !runtimeWorktreeIdsEqual(identity.worktreeId, surface.worktreeId) ||
      identity.tabId !== surface.tabId ||
      identity.leafId !== surface.leafId ||
      identity.ptyId !== surface.ptyId
    ) {
      throw new Error('terminal_reveal_identity_mismatch')
    }
  } catch (error) {
    // Loud, never silent — the pane stays queued so the NEXT drain (the renderer-startup handler
    // fires more than once per cold start) retries it.
    console.warn(
      '[restore-sweep] desktop materialize reveal did not complete; pane remains queued',
      { paneKey, error: error instanceof Error ? error.message : String(error) }
    )
    const message = error instanceof Error ? error.message : String(error)
    const reasonCode =
      message === 'terminal_reveal_identity_mismatch'
        ? 'desktop_materialize_refused: identity_mismatch'
        : message === 'Terminal reveal timed out'
          ? 'desktop_materialize_refused: reveal_timeout'
          : `desktop_materialize_refused: reveal_error ${message.slice(0, 200)}`
    auditSweepNoteSafe(db, hostId, paneKey, surface.agentId, reasonCode)
    return 'refused'
  }
  state.queue.delete(paneKey)
  auditSweepNoteSafe(
    db,
    hostId,
    paneKey,
    surface.agentId,
    `desktop_materialize: revealed tab=${surface.tabId}`
  )
  return 'revealed'
}

/** [S10-21c B6, design §2 S9; D-R153-b6 F1/F2; D-R155-b6b finding 2] Drains every still-queued
 * pane. No notifier installed (serve) -> no-op, returns cleanly: serve has no renderer to reveal
 * into and this module must never assume one. A pane whose pty `isPtyLive` reports gone is
 * skipped and deleted without ever attempting a reveal. Called from
 * `orca-runtime.ts#materializeRestoredAgentPanes` (itself serialized through a single in-flight
 * promise, [D-R153-b6 F6] — see that method's own doc comment), from the SAME main-process
 * handler the legacy-worker-terminal recovery drain uses
 * (`app:recoverLegacyWorkerTerminalsForRendererStartup`, `index.ts:893`) and now also from the
 * end of the desktop sweep body itself (`index.ts` ~3483, [D-R153-b6 F8], gated on renderer
 * hydration — [D-R155-b6b finding 1] — by `desktop-materialize-hydration-gate.ts`). Firing more
 * than once is safe: every entry this call resolves (reveals or drops) is deleted, so a redundant
 * later call simply finds nothing left to do for it. Provably non-rejecting: every audit write
 * goes through `auditSweepNoteSafe`, so neither a throwing/absent `db` nor a reveal failure can
 * propagate out of this function. [S10-21c B-final, D-R157-b6c finding 6] Also logs one summary
 * line per call, but that line is a convenience view only: the `agent_audit` `sweep_note` rows
 * (above) are the evidence that SURVIVES a packaged build, where nothing forwards `console` —
 * Field Drill B1 (design §5 amendment, D-R155-b6b finding 6) reads those rows, not the console. */
export async function drainDesktopMaterializeQueue(
  state: DesktopMaterializeQueueState,
  notifier: DesktopMaterializeNotifier | null,
  isPtyLive: (ptyId: string) => boolean,
  resolveTitle: (ptyId: string) => string | null,
  db: OrchestrationDb | null,
  hostId: string
): Promise<void> {
  if (!notifier?.revealTerminalSession) {
    return
  }
  const pending = [...state.queue.entries()]
  let revealed = 0
  let refused = 0
  let skipped = 0
  await Promise.all(
    pending.map(async ([paneKey, surface]) => {
      if (!isPtyLive(surface.ptyId)) {
        state.queue.delete(paneKey)
        skipped += 1
        auditSweepNoteSafe(
          db,
          hostId,
          paneKey,
          surface.agentId,
          'desktop_materialize_skipped: pty_gone'
        )
        return
      }
      const outcome = await materializeOnePane(
        state,
        notifier,
        resolveTitle,
        db,
        hostId,
        paneKey,
        surface
      )
      if (outcome === 'revealed') {
        revealed += 1
      } else {
        refused += 1
      }
    })
  )
  console.log(
    `[restore-sweep] desktop materialize: queued ${pending.length} revealed ${revealed} refused ${refused} skipped ${skipped}`
  )
}
