// Why: split out of types.ts to stay under the max-lines ratchet — this is the one row shape
// federation attach/stop/close/prune (S10-19) all read and write.
import type { WorkerDispatchState } from './types'

export type RemoteDispatchAttachmentRow = {
  dispatch_id: string
  task_id: string
  home_peer_fingerprint: string
  protocol_version: number
  runtime_epoch: string
  capability_hash: string | null
  pane_key: string | null
  process_incarnation: string | null
  // S10-19 (Ruling 24(c)/(e)): 'agent_exited' is an ATTACHMENT state, not a WorkerDispatchState —
  // never widen WorkerDispatchState/WORKER_SETTLED_STATES to include it (ops MN-3 / attacker 12).
  state: WorkerDispatchState | 'agent_exited'
  stage: string
  worktree_id: string | null
  terminal_handle: string | null
  setup_state: string
  effects: string
  residual_resources: string
  to_worker_imported_sequence: number
  last_error: string | null
  blocked_reason: string | null
  blocked_at: string | null
  blocked_consumed_at: string | null
  handle_bound_at: string | null
  agent_exited_at: string | null
  created_at: string
  updated_at: string
}
