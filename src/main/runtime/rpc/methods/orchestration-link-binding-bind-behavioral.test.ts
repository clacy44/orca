// Ruling 28 Addendum 1(p)/D-1/D-2/D2: a behavioural `linkBind` test THROUGH the RPC dispatcher
// (Ruling 28(n)'s missing block) — `linkBind` was the one write verb with no end-to-end
// coverage, so D1 (the forced round dropping its own link on the backoff gate) shipped
// undetected. Harness duplicated from link-binding-prover-round.test.ts's `beforeEach`/
// `fakeResponder` (this codebase's established test-split precedent — see that file's own header
// comment) rather than shared, but driven through `ORCHESTRATION_LINK_BINDING_BIND_METHODS` and
// `ORCHESTRATION_LINK_BINDING_LOCAL_METHODS`'s real handlers — never `runOneRound` directly —
// so a regression in the RPC-level wiring (D1's exact shape) is what fails this file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type Database from '../../../sqlite/sync-database'
import { DeviceRegistry } from '../../device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from '../../e2ee-keypair'
import { createLinkBindingSelfView } from '../../device-registry-link-credential'
import { hashCallerCredential } from '../../principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from '../../orchestration/environment-transport'
import { SELECTOR_LABEL, PROOF_LABEL, linkBindingMac } from '../../orchestration/link-binding-proof'
import { ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../../../shared/runtime-environment-store'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_LINK_BINDING_BIND_METHODS } from './orchestration-link-binding-bind'
import { ORCHESTRATION_LINK_BINDING_LOCAL_METHODS } from './orchestration-link-binding-local'
import type { RpcContext } from '../core'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

type AuditRow = { verb: string; outcome: string; reason_code: string | null }

function listAudit(db: OrchestrationDb): AuditRow[] {
  return rawDb(db)
    .prepare('SELECT verb, outcome, reason_code FROM agent_audit ORDER BY seq ASC')
    .all() as AuditRow[]
}

const ALL_METHODS = [
  ...ORCHESTRATION_LINK_BINDING_BIND_METHODS,
  ...ORCHESTRATION_LINK_BINDING_LOCAL_METHODS
]

function findMethod(name: string) {
  const method = ALL_METHODS.find((m) => m.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

async function call(name: string, params: Record<string, unknown>, ctx: RpcContext) {
  const method = findMethod(name)
  const parsed = method.params ? method.params.parse(params) : params
  return method.handler(parsed, ctx)
}

describe('Ruling 28 Addendum 1(p): linkBind, behaviourally, through the RPC dispatcher', () => {
  let root: string
  let userDataPath: string
  let deviceRegistry: DeviceRegistry
  let e2ee: E2EEKeypair
  let peerE2ee: E2EEKeypair
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let linkId: string
  let linkToken: string

  // R10-B: candidates are collapsed to the newest per hashCallerCredential(deviceToken) — the
  // environment's OWN stored pairing token, unrelated to what the fake responder actually proves
  // with below. `deviceToken` defaults to `linkToken` (a single surviving candidate); pass a
  // distinct one (as "two winners: stays contested..." below does) so BOTH environments survive
  // the collapse as separate round candidates — exactly the "different grant to the same host"
  // (multi_grant) shape the collapse's own doc comment names, not a defect in the fixture.
  function saveMatchingEnvironmentWithKey(
    key: E2EEKeypair,
    label: string,
    deviceToken: string = linkToken
  ): string {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: `ws://${label}.example:16768`,
      deviceToken,
      publicKeyB64: key.publicKeyB64
    })
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: `env-${label}-${randomBytes(4).toString('hex')}`,
      pairingCode: code
    })
    return env.id
  }

  function saveNonMatchingEnvironment(): string {
    const code = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://other.example:16768',
      deviceToken: `not-the-link-token-${randomBytes(8).toString('hex')}`,
      publicKeyB64: peerE2ee.publicKeyB64
    })
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: `env-nonmatch-${randomBytes(4).toString('hex')}`,
      pairingCode: code
    })
    return env.id
  }

  // A generalised responder over a MAP of environmentId -> answering key, so one round can seat
  // TWO distinct, genuinely-verifying peers (the two-winner scenario) — `args.selector` is the
  // environmentId `callPinnedEnvironment` was called with.
  // `tokensByEnv` lets a caller give an environment its OWN `deviceToken` (as pinned on it at
  // `saveMatchingEnvironmentWithKey` time) for the `observedChannelFp` the responder embeds —
  // per link-binding-prover-probe.ts:91-92, that field is derived from THIS HOST's local record
  // of the environment's pairing token, not from the shared link-registry secret; a genuinely-
  // verifying peer must reproduce it to match the selector the prover built locally. Unlisted
  // environments default to `linkToken` (the harness's prior single-winner shape, unchanged).
  function multiKeyResponder(
    keysByEnv: Map<string, E2EEKeypair>,
    tokensByEnv: Map<string, string> = new Map<string, string>()
  ) {
    return vi.fn(async (args: { selector: string; method: string; params: unknown }) => {
      const key = keysByEnv.get(args.selector) ?? peerE2ee
      const deviceToken = tokensByEnv.get(args.selector) ?? linkToken
      if (args.method === 'status.get') {
        return { capabilities: [ORCHESTRATION_LINK_BINDING_RUNTIME_CAPABILITY] }
      }
      if (args.method === 'orchestration.federatedLinkConfirm') {
        const p = args.params as { confirms: { slotIndex: number; confirm: string }[] }
        return {
          protocol: 'orca.link-binding.v1',
          acknowledged: p.confirms.map((c) => c.slotIndex)
        }
      }
      if (args.method === 'orchestration.federatedLinkProbe') {
        const p = args.params as {
          probeId: string
          nonceH: string
          epoch: number
          selectors: string[]
        }
        const observedChannelFp = hashCallerCredential(deviceToken)
        const dstKeyFp = fingerprintOrchestrationPeer(key.publicKeyB64)
        const results: unknown[] = []
        for (let s = 0; s < p.selectors.length; s += 1) {
          const expected = linkBindingMac(linkToken, SELECTOR_LABEL, [
            p.probeId,
            p.nonceH,
            String(s),
            String(p.epoch),
            observedChannelFp,
            dstKeyFp
          ])
          if (expected === p.selectors[s]) {
            const nonceP = randomBytes(32).toString('hex')
            const proof = linkBindingMac(linkToken, PROOF_LABEL, [
              p.probeId,
              p.nonceH,
              String(s),
              String(p.epoch),
              observedChannelFp,
              dstKeyFp,
              nonceP
            ])
            results.push({
              slotIndex: s,
              matched: true,
              nonceP,
              proof,
              observedChannelFp,
              peerKeyFingerprint: dstKeyFp
            })
          }
        }
        return { protocol: 'orca.link-binding.v1', results }
      }
      throw new Error(`unexpected method ${args.method}`)
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-link-binding-bind-behavioral-'))
    userDataPath = join(root, 'userdata')
    appState.userData = userDataPath
    deviceRegistry = new DeviceRegistry(userDataPath)
    const link = deviceRegistry.mintPendingDevice('home', 'runtime')
    linkId = link.deviceId
    linkToken = link.token
    deviceRegistry.updateLastSeen(linkId)
    e2ee = loadOrCreateE2EEKeypair(userDataPath)
    peerE2ee = loadOrCreateE2EEKeypair(join(root, 'peer-userdata'))
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    runtime.setLinkBindingSelfView(
      createLinkBindingSelfView(deviceRegistry, () => e2ee.publicKeyB64)
    )
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  function localCtx(): RpcContext {
    return { runtime }
  }

  it('one winner resolving an existing contest: binding written, contest cleared, link_contest_resolved audited', async () => {
    const keyB = loadOrCreateE2EEKeypair(join(root, 'peer-userdata-b'))
    const envA = saveMatchingEnvironmentWithKey(peerE2ee, 'a')
    const envB = saveMatchingEnvironmentWithKey(keyB, 'b')

    // Seed a contested incumbent bound to envA, exactly as a real two-winner round would leave
    // it (the contest itself is covered by link-binding-prover-round.test.ts's F1/R11.4 test —
    // this test's job is the FORCED round that RESOLVES one, through the RPC dispatcher).
    const incidentId = `incident_${randomBytes(4).toString('hex')}`
    db.contestPeerLinkBinding(linkId, Date.now(), incidentId, 'two winners', {
      environmentId: envA,
      boundEndpointId: 'endpoint_a',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_a',
      peerCredentialFp: 'peer_fp_a',
      peerKeyFingerprint: 'peer_key_fp_a',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1'
    })
    expect(db.getPeerLinkBinding(linkId)?.state).toBe('contested')

    // Exclude envA from this round's candidates so envB is the ROUND's sole winner — isolating
    // the forced-resolve-with-one-winner path from the two-winner contest path pinned by
    // "two winners: stays contested..." below.
    db.putContainment({
      subjectKind: 'environment',
      subjectId: envA,
      action: 'scan_exclude',
      reasonCode: 'test',
      reasonText: null,
      detail: null,
      createdAt: Date.now(),
      expiresAt: null
    })

    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      multiKeyResponder(new Map([[envB, keyB]]))
    )

    const beforeAudit = listAudit(db).length
    const result = (await call('orchestration.linkBind', { link: linkId }, localCtx())) as {
      state: string
      link: string
    }
    expect(result.state).toBe('proven')

    const binding = db.getPeerLinkBinding(linkId)
    expect(binding?.state).toBe('confirmed')
    expect(binding?.environmentId).toBe(envB)
    expect(binding?.contestIncidentId).toBeNull()
    expect(binding?.contestedAt).toBeNull()

    const audit = listAudit(db)
    expect(audit.length).toBeGreaterThan(beforeAudit)
    const resolved = audit.find((a) => a.outcome === 'link_contest_resolved')
    expect(resolved).toBeDefined()
    const reason = JSON.parse(resolved?.reason_code ?? '{}') as { incidentId?: string }
    expect(reason.incidentId).toBe(incidentId)
  })

  // Ruling 28 Addendum 1(p)/review E1: "two winners in one round" (classifyLinkRound's own
  // >=2-different-key branch) IS constructible through two DISTINCT saved environments in this
  // harness — the earlier claim that it wasn't conflated two different secrets. The proof MAC
  // key is THIS HOST'S OWN registry credential for the link
  // (`selfView.macWithRegistryToken(link.linkDeviceId, ...)`, link-binding-prover-outcome.ts:
  // 265-273), not the environment's stored `deviceToken`. `observedChannelFp`/`dstKeyFp` are
  // per-environment transcript fields the verifier derives itself from that environment's own
  // record (link-binding-prover-probe.ts:91-92). So two saved environments with DIFFERENT
  // `deviceToken`s survive R10-B's collapse as separate round candidates, and a responder
  // holding the real link token — `multiKeyResponder` above, given each environment's own
  // `deviceToken` via its `tokensByEnv` map so it reproduces the correct `observedChannelFp`
  // per environment — produces a verifying proof for both, each under its own
  // `observedChannelFp`/`dstKeyFp`. Give them different `publicKeyB64`
  // and the two winners carry different `dstKeyFp`, which is exactly `classifyLinkRound`'s
  // contested branch. What this test pins that `link-binding-classify.test.ts:57`'s pure-function
  // coverage cannot: that `writeContest` runs under `forcedResolve` for a two-winner outcome,
  // that `contestPeerLinkBinding`'s `WHERE state = 'confirmed'` guard correctly no-ops on an
  // already-contested row (a pre-existing contest's incumbent/incident id survive untouched),
  // and that the verb reports `contested` rather than resolving it — the one place a wrong
  // `forcedResolve` branch would silently clear a live contest.
  it('two winners: stays contested, no binding written for either winner, no resolve audit, existing contest untouched', async () => {
    const keyB = loadOrCreateE2EEKeypair(join(root, 'peer-userdata-two-winner-b'))
    const tokenA = `token-two-a-${randomBytes(8).toString('hex')}`
    const tokenB = `token-two-b-${randomBytes(8).toString('hex')}`
    const envA = saveMatchingEnvironmentWithKey(peerE2ee, 'two-a', tokenA)
    const envB = saveMatchingEnvironmentWithKey(keyB, 'two-b', tokenB)

    // Seed a pre-existing contest so this test also pins that a genuine two-winner round leaves
    // an already-contested row's identity untouched — `contestPeerLinkBinding`'s UPDATE half
    // guards on `WHERE state = 'confirmed'`, so re-running `writeContest` against an
    // already-contested row must no-op rather than mint a fresh incident.
    const priorIncidentId = `incident_${randomBytes(4).toString('hex')}`
    db.contestPeerLinkBinding(linkId, Date.now(), priorIncidentId, 'prior contest', {
      environmentId: 'env_prior_incumbent',
      boundEndpointId: 'endpoint_prior',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_prior',
      peerCredentialFp: 'peer_fp_prior',
      peerKeyFingerprint: 'peer_key_fp_prior',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1'
    })
    expect(db.getPeerLinkBinding(linkId)?.contestIncidentId).toBe(priorIncidentId)

    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      multiKeyResponder(
        new Map([
          [envA, peerE2ee],
          [envB, keyB]
        ]),
        new Map([
          [envA, tokenA],
          [envB, tokenB]
        ])
      )
    )

    const beforeAudit = listAudit(db).length
    const result = (await call('orchestration.linkBind', { link: linkId }, localCtx())) as {
      state: string
    }
    expect(result.state).toBe('contested')

    const binding = db.getPeerLinkBinding(linkId)
    expect(binding?.state).toBe('contested')
    expect(binding?.contestedAt).not.toBeNull()
    expect(binding?.contestIncidentId).toBe(priorIncidentId)
    // No binding was written for either round winner — the pre-existing incumbent's identity
    // (never envA's or envB's) is still what the row names.
    expect(binding?.environmentId).toBe('env_prior_incumbent')

    const audit = listAudit(db)
    expect(audit.length).toBeGreaterThan(beforeAudit)
    expect(audit.find((a) => a.outcome === 'link_contest_resolved')).toBeUndefined()
  })

  // A forced round that finds NO clean single winner (here: zero live candidates) must also
  // leave an existing contest completely alone — `resolvePeerLinkBindingContest` is the ONE path
  // that clears one, and it requires `forcedResolve && exactly one winner`; this isolates that
  // zero-winner shape from the two-winner shape pinned immediately above.
  it('an existing contest with no clean winner this round: stays contested, the verb reports contested', async () => {
    const incidentId = `incident_${randomBytes(4).toString('hex')}`
    db.contestPeerLinkBinding(linkId, Date.now(), incidentId, 'two winners', {
      environmentId: 'env_stale_incumbent',
      boundEndpointId: 'endpoint_stale',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_stale',
      peerCredentialFp: 'peer_fp_stale',
      peerKeyFingerprint: 'peer_key_fp_stale',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1'
    })
    expect(db.getPeerLinkBinding(linkId)?.state).toBe('contested')

    // No saved environments at all — zero candidates, zero winners this round.
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(multiKeyResponder(new Map()))

    const result = (await call('orchestration.linkBind', { link: linkId }, localCtx())) as {
      state: string
    }
    expect(result.state).toBe('contested')

    const binding = db.getPeerLinkBinding(linkId)
    expect(binding?.state).toBe('contested')
    expect(binding?.contestIncidentId).toBe(incidentId)
  })

  it('no winner: the link is left unchanged, the verb reports the no-winner outcome', async () => {
    saveNonMatchingEnvironment()
    db.putBindingAttempt(linkId)
    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(multiKeyResponder(new Map()))

    const result = (await call('orchestration.linkBind', { link: linkId }, localCtx())) as {
      state: string
    }
    expect(result.state).toBe('unpaired')
    expect(db.getPeerLinkBinding(linkId)).toBeNull()
  })

  it('revoked: link_revoke_lifted is audited, THEN the round runs and re-establishes the binding', async () => {
    const envA = saveMatchingEnvironmentWithKey(peerE2ee, 'a3')
    db.putPeerLinkBinding({
      linkDeviceId: linkId,
      environmentId: envA,
      boundEndpointId: 'endpoint_a3',
      boundPairingRevision: 1,
      linkCredentialFp: 'link_fp_a3',
      peerCredentialFp: 'peer_fp_a3',
      peerKeyFingerprint: 'peer_key_fp_a3',
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'v1',
      provedAt: 0,
      lastVerifiedAt: 0
    })
    db.revokePeerLinkBinding(linkId, Date.now())
    expect(db.getPeerLinkBinding(linkId)?.state).toBe('revoked')

    vi.spyOn(runtime, 'callPinnedEnvironment').mockImplementation(
      multiKeyResponder(new Map([[envA, peerE2ee]]))
    )

    const result = (await call('orchestration.linkBind', { link: linkId }, localCtx())) as {
      state: string
    }
    expect(result.state).toBe('proven')

    const binding = db.getPeerLinkBinding(linkId)
    expect(binding?.state).toBe('confirmed')
    expect(binding?.revokedAt).toBeNull()

    const audit = listAudit(db)
    const liftedIndex = audit.findIndex((a) => a.outcome === 'link_revoke_lifted')
    expect(liftedIndex).toBeGreaterThanOrEqual(0)
    // "link_revoke_lifted audit THEN the round": no round-outcome audit for this link precedes
    // the lift — the only round-outcome audit this scenario can produce is a rebind (a fresh
    // winner at the SAME environment is not a rebind, so none is expected either); asserting the
    // lift exists and is not the last-possible write is sufficient signal that it ran first.
    expect(liftedIndex).toBe(0)
  })

  // D-6/D6: `linkBindings --wait` is only meaningful against a single named link — a wait with
  // no `--link` waited on nothing and must never report `state: 'settled'` as though it had.
  // The genuine settled/timeout outcomes of a `--wait` are exercised by `linkBind`'s own wait,
  // above (all four scenarios resolve `'proven'`/`'contested'`/`'unpaired'` promptly, never
  // `'timeout'`, now that D1's forced-round fix lands) and by the existing test-61 clamp test in
  // `orchestration-link-binding-local.test.ts` (the genuine 45s-timeout case, under fake timers).
  it('D-6: linkBindings --wait without --link is a hard refusal, never "settled"', async () => {
    await expect(
      call('orchestration.linkBindings', { wait: true }, localCtx())
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})
