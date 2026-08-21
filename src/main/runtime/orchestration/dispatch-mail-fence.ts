import type { OrchestrationDb } from './db'
import { localDispatchInactiveRecoveryData } from './dispatch-inactive-recovery'
import { OrchestrationError } from './orchestration-error'

// Why: `check` resolves a worker's mailbox with status IN ('pending','dispatched') and falls back
// to the terminal handle once the Dispatch settles, so a `dispatch:<id>` row written after that has
// no reader at all. Refuse it at send instead of storing mail nobody will ever read.
export function requireActiveDispatchForWorkerMail(db: OrchestrationDb, dispatchId: string): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  // Why the missing-row pass: the send path already answered dispatch_not_found for it.
  if (!dispatch || dispatch.status === 'pending' || dispatch.status === 'dispatched') {
    return
  }
  throw new OrchestrationError(
    'dispatch_inactive',
    `Dispatch ${dispatchId} is ${dispatch.status}; its worker no longer reads this mailbox.`,
    localDispatchInactiveRecoveryData(dispatch.assignee_handle)
  )
}
