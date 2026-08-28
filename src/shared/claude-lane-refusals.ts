/**
 * Typed refusals for the per-principal Claude credential lanes (S9 §2a/§2d).
 *
 * Every code carries a complete human sentence: the client has no string table for these,
 * so a bare code — or an untyped throw — reaches the person as nothing at all.
 */
export const CLAUDE_LANE_REFUSAL_CODES = [
  'accounts.lane.grant_unknown',
  'accounts.lane.grant_not_bound',
  'accounts.lane.grant_not_per_person',
  'accounts.lane.grant_already_bound',
  'accounts.lane.grant_not_redeemed',
  'accounts.lane.principal_unknown',
  'accounts.lane.principal_id_invalid',
  'accounts.lane.display_name_invalid',
  'accounts.lane.not_provisioned',
  'accounts.lane.caller_unidentified',
  'accounts.selection_out_of_scope',
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
  'accounts.lane.probe_not_confirmed_dead',
  'accounts.lane.wipe_in_progress',
  // S9-L3 (§6, §10(g)) retires the sixteen push/lease-era codes the design's degradation row
  // (spec:479) enumerates: no_pusher_designated, push_stale, push_malformed, push_not_delegated,
  // push_write_failed, push_write_locked, account_resident_elsewhere, residency_unverifiable,
  // delegated_elsewhere, local_clear_locked, delegable_account_unknown, delegable_list_invalid,
  // desktop_unavailable, switch_timed_out, switch_lane_cleared, clear_incomplete.
  // S9-L1/S9-L2 mint the login-quartet/select/remove/logout codes below on the client side;
  // every one carries a complete sentence (below) since the client has no string table for these.
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

/**
 * S9-L2 (design rev 38 §3): the fifteen minted sentences for the login quartet plus
 * selectAccount/removeAccount/logout, so a v2 host has one canonical wording to send and the
 * client renders it verbatim rather than keeping its own copy that can drift from the host's. A
 * mock host (used while L1's server is not yet merged) should send these strings unchanged.
 */
export const CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES: Record<
  | 'accounts.lane.login_not_designated'
  | 'accounts.lane.no_login_device_designated'
  | 'accounts.lane.login_already_in_flight'
  | 'accounts.lane.login_session_unknown'
  | 'accounts.lane.login_session_expired'
  | 'accounts.lane.login_code_rejected'
  | 'accounts.lane.login_identity_mismatch'
  | 'accounts.lane.login_cancelled'
  | 'accounts.lane.login_store_full'
  | 'accounts.lane.login_cli_unsupported'
  | 'accounts.lane.account_unknown'
  | 'accounts.lane.switch_in_progress'
  | 'accounts.lane.switch_write_locked'
  | 'accounts.lane.switch_write_failed'
  | 'accounts.lane.logout_incomplete',
  string
> = {
  'accounts.lane.login_not_designated':
    'This device is paired to you but is not the device you designated to sign this lane into an account, so Orca did not start the login. Start it from the designated device, or designate this one on the host first.',
  'accounts.lane.no_login_device_designated':
    'No device is designated to sign this lane into a Claude account, so Orca did not start the login. On the host, run `orca lane designate --person <name> --device <id>`, then try again.',
  'accounts.lane.login_already_in_flight':
    'A Claude login is already in progress for this lane, so Orca did not start a second one. Finish or cancel the login that is running, then start this one again.',
  'accounts.lane.login_session_unknown':
    'Orca has no record of that login for you — it was started somewhere else, it belongs to another device, or Orca restarted since it began — so nothing was submitted. Start a new login and use the link it gives you.',
  'accounts.lane.login_session_expired':
    'This login has expired, so Orca did not submit the code. Start a new login and complete it before the link runs out.',
  'accounts.lane.login_code_rejected':
    'That code was not accepted. Check the code and try again — after too many wrong attempts this login ends and you will need to start a new one.',
  'accounts.lane.login_identity_mismatch':
    'You signed in as a different account than the one this login expected, so Orca did not load it into the lane. Start a new login and sign in as the expected account, or start one with no expected account to allow any account.',
  'accounts.lane.login_cancelled':
    'This login was cancelled, so Orca did not submit the code. Start a new login if you still want to sign this lane in.',
  'accounts.lane.login_store_full':
    'This lane already holds the maximum number of signed-in accounts, so Orca did not start a new login. Remove an account you no longer need, then try again.',
  'accounts.lane.login_cli_unsupported':
    'This login cannot be started from here right now, so Orca did not start it. Try again from the device designated to sign this lane in.',
  'accounts.lane.account_unknown':
    'Orca has no record of that account in this lane — it may already have been removed, or a logout may have cleared the lane — so nothing changed. Refresh the account list and try again.',
  'accounts.lane.switch_in_progress':
    'Another switch is already running for this lane, so Orca did not start a second one. Wait a moment and try again.',
  'accounts.lane.switch_write_locked':
    'A Claude session on the host is holding this lane’s credential file, so Orca could not switch accounts just now. The lane is unchanged — wait a moment and try again.',
  'accounts.lane.switch_write_failed':
    'Orca could not write the lane’s credential file, so the switch did not happen and the lane is unchanged. Try again, and let the person who runs the host know if it keeps failing.',
  'accounts.lane.logout_incomplete':
    'Orca could not confirm every credential for this lane was removed, so it is refusing to report the logout as done. Try again — nothing else was affected while this ran.'
}
