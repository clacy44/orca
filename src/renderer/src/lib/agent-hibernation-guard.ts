import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { HibernationGuardSnapshot } from '../../../shared/hibernation-guard-types'

// Why: provider done hooks can fire mid-Dispatch; only runtime-confirmed settlement makes sleep safe.
export const hasUnsettledOrUnknownDispatch = ({ orchestration }: AgentStatusEntry): boolean =>
  orchestration
    ? !['completed', 'failed', 'circuit_broken'].includes(orchestration.dispatchStatus ?? '')
    : false

/**
 * R316: true when the host guard forbids sleeping this pane. A protected pane never qualifies,
 * and only an explicit 'idle' background-work verdict does — 'busy', 'unknown' and a missing
 * verdict all refuse, so a guard that could not be computed hibernates nothing.
 */
export function guardRefusal(entry: AgentStatusEntry, guard: HibernationGuardSnapshot): boolean {
  if (guard.protectedPaneKeys.includes(entry.paneKey)) {
    return true
  }
  return guard.backgroundWork[entry.paneKey] !== 'idle'
}
