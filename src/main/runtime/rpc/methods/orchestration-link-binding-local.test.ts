// S10-16 C7, test 53: every local link-binding verb refuses a paired/mobile caller `forbidden`,
// gate-first (bogus ids never reach a read/write), and is absent from the peer allowlist.
import { afterEach, describe, expect, it, vi } from 'vitest'

// Ruling 28: the --environment filter's server-side resolution (orchestration-link-binding-
// local.ts's resolveEnvironmentFilterId) reads userDataPath via electron's `app.getPath`
// (orchestration-link-binding-pending.ts's resolveUserDataPath) — mocked so that read never
// throws ahead of the `resolveEnvironment` spy the filter tests install per-test.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-link-binding-local-test' } }))
import { ORCHESTRATION_LINK_BINDING_LOCAL_METHODS } from './orchestration-link-binding-local'
import { RUNTIME_PEER_RPC_METHOD_ALLOWLIST } from '../../runtime-peer-rpc-allowlist'
import type { RpcContext } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type Database from '../../../sqlite/sync-database'
import { LINK_BINDING_STATUS_WAIT_CAP_MS } from '../../orchestration/link-binding-constants'
import * as runtimeEnvironmentStore from '../../../../shared/runtime-environment-store'

function rawDb(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

type AuditRow = { verb: string; outcome: string; reason_code: string | null }

function listAudit(db: OrchestrationDb): AuditRow[] {
  return rawDb(db)
    .prepare('SELECT verb, outcome, reason_code FROM agent_audit ORDER BY seq ASC')
    .all() as AuditRow[]
}

function findMethod(name: string) {
  const method = ORCHESTRATION_LINK_BINDING_LOCAL_METHODS.find((m) => m.name === name)
  if (!method) {
    throw new Error(`Method not found: ${name}`)
  }
  return method
}

describe('orchestration-link-binding-local RPC methods', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  }

  afterEach(() => {
    if (!dbOpen) {
      return
    }
    dbOpen = false
    db.close()
  })

  async function call(name: string, params: Record<string, unknown>, ctx: RpcContext) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : params
    return method.handler(parsed, ctx)
  }

  it.each([
    ['orchestration.linkBindings', { link: 'lnk_bogus' }],
    ['orchestration.linkBind', { link: 'lnk_bogus' }],
    ['orchestration.linkRevoke', { link: 'lnk_bogus' }],
    ['orchestration.linkForget', { link: 'lnk_bogus' }],
    [
      'orchestration.linkContainment',
      { subjectKind: 'link', subjectId: 'lnk_bogus', action: 'quarantine' }
    ],
    ['orchestration.replyOutbox', { link: 'lnk_bogus' }]
  ])('%s refuses a paired caller with forbidden, before any read/write', async (method, params) => {
    setup()
    const ctx: RpcContext = { runtime, pairedDeviceId: 'dev_paired_peer', clientKind: 'runtime' }
    await expect(call(method, params, ctx)).rejects.toMatchObject({ code: 'forbidden' })
    // Gate-first: a bogus link id never reaches a read, so nothing was written or read from it.
    expect(db.getPeerLinkBinding('lnk_bogus')).toBeNull()
  })

  it.each([
    ['orchestration.linkBindings', { link: 'lnk_bogus' }],
    ['orchestration.linkBind', { link: 'lnk_bogus' }],
    ['orchestration.linkRevoke', { link: 'lnk_bogus' }],
    ['orchestration.linkForget', { link: 'lnk_bogus' }],
    [
      'orchestration.linkContainment',
      { subjectKind: 'link', subjectId: 'lnk_bogus', action: 'quarantine' }
    ],
    ['orchestration.replyOutbox', { link: 'lnk_bogus' }]
  ])('%s refuses a mobile-scope caller the same way', async (name, params) => {
    setup()
    const ctx: RpcContext = { runtime, clientKind: 'mobile' }
    await expect(call(name, params, ctx)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a genuinely local caller (no pairedDeviceId, no clientKind) is admitted', async () => {
    setup()
    const ctx: RpcContext = { runtime }
    const result = (await call('orchestration.linkBindings', {}, ctx)) as { links: unknown[] }
    expect(result.links).toEqual([])
  })

  // Ruling 28(h)/protocol F10: the positive-form gate must ALSO admit the in-process
  // `clientKind: 'runtime'` shape with no `pairedDeviceId` — the exact case the old denylist
  // form (`pairedDeviceId != null || clientKind === 'mobile'`) silently admitted by accident,
  // never asserted by C7's own test.
  it('a local caller carrying {clientKind: "runtime"} and no pairedDeviceId is admitted', async () => {
    setup()
    const ctx: RpcContext = { runtime, clientKind: 'runtime' }
    const result = (await call('orchestration.linkBindings', {}, ctx)) as { links: unknown[] }
    expect(result.links).toEqual([])
  })

  // Ruling 28(c)/design test 61: the server-side wait is bounded by the SINGLE cap
  // (LINK_BINDING_STATUS_WAIT_CAP_MS) regardless of a larger --timeout-ms — replaces C7's test
  // that pinned `--wait` as a documented no-op.
  describe('Ruling 28(c)/test 61: linkBindings --wait is clamped to the single 45s cap', () => {
    it('--timeout-ms 200000 is clamped to LINK_BINDING_STATUS_WAIT_CAP_MS, and a timed-out wait is a report, not an error', async () => {
      setup()
      vi.useFakeTimers()
      try {
        const promise = call(
          'orchestration.linkBindings',
          { link: 'lnk_never_settles', wait: true, timeoutMs: 200_000 },
          { runtime }
        )
        await vi.advanceTimersByTimeAsync(LINK_BINDING_STATUS_WAIT_CAP_MS - 1)
        // Not yet resolved — the wait has not hit its cap.
        let settled = false
        void promise.then(() => {
          settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(2)
        const result = (await promise) as { links: unknown[]; state?: string }
        expect(result.state).toBe('timeout')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Ruling 28(n): behavioural tests for the write verbs — the row changed, and its audit row', () => {
    function localCtx(): RpcContext {
      return { runtime }
    }

    it('linkRevoke revokes the row and writes an audit row', async () => {
      setup()
      db.putPeerLinkBinding({
        linkDeviceId: 'link_revoke_behav',
        environmentId: 'env_revoke_behav',
        boundEndpointId: 'endpoint_1',
        boundPairingRevision: 1,
        linkCredentialFp: 'fp_1',
        peerCredentialFp: 'peer_fp_1',
        peerKeyFingerprint: 'peer_key_fp_1',
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'v1',
        provedAt: 0,
        lastVerifiedAt: 0
      })
      const before = listAudit(db).length
      const result = (await call(
        'orchestration.linkRevoke',
        { link: 'link_revoke_behav' },
        localCtx()
      )) as { linkDeviceId: string; revokedAt: number }
      expect(result.revokedAt).toBeGreaterThan(0)
      expect(db.getPeerLinkBinding('link_revoke_behav')?.state).toBe('revoked')
      const audit = listAudit(db)
      expect(audit.length).toBe(before + 1)
      expect(audit.at(-1)?.outcome).toBe('revoked')
    })

    it('linkForget deletes the row from all four tables and writes an audit row, and refuses an unknown link', async () => {
      setup()
      db.putPeerLinkBinding({
        linkDeviceId: 'link_forget_behav',
        environmentId: 'env_forget_behav',
        boundEndpointId: 'endpoint_1',
        boundPairingRevision: 1,
        linkCredentialFp: 'fp_1',
        peerCredentialFp: 'peer_fp_1',
        peerKeyFingerprint: 'peer_key_fp_1',
        grantClass: 'minted',
        scanCompleteness: 'complete',
        proofProtocol: 'v1',
        provedAt: 0,
        lastVerifiedAt: 0
      })
      db.putScanFact({
        linkDeviceId: 'link_forget_behav',
        environmentId: 'env_forget_behav',
        outcome: 'proven',
        environmentPairingRevision: 1,
        linkCredentialFp: 'fp_1',
        detail: null,
        observedAt: 0
      })
      db.putConfirmObservation({
        linkDeviceId: 'link_forget_behav',
        environmentId: 'env_forget_behav',
        kind: 'peer_confirmed',
        detail: null,
        observedAt: 0
      })
      const before = listAudit(db).length
      const result = (await call(
        'orchestration.linkForget',
        { link: 'link_forget_behav' },
        localCtx()
      )) as { forgotten: string[] }
      expect(result.forgotten).toEqual(['link_forget_behav'])
      expect(db.getPeerLinkBinding('link_forget_behav')).toBeNull()
      expect(db.listScanFacts('link_forget_behav')).toEqual([])
      expect(db.listConfirmObservations('link_forget_behav')).toEqual([])
      const audit = listAudit(db)
      expect(audit.length).toBe(before + 1)
      expect(audit.at(-1)?.outcome).toBe('forgotten')

      await expect(
        call('orchestration.linkForget', { link: 'link_unknown_behav' }, localCtx())
      ).rejects.toMatchObject({ code: 'invalid_argument' })
    })

    it('linkContainment writes a containment row and an audit row, then lift writes another audit row carrying the prior reason', async () => {
      setup()
      const write = (await call(
        'orchestration.linkContainment',
        {
          subjectKind: 'link',
          subjectId: 'link_containment_behav',
          action: 'quarantine',
          reason: 'r1'
        },
        localCtx()
      )) as { subjectId: string; liftedAt: number | null }
      expect(write.subjectId).toBe('link_containment_behav')
      expect(db.isPeerLinkQuarantined('link_containment_behav')).toBe(true)
      const afterWriteAudit = listAudit(db)
      expect(afterWriteAudit.at(-1)?.outcome).toBe('quarantine')

      const lift = (await call(
        'orchestration.linkContainment',
        {
          subjectKind: 'link',
          subjectId: 'link_containment_behav',
          action: 'quarantine',
          lift: true
        },
        localCtx()
      )) as { liftedAt: number }
      expect(lift.liftedAt).toBeGreaterThan(0)
      expect(db.isPeerLinkQuarantined('link_containment_behav')).toBe(false)
      const afterLiftAudit = listAudit(db)
      expect(afterLiftAudit.at(-1)?.outcome).toBe('quarantine_lifted')
      expect(afterLiftAudit.at(-1)?.reason_code).toContain('"priorReasonText":"r1"')
    })

    it('replyOutbox --drain reports the pre-kick queued count labelled "kicked", never claiming a completed drain', async () => {
      setup()
      const result = (await call(
        'orchestration.replyOutbox',
        { link: 'link_drain_behav', drain: true },
        localCtx()
      )) as { kicked: Record<string, number> }
      expect(result.kicked).toEqual({ link_drain_behav: 0 })
    })
  })

  // Lifecycle F-12/Ruling 28: `--environment` was advertised in the CLI spec but no code path
  // ever read it — a documented flag that does nothing is a defect. Implemented server-side,
  // resolving the selector to the environment id `buildLinkRow`'s own `environmentId` is keyed
  // on (the same shape as (d)'s other selector-resolution sites), so it is asserted here rather
  // than removed.
  describe('Ruling 28: linkBindings --environment filters by the resolved environment id', () => {
    function boundRow(linkDeviceId: string, environmentId: string) {
      return {
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
      }
    }

    it('a name selector resolves to the environment id and filters the table to that environment only', async () => {
      setup()
      db.putPeerLinkBinding(boundRow('link_env_a', 'env_uuid_a'))
      db.putPeerLinkBinding(boundRow('link_env_b', 'env_uuid_b'))
      const spy = vi
        .spyOn(runtimeEnvironmentStore, 'resolveEnvironment')
        .mockImplementation((_userDataPath: string, selector: string) => {
          if (selector !== 'desktop') {
            throw new Error('no match')
          }
          return { id: 'env_uuid_a' } as never
        })
      try {
        const result = (await call(
          'orchestration.linkBindings',
          { environment: 'desktop' },
          { runtime }
        )) as { links: { linkDeviceId: string }[] }
        expect(result.links.map((l) => l.linkDeviceId)).toEqual(['link_env_a'])
      } finally {
        spy.mockRestore()
      }
    })

    it('an unresolvable selector is a hard refusal, never a filter that silently matches nothing', async () => {
      setup()
      db.putPeerLinkBinding(boundRow('link_env_c', 'env_uuid_c'))
      const spy = vi.spyOn(runtimeEnvironmentStore, 'resolveEnvironment').mockImplementation(() => {
        throw new Error('no match')
      })
      try {
        await expect(
          call('orchestration.linkBindings', { environment: 'ghost' }, { runtime })
        ).rejects.toMatchObject({ code: 'invalid_argument' })
      } finally {
        spy.mockRestore()
      }
    })
  })

  it('R30.3: none of the local verbs are on the peer allowlist', () => {
    for (const method of ORCHESTRATION_LINK_BINDING_LOCAL_METHODS) {
      expect(RUNTIME_PEER_RPC_METHOD_ALLOWLIST.has(method.name)).toBe(false)
    }
  })
})
