// S10-4 ruling 1: mirrored peer-agent claims. NEVER a row in `agents` — agents.origin_kind is
// refused for anything but 'pane'/'derived' (trg_agents_no_foreign_origin, db.ts).
// S10-15 D5: which local link keyed this row — 'paired_device' (inbound relay, provenance/
// containment only, never addressable) or 'environment' (probe/find mirroring, the only
// addressable kind).
export type RemoteAgentLinkKind = 'paired_device' | 'environment'

export type RemoteAgentRow = {
  environment_id: string
  environment_name: string
  link_kind: RemoteAgentLinkKind
  remote_agent_id: string
  display_name: string
  role: string | null
  state: 'live' | 'idle' | 'gone'
  derived: number
  remote_quarantined: number
  local_quarantined: number
  quarantine_reason_code: string | null
  // S10-15 ruling 2: the link's own authenticated fingerprint bound to this environment_id on
  // first contact (TOFU). Null on rows written before this slice, or by a writer that never
  // supplied one (e.g. a future `link_kind='environment'` writer).
  peer_fingerprint: string | null
  last_seen_at: string
}
