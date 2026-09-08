// S10-21c B6 (design §2 S9): desktop materialization (T2 CODE; acceptance gated on Field Drill
// B1, design doc §5 — see that section before treating T2 as met). The sweep records each
// successful Layer-2 restore's surface here; later, after the renderer has hydrated its tabs,
// the host drains the queue through the EXISTING `notifier.revealTerminalSession` primitive
// (verified `attach-main-window-services.ts:385-424` — rejects on an identity mismatch, resolves
// only on an exact worktreeId/tabId/leafId/ptyId match) instead of new renderer-store surgery.
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
import type { RestoreSweepDeps } from './restore-sweep-types'

/** One successful Layer-2 restore's surface — everything the drain needs to drive
 * `notifier.revealTerminalSession` for this pane, captured at record time so the drain never
 * re-derives it from mutable runtime state. */
export type RestoredPaneMaterializeSurface = {
  paneKey: string
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  expectedProcessIdentity: { terminalHandle: string; incarnationId: string }
}

/** Runtime-held state: one queue entry per pane, plus the epoch each pane was last successfully
 * materialized under (mirrors `legacyWorkerTerminalReceiptEpochByPane`'s shape/intent). Entries
 * are never deleted on success — the epoch guard is what makes a redrain within the SAME epoch a
 * no-op, and a mismatch leaves the entry queued (never marked) so the next drain retries it. */
export type DesktopMaterializeQueueState = {
  queue: Map<string, RestoredPaneMaterializeSurface>
  materializedEpochByPane: Map<string, number>
}

export function createDesktopMaterializeQueueState(): DesktopMaterializeQueueState {
  return { queue: new Map(), materializedEpochByPane: new Map() }
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
 * incomplete surface (missing ptyId or process incarnation — not expected given a successful
 * rebind, but not proven unreachable) is logged loudly and dropped rather than queued
 * half-built — `console.warn`, the same loud-not-silent primitive
 * `reconcileLegacyWorkerTerminalsNow`'s own "adopted legacy worker was not revealed" arm uses
 * for this same class of best-effort-materialization degradation (never a DB audit row: this
 * call has no `hostId`/`agentId`/`launchRow` to attribute one to, deliberately, to keep this
 * call site a one-liner under restore-registered-agent-panes.ts's max-lines budget). */
export function recordDesktopMaterialize(
  deps: RestoreSweepDeps,
  created: RuntimeEnsureAgentSessionResult,
  newPaneKey: string,
  newTerminalHandle: string,
  newProcessIncarnation: string | null
): void {
  const parsed = parsePaneKey(newPaneKey)
  const ptyId = created.terminal.ptyId
  if (!parsed || !ptyId || !newProcessIncarnation) {
    console.warn('[restore-sweep] desktop materialize queue skipped: incomplete surface', {
      newPaneKey
    })
    return
  }
  deps.recordRestoredPaneForDesktopMaterialization({
    paneKey: newPaneKey,
    worktreeId: created.terminal.worktreeId,
    tabId: parsed.tabId,
    leafId: parsed.leafId,
    ptyId,
    expectedProcessIdentity: {
      terminalHandle: newTerminalHandle,
      incarnationId: newProcessIncarnation
    }
  })
}

/** Minimal structural shape of the runtime's `notifier` this module needs. The runtime's own
 * `RuntimeNotifier` type is not exported (orca-runtime.ts keeps it file-local) and this module
 * needs only this one method — the runtime passes `this.notifier` in directly. */
export type DesktopMaterializeNotifier = {
  revealTerminalSession?(
    worktreeId: string,
    opts: {
      ptyId: string
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

async function materializeOnePane(
  state: DesktopMaterializeQueueState,
  notifier: DesktopMaterializeNotifier,
  rendererGraphEpoch: number,
  paneKey: string,
  surface: RestoredPaneMaterializeSurface
): Promise<void> {
  try {
    const reveal = await notifier.revealTerminalSession!(surface.worktreeId, {
      ptyId: surface.ptyId,
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
    state.materializedEpochByPane.set(paneKey, rendererGraphEpoch)
  } catch (error) {
    // Loud, never silent — the pane stays queued (materializedEpochByPane untouched) so the NEXT
    // drain (the renderer-startup handler fires more than once per cold start) retries it.
    console.warn(
      '[restore-sweep] desktop materialize reveal did not complete; pane remains queued',
      { paneKey, error: error instanceof Error ? error.message : String(error) }
    )
  }
}

/** [S10-21c B6, design §2 S9] Drains every queued pane not yet materialized THIS renderer
 * epoch. No notifier installed (serve) -> no-op, returns cleanly: serve has no renderer to
 * reveal into and this module must never assume one. Called from
 * `orca-runtime.ts#materializeRestoredAgentPanes`, itself invoked from the SAME main-process
 * handler the legacy-worker-terminal recovery drain uses
 * (`app:recoverLegacyWorkerTerminalsForRendererStartup`, `index.ts:893`) — that handler fires
 * `reconcile()` on both its pre- and post-`reconnectPersistedTerminals` invocations with no
 * discriminator available to the main process (App.tsx passes no argument either time); firing
 * this drain on both is safe for the same reason the existing legacy-worker drain already fires
 * on both: the epoch guard makes every call after the first successful reveal a no-op, and a
 * reveal that arrives before hydration either lands (fine) or fails/mismatches and is logged and
 * retried on the next call, never marked, never silently dropped. */
export async function drainDesktopMaterializeQueue(
  state: DesktopMaterializeQueueState,
  notifier: DesktopMaterializeNotifier | null,
  rendererGraphEpoch: number
): Promise<void> {
  if (!notifier?.revealTerminalSession) {
    return
  }
  const pending = [...state.queue.entries()].filter(
    ([paneKey]) => state.materializedEpochByPane.get(paneKey) !== rendererGraphEpoch
  )
  await Promise.all(
    pending.map(([paneKey, surface]) =>
      materializeOnePane(state, notifier, rendererGraphEpoch, paneKey, surface)
    )
  )
}
