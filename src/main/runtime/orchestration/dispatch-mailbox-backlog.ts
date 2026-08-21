import type { OrchestrationDb } from './db'
import type { DispatchStatus } from './types'

// Why a name distinct from the federated workerMail.pending: that counts relay items not yet
// pushed to a peer, this counts unread rows already sitting in the worker's own mailbox. One
// field name over two denotations is exactly the "meaning changes" hazard the wire rules warn of.
export type DispatchMailboxBacklog = { unread: number; deliverable: boolean }

export function summarizeDispatchMailboxBacklog(
  db: OrchestrationDb,
  dispatchId: string,
  dispatchStatus: DispatchStatus
): DispatchMailboxBacklog {
  return {
    unread: db.countUnreadMessages(`dispatch:${dispatchId}`),
    // Why dispatch status, not worker state: `check` resolves this mailbox with status IN
    // ('pending','dispatched') and falls back to the terminal handle once the Dispatch settles,
    // so unread rows on a settled Dispatch are stranded rather than waiting.
    deliverable: dispatchStatus === 'pending' || dispatchStatus === 'dispatched'
  }
}
