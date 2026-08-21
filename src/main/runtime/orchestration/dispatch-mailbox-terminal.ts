import type {
  DispatchContextRow,
  DispatchStatus,
  RemoteDispatchAttachmentRow,
  WorkerDispatchRow
} from './types'
import { WORKER_SETTLED_STATES } from './worker-terminal-ownership'

// Why pending/dispatched only: the preamble tells a worker to stop reading mail after
// worker_done, so pointing a settled pane types into an agent that owes no reply.
const POINTABLE_DISPATCH_STATUSES: readonly DispatchStatus[] = ['pending', 'dispatched']

export type DispatchMailboxRows = {
  dispatch?: Pick<DispatchContextRow, 'status' | 'assignee_handle'> | null
  worker?: Pick<WorkerDispatchRow, 'state' | 'agent_terminal_handle'> | null
  // Why: the peer side of a federated Dispatch has no dispatch_contexts row — the
  // attachment is the only record of which terminal the imported mail belongs to.
  attachment?: Pick<RemoteDispatchAttachmentRow, 'state' | 'terminal_handle'> | null
  // Why required alongside the attachment: `check` refuses the same mailbox with
  // dispatch_inactive once the pane's process re-spawned, so pointing it would
  // announce mail to a process that cannot read it. The push is never laxer.
  isAttachmentProcessCurrent?: boolean
}

// Resolves the agent terminal a `dispatch:<id>` mailbox should point at; null when the
// Dispatch is unknown, settled, or owns no terminal on this runtime.
export function resolveDispatchMailboxTerminalHandle(rows: DispatchMailboxRows): string | null {
  const { dispatch, worker, attachment } = rows
  if (!dispatch && !worker && !attachment) {
    return null
  }
  if (dispatch && !POINTABLE_DISPATCH_STATUSES.includes(dispatch.status)) {
    return null
  }
  if (worker && WORKER_SETTLED_STATES.includes(worker.state)) {
    return null
  }
  if (attachment && WORKER_SETTLED_STATES.includes(attachment.state)) {
    return null
  }
  const attachmentHandle =
    attachment && rows.isAttachmentProcessCurrent === true ? attachment.terminal_handle : null
  return worker?.agent_terminal_handle ?? dispatch?.assignee_handle ?? attachmentHandle ?? null
}
