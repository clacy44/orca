import type { AppState } from '@/store/types'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  HIBERNATION_GUARD_MAX_PANE_KEYS,
  isBackgroundWorkVerdict,
  type HibernationGuardSnapshot
} from '../../../shared/hibernation-guard-types'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

const GUARD_RPC_TIMEOUT_MS = 10_000

function targetKey(environmentId: string | null): string {
  return environmentId === null ? 'local' : `env:${environmentId}`
}

// Why: only done agent panes in a non-active worktree can ever be sleep candidates; asking the
// host about nothing else keeps the per-tick RPC small.
function collectGuardPaneKeysByTarget(
  state: AppState
): Map<string, { target: RuntimeClientTarget; paneKeys: string[] }> {
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }
  const byTarget = new Map<string, { target: RuntimeClientTarget; paneKeys: string[] }>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (!entry || entry.state !== 'done') {
      continue
    }
    const tabId = entry.tabId ?? parsePaneKey(entry.paneKey)?.tabId
    const worktreeId = tabId ? worktreeIdByTabId.get(tabId) : undefined
    if (!worktreeId || worktreeId === state.activeWorktreeId) {
      continue
    }
    const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    const key = targetKey(environmentId)
    const group = byTarget.get(key) ?? {
      target:
        environmentId === null
          ? { kind: 'local' as const }
          : { kind: 'environment' as const, environmentId },
      paneKeys: []
    }
    group.paneKeys.push(entry.paneKey)
    byTarget.set(key, group)
  }
  return byTarget
}

function parseGuardResult(result: unknown, paneKeys: string[]): HibernationGuardSnapshot | null {
  if (typeof result !== 'object' || result === null) {
    return null
  }
  const { protectedPaneKeys, backgroundWork } = result as Record<string, unknown>
  if (
    !Array.isArray(protectedPaneKeys) ||
    typeof backgroundWork !== 'object' ||
    backgroundWork === null
  ) {
    return null
  }
  const verdicts: HibernationGuardSnapshot['backgroundWork'] = {}
  for (const paneKey of paneKeys) {
    const verdict = (backgroundWork as Record<string, unknown>)[paneKey]
    if (isBackgroundWorkVerdict(verdict)) {
      verdicts[paneKey] = verdict
    }
  }
  return {
    protectedPaneKeys: protectedPaneKeys.filter((key): key is string => typeof key === 'string'),
    backgroundWork: verdicts
  }
}

/**
 * R316: fetch the host's sleep guard from each runtime that owns candidate panes. A target whose
 * RPC fails, times out, is unsupported (old runtime) or answers malformed contributes NO verdicts,
 * so the planner refuses every one of its panes (a missing verdict is never 'idle').
 */
export async function collectHibernationGuard(state: AppState): Promise<HibernationGuardSnapshot> {
  const merged: HibernationGuardSnapshot = { protectedPaneKeys: [], backgroundWork: {} }
  await Promise.all(
    [...collectGuardPaneKeysByTarget(state).values()].map(async ({ target, paneKeys }) => {
      const parts: HibernationGuardSnapshot[] = []
      try {
        for (let i = 0; i < paneKeys.length; i += HIBERNATION_GUARD_MAX_PANE_KEYS) {
          const chunk = paneKeys.slice(i, i + HIBERNATION_GUARD_MAX_PANE_KEYS)
          const result = await callRuntimeRpc<unknown>(
            target,
            'terminal.hibernationGuard',
            { paneKeys: chunk },
            { timeoutMs: GUARD_RPC_TIMEOUT_MS }
          )
          const parsed = parseGuardResult(result, chunk)
          if (!parsed) {
            return
          }
          parts.push(parsed)
        }
      } catch {
        // Why: fail closed — this target's panes get no verdict and therefore never sleep.
        return
      }
      for (const part of parts) {
        merged.protectedPaneKeys.push(...part.protectedPaneKeys)
        Object.assign(merged.backgroundWork, part.backgroundWork)
      }
    })
  )
  return merged
}
