// S10-2b deferral (ruling 8 follow-up): sensitive-thread refusals at the three edges a
// sensitive thread's content could otherwise leak past its own participant list — a group/
// broadcast fan-out (many recipients, not all necessarily participants) and the two federation
// relay-enqueue points (content leaving this host entirely). A thread with no `--thread-id`
// given, or one that resolves to no row (not yet minted, or purged), is never sensitive by
// construction — this only ever fires against an EXISTING sensitive thread.
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../orchestration/db'

export function assertThreadNotSensitiveForBroadcast(
  db: OrchestrationDb,
  threadId: string | null | undefined
): void {
  if (!threadId) {
    return
  }
  const thread = db.getThread(threadId)
  if (thread?.sensitive === 1) {
    throw new OrchestrationError(
      'sensitive_thread_no_broadcast',
      `Refused: ${threadId} is a sensitive thread; a group/broadcast send fans out past its own ` +
        'participant list. Send to each participant individually.',
      { nextSteps: [`orca agents thread --id ${threadId}`] }
    )
  }
}

export function assertThreadNotSensitiveForFederation(
  db: OrchestrationDb,
  threadId: string | null | undefined
): void {
  if (!threadId) {
    return
  }
  const thread = db.getThread(threadId)
  if (thread?.sensitive === 1) {
    throw new OrchestrationError(
      'sensitive_thread_no_federation',
      `Refused: ${threadId} is a sensitive thread; its content never leaves this host over ` +
        'federation.',
      { nextSteps: [`orca agents thread --id ${threadId}`] }
    )
  }
}
