// [R270; I-24-1 E1/E5] The pure half of the anchored Claude identity (orca-runtime.ts:
// hasAnchoredClaudeIdentity). After a main restart every reattached pty record starts blank —
// observedLive false, launchAgent null — so an idle Claude chair, which emits no title and no hook,
// can never re-establish liveness and its mail starves (E1; E5 for a leafless pty). What DOES
// survive the restart, persisted per pane key:
//   - the launch anchor the host wrote at mint (workspace session: terminalLaunchTokenHashesByPaneKey
//     is the sha256 of the ORCA_AGENT_LAUNCH_TOKEN, terminalLaunchTokenAnchorPtyByPaneKey the
//     `<ptyId>:<incarnationId>` of the pty that received it);
//   - the hook server's corroborated authority commitment for the pane (last-status.json), which
//     exists only if a hook carrying THAT token was accepted for THIS pane — the launched agent
//     itself ran its hooks there, the evidence class INV-P-LAUNCH-EDGE accepts as "past its launch";
//   - the pane's newest hook row, which names the agent.
// The pane is re-admitted to the observed-live Claude ladder only when all three bind together:
// the anchor is bound to the very pty standing on the pane now (same daemon session incarnation; a
// respawn or a later occupant carries a different identity and never matches), the hook evidence
// carries the anchor's hash (checked by the caller through the hook server's attestation), and the
// newest row is Claude's. Nothing here writes: the ladder's own gates — the launch fence, the fresh
// foreground confirm and the dialog checks — still run before every byte.

const LAUNCH_TOKEN_HASH_RE = /^[a-f0-9]{64}$/

export type LaunchAnchorBinding = {
  /** The pane's persisted launch-token hash, or undefined when none is on file. */
  readonly anchorLaunchTokenHash: string | undefined
  /** The `<ptyId>:<incarnationId>` the anchor was bound to at mint; undefined for a legacy,
   *  unbound anchor (refused here — the attestation path upgrades those on first use). */
  readonly anchorPty: string | undefined
  /** The `<ptyId>:<incarnationId>` of the pty on the pane now, or null when it has no incarnation. */
  readonly ptyIdentity: string | null
}

/** True only when a well-formed anchor is on file AND bound to exactly the pty now on the pane. */
export function isLaunchAnchorBoundToPty(binding: LaunchAnchorBinding): boolean {
  return (
    typeof binding.anchorLaunchTokenHash === 'string' &&
    LAUNCH_TOKEN_HASH_RE.test(binding.anchorLaunchTokenHash) &&
    typeof binding.anchorPty === 'string' &&
    binding.ptyIdentity !== null &&
    binding.anchorPty === binding.ptyIdentity
  )
}

/** The one shape this module needs off a hook snapshot row (a subset of AgentStatusIpcPayload). */
export type PaneHookRow = {
  readonly paneKey: string | null
  readonly agentType?: string
  readonly receivedAt: number | null
}

/** True when the pane's newest hook row (any age, restored or live) is Claude's. */
export function isNewestPaneHookRowClaude(
  rows: readonly PaneHookRow[],
  paneKey: string | null
): boolean {
  if (!paneKey) {
    return false
  }
  let newest: PaneHookRow | undefined
  for (const row of rows) {
    if (row.paneKey !== paneKey) {
      continue
    }
    if (!newest || (row.receivedAt ?? 0) > (newest.receivedAt ?? 0)) {
      newest = row
    }
  }
  return newest?.agentType === 'claude'
}
