// S10-19 W-3 (Ruling 24(a)): the two profile-specific dispatch-input sends, split out of
// orchestration-federation.ts to stay under the max-lines ratchet.
import { stripAgentPromptSubmitBytes } from '../../../../shared/agent-prompt-injection'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { captureDispatchInputEvidence } from '../../orchestration/dispatch-input-evidence'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { buildPeerDispatchMailPointerPreamble } from './orchestration-federation-peer-mail-pointer'
import type { FederationEffect } from './orchestration-federation-effects'

type DispatchInputSendResult = {
  attachment: ReturnType<OrchestrationDb['markRemoteAttachmentReady']>
  inputEvidence: ReturnType<typeof captureDispatchInputEvidence>
}

// Ruling 24(a) PEER profile (review M4/M6): taskSpec is NEVER typed. Order matches the FULL
// path — write first, `ready` LAST — so a refused mail body or a failed pane write leaves the
// row in 'starting' and the caller's catch can still route it through failRemoteAttachment to a
// receipt (dispatch_inactive is only reachable once the row IS ready, review finding 4). The
// preamble write also carries the same fresh-foreground conjunct the FULL paste does (review
// finding 6) — the least-trusted caller's write must not be the one write path with no
// liveness gate.
export async function sendPeerDispatchMailPointer(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  dispatchId: string
  taskId: string
  taskSpec: string
  terminalHandle: string
  capability?: string
  cliCommand?: 'orca' | 'orca-ide'
  effects: FederationEffect[]
}): Promise<DispatchInputSendResult> {
  const mailInsert = args.db.insertGatedMessage({
    from: 'Run home (relayed by Orca)',
    to: `dispatch:${args.dispatchId}`,
    subject: `Task ${args.taskId}`,
    body: args.taskSpec,
    type: 'dispatch',
    verb: 'federation_import'
  })
  if (mailInsert.outcome === 'refused') {
    throw new Error('The task body was refused by the outbound content gate.')
  }
  args.runtime.notifyMessageArrived(`dispatch:${args.dispatchId}`, 'dispatch')
  await args.runtime.sendTerminalAgentPrompt(
    args.terminalHandle,
    buildPeerDispatchMailPointerPreamble({
      dispatchId: args.dispatchId,
      taskId: args.taskId,
      workerHandle: args.terminalHandle,
      dispatchCapability: args.capability,
      cliCommand: args.cliCommand
    }),
    {
      beforeWrite: async () => {
        if (!(await args.runtime.isPeerPaneForegroundAgentLive(args.terminalHandle))) {
          throw new Error('agent_not_live')
        }
      }
    }
  )
  const inputEvidence = captureDispatchInputEvidence(args.runtime, args.terminalHandle)
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: args.terminalHandle,
    state: 'accepted'
  })
  const attachment = args.db.markRemoteAttachmentReady(args.dispatchId, args.effects)
  return { attachment, inputEvidence }
}

// Ruling 24(a) FULL profile: the paste stays, with two changes — every submit byte stripped from
// taskSpec first (exactly one host submit occurs), and a beforeWrite liveness conjunct
// (isPeerPaneForegroundAgentLive is the safety gate here, not the stale tui-idle wait — see its
// own doc comment).
export async function sendFullDispatchPaste(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  dispatchId: string
  taskId: string
  taskSpec: string
  terminalHandle: string
  capability?: string
  cliCommand?: 'orca' | 'orca-ide'
  devMode?: boolean
  effects: FederationEffect[]
}): Promise<DispatchInputSendResult> {
  await args.runtime.sendTerminalAgentPrompt(
    args.terminalHandle,
    buildDispatchPreamble({
      taskId: args.taskId,
      dispatchId: args.dispatchId,
      taskSpec: stripAgentPromptSubmitBytes(args.taskSpec),
      coordinatorHandle: 'Run home (relayed by Orca)',
      workerHandle: args.terminalHandle,
      dispatchCapability: args.capability,
      devMode: args.devMode,
      cliCommand: args.cliCommand
    }),
    {
      beforeWrite: async () => {
        if (!(await args.runtime.isPeerPaneForegroundAgentLive(args.terminalHandle))) {
          throw new Error('agent_not_live')
        }
      }
    }
  )
  // Why the peer reads its own terminal: the home never sees this PTY, so the only runtime that
  // can say what was on screen at the submit is the one that wrote it (A1 section 2).
  const inputEvidence = captureDispatchInputEvidence(args.runtime, args.terminalHandle)
  args.effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: args.terminalHandle,
    state: 'accepted'
  })
  const attachment = args.db.markRemoteAttachmentReady(args.dispatchId, args.effects)
  return { attachment, inputEvidence }
}
