// S10-21a C5/C5a (design v3.2 §2.4; errata 5(p)-5 v2.1 §C.5/§F; Ruling 34 Addendum 16): the
// restore rebind — predicate and transaction, pure DB. Predicate evaluation is
// agent-restore-rebind-predicate.ts (split to stay under the max-lines ratchet). Pact un-pause
// (§2.11 N4) is NOT called here — this returns the paused-pact thread ids for C10 to act on
// post-commit, its own separate call.
//
// FORCED DEVIATION (recorded per _common-rules.md; see the RETURN block for the citation):
//   §2.4 lists "H6 idempotent succession catch-up" as step 4 of ONE `BEGIN IMMEDIATE...COMMIT`.
//   `catchUpThreadSuccession` (agent-thread-succession.ts:272) manages its own transaction and
//   throws ("cannot start a transaction within a transaction") if nested inside another open
//   one. H6 catch-up is inlined here using the same nesting-safe primitive `remintRow` itself
//   uses when it is the one holding the open transaction (`adoptPredecessorThreadMembership`,
//   exported, carries no BEGIN/COMMIT of its own) — same marker-gated idempotence, no behaviour
//   change.
//
// [Ruling 34 Addendum 16(c)] The launch-row write is now INSIDE this function's own transaction,
// via `recordLaunchInTransaction` (agent-launch-sessions.ts, split off `recordLaunch` for
// exactly this caller) — no longer a forced post-commit deviation. A genuine foreign_session_id
// collision rolls back the WHOLE rebind (agent row, mailboxes, threads) and refuses; the prunes
// (host-scoped, self-transacting) still run after this transaction commits, same as
// `recordLaunch`'s own wrapper does for every other caller.
//
// [S10-21a C5b, D-R107 MEDIUM-3, accepted per Ruling 34 Addendum 18] `evaluateRebindPredicate`'s
// clause 8 (`checkAndBumpRate`) commits its own BEGIN IMMEDIATE...COMMIT BEFORE this function
// opens its own transaction below — a refusal at step 5, or a throw anywhere in this
// transaction, permanently consumes 1/20 of the rate budget for a rebind that never landed.
// Accepted rather than restructured: every refusal (including this one) is now audited (this
// commit), so the budget loss is visible and diagnosable rather than silent, which was the
// actual defect MEDIUM-3 named — moving the bump inside this function's own transaction would
// require `evaluateRebindPredicate` to stop being callable standalone (every other clause is a
// pure read), a larger restructuring this brief did not ask for.
import type Database from '../../sqlite/sync-database'
import { adoptFromPredecessors, adoptPredecessorThreadMembership } from './agent-thread-succession'
import {
  repointMailboxFromBareHandle,
  repointMailboxOnNameBind,
  repointMailboxOnReMint,
  repointMailboxOnSuccession
} from './agent-mailbox-repoint'
import { writeAgentAudit } from './agent-audit-log'
import {
  newestLaunchForPane,
  recordLaunchInTransaction,
  setLaunchAgentId
} from './agent-launch-sessions'
import { prunePaneRows, pruneGlobalRows } from './agent-launch-sessions-retention'
import {
  evaluateRebindPredicate,
  type RebindRefusalReason,
  type RebindRestoredPaneParams
} from './agent-restore-rebind-predicate'
import { refreshAgentHandleAfterRespawn } from './agent-daemon-respawn-handle-refresh'
import { parseProcessIncarnation } from './agent-process-identity'
import { pactsAwaitingUnpause } from './agent-pact-unpause-lookup'
export type {
  RebindRefusalReason,
  RebindRestoredPaneParams
} from './agent-restore-rebind-predicate'

export type RebindRestoredPaneResult =
  | {
      ok: true
      rebound: true
      agentId: string
      adoptedThreads: number
      repointedMessages: number
      pendingOnOldHandle: number
      pactsToUnpause: string[]
      // [S10-21a C5b, D-R107 MEDIUM-4] Surfaced so a caller renders the honest zero — a
      // quarantined predecessor sharing this name blocked H6 catch-up outright, distinct from
      // "there was nothing to inherit" (adoptPredecessorThreadMembership's own F-9 reasoning).
      blockedByQuarantinedPredecessor: boolean
    }
  | { ok: true; rebound: false; agentId: string }
  | { ok: false; reason: RebindRefusalReason }

// [S10-21a C5b, D-R107 fix item 14] verb 'rebind' for every refusal — 'contested' outcome for
// the two identity-contest reasons (predicate.ts sets `agentId` for exactly these), 'refused'
// for everything else (agentId null: nothing to attribute besides the attempted claim itself).
const CONTESTED_REFUSAL_REASONS: ReadonlySet<RebindRefusalReason> = new Set([
  'incumbent_alive',
  'predecessor_moved'
])

// [S10-21a C7d] Re-exported for back-compat — moved to agent-pact-unpause-lookup.ts (C7i) to
// break the import cycle this file now has with agent-daemon-respawn-handle-refresh.ts.
export { pactsAwaitingUnpause }

/** §2.4's rebind: predicate, then the transaction. `db` is the caller's raw handle (same
 * convention as every other orchestration/*.ts primitive) — the caller (C7) never opens a
 * transaction of its own around this call. See the FORCED DEVIATION note above for the one place
 * this cannot literally be "one BEGIN IMMEDIATE...COMMIT" as §2.4's text states. */
export function rebindRestoredPane(
  db: Database.Database,
  params: RebindRestoredPaneParams
): RebindRestoredPaneResult {
  const predicate = evaluateRebindPredicate(db, params)
  if (predicate.kind === 'refuse') {
    // [S10-21a C5b, D-R107 fix item 14 / MEDIUM-2] Every refusal reason is now audited — the
    // prior code left every reason but 'incumbent_alive' silent (loud-degradation rule).
    // Fail-closed: no rebind, no row change, no write besides this one audit row (and the
    // predicate's own rate bump, MEDIUM-3, documented above). 'incumbent_alive' and
    // 'predecessor_moved' are contested-lineage events (§2.6 SCOPE(a); errata 5(z)); every other
    // reason is a plain refusal. Pure DB — no notice from here (the caller owns runtime access).
    const contested = CONTESTED_REFUSAL_REASONS.has(predicate.reason)
    writeAgentAudit(db, {
      agentId: predicate.agentId ?? null,
      actorPaneKey: params.newPaneKey,
      actorHostId: params.hostId,
      verb: 'rebind',
      outcome: contested ? 'contested' : 'refused',
      reasonCode:
        `restore lineage refused (${predicate.reason}): ` +
        `incumbent=${params.incumbent.dead ? params.incumbent.signal : params.incumbent.reason} ` +
        `predecessor=${params.ticketPayload.predecessorPaneKey} claimant=${params.newPaneKey}`
    })
    return { ok: false, reason: predicate.reason }
  }
  if (predicate.kind === 'noop') {
    // [S10-21a C7i, Ruling 34 Addendum 27] The same-pane path returns here, BEFORE step 2's
    // UPDATE below — process_incarnation is never otherwise refreshed on a Layer-1 restore.
    // Refresh it now so the next sweep's identity join sees the truth. Guarded on the caller
    // actually supplying one (every real caller does — restore-registered-agent-panes.ts's
    // `deps.getTerminalProcessIncarnation` always returns `string | null`, never `undefined`):
    // an `undefined` means there is nothing to refresh, so this is a true no-op, not a second
    // audit/UPDATE pair for T13's already-covered idempotent double-fire.
    // [S10-21a C7k, Ruling 34 Addendum 28, item 5] The refresh never writes an empty or legacy
    // identity — `params.processIncarnation` must parse as a genuine 2-segment identity, not
    // merely be non-`undefined` (a caller can supply `null`, or a stale 3-segment legacy form).
    // A supplied-but-unparseable value is recorded (row left untouched), never silently written.
    if (params.processIncarnation !== undefined && params.newTerminalHandle !== null) {
      if (parseProcessIncarnation(params.processIncarnation) !== null) {
        refreshAgentHandleAfterRespawn(db, {
          hostId: params.hostId,
          paneKey: params.newPaneKey,
          newTerminalHandle: params.newTerminalHandle,
          processIncarnation: params.processIncarnation,
          // [S10-21a C7k, Ruling 34 Addendum 28, item 6] Target exactly the predicate's own
          // agent — never re-derive by pane suffix, which two rows can share.
          agentId: predicate.agentId
        })
      } else {
        writeAgentAudit(db, {
          agentId: predicate.agentId,
          actorPaneKey: params.newPaneKey,
          actorHostId: params.hostId,
          verb: 'sweep_note',
          outcome: 'proceeded',
          reasonCode: `identity_unavailable: ${params.processIncarnation === null ? 'null' : 'legacy_form'}`
        })
      }
    }
    return { ok: true, rebound: false, agentId: predicate.agentId }
  }
  const { row, targetRow } = predicate

  let adoptedThreads = 0
  let repointedMessages = 0
  let pendingOnOldHandle = 0
  let pactsToUnpause: string[] = []
  let blockedByQuarantinedPredecessor = false

  db.exec('BEGIN IMMEDIATE')
  try {
    // [S10-21a C5b, D-R107 MEDIUM-4] Snapshot the succession marker BEFORE step 1 runs. Step 1's
    // own `adoptFromPredecessors` call (below, when a derived placeholder occupies the target
    // leaf) writes the SAME 'thread_succession' audit marker step 4 later reads as its own
    // "already ran" gate — reading it AFTER step 1 would let step 1's placeholder-only adoption
    // (a single predecessor: targetRow) silently suppress step 4's broader, name-keyed H6
    // catch-up (every tombstoned row sharing this display_name), which is a strict superset.
    const hasSuccessionMarker = Boolean(
      db
        .prepare(
          `SELECT 1 FROM agent_audit WHERE agent_id = ? AND verb = 'thread_succession' LIMIT 1`
        )
        .get(row.id)
    )

    // Step 1: adopt-or-tombstone a derived placeholder sitting on the target leaf. Same sequence
    // as agent-directory-derived-reclaim.ts's reclaimDerivedPlaceholder (the only other call site
    // that adopts a derived row's history onto a different id inside its own transaction).
    if (targetRow) {
      const succession = repointMailboxOnSuccession(db, targetRow.id, row.id, {
        paneKey: params.newPaneKey,
        hostId: params.hostId
      })
      repointedMessages += succession.repointedMessages
      db.prepare(
        `UPDATE agents SET tombstoned_at = datetime('now'), pane_key = NULL,
           role = NULL, title = NULL, worktree_path = NULL WHERE id = ?`
      ).run(targetRow.id)
      const adopted = adoptFromPredecessors(db, params.hostId, [targetRow.id], row.id)
      adoptedThreads += adopted.adoptedThreads
      repointedMessages += adopted.repointedMessages
      if (targetRow.terminal_handle && targetRow.terminal_handle !== params.newTerminalHandle) {
        const bare = repointMailboxFromBareHandle(db, targetRow.terminal_handle, row.id, {
          paneKey: params.newPaneKey,
          hostId: params.hostId
        })
        repointedMessages += bare.repointedMessages
        pendingOnOldHandle += bare.pendingOnOldHandle
      }
    }

    // Step 2: the NARROW update — pane_key/terminal_handle (+last_seen_at), and
    // process_incarnation only when the caller supplied one (Ruling 34 Addendum 16(b): the
    // column exists and the runtime can supply a value, but C5 itself has no runtime handle to
    // derive one from — undefined leaves the column untouched). Never display_name, id,
    // quarantine, or tombstone fields.
    if (params.processIncarnation !== undefined) {
      db.prepare(
        `UPDATE agents SET pane_key = ?, terminal_handle = ?, process_incarnation = ?,
           last_seen_at = datetime('now') WHERE id = ?`
      ).run(params.newPaneKey, params.newTerminalHandle, params.processIncarnation, row.id)
    } else {
      db.prepare(
        `UPDATE agents SET pane_key = ?, terminal_handle = ?, last_seen_at = datetime('now')
         WHERE id = ?`
      ).run(params.newPaneKey, params.newTerminalHandle, row.id)
    }

    // Step 3: mailbox repoints — bare handle then bare name, same order agent-pane-rebind.ts's
    // remintRow uses.
    const fromReMint = repointMailboxOnReMint(
      db,
      { id: row.id, terminal_handle: row.terminal_handle },
      {
        paneKey: params.newPaneKey,
        hostId: params.hostId,
        terminalHandle: params.newTerminalHandle
      }
    )
    repointedMessages += fromReMint.repointedMessages
    pendingOnOldHandle += fromReMint.pendingOnOldHandle
    const fromName = repointMailboxOnNameBind(db, row.display_name, row.id, {
      paneKey: params.newPaneKey,
      hostId: params.hostId
    })
    repointedMessages += fromName.repointedMessages
    pendingOnOldHandle += fromName.pendingOnOldHandle

    // Step 4: H6 idempotent succession catch-up, inlined (FORCED DEVIATION — see file header).
    // Uses the marker SNAPSHOT taken before step 1 (D-R107 MEDIUM-4) — step 1's own
    // placeholder-only adoption must never suppress this broader, name-keyed catch-up.
    if (!hasSuccessionMarker) {
      const caughtUp = adoptPredecessorThreadMembership(db, params.hostId, row.display_name, row.id)
      adoptedThreads += caughtUp.adoptedThreads
      repointedMessages += caughtUp.repointedMessages
      blockedByQuarantinedPredecessor = caughtUp.blockedByQuarantinedPredecessor
    }

    // Step 5 [Ruling 34 Addendum 16(c)/18(v), D-R107 MEDIUM-5]: the launch-row write, INSIDE
    // this transaction — UNLESS the admission already wrote this exact restore's row at spawn
    // (agent-launch-admission.ts's HOST_RESUME branch: evidence 'sweep_record',
    // supersedePaneKey = predecessorPaneKey, same session id). `recordLaunchInTransaction`'s own
    // `restated` classification does NOT catch this case — its collision detector only fires on
    // a cross-pane `current_sessions` UNIQUE violation, and a same-pane repeat write (as this
    // would be, targeting the SAME newPaneKey the admission already wrote) hits no unique
    // constraint at all (agent-launch-sessions.ts carries none across generations for one pane;
    // T41's own documented behaviour), so it would silently insert a genuine second row — the
    // duplicate MEDIUM-5 found, with the admission's compensating delete then repointing
    // current_sessions to that duplicate instead of removing the fact. Recognise the admission's
    // row FIRST and bind to it directly, never re-inserting.
    const existingForPane = newestLaunchForPane(db, params.hostId, params.newPaneKey)
    const matchesShape =
      existingForPane !== undefined &&
      existingForPane.session_id === params.ticketPayload.sessionId &&
      existingForPane.evidence === 'sweep_record'
    // [S10-21a C6b, Ruling 34 Addendum 19 R3] Same session/evidence is not enough — a STALE row
    // from a prior generation or a different execution host sharing this exact session id (e.g.
    // a retried restore after a crash-restart) must never be silently adopted as "this restore's
    // own row". Both must match too, or this is refused, not adopted.
    const isAdmissionsOwnRow =
      matchesShape &&
      existingForPane.launch_generation === params.launchGeneration &&
      existingForPane.execution_host_id === params.executionHostId
    if (matchesShape && !isAdmissionsOwnRow) {
      db.exec('ROLLBACK')
      writeAgentAudit(db, {
        agentId: row.id,
        actorPaneKey: params.newPaneKey,
        actorHostId: params.hostId,
        verb: 'rebind',
        outcome: 'refused',
        reasonCode: `launch_row_restated_mismatch: stale generation/host, seq=${existingForPane.seq}`
      })
      return { ok: false, reason: 'launch_row_restated_mismatch' }
    }
    if (isAdmissionsOwnRow) {
      setLaunchAgentId(db, { seq: existingForPane.seq }, row.id)
    } else {
      const launchResult = recordLaunchInTransaction(db, {
        hostId: params.hostId,
        paneKey: params.newPaneKey,
        agentType: 'claude',
        sessionId: params.ticketPayload.sessionId,
        launchGeneration: params.launchGeneration,
        executionHostId: params.executionHostId,
        evidence: 'sweep_record',
        supersedePaneKey: params.ticketPayload.predecessorPaneKey
      })
      if (!launchResult.ok) {
        db.exec('ROLLBACK')
        // [S10-21a C5b, D-R107 MEDIUM-2/fix item 14] Was silent before this commit — a genuine
        // cross-pane session-id collision at step 5 now audits like every other refusal.
        writeAgentAudit(db, {
          agentId: row.id,
          actorPaneKey: params.newPaneKey,
          actorHostId: params.hostId,
          verb: 'rebind',
          outcome: 'refused',
          reasonCode: 'launch_row_foreign_session_id'
        })
        return { ok: false, reason: 'launch_row_foreign_session_id' }
      }
      if (launchResult.restated) {
        // [Ruling 34 Addendum 18(v)] Unreachable through this call's own params today —
        // `isAdmissionsOwnRow` above already recognises the one shape that could reach it (same
        // pane, same session, same evidence), and `recordLaunchInTransaction`'s own restatement
        // branch requires the exact same conjuncts to classify as `restated` in the first place
        // (agent-launch-sessions.test.ts's own JUDGMENT CALL notes this branch is unreachable
        // via ordinary recordLaunch calls too). Kept as a typed fence rather than an
        // unconditional bind: ANY other restated shape reaching here would mean this call
        // collided with a row this restore does not own, and must refuse, not silently adopt it.
        const isThisRestoresOwnRow =
          launchResult.row.session_id === params.ticketPayload.sessionId &&
          launchResult.row.evidence === 'sweep_record'
        if (!isThisRestoresOwnRow) {
          db.exec('ROLLBACK')
          writeAgentAudit(db, {
            agentId: row.id,
            actorPaneKey: params.newPaneKey,
            actorHostId: params.hostId,
            verb: 'rebind',
            outcome: 'refused',
            reasonCode: `launch_row_restated_mismatch: seq=${launchResult.row.seq}`
          })
          return { ok: false, reason: 'launch_row_restated_mismatch' }
        }
      }
      setLaunchAgentId(db, { seq: launchResult.row.seq }, row.id)
    }

    // Pact un-pause is C10's job (§2.11 N4) — this is a read-only lookup of the candidates so
    // C10 can act on them post-commit; no thread row is written here.
    pactsToUnpause = pactsAwaitingUnpause(db, row.id)

    // Step 6: the one audit row. `ticket <id>` is not available here (C5 receives the payload,
    // never the registry/ticket id) — the predecessor/new pane keys and death signal are cited
    // instead, which is what the idempotent-double-fire fence above matches against.
    writeAgentAudit(db, {
      agentId: row.id,
      actorPaneKey: params.newPaneKey,
      actorHostId: params.hostId,
      verb: 'rebind',
      outcome: 'reminted',
      reasonCode:
        `restore lineage rebind: ${params.ticketPayload.predecessorPaneKey} -> ` +
        `${params.newPaneKey}; death=${params.incumbent.dead ? params.incumbent.signal : 'unknown'}`
    })

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // Post-commit: the §7 prunes, host-scoped and self-transacting, same as recordLaunch's own
  // wrapper runs for every other caller.
  prunePaneRows(db, params.hostId, params.newPaneKey)
  pruneGlobalRows(db, params.hostId)

  return {
    ok: true,
    rebound: true,
    agentId: row.id,
    adoptedThreads,
    repointedMessages,
    pendingOnOldHandle,
    pactsToUnpause,
    blockedByQuarantinedPredecessor
  }
}
