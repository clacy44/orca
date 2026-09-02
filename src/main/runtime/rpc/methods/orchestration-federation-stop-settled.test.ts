// S10-19 W1-T1 (ops BL-3 / attacker 5, Ruling 24(e)): federationStop on an 'agent_exited' row
// must return alreadySettled:true, never throw dispatch_inactive — PEER_ATTACHMENT_SETTLED_STATES
// is the ONE list both db.ts's beginRemoteAttachmentStop and this handler consult.
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { RpcContext } from '../core'
import { ORCHESTRATION_FEDERATION_CONTROL_METHODS } from './orchestration-federation-control'

describe('S10-19 W1-T1: federationStop on an already-agent_exited row', () => {
  it('returns alreadySettled:true and does not throw dispatch_inactive', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    const dispatchId = 'disp_w1t1_exited1'
    const homeFingerprint = 'home-peer-fp'
    ;(
      db as unknown as {
        db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } }
      }
    ).db
      .prepare(
        `INSERT INTO remote_dispatch_attachments
           (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage, agent_exited_at)
         VALUES (?, 'task_w1t1', ?, 'epoch1', 'agent_exited', 'agent_exited', datetime('now'))`
      )
      .run(dispatchId, homeFingerprint)

    const method = ORCHESTRATION_FEDERATION_CONTROL_METHODS.find(
      (m) => m.name === 'orchestration.federationStop'
    )
    expect(method).toBeDefined()

    const ctx: RpcContext = {
      runtime,
      authenticatedCallerFingerprint: homeFingerprint
    }
    const result = (await method!.handler({ dispatchId }, ctx)) as {
      dispatchId: string
      state: string
      alreadySettled: boolean
      processAction: string
    }

    expect(result).toEqual({
      dispatchId,
      state: 'agent_exited',
      alreadySettled: true,
      processAction: 'none'
    })
  })
})
