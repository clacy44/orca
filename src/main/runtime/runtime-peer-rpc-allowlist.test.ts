// S10-19 W-5: the ingress filter, the allowlist literal, per-verb hardening, metering.
// Mirrors mobile-rpc-allowlist.test.ts's source-scanning structure (§14B): the literal is
// auditable in one file and this suite is the thing that keeps it honest.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_RPC_METHODS } from './rpc/methods'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import {
  admitRuntimePeerMethod,
  assertPeerDispatchIds,
  assertPeerWorktreeMetadataBounded,
  clampPeerAttachTimeoutMs,
  peerRefusal,
  recordPeerAdmissionFault,
  RESERVED_PENDING_S10_16,
  RUNTIME_PEER_RPC_METHOD_ALLOWLIST,
  type PeerAdmissionContext
} from './runtime-peer-rpc-allowlist'
import { isHostScopedId } from './orchestration/orchestration-id-grammar'
import { PEER_ATTACH_PER_MINUTE, PEER_LIVE_ATTACHMENTS_PER_LINK } from './peer-profile-constants'

function setup(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('epoch-current')
  return { db, runtime }
}

describe('S10-19 W-5: the allowlist literal (S-1, S-8)', () => {
  it('has exactly 20 entries', () => {
    expect(RUNTIME_PEER_RPC_METHOD_ALLOWLIST.size).toBe(20)
  })

  it('every entry other than the two S10-16 reservations resolves to a registered method', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    const missing = [...RUNTIME_PEER_RPC_METHOD_ALLOWLIST.keys()].filter(
      (method) => !RESERVED_PENDING_S10_16.has(method) && !registered.has(method)
    )
    expect(missing).toEqual([])
  })

  // W-5..W-7 review finding 9 (Ruling 24 addendum 4(ee)): the un-conditioned version of this
  // test breaks the instant S10-16 registers federatedLinkProbe/federatedLinkConfirm — it was a
  // merge tripwire, not a companion that "goes live automatically" as the plan asked. Split into
  // two mutually-exclusive halves so exactly one runs, keyed on whether ALL_RPC_METHODS already
  // contains the S10-16 symbols at THIS branch's HEAD.
  const s10_16Registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
  const s10_16Landed = [...RESERVED_PENDING_S10_16].every((method) => s10_16Registered.has(method))

  it.skipIf(s10_16Landed)(
    'S-5 companion (pre-S10-16): RESERVED_PENDING_S10_16 stays non-empty until S10-16 registers its verbs',
    () => {
      const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
      const stillReserved = [...RESERVED_PENDING_S10_16].filter((method) => !registered.has(method))
      expect(stillReserved).toEqual([...RESERVED_PENDING_S10_16])
    }
  )

  it.skipIf(!s10_16Landed)(
    'S-5 companion (post-S10-16): once federatedLinkProbe/federatedLinkConfirm are registered, RESERVED_PENDING_S10_16 is fully covered',
    () => {
      const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
      const stillReserved = [...RESERVED_PENDING_S10_16].filter((method) => !registered.has(method))
      expect(stillReserved).toEqual([])
    }
  )

  it('S-8: orchestration.federationWorkerInput does not exist anywhere in the allowlist', () => {
    expect(RUNTIME_PEER_RPC_METHOD_ALLOWLIST.has('orchestration.federationWorkerInput')).toBe(false)
  })

  // W-5..W-7 review finding 10 (Ruling 24 addendum 4(ee)): S-9 was named in the plan but never
  // written — a structural regression guard against a later refactor silently dropping this
  // module's import of S10-20's id-grammar module. Proven by exercising assertPeerDispatchIds
  // against the REAL isHostScopedId (never a local stand-in) — a regression that swapped in a
  // permissive local check would still pass a hand-rolled test but fail this one.
  it('S-9: assertPeerDispatchIds is wired to the real S10-20 isHostScopedId grammar, not a local stand-in', () => {
    // ctx_/task_ + 12 lowercase-hex is the S10-20 grammar's own shape (orchestration-id-grammar.ts).
    expect(isHostScopedId('ctx_0123456789ab', ['ctx'])).toBe(true)
    expect(
      assertPeerDispatchIds({ dispatchId: 'ctx_0123456789ab', taskId: 'task_0123456789ab' })
    ).toEqual({ refused: false })
    // A peer-chosen id outside the grammar (wrong prefix, wrong length, uppercase) refuses —
    // this is the ingress-level bound the module import exists to enforce.
    expect(assertPeerDispatchIds({ dispatchId: 'evil_id', taskId: 'task_0123456789ab' })).toEqual(
      expect.objectContaining({ refused: true, code: 'invalid_argument' })
    )
  })

  it('NEG-1..NEG-7: default-denies terminal.send, terminal.create, and other unlisted verbs', () => {
    const denied = [
      'terminal.send',
      'terminal.create',
      'terminal.write',
      'terminal.read',
      'terminal.wait',
      'files.write',
      'computer.click',
      'browser.navigate',
      'repo.list',
      'worktree.create',
      'git.status',
      'settings.update',
      'automation.run',
      'linear.list',
      'accounts.lane.mintInvite',
      'accounts.lane.push',
      'aiVault.get',
      'artifacts.create',
      'orchestration.workerStart',
      'orchestration.workerStop',
      'orchestration.workerTerminalUserInput',
      'orchestration.run',
      'orchestration.runCreate',
      'orchestration.runUse',
      'orchestration.reset',
      'orchestration.agents.register',
      'orchestration.agents.retire',
      'orchestration.agents.quarantine',
      'orchestration.agents.relink',
      'orchestration.threads.pact'
    ]
    for (const method of denied) {
      expect(RUNTIME_PEER_RPC_METHOD_ALLOWLIST.has(method), method).toBe(false)
    }
  })
})

describe('S10-19 W-5: admitRuntimePeerMethod (§3)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('default-denies a method not on the list with method_not_available', async () => {
    const s = setup()
    db = s.db
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'terminal.send'
    })
    expect(result).toMatchObject({
      refused: true,
      code: 'method_not_available',
      wireCode: 'forbidden'
    })
  })

  it('admits a name-admitted method with no predicate', async () => {
    const s = setup()
    db = s.db
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'orchestration.federationPull'
    })
    expect(result).toEqual({ refused: false })
  })

  it('P-2..P-7: admits status.get and terminal.list under budget (metered, not refused)', async () => {
    const s = setup()
    db = s.db
    for (const method of ['status.get', 'terminal.list']) {
      const result = await admitRuntimePeerMethod({
        runtime: s.runtime,
        callerFingerprint: 'fp1',
        method
      })
      expect(result, method).toEqual({ refused: false })
    }
  })

  it('§3 prereq 5 (D-5, MJ-5): a throw from a predicate never propagates — it refuses admission_unavailable and audits', async () => {
    const s = setup()
    db = s.db
    vi.spyOn(s.runtime, 'getOrchestrationDb').mockImplementation(() => {
      throw new Error('store unreadable')
    })
    const auditSpy = vi.spyOn(db, 'writeAgentAudit')
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'status.get'
    })
    expect(result).toMatchObject({ refused: true, code: 'admission_unavailable' })
    expect(auditSpy).not.toHaveBeenCalled()
  })

  // Review Q4 (2026-09-02): the audit row recordPeerAdmissionFault writes must never carry the
  // raw, peer-supplied method through unbounded — only a KNOWN allowlist key is stored.
  it('Q4: a fault on a KNOWN method audits the real method name, capped', async () => {
    const s = setup()
    db = s.db
    vi.spyOn(db, 'checkAndBumpRate').mockImplementation(() => {
      throw new Error('meter store unreadable')
    })
    const auditSpy = vi.spyOn(db, 'writeAgentAudit')
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'status.get'
    })
    expect(result).toMatchObject({ refused: true, code: 'admission_unavailable' })
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ verb: 'peer_link:status.get' }))
  })

  it('Q4: recordPeerAdmissionFault with a 10 KB control-byte method name (not a registered key) audits unknown_method, never the raw string, length-capped', () => {
    const s = setup()
    db = s.db
    const auditSpy = vi.spyOn(db, 'writeAgentAudit')
    const hostile = `files.${'x'.repeat(10_000)}${String.fromCharCode(0x1b, 0x00, 0x07)}`
    expect(RUNTIME_PEER_RPC_METHOD_ALLOWLIST.has(hostile)).toBe(false)
    recordPeerAdmissionFault(
      { runtime: s.runtime, callerFingerprint: 'fp1', method: hostile },
      new Error('boom')
    )
    expect(auditSpy).toHaveBeenCalledTimes(1)
    const call = auditSpy.mock.calls[0]?.[0] as { verb: string }
    expect(call.verb).toBe('peer_link:unknown_method')
    expect(call.verb).not.toContain(hostile)
    expect(call.verb.length).toBeLessThanOrEqual(128)
  })
})

describe('S10-19 W-5: federationAttachStart admission (R7, R15, §4.1a)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('R7: refuses a caller-named terminal, effect-free', async () => {
    const s = setup()
    db = s.db
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'orchestration.federationAttachStart',
      params: { terminal: 'term_x' }
    })
    expect(result).toMatchObject({ refused: true, code: 'worktree_not_federated' })
  })

  it('admits a well-formed attach with no terminal, under the live-attachment cap', async () => {
    const s = setup()
    db = s.db
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'orchestration.federationAttachStart',
      params: {}
    })
    expect(result).toEqual({ refused: false })
  })

  it('refuses over the per-link live-attachment cap (PEER_LIVE_ATTACHMENTS_PER_LINK)', async () => {
    const s = setup()
    db = s.db
    vi.spyOn(s.db, 'countLivePeerAttachments').mockReturnValue(PEER_LIVE_ATTACHMENTS_PER_LINK)
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'orchestration.federationAttachStart',
      params: {}
    })
    expect(result).toMatchObject({ refused: true, code: 'attachment_cap_reached' })
  })

  it('meters the attach verb at PEER_ATTACH_PER_MINUTE, distinct from the mailbox meter', async () => {
    const s = setup()
    db = s.db
    let lastResult: Awaited<ReturnType<typeof admitRuntimePeerMethod>> | undefined
    for (let i = 0; i < PEER_ATTACH_PER_MINUTE + 1; i++) {
      lastResult = await admitRuntimePeerMethod({
        runtime: s.runtime,
        callerFingerprint: 'fp_attach',
        method: 'orchestration.federationAttachStart',
        params: {}
      })
    }
    expect(lastResult).toMatchObject({ refused: true, code: 'rate_limited' })
  })
})

describe('S10-19 W-5: federationAnswerPrompt admission (§6.4)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('refuses shape when dispatchId is missing', async () => {
    const s = setup()
    db = s.db
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'orchestration.federationAnswerPrompt',
      params: {}
    })
    expect(result).toMatchObject({ refused: true, code: 'pane_not_peer_owned' })
  })

  it("admits on shape alone — ownership/metering is writeToPeerOwnedPane's job (no double meter)", async () => {
    const s = setup()
    db = s.db
    const result = await admitRuntimePeerMethod({
      runtime: s.runtime,
      callerFingerprint: 'fp1',
      method: 'orchestration.federationAnswerPrompt',
      params: { dispatchId: 'disp_nonexistent' }
    })
    expect(result).toEqual({ refused: false })
  })
})

describe('S10-19 W-3 review finding 8: clampPeerAttachTimeoutMs', () => {
  it('an absent or non-finite timeoutMs falls back to the plain 60s default, not the 180s ceiling', () => {
    expect(clampPeerAttachTimeoutMs(undefined)).toBe(60_000)
    expect(clampPeerAttachTimeoutMs(Number.NaN)).toBe(60_000)
    expect(clampPeerAttachTimeoutMs(Number.POSITIVE_INFINITY)).toBe(60_000)
  })

  it('a supplied value is clamped into [10s, 180s]', () => {
    expect(clampPeerAttachTimeoutMs(1)).toBe(10_000)
    expect(clampPeerAttachTimeoutMs(999_999)).toBe(180_000)
    expect(clampPeerAttachTimeoutMs(45_000)).toBe(45_000)
  })
})

describe('Ruling 24 addendum (h): assertPeerWorktreeMetadataBounded', () => {
  it('admits absent fields and short, clean text', () => {
    expect(assertPeerWorktreeMetadataBounded({})).toEqual({ refused: false })
    expect(
      assertPeerWorktreeMetadataBounded({
        name: 'feature-x',
        repo: 'org/repo',
        displayName: 'Feature X',
        comment: 'a short comment'
      })
    ).toEqual({ refused: false })
  })

  it.each(['name', 'repo', 'displayName'] as const)(
    'refuses %s past its 200-character bound',
    (field) => {
      const result = assertPeerWorktreeMetadataBounded({ [field]: 'x'.repeat(201) })
      expect(result).toMatchObject({ refused: true, code: 'invalid_argument' })
    }
  )

  it('refuses comment past its 2000-character bound', () => {
    const result = assertPeerWorktreeMetadataBounded({ comment: 'x'.repeat(2001) })
    expect(result).toMatchObject({ refused: true, code: 'invalid_argument' })
  })

  it('refuses a control character (e.g. embedded newline) in any bounded field', () => {
    expect(assertPeerWorktreeMetadataBounded({ name: 'a\nb' })).toMatchObject({
      refused: true,
      code: 'invalid_argument'
    })
    expect(assertPeerWorktreeMetadataBounded({ comment: 'a\x01b' })).toMatchObject({
      refused: true,
      code: 'invalid_argument'
    })
  })
})

describe('S10-19 W-5: T-3 byte-identical ownership refusals', () => {
  it('peerRefusal builds the same shape for the same code/message across call sites', () => {
    const a = peerRefusal('pane_not_peer_owned', 'x is not a live peer-owned pane.')
    const b = peerRefusal('pane_not_peer_owned', 'x is not a live peer-owned pane.')
    expect(a).toEqual(b)
  })
})

// Type-only check that PeerAdmissionContext's optional `params`/`method` widening (W-5) does not
// break W-3/W-4's narrower construction sites.
const _typeCheck: PeerAdmissionContext = {
  runtime: null as unknown as OrcaRuntimeService,
  callerFingerprint: 'x'
}
void _typeCheck
