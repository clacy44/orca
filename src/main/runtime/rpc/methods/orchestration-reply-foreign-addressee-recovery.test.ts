// F-11 pt.2 (Ruling 32(b)): the "no addressee" reply refusal (orchestration.ts, the
// `original.peer_agent_id == null` branch) recovers the addressee from THIS host's own outbound
// message rows on the same thread when exactly one distinct addressee exists there — never from
// anything the peer supplied. Single-runtime harness (only the local host's own view matters:
// enqueueForeignReply commits durably and returns before any delivery attempt, so no peer-side
// transport is needed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from '../../device-registry'
import { createLinkBindingSelfView } from '../../device-registry-link-credential'
import { hashCallerCredential } from '../../principal-link-fingerprint-binding'
import { fingerprintOrchestrationPeer } from '../../orchestration/environment-transport'
import { addEnvironmentFromPairingCode } from '../../../../shared/runtime-environment-store'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { OrchestrationError } from '../../orchestration/orchestration-error'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

// F-8 strict caller refusal (Ruling 32 Addendum 3(c), item 2): the reply path this file
// exercises now refuses BEFORE reaching the addressee-recovery hunk (F-11 pt.2) unless the
// caller is attested and registered — every call below must carry a real, registered caller
// identity or it refuses no_pane_identity/no_registered_identity before recovery ever runs.
const REPLIER_PANE = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REPLIER_TERMINAL_HANDLE = 'term_replier'

function method(name: string) {
  const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
  if (!found) {
    throw new Error(`method not found: ${name}`)
  }
  return found
}

async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
  const m = method(name)
  const parsed = m.params ? m.params.parse(params) : undefined
  return m.handler(parsed, context)
}

function replierEvidence() {
  return { terminalHandle: REPLIER_TERMINAL_HANDLE, paneKey: REPLIER_PANE }
}

const LOCAL_ADDRESSEE_AGENT_ID = 'agt_local_addressee'

describe('F-11 pt.2: no-addressee reply refusal recovers from own outbound rows', () => {
  let root: string
  let dataPath: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let linkDeviceId: string
  let environmentId: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-reply-addressee-recovery-'))
    dataPath = join(root, 'h-userdata')
    appState.userData = dataPath

    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    const registry = new DeviceRegistry(dataPath)
    const link = registry.mintPendingDevice('p-host', 'runtime')
    registry.updateLastSeen(link.deviceId)
    linkDeviceId = link.deviceId
    runtime.setLinkBindingSelfView(createLinkBindingSelfView(registry, () => 'h_own_pubkey_b64'))

    const pEndpointOffer = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://p.example:16768',
      deviceToken: 'p_endpoint_token',
      publicKeyB64: 'p_own_pubkey_b64'
    })
    const pEnv = addEnvironmentFromPairingCode(dataPath, {
      name: 'p-environment',
      pairingCode: pEndpointOffer
    })
    environmentId = pEnv.id

    db.putPeerLinkBinding({
      linkDeviceId,
      environmentId: pEnv.id,
      boundEndpointId: pEnv.preferredEndpointId,
      boundPairingRevision: pEnv.pairingRevision ?? pEnv.createdAt,
      linkCredentialFp: hashCallerCredential(link.token),
      peerCredentialFp: hashCallerCredential('p_endpoint_token'),
      peerKeyFingerprint: fingerprintOrchestrationPeer('p_own_pubkey_b64'),
      grantClass: 'minted',
      scanCompleteness: 'complete',
      proofProtocol: 'orca.link-binding.v1',
      provedAt: Date.now(),
      lastVerifiedAt: Date.now()
    })

    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: pEnv.id,
      name: 'p-environment',
      peerFingerprint: 'p_fp'
    })

    // F-8 (item 2): every reply call below now needs an attested, registered caller before it
    // ever reaches the addressee-recovery hunk this file actually tests.
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation(
      (evidence): OrchestrationCompatibilityCallerAuthority | null => {
        if (
          (evidence as { terminalHandle?: string; paneKey?: string } | null)?.paneKey ===
          REPLIER_PANE
        ) {
          return {
            hostScope: { kind: 'local', hostId: 'local' },
            paneKey: REPLIER_PANE,
            terminalHandle: REPLIER_TERMINAL_HANDLE,
            processIncarnation: 'proc-1',
            launchTokenHash: 'hash'
          }
        }
        return null
      }
    )
    await call(
      'orchestration.agents.register',
      { name: 'replier', role: 'test agent' },
      { runtime, orchestrationCompatibilityEvidence: replierEvidence() }
    )
  })

  afterEach(() => {
    runtime.replyOutbox?.stop()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  // Inserts the foreign-origin row this host would refuse "no addressee" on: imported over the
  // link, sender identity unverified (peerAgentId null).
  function insertUnverifiedForeignRow(threadId: string) {
    const inserted = db.insertGatedMessage({
      from: `remote:${linkDeviceId}:unverified`,
      to: `agent:${LOCAL_ADDRESSEE_AGENT_ID}`,
      subject: 'hello',
      body: 'hello from the peer',
      threadId,
      runId: 'peer_run',
      verb: 'federation_import',
      peerLinkDeviceId: linkDeviceId,
      peerAgentId: null,
      peerThreadId: 'peer_thread_1'
    })
    if (inserted.outcome === 'refused') {
      throw new Error('setup: unverified foreign row was refused')
    }
    return inserted.message
  }

  // Inserts a row this host itself sent outbound to `addressee` over the same link/thread —
  // local evidence only, never a peer-supplied field.
  function insertOwnOutboundRow(threadId: string, addressee: string) {
    const inserted = db.insertGatedMessage({
      from: `agent:${LOCAL_ADDRESSEE_AGENT_ID}`,
      to: `remote:${environmentId}:${addressee}`,
      subject: 'earlier send',
      body: 'earlier send to the peer',
      threadId,
      runId: 'peer_run',
      verb: 'send',
      peerAgentId: addressee
    })
    if (inserted.outcome === 'refused') {
      throw new Error('setup: own outbound row was refused')
    }
    return inserted.message
  }

  it('recovers and enqueues when exactly one own outbound addressee exists on the thread', async () => {
    const threadId = 'thr_recovery_one'
    insertOwnOutboundRow(threadId, 'agt_peer_addressee')
    const foreign = insertUnverifiedForeignRow(threadId)

    const result = (await call(
      'orchestration.reply',
      { id: foreign.id, body: 'reply body' },
      { runtime, orchestrationCompatibilityEvidence: replierEvidence() }
    )) as { relay: { state: string; environment: string } }

    expect(result.relay.state).toBe('queued')
    expect(result.relay.environment).toBe('p-environment')
  })

  it('still refuses "no addressee" when there are zero own outbound rows on the thread', async () => {
    const threadId = 'thr_recovery_zero'
    const foreign = insertUnverifiedForeignRow(threadId)

    await expect(
      call(
        'orchestration.reply',
        { id: foreign.id, body: 'reply body' },
        { runtime, orchestrationCompatibilityEvidence: replierEvidence() }
      )
    ).rejects.toMatchObject({ code: 'no_return_route' } satisfies Partial<OrchestrationError>)
  })

  it('still refuses "no addressee" when own outbound rows disagree on the addressee', async () => {
    const threadId = 'thr_recovery_two'
    insertOwnOutboundRow(threadId, 'agt_peer_addressee_a')
    insertOwnOutboundRow(threadId, 'agt_peer_addressee_b')
    const foreign = insertUnverifiedForeignRow(threadId)

    await expect(
      call(
        'orchestration.reply',
        { id: foreign.id, body: 'reply body' },
        { runtime, orchestrationCompatibilityEvidence: replierEvidence() }
      )
    ).rejects.toMatchObject({ code: 'no_return_route' } satisfies Partial<OrchestrationError>)
  })
})
