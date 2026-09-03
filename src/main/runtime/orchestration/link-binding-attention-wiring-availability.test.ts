// S10-16 C8b, Ruling 28(m): `unavailable(transport)`/`unavailable(prover)` — gated on evidence
// the wiring was EXPECTED (a binding row, or a queued reply on the link), never unconditional.
// Split out of link-binding-attention.test.ts to stay under max-lines.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeService } from '../orca-runtime'
import { describeLinkBindingHealth } from './link-binding-attention'
import type { LinkBindingSelfView } from '../device-registry-link-credential'

function workingSelfView(): LinkBindingSelfView {
  return {
    registryCredentialFingerprint: () => null,
    ownKeyFingerprint: () => null,
    macWithRegistryToken: () => null,
    listRuntimeLinkCandidates: () => [],
    listRuntimeScopeDeviceIds: () => [],
    registryLoadSucceeded: () => true
  }
}

describe('Ruling 28(m): unavailable(transport)/unavailable(prover), gated on evidence the wiring was expected', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  const boundRow = (linkDeviceId: string, environmentId: string) => ({
    linkDeviceId,
    environmentId,
    boundEndpointId: 'ep_1',
    boundPairingRevision: 1,
    linkCredentialFp: 'fp_link',
    peerCredentialFp: 'fp_peer',
    peerKeyFingerprint: 'fp_key',
    grantClass: 'minted' as const,
    scanCompleteness: 'complete' as const,
    proofProtocol: 'p1',
    provedAt: Date.now(),
    lastVerifiedAt: Date.now()
  })

  it('a binding with no transport wired reads unavailable(transport)', () => {
    const noTransportRuntime = new OrcaRuntimeService()
    noTransportRuntime.setOrchestrationDb(db)
    noTransportRuntime.linkBindingSelfView = workingSelfView()
    noTransportRuntime.getLinkBindingProver()
    vi.spyOn(noTransportRuntime, 'resolveOrchestrationWorkerServer').mockImplementation(
      (selector: string) => ({ name: `env:${selector}`, id: selector }) as never
    )
    db.putPeerLinkBinding(boundRow('link_no_transport', 'env_1'))
    const result = describeLinkBindingHealth(db, noTransportRuntime, 'link_no_transport')
    expect(result.word).toBe('unavailable')
    expect(result.reason).toBe('transport')
  })

  it('a binding with no prover armed reads unavailable(prover)', () => {
    const noProverRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: {} as never
    })
    // Deliberately never attaches a db (setOrchestrationDb auto-arms getLinkBindingProver(),
    // which would construct the prover as a side effect and defeat this test) and never calls
    // getLinkBindingProver() directly either — hasLinkBindingProver() stays false.
    // describeLinkBindingHealth takes its own `db` argument, so no db attachment is needed here.
    noProverRuntime.linkBindingSelfView = workingSelfView()
    vi.spyOn(noProverRuntime, 'resolveOrchestrationWorkerServer').mockImplementation(
      (selector: string) => ({ name: `env:${selector}`, id: selector }) as never
    )
    db.putPeerLinkBinding(boundRow('link_no_prover', 'env_1'))
    const result = describeLinkBindingHealth(db, noProverRuntime, 'link_no_prover')
    expect(result.word).toBe('unavailable')
    expect(result.reason).toBe('prover')
  })

  it('a link with no binding and no pending reply is NOT unavailable(transport), even with no transport wired', () => {
    const noTransportRuntime = new OrcaRuntimeService()
    noTransportRuntime.setOrchestrationDb(db)
    noTransportRuntime.linkBindingSelfView = workingSelfView()
    noTransportRuntime.getLinkBindingProver()
    const result = describeLinkBindingHealth(db, noTransportRuntime, 'link_never_seen')
    expect(result.word).toBe('pending')
  })

  it('a queued outbox reply (no binding) with no transport wired still reads unavailable(transport)', () => {
    const noTransportRuntime = new OrcaRuntimeService()
    noTransportRuntime.setOrchestrationDb(db)
    noTransportRuntime.linkBindingSelfView = workingSelfView()
    noTransportRuntime.getLinkBindingProver()
    db.enqueueReplyOutbox({
      localMessageId: 'msg_local_1',
      linkDeviceId: 'link_outbox_only',
      environmentId: 'env_1',
      boundPairingRevision: 1,
      peerCredentialFp: 'fp_peer',
      peerKeyFingerprint: 'fp_key',
      inReplyToMessageId: 'msg_orig_1',
      peerAgentId: 'agent_1',
      peerThreadId: null,
      localThreadId: null,
      noticeRunId: null,
      noticePaneKey: null,
      payload: '{}',
      byteCount: 2,
      createdAt: Date.now()
    })
    const result = describeLinkBindingHealth(db, noTransportRuntime, 'link_outbox_only')
    expect(result.word).toBe('unavailable')
    expect(result.reason).toBe('transport')
  })
})
