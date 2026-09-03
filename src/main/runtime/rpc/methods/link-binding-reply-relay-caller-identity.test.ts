// F-8 strict caller refusal (Ruling 32 Addendum 3(c)): split out of link-binding-reply-relay.test.ts
// (800-line test-file cap) — a reply to a foreign-origin row (peer_link_device_id set) must
// refuse with the SAME codes the fresh cross-host send path uses (resolveCallerAgent in
// orchestration-caller-identity.ts:57-71, reached from orchestration-peer-send-relay.ts:64) when
// the caller cannot be resolved to a registered agent, rather than falling through to an
// anonymous relay. These tests exercise the refusal in isolation on a single runtime — no
// two-runtime shipping harness is needed since the refusal fires before any routable-binding or
// quarantine check runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import { ORCHESTRATION_METHODS } from './orchestration'
import type { RpcContext } from '../core'

const appState = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => appState.userData } }))

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_UNREGISTERED = 'tabU:uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu'

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

function raw(db: OrchestrationDb) {
  return (
    db as unknown as {
      db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }
    }
  ).db
}

function makeAuthority(
  paneKey: string,
  terminalHandle: string
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

describe('F-8 strict caller refusal: reply to a foreign-origin row', () => {
  let root: string
  let dataPath: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let foreignId: string

  async function registerAgent(
    name: string,
    evidence: { terminalHandle: string; paneKey: string }
  ): Promise<string> {
    const result = (await call(
      'orchestration.agents.register',
      { name, role: 'test agent' },
      { runtime, orchestrationCompatibilityEvidence: evidence }
    )) as { agent: { id: string } }
    return result.agent.id
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-reply-relay-caller-identity-'))
    dataPath = join(root, 'userdata')
    appState.userData = dataPath

    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    // Only PANE_A resolves to an attested caller; PANE_UNREGISTERED is attested but never
    // registered (no agents.register call for it); any other evidence is unattested.
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if ((evidence as { terminalHandle?: string; paneKey?: string } | null)?.paneKey === PANE_A) {
        return makeAuthority(PANE_A, 'term_a')
      }
      if (
        (evidence as { terminalHandle?: string; paneKey?: string } | null)?.paneKey ===
        PANE_UNREGISTERED
      ) {
        return makeAuthority(PANE_UNREGISTERED, 'term_u')
      }
      return null
    })

    const askerId = await registerAgent('asker', { terminalHandle: 'term_a', paneKey: PANE_A })

    foreignId = 'msg_foreign00001'
    db.insertGatedMessage({
      id: foreignId,
      from: 'remote:link_dev_x:remote_agent',
      to: `agent:${askerId}`,
      subject: 'hi from a peer',
      body: 'hi',
      runId: 'run_peer_local',
      verb: 'federation_import',
      peerLinkDeviceId: 'link_dev_x',
      peerAgentId: 'remote_agent',
      threadId: null
    })
  })

  afterEach(() => {
    runtime.replyOutbox?.stop()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses no_pane_identity for an unattested caller, enqueuing nothing', async () => {
    await expect(
      call(
        'orchestration.reply',
        { id: foreignId, body: 'reply from nowhere' },
        {
          runtime,
          orchestrationCompatibilityEvidence: {
            terminalHandle: 'term_ghost',
            paneKey: 'tabG:ghost'
          }
        }
      )
    ).rejects.toMatchObject({ code: 'no_pane_identity' })

    expect(db.listReplyOutbox().length).toBe(0)
    const row = raw(db)
      .prepare('SELECT id FROM messages WHERE from_handle LIKE ?')
      .get('remote:%unverified%')
    expect(row).toBeFalsy()
  })

  it('refuses no_registered_identity for an attested-but-unregistered caller, enqueuing nothing', async () => {
    await expect(
      call(
        'orchestration.reply',
        { id: foreignId, body: 'reply from an unregistered pane' },
        {
          runtime,
          orchestrationCompatibilityEvidence: {
            terminalHandle: 'term_u',
            paneKey: PANE_UNREGISTERED
          }
        }
      )
    ).rejects.toMatchObject({ code: 'no_registered_identity' })

    expect(db.listReplyOutbox().length).toBe(0)
  })
})
