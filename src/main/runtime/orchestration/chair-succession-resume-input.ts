// S10-22a WAVE 2: builds wave 1's `ResumeContextInput` from live runtime/db state (D-R215 §Protocol
// step 3 "rendered at seal time... chair, Run, obligations incl. the retired handle and
// outstanding delivery ids, board"). Split out of chair-succession-seal.ts so that file's seal
// logic and this pure assembly stay independently readable.
//
// DISCLOSED DEVIATION (see the brief's RETURN): `pendingPeerQuestionThreadIds`/`pactTurnsHeld`
// render as `[]`/`0` — no reachable existing query for either surfaced itself in this file's
// search; `board.worktrees` is the chair's own bound worktree only, not a full workspace scan (no
// public runtime accessor enumerates every worktree from this layer).
import type { OrchestrationDb } from './db'
import type { OrcaRuntimeService } from '../orca-runtime'
import { listRetiredHandles, type ChairSuccessionStoreDeps } from './chair-succession-store'
import type { CharterMode, ResumeContextInput } from './chair-succession-types'

export type BuildResumeInputParams = {
  successionId: string
  hostId: string
  chairName: string
  agentId: string
  terminalHandle: string
  paneKey: string
  runId: string
  generation: number
  worktree: string
  charterPath: string
  charterSha: string
  charterMode: CharterMode
  charterText?: string
  ackedDeliveryIds: string[]
  checkpointText: string
  checkpointSha: string
}

export async function buildResumeContextInput(
  deps: { db: OrchestrationDb; runtime: OrcaRuntimeService; storeDeps: ChairSuccessionStoreDeps },
  params: BuildResumeInputParams
): Promise<ResumeContextInput> {
  const chairAgentRow = deps.db.getAgentByName(params.hostId, params.chairName)
  const retired = await listRetiredHandles(deps.storeDeps, params.chairName)
  const laneRow = deps.runtime.credentialLaneOfPaneKey(params.paneKey)
  const lane = laneRow ? (laneRow.kind === 'shared' ? 'shared' : laneRow.principalId) : 'default'
  const liveSeats = deps.db
    .listAgents({ hostId: params.hostId, includeDerived: false, includeQuarantined: false })
    .agents.filter((a) => {
      const signals = deps.runtime.getAgentDirectoryLivenessSignals(a.pane_key ?? '')
      return signals.terminalHandle !== null || signals.observedLive
    })
    .map((a) => ({ name: a.display_name, pane: a.pane_key ?? '', state: a.state }))
  const unfinishedTasks = deps.db
    .listTasksWithDispatch({ runId: params.runId })
    .filter((t) => t.status !== 'completed' && t.status !== 'failed')
    .map((t) => ({ id: t.id, title: t.task_title ?? t.display_name ?? t.id, state: t.status }))

  return {
    successionId: params.successionId,
    charter: {
      path: params.charterPath,
      sha256: params.charterSha,
      mode: params.charterMode,
      ...(params.charterMode === 'embed' ? { text: params.charterText ?? '' } : {})
    },
    runBinding: {
      chair: params.chairName,
      agentId: params.agentId,
      runId: params.runId,
      generation: params.generation,
      handle: params.terminalHandle,
      lane,
      worktree: params.worktree
    },
    obligations: {
      ackedDeliveryIds: params.ackedDeliveryIds,
      outstandingDeliveryIds: [],
      retiredHandle: retired.at(-1)?.handle ?? null,
      pendingPeerQuestionThreadIds: [],
      pactTurnsHeld: 0
    },
    board: {
      worktrees: [
        { path: params.worktree, branch: chairAgentRow?.branch ?? 'unknown', tip: 'unknown' }
      ],
      unfinishedTasks,
      liveSeats
    },
    checkpointText: params.checkpointText,
    checkpointSha: params.checkpointSha
  }
}
