// S10-19 W-2 (INV-P-013, chair rulings 20/22/24 + Ruling 24 addendum 2): a peer-owned pane ends
// with its agent; nothing is orphaned across a restart; a full-profile caller's adopted pane is
// never force-closed. Split from orca-runtime.ts (which already owns the mutable PTY graph) so
// this is unit-testable against a narrow runtime interface, not the whole service.
import type { OrchestrationDb } from './orchestration/db'
import type { RemoteDispatchAttachmentRow } from './orchestration/types'

export type PeerGrantProfileLookup = (fingerprint: string) => 'full' | 'peer' | null

// S10-19 W-2 review B3: peer-owned panes are always local, so this is the one host scope the
// boot sweep and the runtime prune ever probe — matches worker-terminal-process-liveness.ts's
// WorkerTerminalHostScope 'local' shape.
export const PEER_OWNED_PANE_LOCAL_HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

// Why narrow: closePeerOwnedPaneOnAgentExit/runPeerAttachmentRuntimePrune need exactly these
// reads/actions — the same accessors ops BL-2 (W-4) found are the only ones OrcaRuntimeService
// exposes over a handle. getTerminalPaneKey is gone (review B3): a term_<uuid> handle is
// re-minted every process start, so a row's stored terminal_handle NEVER resolves through it
// again after a restart — inspectTerminalProcessIncarnationLiveness (queries the daemon/OS
// process table directly, keyed on the persisted process_incarnation column) is the liveness
// oracle that survives a restart; resolveLivePeerPaneHandle re-derives the CURRENT handle for
// that same underlying pty once this process's pty graph has it (post-reconnect), so the prune
// can still close it.
export type PeerOwnedPaneRuntime = {
  closeTerminal(handle: string): Promise<unknown>
  isTerminalRunningAgent(handle: string): Promise<boolean>
  getRuntimeId(): string
  inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'dead' | 'unknown'>
  resolveLivePeerPaneHandle(processIncarnation: string): string | null
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

// Review D1 (2026-09-02): the ONE place both agent-exit-hook and runtime-prune paths decide what
// an attachment row's grant resolution MEANS for whether the pane may ever be force-closed.
// 'unresolved' is NOT a synonym for 'was a peer' — a rotated, revoked, or expired FULL grant
// resolves null exactly the same way a revoked PEER grant does (accessProfileOfAttachment cannot
// tell them apart; the registry has genuinely forgotten). Only a lookup that POSITIVELY resolves
// 'peer' may ever destructively close/delete. An unresolved row takes the exit hook's third
// branch: stamp + owner_unresolved audit, never close, never delete — a full-profile adopted pane
// is never closed by any path, resolved or not.
export type PeerOwnedPaneDisposition = 'full' | 'peer' | 'unresolved'

export function peerOwnedPaneDisposition(
  row: Pick<RemoteDispatchAttachmentRow, 'home_peer_fingerprint'>,
  lookup: PeerGrantProfileLookup | null
): PeerOwnedPaneDisposition {
  const profile = accessProfileOfAttachment(row, lookup)
  if (profile === 'full') {
    return 'full'
  }
  if (profile === 'peer') {
    return 'peer'
  }
  return 'unresolved'
}

// Shared by both destructive-decision paths (D1): the non-destructive outcome for a row this
// host cannot positively prove was peer-owned. Stamps agent_exited_at (releases the cap slot,
// makes the row visible to sweeps) and writes one owner_unresolved audit row — never closes,
// never deletes.
function markOwnerUnresolved(db: OrchestrationDb, dispatchId: string, cause: string): void {
  db.markPeerOwnedAttachmentAgentExited(dispatchId, cause)
  db.writeAgentAudit({
    agentId: null,
    actorPaneKey: null,
    actorHostId: null,
    verb: 'peerPaneClose',
    outcome: 'owner_unresolved',
    reasonCode: cause
  })
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
  handle: string
  cause: string
}): Promise<void> {
  const row = args.db.findPeerOwnedAttachmentForHandle(args.handle)
  if (!row) {
    return
  }
  const disposition = peerOwnedPaneDisposition(row, args.lookup)
  if (disposition === 'full') {
    return
  }
  if (disposition === 'peer') {
    try {
      await args.runtime.closeTerminal(args.handle)
    } catch (error) {
      console.warn('[orchestration] peer-owned pane close failed', error)
    }
    args.db.markPeerOwnedAttachmentAgentExited(row.dispatch_id, args.cause)
    return
  }
  markOwnerUnresolved(args.db, row.dispatch_id, args.cause)
}

// W-2 rule 1 (Ruling 24 addendum 2(o)): runs at BOOT, before the profile lookup exists (index.ts,
// beside resumeOrchestrationFederationRelayAfterRestart) and before this process's pty graph has
// reconnected anything — so liveness is asked of the daemon/OS process table directly
// (inspectTerminalProcessIncarnationLiveness), never of the in-memory, per-process handle map
// (review B3: that map is always empty for a prior process's handle, making the old gate always
// true). Stamps agent_exited_at ONLY on rows whose PTY is PROVABLY GONE — no terminal_handle, or
// the daemon table proves the persisted process_incarnation dead. Closes nothing, ever, and
// never reads the profile lookup (it does not exist yet). A row whose PTY is still live, or whose
// liveness cannot be proven either way, is left untouched — picked up later by
// runPeerAttachmentRuntimePrune once the lookup is installed.
export async function runPeerAttachmentBootSweep(args: {
  db: OrchestrationDb
  runtime: Pick<PeerOwnedPaneRuntime, 'inspectTerminalProcessIncarnationLiveness' | 'getRuntimeId'>
}): Promise<void> {
  const currentEpoch = args.runtime.getRuntimeId()
  for (const row of args.db.findStaleEpochAttachments(currentEpoch)) {
    let ptyProvablyGone: boolean
    if (!row.terminal_handle) {
      ptyProvablyGone = true
    } else if (!row.process_incarnation) {
      // Why not gone: a handle without a recorded process_incarnation cannot be proven dead —
      // the non-destructive branch is "leave it for the runtime prune", never "assume gone".
      ptyProvablyGone = false
    } else {
      ptyProvablyGone =
        (await args.runtime.inspectTerminalProcessIncarnationLiveness(
          row.process_incarnation,
          PEER_OWNED_PANE_LOCAL_HOST_SCOPE
        )) === 'dead'
    }
    if (!ptyProvablyGone) {
      continue
    }
    args.db.markPeerOwnedAttachmentAgentExited(row.dispatch_id, 'runtime_restart')
  }
}

// W-2 (Ruling 24 addendum 2(p)/(q), W-5..W-7 review finding 2 / Ruling 24 addendum 4(bb)): runs
// at RUNTIME TIME, once the profile lookup is installed (runtime-rpc.ts, beside
// attachPrincipalLaneHost) — catches a peer-owned pane whose PTY survived the restart (so the
// boot sweep left it alone) but whose agent had already finished. resolveLivePeerPaneHandle
// re-derives the CURRENT handle for the row's persisted process_incarnation (review B3 — the
// row's stored terminal_handle from the prior process never resolves again); close, then stamp,
// then delete, in that order (W2-T1).
//
// RE-RUN, not once (finding 2): this function is now called from every attachment settle path,
// every runtime-time agent-exit hook, and the existing dispatch-liveness periodic tick
// (orca-runtime.ts's tickDispatchLivenessMonitor) — a row that could not be resolved on one pass
// (the pty graph had not yet re-adopted it) is retried on the next, rather than left alone
// forever.
//
// Review D1 (2026-09-02, replaces the pre-review "unresolved === peer-owned" rule this comment
// used to state): ONLY a row that resolves POSITIVELY to 'peer' is ever force-closed here. A
// row whose grant is unresolved (lookup absent, or the registry has no matching device —
// rotated, revoked, or expired) shares the SAME disposition ('unresolved') whether the grant
// was originally 'peer' or 'full' — accessProfileOfAttachment cannot and must not be trusted to
// tell them apart, because "the registry forgot" is not evidence of which profile it forgot. An
// unresolved row therefore takes exactly closePeerOwnedPaneOnAgentExit's third branch (shared
// via markOwnerUnresolved so the two paths cannot diverge again): stamp agent_exited_at + one
// owner_unresolved audit row, never close, never delete. This still makes the row visible to
// every sweep and releases the cap slot — finding 2's whole ask — without ever force-closing a
// pane this host cannot prove was peer-owned. A row that resolves to an ACTUAL 'full' grant is
// skipped entirely, exactly as before.
export async function runPeerAttachmentRuntimePrune(args: {
  db: OrchestrationDb
  runtime: PeerOwnedPaneRuntime
  lookup: PeerGrantProfileLookup
}): Promise<void> {
  for (const row of args.db.findLivePeerCandidateAttachments()) {
    if (!row.terminal_handle || !row.process_incarnation) {
      continue
    }
    const liveHandle = args.runtime.resolveLivePeerPaneHandle(row.process_incarnation)
    if (!liveHandle) {
      // Ruling 31(d')/Add.1(f): a resolution failure is NOT proof the pane is gone — it is also
      // what "the pty graph has not re-adopted it yet" looks like (Ruling 24 Add.4(bb)). Stamp
      // only on POSITIVE proof (same oracle + profile-blind rule as runPeerAttachmentBootSweep);
      // otherwise leave the row untouched for the next pass. Delete-safety comes from the DELETE
      // predicate, which already refuses any settled row still carrying a terminal_handle.
      const liveness = await args.runtime.inspectTerminalProcessIncarnationLiveness(
        row.process_incarnation,
        PEER_OWNED_PANE_LOCAL_HOST_SCOPE
      )
      if (liveness === 'dead') {
        markOwnerUnresolved(args.db, row.dispatch_id, 'incarnation_dead')
      }
      continue
    }
    const disposition = peerOwnedPaneDisposition(row, args.lookup)
    if (disposition === 'full') {
      continue
    }
    if (await args.runtime.isTerminalRunningAgent(liveHandle)) {
      continue
    }
    if (disposition === 'unresolved') {
      markOwnerUnresolved(args.db, row.dispatch_id, 'command_finished')
      continue
    }
    try {
      await args.runtime.closeTerminal(liveHandle)
    } catch (error) {
      console.warn('[orchestration] peer attachment runtime prune close failed', error)
    }
    args.db.markPeerOwnedAttachmentAgentExited(row.dispatch_id, 'command_finished')
    args.db.deleteRemoteDispatchAttachment(row.dispatch_id)
  }
}
