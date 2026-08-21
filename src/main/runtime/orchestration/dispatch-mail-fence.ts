import type { OrchestrationDb } from './db'
import { localDispatchInactiveRecoveryData } from './dispatch-inactive-recovery'
import { OrchestrationError } from './orchestration-error'

// Why: `check` resolves a worker's mailbox with status IN ('pending','dispatched') and falls back
// to the terminal handle once the Dispatch settles, so a `dispatch:<id>` row written after that has
// no reader at all. Refuse it at send instead of storing mail nobody will ever read.
export function requireActiveDispatchForWorkerMail(db: OrchestrationDb, dispatchId: string): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    // Why refuse rather than pass: neither caller vouches for this id — send resolves the Dispatch
    // its payload named, not the one `to:` addresses, and reply resolves none — and a mailbox whose
    // Dispatch row is gone can never be read, so an insert here is mail with no reader.
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${dispatchId} was not found.`,
      localDispatchInactiveRecoveryData(null)
    )
  }
  if (dispatch.status === 'pending' || dispatch.status === 'dispatched') {
    return
  }
  throw new OrchestrationError(
    'dispatch_inactive',
    `Dispatch ${dispatchId} is ${dispatch.status}; its worker no longer reads this mailbox.`,
    localDispatchInactiveRecoveryData(dispatch.assignee_handle)
  )
}
