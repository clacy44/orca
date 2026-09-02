// S10-19 W-5: the ingress filter, the allowlist literal, per-verb hardening, metering.
// Mirrors mobile-rpc-allowlist.test.ts's source-scanning structure (§14B): the literal is
// auditable in one file and this suite is the thing that keeps it honest.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_RPC_METHODS } from './rpc/methods'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import {
  admitRuntimePeerMethod,
  peerRefusal,
  RESERVED_PENDING_S10_16,
  RUNTIME_PEER_RPC_METHOD_ALLOWLIST,
  type PeerAdmissionContext
} from './runtime-peer-rpc-allowlist'
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

  it('S-5 companion: RESERVED_PENDING_S10_16 stays non-empty until S10-16 registers its verbs', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    const stillReserved = [...RESERVED_PENDING_S10_16].filter((method) => !registered.has(method))
    // Why not toEqual([]): this asserts the COMBINED artifact, not this branch (§E.1) — it goes
    // live automatically once S10-16 lands (`registered.has` starts returning true for both).
    expect(stillReserved).toEqual([...RESERVED_PENDING_S10_16])
  })

  it('S-8: orchestration.federationWorkerInput does not exist anywhere in the allowlist', () => {
    expect(RUNTIME_PEER_RPC_METHOD_ALLOWLIST.has('orchestration.federationWorkerInput')).toBe(false)
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
