// S10-4 ruling 1: mirrored peer-agent claims. NEVER a row in `agents` — agents.origin_kind is
// refused for anything but 'pane'/'derived' (trg_agents_no_foreign_origin, db.ts).
export type RemoteAgentRow = {
  environment_id: string
  environment_name: string
  remote_agent_id: string
  display_name: string
  role: string | null
  state: 'live' | 'idle' | 'gone'
  derived: number
  remote_quarantined: number
  local_quarantined: number
  quarantine_reason_code: string | null
  last_seen_at: string
}
