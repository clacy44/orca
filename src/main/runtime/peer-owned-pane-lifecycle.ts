// S10-19 W-2 (INV-P-013, chair rulings 20/22/24 + Ruling 24 addendum 2): a peer-owned pane ends
// with its agent; nothing is orphaned across a restart; a full-profile caller's adopted pane is
// never force-closed. Split from orca-runtime.ts (which already owns the mutable PTY graph) so
// this is unit-testable against a narrow runtime interface, not the whole service.
import type { OrchestrationDb } from './orchestration/db'
import type { RemoteDispatchAttachmentRow } from './orchestration/types'

export type PeerGrantProfileLookup = (fingerprint: string) => 'full' | 'peer' | null

// Why narrow: closePeerOwnedPaneOnAgentExit/runPeerAttachmentRuntimePrune need exactly these
// four PTY-table reads/actions — the same four public accessors ops BL-2 (W-4) found are the
// only ones OrcaRuntimeService exposes over a handle.
export type PeerOwnedPaneRuntime = {
  getTerminalPaneKey(handle: string): string | null
  closeTerminal(handle: string): Promise<unknown>
  isTerminalRunningAgent(handle: string): Promise<boolean>
  getRuntimeId(): string
}

// S10-19 (§7.3-adjacent): the ONE place a peer-owned ATTACHMENT's grant profile is resolved —
// null means "no lookup installed" (boot) OR "no device matches this fingerprint" (grant
// revoked/rotated, Ruling 20(c)/attacker 4's owner_unresolved case). Both read the same as
// "cannot prove this is a peer grant" and take the non-destructive branch.
export function accessProfileOfAttachment(
  row: Pick<RemoteDispatchAttachmentRow, 'home_peer_fingerprint'>,
  lookup: PeerGrantProfileLookup | null
): 'full' | 'peer' | null {
  return lookup ? lookup(row.home_peer_fingerprint) : null
}

// W-2 rule 3 (Ruling 20(c) / attacker 4): wired at the four runtime-time agent-exit hooks. A
// resolved 'peer' profile closes then stamps; an unresolved profile (lookup absent, or grant
// revoked/rotated) stamps only and audits owner_unresolved — the stamp is not destructive (the
// row is already unwritable/unpointable) and is what releases the cap slot and makes the row
// prunable; without it the row would be invisible to every sweep forever. A resolved 'full'
// profile is NEVER touched — no close, no stamp, no audit.
export async function closePeerOwnedPaneOnAgentExit(args: {
  db: OrchestrationDb
  runtime: Pick<PeerOwnedPaneRuntime, 'closeTerminal'>
  lookup: PeerGrantProfileLookup | null
  ptyId: string
  cause: string
}): Promise<void> {
  const row = args.db.findPeerOwnedAttachmentForHandle(args.ptyId)
  if (!row) {
    return
  }
  const profile = accessProfileOfAttachment(row, args.lookup)
  if (profile === 'full') {
    return
  }
  if (profile === 'peer') {
    try {
      await args.runtime.closeTerminal(args.ptyId)
    } catch (error) {
      console.warn('[orchestration] peer-owned pane close failed', error)
    }
    args.db.markPeerOwnedAttachmentAgentExited(row.dispatch_id, args.cause)
    return
  }
  args.db.markPeerOwnedAttachmentAgentExited(row.dispatch_id, args.cause)
  args.db.writeAgentAudit({
    agentId: null,
    actorPaneKey: null,
    actorHostId: null,
    verb: 'peerPaneClose',
    outcome: 'owner_unresolved',
    reasonCode: args.cause
  })
}

// W-2 rule 1 (Ruling 24 addendum 2(o)): runs at BOOT, before the profile lookup exists (index.ts,
// beside resumeOrchestrationFederationRelayAfterRestart, after prepareLegacyWorkerTerminalRecovery
// has had a chance to reconnect daemon-backed sessions into this process's pty table). Stamps
// agent_exited_at ONLY on rows whose PTY is PROVABLY GONE (no terminal_handle, or the handle
// resolves to nothing in this process's pty table) — closes nothing, ever, and never reads the
// profile lookup (it does not exist yet). A row whose PTY still lives is left untouched; it is
// picked up later by runPeerAttachmentRuntimePrune once the lookup is installed.
export function runPeerAttachmentBootSweep(args: {
  db: OrchestrationDb
  runtime: Pick<PeerOwnedPaneRuntime, 'getTerminalPaneKey' | 'getRuntimeId'>
}): void {
  const currentEpoch = args.runtime.getRuntimeId()
  for (const row of args.db.findStaleEpochAttachments(currentEpoch)) {
    const ptyProvablyGone =
      !row.terminal_handle || args.runtime.getTerminalPaneKey(row.terminal_handle) === null
    if (!ptyProvablyGone) {
      continue
    }
    args.db.markPeerOwnedAttachmentAgentExited(row.dispatch_id, 'runtime_restart')
  }
}

// W-2 (Ruling 24 addendum 2(p)/(q)): runs at RUNTIME TIME, once the profile lookup is installed
// (runtime-rpc.ts, beside attachPrincipalLaneHost) — catches a peer-owned pane whose PTY
// survived the restart (so the boot sweep left it alone) but whose agent had already finished.
// close, then stamp, then delete, in that order (W2-T1) — restricted to profile==='peer' rows
// whose agent has actually exited; a full-profile row is never even inspected for closing.
export async function runPeerAttachmentRuntimePrune(args: {
  db: OrchestrationDb
  runtime: PeerOwnedPaneRuntime
  lookup: PeerGrantProfileLookup
}): Promise<void> {
  for (const row of args.db.findLivePeerCandidateAttachments()) {
    if (!row.terminal_handle || args.runtime.getTerminalPaneKey(row.terminal_handle) === null) {
      continue
    }
    if (accessProfileOfAttachment(row, args.lookup) !== 'peer') {
      continue
    }
    if (await args.runtime.isTerminalRunningAgent(row.terminal_handle)) {
      continue
    }
    try {
      await args.runtime.closeTerminal(row.terminal_handle)
    } catch (error) {
      console.warn('[orchestration] peer attachment runtime prune close failed', error)
    }
    args.db.markPeerOwnedAttachmentAgentExited(row.dispatch_id, 'command_finished')
    args.db.deleteRemoteDispatchAttachment(row.dispatch_id)
  }
}
