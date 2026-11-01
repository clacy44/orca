// Bounded drain for the live-terminal surface reconcile: reveals each planned terminal through
// `notifier.revealTerminalSession`, at most 4 at a time inside one 10 s budget. The planner and
// the exclusion rules live in live-terminal-surface-plan.ts.
import {
  MATERIALIZE_ONLY_ERROR_AMBIGUOUS,
  MATERIALIZE_ONLY_ERROR_TAB_CONFLICT,
  MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE,
  type TerminalRevealIdentity
} from '../../shared/terminal-reveal-identity'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { runtimeWorktreeIdsEqual } from './runtime-worktree-id-equality'
import type {
  LiveSurfaceReceipts,
  LiveSurfaceRevealGroup,
  LiveSurfaceRevealItem,
  ReceiptOutcome
} from './live-terminal-surface-plan'

export const LIVE_SURFACE_REVEAL_CONCURRENCY = 4
export const LIVE_SURFACE_RECONCILE_BUDGET_MS = 10_000

export type LiveSurfaceRevealOptions = {
  ptyId: string
  title: string | null
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  activate: false
  focus: false
  presentation: 'background'
  materializeOnly: true
  tabId: string
  leafId: string
  splitFromLeafId?: string
  expectedProcessIdentity?: { terminalHandle: string; incarnationId: string }
}

export type LiveSurfaceRevealReply =
  | { identity?: TerminalRevealIdentity; skipped?: 'owned' }
  | void
  | undefined

export type LiveSurfaceLiveness = { live: boolean | null; incarnationId?: string | null }

export type LiveSurfaceDrainSummary = {
  revealed: number
  owned: number
  refused: number
  deferred: number
  budgetExhausted: boolean
}

export function buildLiveSurfaceRevealOptions(
  item: LiveSurfaceRevealItem,
  splitFromLeafId: string | null
): LiveSurfaceRevealOptions {
  return {
    ptyId: item.ptyId,
    title: item.title,
    ...(item.launchAgent ? { launchAgent: item.launchAgent } : {}),
    // Why: the launch TOKEN is never forwarded — only the config the renderer needs for chrome.
    ...(item.launchConfig ? { launchConfig: item.launchConfig } : {}),
    activate: false,
    focus: false,
    presentation: 'background',
    materializeOnly: true,
    tabId: item.tabId,
    leafId: item.leafId,
    ...(splitFromLeafId ? { splitFromLeafId } : {}),
    ...(item.expectedProcessIdentity
      ? { expectedProcessIdentity: item.expectedProcessIdentity }
      : {})
  }
}

const REFUSING_ERRORS = new Set([
  MATERIALIZE_ONLY_ERROR_AMBIGUOUS,
  MATERIALIZE_ONLY_ERROR_TAB_CONFLICT,
  'terminal_reveal_identity_mismatch'
])

export async function drainLiveTerminalSurfaceReveals(deps: {
  groups: LiveSurfaceRevealGroup[]
  reveal: (worktreeId: string, opts: LiveSurfaceRevealOptions) => Promise<LiveSurfaceRevealReply>
  /** Fresh controller check made immediately before each reveal. */
  checkLiveness: (item: LiveSurfaceRevealItem) => Promise<LiveSurfaceLiveness>
  receipts: LiveSurfaceReceipts
  /** Renderer graph epoch the plan was made against; receipts are recorded under it. */
  planEpoch: number
  getEpoch: () => number
  recordBreadcrumb: (name: string, data: Record<string, string | number | boolean | null>) => void
  now?: () => number
  budgetMs?: number
  concurrency?: number
}): Promise<LiveSurfaceDrainSummary> {
  const now = deps.now ?? Date.now
  const budgetMs = deps.budgetMs ?? LIVE_SURFACE_RECONCILE_BUDGET_MS
  const startedAt = now()
  const summary: LiveSurfaceDrainSummary = {
    revealed: 0,
    owned: 0,
    refused: 0,
    deferred: 0,
    budgetExhausted: false
  }
  const remainingMs = (): number => budgetMs - (now() - startedAt)
  const queue = [...deps.groups]

  const settle = (item: LiveSurfaceRevealItem, epoch: number, outcome: ReceiptOutcome): void => {
    deps.receipts.record(item.ptyId, item.incarnationId, epoch, outcome)
    if (outcome === 'refused') {
      summary.refused += 1
    } else if (outcome === 'owned') {
      summary.owned += 1
    } else {
      summary.revealed += 1
    }
  }

  const revealOne = async (
    item: LiveSurfaceRevealItem,
    splitFromLeafId: string | null
  ): Promise<'handled' | 'stop'> => {
    const epoch = deps.planEpoch
    const liveness = await deps
      .checkLiveness(item)
      .catch(() => ({ live: null }) as LiveSurfaceLiveness)
    if (liveness.live === null) {
      deps.recordBreadcrumb('live_terminal_surface_deferred', {
        ptyId: item.ptyId,
        reason: 'liveness_unknown'
      })
      summary.deferred += 1
      return 'stop'
    }
    if (
      liveness.live === false ||
      (item.incarnationId &&
        liveness.incarnationId &&
        liveness.incarnationId !== item.incarnationId)
    ) {
      // Exited (or was replaced) in the gap: a tab for it would be a dead surface.
      deps.recordBreadcrumb('live_terminal_surface_skipped', {
        ptyId: item.ptyId,
        reason: 'exited_in_gap'
      })
      return 'stop'
    }
    // Why: the liveness round can eat the whole budget; a reveal started now would overrun it.
    if (remainingMs() <= 0) {
      summary.budgetExhausted = true
      summary.deferred += 1
      return 'stop'
    }
    // Why: a renderer reload since planning invalidates the plan and the tab ownership it saw;
    // reveal nothing from it and leave no receipt, so the next call re-plans against the new graph.
    if (deps.getEpoch() !== epoch) {
      deps.recordBreadcrumb('live_terminal_surface_deferred', {
        ptyId: item.ptyId,
        reason: 'epoch_changed'
      })
      summary.deferred += 1 + queue.reduce((sum, group) => sum + group.items.length, 0)
      queue.length = 0
      return 'stop'
    }
    const outcome = await new Promise<
      | { kind: 'reply'; reply: LiveSurfaceRevealReply }
      | { kind: 'error'; error: unknown }
      | { kind: 'budget' }
    >((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'budget' }), Math.max(1, remainingMs()))
      deps.reveal(item.worktreeId, buildLiveSurfaceRevealOptions(item, splitFromLeafId)).then(
        (reply) => {
          clearTimeout(timer)
          if (isSuccessfulReply(reply, item)) {
            // A reply that lands after the budget still counts: the next call finds it settled.
            deps.receipts.record(item.ptyId, item.incarnationId, epoch, replyOutcome(reply))
          }
          resolve({ kind: 'reply', reply })
        },
        (error: unknown) => {
          clearTimeout(timer)
          resolve({ kind: 'error', error })
        }
      )
    })
    if (outcome.kind === 'budget') {
      summary.budgetExhausted = true
      summary.deferred += 1
      return 'stop'
    }
    if (outcome.kind === 'reply') {
      if (isSuccessfulReply(outcome.reply, item)) {
        settle(item, epoch, replyOutcome(outcome.reply))
        return 'handled'
      }
      deps.recordBreadcrumb('live_terminal_surface_refused', {
        ptyId: item.ptyId,
        reason: 'identity_mismatch'
      })
      settle(item, epoch, 'refused')
      return 'stop'
    }
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    const reason = message.slice(0, 120)
    if (REFUSING_ERRORS.has(message)) {
      // Ambiguous / conflicting ownership will not heal inside this epoch; do not retry.
      deps.recordBreadcrumb('live_terminal_surface_refused', { ptyId: item.ptyId, reason })
      settle(item, epoch, 'refused')
      return 'stop'
    }
    // Unknown worktree (catalog still loading), timeout, runtime_unavailable ...: retry next call.
    deps.recordBreadcrumb(
      message === MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE
        ? 'live_terminal_surface_deferred'
        : 'live_terminal_surface_failed',
      { ptyId: item.ptyId, reason }
    )
    summary.deferred += 1
    return 'stop'
  }

  const runGroup = async (group: LiveSurfaceRevealGroup): Promise<void> => {
    let splitFrom = group.anchorLeafId
    for (const item of group.items) {
      if (remainingMs() <= 0) {
        summary.budgetExhausted = true
        summary.deferred += 1
        continue
      }
      const result = await revealOne(item, splitFrom)
      if (result === 'stop') {
        // Later leaves of this tab depend on the first one landing.
        summary.deferred += group.items.length - group.items.indexOf(item) - 1
        return
      }
      splitFrom ??= item.leafId
    }
  }

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      if (remainingMs() <= 0) {
        summary.budgetExhausted = true
        summary.deferred += queue.reduce((sum, group) => sum + group.items.length, 0)
        queue.length = 0
        return
      }
      const group = queue.shift()
      if (group) {
        await runGroup(group)
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(deps.concurrency ?? LIVE_SURFACE_REVEAL_CONCURRENCY, queue.length) },
      worker
    )
  )
  return summary
}

function isSuccessfulReply(reply: LiveSurfaceRevealReply, item: LiveSurfaceRevealItem): boolean {
  if (!reply) {
    return false
  }
  if (reply.skipped === 'owned') {
    return true
  }
  const identity = reply.identity
  return Boolean(
    identity &&
    runtimeWorktreeIdsEqual(identity.worktreeId, item.worktreeId) &&
    identity.tabId === item.tabId &&
    identity.leafId === item.leafId &&
    identity.ptyId === item.ptyId
  )
}

function replyOutcome(reply: LiveSurfaceRevealReply): ReceiptOutcome {
  return reply && reply.skipped === 'owned' ? 'owned' : 'revealed'
}
