// S10-21b B8 (design §2.5) — the inbound-apply wake descriptor: pact-federated-inbound-apply.ts
// returns one of these per applied verb; orchestration-federated-peer-send.ts (which holds
// `runtime`) fires the actual wake AFTER the transaction commits. Kept out of the apply module
// (which never imports OrcaRuntimeService — db.ts, which would wrap it as a method, would cycle
// back into orca-runtime.ts) and out of the RPC handler (which would otherwise re-derive the
// per-verb wake shape) — this is the one place that maps verb -> wake target.
import type { ThreadRow } from './types'
import type { InboundPactVerb } from './pact-federated-inbound-gates'
import { otherLocalParty } from './pact-federated-inbound-gates'

export type InboundPactWake =
  | { kind: 'none' }
  | { kind: 'proposed'; toAgentId: string; threadId: string }
  | { kind: 'accepted'; proposerAgentId: string | null; threadId: string }
  | { kind: 'declined'; otherLocal: string | null; threadId: string }
  | { kind: 'released'; bothParties: (string | null)[]; threadId: string }
  | { kind: 'stepArrived'; otherLocal: string | null; threadId: string }
  | {
      kind: 'pauseOrResume'
      verb: 'pause' | 'resume'
      bothParties: (string | null)[]
      threadId: string
    }
  | { kind: 'gapNotice'; bothParties: (string | null)[]; threadId: string }

export function describeWake(
  thread: ThreadRow,
  verb: InboundPactVerb,
  turnAfterAgentId: string | null,
  senderKey: string
): InboundPactWake {
  const other = otherLocalParty(thread, senderKey)
  const bothParties = [thread.pact_proposer_agent_id, thread.pact_with_agent_id]
  if (verb === 'accept') {
    return { kind: 'accepted', proposerAgentId: turnAfterAgentId, threadId: thread.id }
  } else if (verb === 'decline') {
    return { kind: 'declined', otherLocal: other, threadId: thread.id }
  } else if (verb === 'release') {
    return { kind: 'released', bothParties, threadId: thread.id }
  } else if (verb === 'step') {
    return { kind: 'stepArrived', otherLocal: other, threadId: thread.id }
  } else if (verb === 'pause' || verb === 'resume') {
    return { kind: 'pauseOrResume', verb, bothParties, threadId: thread.id }
  } else if (verb === 'gap_notice') {
    return { kind: 'gapNotice', bothParties, threadId: thread.id }
  }
  return { kind: 'none' }
}
