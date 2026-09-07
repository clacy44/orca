// S10-21b B15 (design §3.3, §2.7, Addendum 6(13)/errata NB2/NB3/NB5/NB9; N10) — T32,
// T-NA2a, T-NA2b, T-NB9. Every test here fails at base ad537573bf: `pact-link-evidence-sweep.ts`
// does not exist, `peer_link_scan_facts.unreachable_since` is read/written nowhere,
// `emitFederatedPactSideEffect` does not coalesce cross-kind, and the 21a rebind-unpause path
// has no reason_code disambiguation.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as PactShared from './pact-shared'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import type { UpsertAgentByPaneSuffixParams } from './agent-directory'
import { renderFederatedPartyKey } from './pact-federated-identity'
import { putPeerLinkBinding } from './link-binding-store'
import { putScanFact } from './link-binding-observations-store'
import type { LinkScanFactOutcome } from './link-binding-observations-store'
import {
  PACT_LINK_SILENCE_MS,
  PACT_LINK_RECOVERY_MS,
  LINK_BINDING_REVERIFY_MS
} from './link-binding-constants'
import { emitFederatedPactSideEffect } from './pact-federated-pause-resume-emit'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

const ENV = 'env1'
const REMOTE_AGENT_ID = 'rb'

describe('pact-link-evidence-sweep / emitFederatedPactSideEffect (S10-21b B15)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function freshDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function seedAgent(d: OrchestrationDb, id: string): string {
    const params: UpsertAgentByPaneSuffixParams = {
      displayName: id,
      role: null,
      hostId: 'local',
      paneKey: `tab:${id}`,
      terminalHandle: `term_${id}`,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: `term_${id}`,
      originHostId: 'local'
    }
    const result = d.upsertAgentByPaneSuffix(params)
    if (result.outcome === 'name_taken') {
      throw new Error(`seedAgent: name taken for ${id}`)
    }
    return result.agent.id
  }

  function actor(agentId: string): {
    callerAgentId: string
    callerPaneKey: string | null
    callerHostId: string
  } {
    return { callerAgentId: agentId, callerPaneKey: `tab:${agentId}`, callerHostId: 'local' }
  }

  function seedFederatedPeer(d: OrchestrationDb): string {
    d.upsertRemoteAgent({
      environmentId: ENV,
      environmentName: ENV,
      linkKind: 'environment',
      remoteAgentId: REMOTE_AGENT_ID,
      displayName: 'b (remote)',
      role: null,
      state: 'live',
      derived: false,
      remoteQuarantined: false
    })
    putPeerLinkBinding(rawDb(d), {
      linkDeviceId: ENV,
      environmentId: ENV,
      boundEndpointId: 'endpoint1',
      boundPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      peerCredentialFp: 'pcfp',
      peerKeyFingerprint: 'pkfp',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })
    return renderFederatedPartyKey({ linkDeviceId: ENV, remoteAgentId: REMOTE_AGENT_ID })
  }

  function engagedFederatedPact(d: OrchestrationDb, a: string): { threadId: string } {
    const peerKey = seedFederatedPeer(d)
    const { thread } = d.createThread({
      subject: 's',
      createdByAgentId: a,
      participants: [
        { participantKey: a, agentId: a },
        { participantKey: peerKey, agentId: null }
      ]
    })
    d.proposePact({ ...actor(a), threadId: thread.id, peerAgentId: peerKey, stepsTotal: null })
    // S10-21b B6c: proposePact now relays for real (its own outbox row, seq 1) — settle it
    // out of the way here so this fixture's later single-outstanding-item assertions (this
    // file's own subject: the sweep's pause/resume relay) see only the row THEY create.
    rawDb(d)
      .prepare(
        `DELETE FROM peer_reply_outbox WHERE pact_thread_id = ? AND relay_kind = 'pact_propose'`
      )
      .run(thread.id)
    rawDb(d)
      .prepare(`UPDATE threads SET pact_state = 'engaged', pact_turn_agent_id = ? WHERE id = ?`)
      .run(a, thread.id)
    return { threadId: thread.id }
  }

  function scanFact(outcome: 'unreachable' | 'proven', now: number): void {
    putScanFact(rawDb(db as OrchestrationDb), {
      linkDeviceId: ENV,
      environmentId: ENV,
      outcome,
      environmentPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      detail: null,
      observedAt: now
    })
  }

  // -------------------------------------------------------------------------------------
  // T-NA2a — peer link death, no outbox rows: unreachable_since stamped on first transition
  // only, one host pause row for the episode, parked wait woken with outcome:'paused'.
  // -------------------------------------------------------------------------------------
  it('T-NA2a: link-evidence auto-pause fires once the episode has been unreachable for PACT_LINK_SILENCE_MS', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const t0 = 1_000_000

    scanFact('unreachable', t0)
    expect(rawDb(d).prepare(`SELECT unreachable_since FROM peer_link_scan_facts`).get()).toEqual({
      unreachable_since: t0
    })

    // Repeat 'unreachable' scans: unreachable_since untouched, and the sweep does not yet fire.
    scanFact('unreachable', t0 + 60_000)
    expect(
      (
        rawDb(d).prepare(`SELECT unreachable_since FROM peer_link_scan_facts`).get() as {
          unreachable_since: number
        }
      ).unreachable_since
    ).toBe(t0)
    let result = d.runPactLinkEvidenceSweep(t0 + 60_000)
    expect(result.paused).toEqual([])
    expect(d.getThread(threadId)?.pact_paused_at).toBeNull()

    // Past PACT_LINK_SILENCE_MS from the FIRST transition: fires.
    result = d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS)
    expect(result.paused.map((o) => o.threadId)).toEqual([threadId])
    const thread = d.getThread(threadId)
    expect(thread?.pact_pause_reason).toBe('counterpart_gone')
    const pauseRow = rawDb(d)
      .prepare(`SELECT reason_code FROM pact_steps WHERE thread_id = ? AND kind = 'pause'`)
      .get(threadId) as { reason_code: string }
    expect(pauseRow.reason_code).toBe('counterpart_unreachable')

    // Idempotent per episode: a repeat qualifying sweep tick pauses nothing more.
    const again = d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS + 60_000)
    expect(again.paused).toEqual([])
    const pauseRows = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'pause'`)
      .get(threadId) as { n: number }
    expect(pauseRows.n).toBe(1)
  })

  // -------------------------------------------------------------------------------------
  // T-NA2b — one good scan is NOT sufficient; only PACT_LINK_RECOVERY_MS of continuous
  // non-unreachable resumes, exactly one resume row for the episode.
  // -------------------------------------------------------------------------------------
  it('T-NA2b: auto-resume requires PACT_LINK_RECOVERY_MS, not a single good scan', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    // Real wall-clock t0: the pause row's own `pact_steps.at` (datetime('now'), not caller-
    // supplied) is the sweep's resume anchor, so t0 must be realistic for that comparison.
    const t0 = Date.now()
    scanFact('unreachable', t0)
    d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS)
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // One good scan, well short of the recovery window: still paused.
    scanFact('proven', t0 + PACT_LINK_SILENCE_MS + 1_000)
    let result = d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS + 1_000)
    expect(result.resumed).toEqual([])
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // D-R139 N8: recovery now also requires the evidence to be FRESH, not merely old-enough-
    // since-reachable — a periodic prover keeps scanning through the window, so pin a second
    // good scan close to the recovery boundary (same episode: reachable_since untouched).
    scanFact('proven', t0 + PACT_LINK_SILENCE_MS + PACT_LINK_RECOVERY_MS)

    // Past PACT_LINK_RECOVERY_MS since the pause: resumes automatically.
    result = d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS + PACT_LINK_RECOVERY_MS + 1_000)
    expect(result.resumed.map((o) => o.threadId)).toEqual([threadId])
    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).toBeNull()
    expect(thread?.pact_pause_reason).toBeNull()
    const resumeRow = rawDb(d)
      .prepare(`SELECT actor_agent_id FROM pact_steps WHERE thread_id = ? AND kind = 'resume'`)
      .get(threadId) as { actor_agent_id: string | null }
    expect(resumeRow.actor_agent_id).toBeNull()
    const resumeRows = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'resume'`)
      .get(threadId) as { n: number }
    expect(resumeRows.n).toBe(1)
  })

  // -------------------------------------------------------------------------------------
  // S10-21b B17 (D-R137 F4, D-R138 F3) — auto-resume must require CONTINUOUS recovery
  // (`reachable_since`), not merely that the PAUSE is old. T-NA2b above happens not to
  // distinguish the two anchors (its single good scan lands right after the pause fires, so
  // pause-age and time-since-good-scan coincide); this test separates them: the pause is left
  // to age for well over PACT_LINK_RECOVERY_MS BEFORE the first good scan ever lands.
  // -------------------------------------------------------------------------------------
  it('F4: a pause older than PACT_LINK_RECOVERY_MS plus ONE fresh good scan does NOT resume (RED at base: resumes on pause age alone)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const t0 = Date.now()
    scanFact('unreachable', t0)
    d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS)
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // The pause is now old (well past PACT_LINK_RECOVERY_MS), but the link has been silent the
    // whole time — no scan at all until just now, one single good scan.
    const longAfter = t0 + PACT_LINK_SILENCE_MS + PACT_LINK_RECOVERY_MS * 3
    scanFact('proven', longAfter)
    const result = d.runPactLinkEvidenceSweep(longAfter)
    expect(result.resumed).toEqual([])
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // Continuous good scans for the full recovery window FROM the first one: resumes.
    const afterContinuity = longAfter + PACT_LINK_RECOVERY_MS
    scanFact('proven', afterContinuity)
    const resumed = d.runPactLinkEvidenceSweep(afterContinuity)
    expect(resumed.resumed.map((o) => o.threadId)).toEqual([threadId])
    expect(d.getThread(threadId)?.pact_paused_at).toBeNull()
  })

  it('F4: a flap (unreachable scan) resets reachable_since, restarting the continuity requirement', () => {
    const d = freshDb()
    seedFederatedPeer(d)
    const t0 = Date.now()
    scanFact('proven', t0)
    let fact = rawDb(d).prepare(`SELECT reachable_since FROM peer_link_scan_facts`).get() as {
      reachable_since: number
    }
    expect(fact.reachable_since).toBe(t0)

    // Continuing good scans hold reachable_since steady.
    scanFact('proven', t0 + 1_000)
    fact = rawDb(d).prepare(`SELECT reachable_since FROM peer_link_scan_facts`).get() as {
      reachable_since: number
    }
    expect(fact.reachable_since).toBe(t0)

    // A flap back to unreachable clears it.
    scanFact('unreachable', t0 + 2_000)
    const afterFlap = rawDb(d)
      .prepare(`SELECT reachable_since FROM peer_link_scan_facts`)
      .get() as { reachable_since: number | null }
    expect(afterFlap.reachable_since).toBeNull()

    // Recovery starts a NEW episode from this later timestamp.
    scanFact('proven', t0 + 3_000)
    const afterRecover = rawDb(d)
      .prepare(`SELECT reachable_since FROM peer_link_scan_facts`)
      .get() as { reachable_since: number }
    expect(afterRecover.reachable_since).toBe(t0 + 3_000)
  })

  // -------------------------------------------------------------------------------------
  // D-R139 N8 — the clock must distinguish "still good" from "no longer scanned": one good
  // scan right after the pause, then a silent prover for the whole recovery window, must NOT
  // resume — reachable_since alone is satisfied by clock passage with no further evidence.
  // -------------------------------------------------------------------------------------
  it('N8: one good scan then a silent prover for PACT_LINK_RECOVERY_MS does NOT resume (RED at base: resumes)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const t0 = Date.now()
    scanFact('unreachable', t0)
    d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS)
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // ONE good scan, then the prover goes silent — no further scan lands.
    scanFact('proven', t0 + PACT_LINK_SILENCE_MS + 1_000)
    const result = d.runPactLinkEvidenceSweep(
      t0 + PACT_LINK_SILENCE_MS + PACT_LINK_RECOVERY_MS + 1_000
    )
    expect(result.resumed).toEqual([])
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()
  })

  // -------------------------------------------------------------------------------------
  // D-R140 NF-4 — the recovery freshness bound must not be tighter than the PROVER'S OWN
  // re-probe cadence for the fact's outcome. A `no_match` outcome is TTL'd on
  // LINK_BINDING_REVERIFY_MS (24h) by the prover (link-binding-prover-probe.ts:126-134): once
  // recovered, no NEW fact is expected to land for up to that long, and that must not itself
  // block auto-resume. RED at base: base's PACT_LINK_SILENCE_MS-only bound (15 min) treated the
  // (correctly) stale-by-design fact as stale evidence and never resumed.
  // -------------------------------------------------------------------------------------
  it('D-R140 NF-4: a recovered no_match link resumes even though the prover has not re-probed it for hours (RED at base: not resumed)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const t0 = Date.now()
    scanFact('unreachable', t0)
    d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS)
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()

    // Recovery: a `no_match` outcome (not 'unreachable') establishes `reachable_since` and
    // stays continuous for PACT_LINK_RECOVERY_MS with no further scan.
    const recoveredScanAt = t0 + PACT_LINK_SILENCE_MS + 1_000
    putScanFact(rawDb(d), {
      linkDeviceId: ENV,
      environmentId: ENV,
      outcome: 'no_match' as LinkScanFactOutcome,
      environmentPairingRevision: 1,
      linkCredentialFp: 'lcfp',
      detail: null,
      observedAt: recoveredScanAt
    })

    // No NEW fact lands for two hours — well inside LINK_BINDING_REVERIFY_MS (24h), the
    // prover's own deliberate re-probe TTL for `no_match` — but well outside
    // PACT_LINK_SILENCE_MS (15 min).
    const twoHoursLater = recoveredScanAt + PACT_LINK_RECOVERY_MS + 2 * 60 * 60 * 1000
    expect(twoHoursLater - recoveredScanAt).toBeLessThan(LINK_BINDING_REVERIFY_MS)
    const result = d.runPactLinkEvidenceSweep(twoHoursLater)
    expect(result.resumed.map((o) => o.threadId)).toEqual([threadId])
    expect(d.getThread(threadId)?.pact_paused_at).toBeNull()
  })

  // -------------------------------------------------------------------------------------
  // T32 — cross-kind coalescing: three rapid local pause/resume flips enqueue ONE
  // outstanding relay item carrying the final absolute state.
  // -------------------------------------------------------------------------------------
  it('T32: rapid pause/resume flips enqueue exactly one outstanding relay item, cross-kind', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    emitFederatedPactSideEffect(rawDb(d), null, threadId, 'pause', 'counterpart_gone')
    emitFederatedPactSideEffect(rawDb(d), null, threadId, 'resume', null)
    emitFederatedPactSideEffect(rawDb(d), null, threadId, 'pause', 'counterpart_gone')

    const items = rawDb(d)
      .prepare(
        `SELECT relay_kind, state FROM peer_reply_outbox
         WHERE pact_thread_id = ? AND settled_at IS NULL`
      )
      .all(threadId) as { relay_kind: string; state: string }[]
    expect(items).toHaveLength(1)
    expect(items[0].relay_kind).toBe('pact_pause')
    expect(items[0].state).toBe('queued')
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()
  })

  // T32's second clause — the 21a rebind-unpause path (chair ruling: agent-pact-unpause-
  // lookup.ts + agent-pact-resume-after-restore.ts) refuses/no-ops a resume against a pact
  // paused for an UNRELATED reason (here: link-evidence 'counterpart_unreachable'), never
  // relaying it.
  it("T32: 21a's rebind-unpause never resumes a pact paused for a DIFFERENT reason_code", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const t0 = 1_000_000
    scanFact('unreachable', t0)
    d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS)
    expect(d.getThread(threadId)?.pact_pause_reason).toBe('counterpart_gone')

    const eligible = rawDb(d)
      .prepare(
        `SELECT id FROM threads WHERE id = ? AND pact_state = 'engaged' AND pact_paused_at IS NOT NULL
           AND pact_pause_reason = 'counterpart_gone'`
      )
      .all(threadId) as { id: string }[]
    expect(eligible.map((r) => r.id)).toEqual([threadId])

    d.resumePactsForRestoredAgent(a, [threadId])
    // Still paused — the link-evidence episode is untouched by the restore-driven resume.
    expect(d.getThread(threadId)?.pact_paused_at).not.toBeNull()
    expect(d.getThread(threadId)?.pact_pause_reason).toBe('counterpart_gone')
    const resumeRows = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'resume'`)
      .get(threadId) as { n: number }
    expect(resumeRows.n).toBe(0)
  })

  // S10-21b B17 (D-R138 B-F7) restart-predicate half: NOT applied — STOP, contradicted by
  // source. See agent-pact-unpause-lookup.ts's `pactsAwaitingUnpause` comment and
  // agent-pact-resume-after-restore.ts's `resumeOnePactIfEligible` comment for the finding.

  // -------------------------------------------------------------------------------------
  // S10-21b B17 (D-R138 B-F7) transactional half: the sweep's UPDATE + ledger insert now run
  // in ONE BEGIN IMMEDIATE per thread — a failure partway through must roll BOTH back, never
  // leave `pact_paused_at` set with no ledger row. RED at base: the base implementation wrote
  // the UPDATE as its own auto-commit BEFORE the (here, failing) ledger insert, so the pause
  // landed regardless.
  // -------------------------------------------------------------------------------------
  it('F17: a failure between the UPDATE and the ledger insert rolls BOTH back, in one transaction (RED at base)', () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)
    const t0 = 1_000_000
    scanFact('unreachable', t0)

    const spy = vi.spyOn(PactShared, 'insertPactStepRow').mockImplementation(() => {
      throw new Error('simulated crash between UPDATE and ledger insert')
    })
    try {
      expect(() => d.runPactLinkEvidenceSweep(t0 + PACT_LINK_SILENCE_MS)).toThrow('simulated crash')
    } finally {
      spy.mockRestore()
    }

    // The UPDATE must NOT have survived the rollback.
    const thread = d.getThread(threadId)
    expect(thread?.pact_paused_at).toBeNull()
    expect(thread?.pact_pause_reason).toBeNull()
    const ledgerRows = rawDb(d)
      .prepare(`SELECT COUNT(*) AS n FROM pact_steps WHERE thread_id = ? AND kind = 'pause'`)
      .get(threadId) as { n: number }
    expect(ledgerRows.n).toBe(0)
  })

  // -------------------------------------------------------------------------------------
  // T-NB9 — pact_pause_epoch (the RECOMPUTED, ledger-derived local toggle count B9c's resync
  // emits) reflects only OUR OWN local pause/resume transitions, never an inbound resync's
  // write to the (differently-scoped) `threads.pact_pause_epoch` column.
  // -------------------------------------------------------------------------------------
  it("T-NB9: our own local pause epoch is unaffected by an inbound resync's pact_pause_epoch write", () => {
    const d = freshDb()
    const a = seedAgent(d, 'a')
    const { threadId } = engagedFederatedPact(d, a)

    const localEpochBefore = rawDb(d)
      .prepare(
        `SELECT COUNT(*) AS n FROM pact_steps
           WHERE thread_id = ? AND actor_is_remote = 0 AND kind IN ('pause','resume')`
      )
      .get(threadId) as { n: number }
    expect(localEpochBefore.n).toBe(0)

    // Simulate an inbound resync learning of the PEER's pause history (their epoch), which
    // writes the stored `threads.pact_pause_epoch` column directly — a column B2.1 documents
    // as tracking "their pause", never ours.
    rawDb(d).prepare(`UPDATE threads SET pact_pause_epoch = 7 WHERE id = ?`).run(threadId)

    // Our own local pause/resume ledger count (what B9c's outbound resync emits) is untouched.
    const localEpochAfter = rawDb(d)
      .prepare(
        `SELECT COUNT(*) AS n FROM pact_steps
           WHERE thread_id = ? AND actor_is_remote = 0 AND kind IN ('pause','resume')`
      )
      .get(threadId) as { n: number }
    expect(localEpochAfter.n).toBe(0)

    // A genuine local pause DOES tick our own count, independent of the inbound-set column.
    emitFederatedPactSideEffect(rawDb(d), null, threadId, 'pause', 'operator')
    const localEpochAfterOwnPause = rawDb(d)
      .prepare(
        `SELECT COUNT(*) AS n FROM pact_steps
           WHERE thread_id = ? AND actor_is_remote = 0 AND kind IN ('pause','resume')`
      )
      .get(threadId) as { n: number }
    expect(localEpochAfterOwnPause.n).toBe(1)
    // The peer-learned column is unchanged by our own local transition.
    expect(d.getThread(threadId)?.pact_pause_epoch).toBe(7)
  })
})
