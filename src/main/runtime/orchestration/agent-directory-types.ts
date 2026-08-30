// S10-1 agent directory row types (SCHEMA v33). Split out of types.ts to keep that file under
// the repo's max-lines ratchet.
export type AgentState = 'live' | 'idle' | 'gone'
export type AgentOriginKind = 'pane' | 'paired_runtime' | 'derived'

export type AgentRow = {
  id: string
  display_name: string
  role: string | null
  host_id: string
  pane_key: string | null
  terminal_handle: string | null
  process_incarnation: string | null
  worktree_id: string | null
  worktree_path: string | null
  branch: string | null
  title: string | null
  agent_label: string | null
  state: AgentState
  derived: number
  quarantined: number
  quarantine_reason_code: string | null
  quarantined_at: string | null
  tombstoned_at: string | null
  origin_kind: AgentOriginKind
  origin_pane_key: string | null
  origin_handle: string | null
  origin_host_id: string
  origin_paired_device_id: string | null
  origin_at: string
  registered_at: string
  last_seen_at: string
}

export type MailboxDeliveryStatus = 'outstanding' | 'acknowledged'

export type MailboxDeliveryRow = {
  id: string
  mailbox_handle: string
  message_ids: string
  status: MailboxDeliveryStatus
  created_at: string
  acknowledged_at: string | null
}

export type AgentAuditRow = {
  seq: number
  agent_id: string | null
  actor_pane_key: string | null
  actor_host_id: string | null
  verb: string
  outcome: string
  reason_code: string | null
  at: string
}

export type AgentRateRow = {
  subject_key: string
  verb: string
  window_start: string
  count: number
}
