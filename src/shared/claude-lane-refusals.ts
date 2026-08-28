/**
 * Typed refusals for the per-principal Claude credential lanes (S9 §2a/§2d).
 *
 * Every code carries a complete human sentence: the client has no string table for these,
 * so a bare code — or an untyped throw — reaches the person as nothing at all.
 */
export const CLAUDE_LANE_REFUSAL_CODES = [
  'accounts.lane.no_pusher_designated',
  'accounts.lane.grant_unknown',
  'accounts.lane.grant_not_bound',
  'accounts.lane.grant_not_per_person',
  'accounts.lane.grant_already_bound',
  'accounts.lane.grant_not_redeemed',
  'accounts.lane.principal_unknown',
  'accounts.lane.principal_id_invalid',
  'accounts.lane.display_name_invalid',
  'accounts.lane.push_stale',
  'accounts.lane.push_malformed',
  'accounts.lane.push_not_delegated',
  'accounts.lane.not_provisioned',
  'accounts.lane.caller_unidentified',
  'accounts.lane.delegable_account_unknown',
  'accounts.lane.delegable_list_invalid',
  'accounts.lane.desktop_unavailable',
  'accounts.lane.switch_timed_out',
  'accounts.lane.switch_lane_cleared',
  'accounts.selection_out_of_scope',
  'accounts.lane.push_write_failed',
  'accounts.lane.push_write_locked',
  'accounts.lane.account_resident_elsewhere',
  'accounts.lane.residency_unverifiable',
  'accounts.lane.link_fingerprint_unbindable',
  'accounts.lane.provision_dacl_unverified',
  'accounts.lane.provisioning_platform_gated',
  'accounts.lane.lane_not_owned_by_orca',
  'accounts.lane.lane_path_not_contained',
  'accounts.lane.lane_root_not_local',
  'accounts.lane.consent_caller_not_local',
  'accounts.lane.person_unknown',
  'accounts.lane.invite_name_invalid',
  'accounts.lane.invite_unavailable',
  'accounts.lane.not_enabled',
  'accounts.lane.delegated_elsewhere',
  'accounts.lane.local_clear_locked',
  'accounts.lane.clear_incomplete',
  'accounts.lane.probe_not_confirmed_dead',
  'accounts.lane.wipe_in_progress',
  // --- S9-L1: per-lane Claude account login (§3) — sixteen minted, additive only.
  // The doc's own arithmetic (57→56) is wrong against this tree (60 entries above);
  // S9-L1's scope boundary (§F) forbids retiring the sixteen push/lease-era codes,
  // so this slice is additive-only: 60 → 76. Retirement is S9-L3's.
  'accounts.lane.login_not_designated',
  'accounts.lane.no_login_device_designated',
  'accounts.lane.login_already_in_flight',
  'accounts.lane.login_session_unknown',
  'accounts.lane.login_session_expired',
  'accounts.lane.login_code_rejected',
  'accounts.lane.login_identity_mismatch',
  'accounts.lane.login_url_unparsed',
  'accounts.lane.login_cli_unsupported',
  'accounts.lane.login_store_full',
  'accounts.lane.login_cancelled',
  'accounts.lane.account_unknown',
  'accounts.lane.switch_in_progress',
  'accounts.lane.switch_write_locked',
  'accounts.lane.logout_incomplete',
  'accounts.lane.switch_write_failed',
  'terminal.lane_not_loaded',
  'terminal.lane_wsl_unsupported',
  'terminal.lane_wsl_shell_unsupported',
  'terminal.lane_agent_unsupported',
  'terminal.lane_remote_pane',
  'terminal.agent_env_refused',
  'terminal.agent_args_refused',
  'terminal.resume_path_refused',
  'terminal.lane_not_owned',
  'terminal.lane_unspecified',
  'terminal.lane_pane_unbound',
  'terminal.lane_source_unknown',
  'terminal.lane_renderer_split_unsupported',
  'terminal.lane_open_no_lane',
  'terminal.lane_open_forbidden',
  'terminal.lane_seed_too_long',
  'terminal.lane_seed_control_char',
  'terminal.lane_requires_workspace',
  'terminal.lane_link_unbound',
  'worktree.wake_refused_not_owned'
] as const

export type ClaudeLaneRefusalCode = (typeof CLAUDE_LANE_REFUSAL_CODES)[number]

export class ClaudeLaneRefusal extends Error {
  readonly code: ClaudeLaneRefusalCode

  constructor(code: ClaudeLaneRefusalCode, message: string) {
    super(message)
    this.name = 'ClaudeLaneRefusal'
    this.code = code
  }
}

export function isClaudeLaneRefusal(error: unknown): error is ClaudeLaneRefusal {
  return error instanceof ClaudeLaneRefusal
}
