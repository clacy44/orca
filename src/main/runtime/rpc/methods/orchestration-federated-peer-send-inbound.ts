// S10-16 C5, R28.1: the inbound thread-selection half of orchestration.federatedSend — split
// out of orchestration-federated-peer-send.ts to stay under the max-lines ratchet (LINT/Ruling
// 26 fix-up). No behaviour change; R27 rate-before-containment ordering is untouched (that
// ordering lives entirely in the handler this module does not touch).
import { deriveThreadSubject } from '../../../../shared/thread-subject'
import { getRoutableLinkBinding } from '../../orchestration/link-binding-routable'
import type { OrchestrationDb } from '../../orchestration/db'
import type { MessageRow } from '../../orchestration/types'
import type { OrcaRuntimeService } from '../../orca-runtime'

// S10-16 C5, R28.1: the ONE thread selector — rule 1 (reply to a locally-authored outbound row,
// gated by clauses (i)/(ii)), rule 2 (continuation on (link, peerThreadId)), rule 3 (mint fresh).
// Also computes R20.1's authorshipUnconfirmed flag (a lookup this function already performs).
export function resolveForeignThread(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  args: {
    toAgent: NonNullable<ReturnType<OrchestrationDb['getAgentById']>>
    askerHandle: string
    pairedDeviceId: string
    inReplyToMessageId: string | undefined
    peerThreadId: string | null
    subject: string
    body: string | undefined
  }
): { threadId: string; authorshipUnconfirmed: boolean } {
  const participants = [
    {
      participantKey: args.askerHandle,
      agentId: null,
      handle: args.askerHandle,
      role: 'owner' as const
    },
    {
      participantKey: args.toAgent.id,
      agentId: args.toAgent.id,
      handle: args.toAgent.terminal_handle,
      role: 'member' as const
    }
  ]
  const mintFresh = (): { threadId: string; authorshipUnconfirmed: boolean } => {
    const { thread } = db.createThread({
      subject: deriveThreadSubject({ body: args.body ?? '' }),
      createdByAgentId: null,
      origin: 'peer',
      participants
    })
    return { threadId: thread.id, authorshipUnconfirmed: false }
  }

  if (args.inReplyToMessageId !== undefined) {
    const r: MessageRow | undefined = db.getMessageById(args.inReplyToMessageId)
    // R20.1's predicate: locally authored here, addressed outward — independent of whether an
    // acknowledgement came back (v4 wrongly also required peer_relayed_at != null).
    const authorshipOk =
      r !== undefined && r.from_handle.startsWith('agent:') && r.to_handle.startsWith('remote:')
    if (!authorshipOk) {
      // L5: the receiver STORES the reply; it does not refuse. Falls through to rule 2/3.
      const rest = args.peerThreadId != null ? resolveByPeerThread() : mintFresh()
      return { threadId: rest.threadId, authorshipUnconfirmed: true }
    }
    const row = r as MessageRow
    // R28.1(1a) clause (i): the row is addressed back to THIS reply's recipient.
    const clauseI = row.from_handle === `agent:${args.toAgent.id}`
    let clauseII = false
    if (clauseI) {
      const toEnv = row.to_handle.split(':')[1]
      const callerBinding = getRoutableLinkBinding(db, runtime, args.pairedDeviceId)
      if (toEnv && callerBinding) {
        if (toEnv === callerBinding.environmentId) {
          clauseII = true
        } else {
          // Ruling 26 Addendum 5(nn): mechanical rename follow (findBindingCandidateByKeyFingerprint
          // is not the routable predicate); this clause only reads the candidate's environmentId
          // for an authorship comparison and never retargets — behaviour unchanged.
          const retargeted = db.findBindingCandidateByKeyFingerprint(
            callerBinding.peerKeyFingerprint
          )
          clauseII = retargeted?.environmentId === toEnv
        }
      }
    }
    if (clauseI && clauseII) {
      if (row.thread_id) {
        return { threadId: row.thread_id, authorshipUnconfirmed: false }
      }
      // R28.1(1b): mint + back-fill the NULL-thread row this reply answers.
      const { threadId } = db.mintThreadAndBackfillMessage(row.id, {
        subject: deriveThreadSubject({ body: args.body ?? '' }),
        createdByAgentId: null,
        origin: 'peer',
        participants
      })
      return { threadId, authorshipUnconfirmed: false }
    }
    // Authorship passed but the thread-selection clauses did not — a well-formed reply that
    // simply gets its own thread (never a refusal, never authorshipUnconfirmed).
    const rest = args.peerThreadId != null ? resolveByPeerThread() : mintFresh()
    return { threadId: rest.threadId, authorshipUnconfirmed: false }
  }

  function resolveByPeerThread(): { threadId: string; authorshipUnconfirmed: boolean } {
    if (args.peerThreadId != null) {
      const prior = db.findForeignRowByLinkAndPeerThread(args.pairedDeviceId, args.peerThreadId)
      if (prior?.thread_id) {
        return { threadId: prior.thread_id, authorshipUnconfirmed: false }
      }
    }
    return mintFresh()
  }

  return resolveByPeerThread()
}
