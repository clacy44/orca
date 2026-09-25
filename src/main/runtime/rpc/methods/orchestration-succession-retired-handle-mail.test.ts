// [S10-22a Wave 2 contract, D-R215 §Protocol step 6 A3; G1-10z attempt-2 N2 repair] End-to-end
// proof that the retired-handle -> agent:<id> rewrite happens in the RPC address-resolution
// block (send, reply, peer-question), BEFORE the display-name/getTerminalPaneKey gate, the C4
// attested-sender checks, and the wake — not in the choke (message-gate-writer.ts), which ran
// too late to enforce either. Real handles are minted as `term_${randomUUID()}` (orca-runtime.ts
// issueHandle/issuePtyHandle) — 41 chars with an underscore, so they never match
// DISPLAY_NAME_PATTERN. A rewrite gated on that pattern (attempt-2 N2) never fires for a real
// retired handle; only a display-name-shaped fixture (kept below as a control) would pass.
// Mirrors orchestration-bare-name-send.test.ts's fixture shape.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import {
  _resetRetiredHandlesIndexForTest,
  refreshRetiredHandlesIndexSync
} from '../../orchestration/chair-succession-retired-index'

const DISPLAY_NAME_RETIRED_HANDLE = 'chair-succ-incumbent-handle'
const REAL_RETIRED_HANDLE = `term_${randomUUID()}`
const RETIRED_HANDLE = DISPLAY_NAME_RETIRED_HANDLE
const CHAIR_NAME = 'chair-succ'

describe('B7 repair: retired-handle resolution runs in the RPC address-resolution block (not the choke)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let orcaHome: string
  let cleanupOrcaHome: () => Promise<void>

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function writeRetiredHandlesFixture(handle: string = RETIRED_HANDLE): Promise<void> {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    orcaHome = await mkdtemp(join(tmpdir(), 'orca-b7-mail-'))
    const chairDir = join(orcaHome, 'chairs', CHAIR_NAME)
    await mkdir(chairDir, { recursive: true })
    await writeFile(
      join(chairDir, 'retired-handles.json'),
      JSON.stringify([{ handle, succession: 'succ_test000001', at: '2026-01-01T00:00:00Z' }])
    )
    refreshRetiredHandlesIndexSync(orcaHome)
    cleanupOrcaHome = async () => {
      const { rm } = await import('node:fs/promises')
      await rm(orcaHome, { recursive: true, force: true })
    }
  }

  async function setup(): Promise<{
    callerHandle: string
    callerPaneKey: string
    successorPaneKey: string
    successorAgentId: string
  }> {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-caller',
          worktreeId: 'repo-1::/tmp/wa',
          title: 'Claude',
          activeLeafId: 'pane:caller',
          layout: null
        },
        {
          tabId: 'tab-successor',
          worktreeId: 'repo-1::/tmp/wa',
          title: 'Claude',
          activeLeafId: 'pane:successor',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-caller',
          worktreeId: 'repo-1::/tmp/wa',
          leafId: 'pane:caller',
          paneRuntimeId: 1,
          ptyId: 'pty-caller',
          paneTitle: null
        },
        {
          tabId: 'tab-successor',
          worktreeId: 'repo-1::/tmp/wa',
          leafId: 'pane:successor',
          paneRuntimeId: 2,
          ptyId: 'pty-successor',
          paneTitle: null
        }
      ]
    })
    const { terminals } = await runtime.listTerminals()
    const caller = terminals.find((t) => t.tabId === 'tab-caller')
    const successor = terminals.find((t) => t.tabId === 'tab-successor')
    if (!caller || !successor) {
      throw new Error('fixture setup failed: expected two live terminals')
    }
    const callerPaneKey = `${caller.tabId}:${caller.leafId}`
    const successorPaneKey = `${successor.tabId}:${successor.leafId}`
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === caller.handle) {
        return callerPaneKey
      }
      if (handle === successor.handle) {
        return successorPaneKey
      }
      return null
    })

    // The successor's agent row — same shape a confirmed dead-pane takeover leaves: display
    // name is the CHAIR NAME (never the retired handle), bound to the successor's live pane.
    const successorAgent = db.upsertAgentByPaneSuffix({
      displayName: CHAIR_NAME,
      role: null,
      hostId: 'local',
      paneKey: successorPaneKey,
      terminalHandle: successor.handle,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: successor.handle,
      originHostId: 'local'
    })
    if (successorAgent.outcome === 'name_taken') {
      throw new Error('fixture setup failed: name_taken')
    }

    const callerAgent = db.upsertAgentByPaneSuffix({
      displayName: 'caller-agent',
      role: null,
      hostId: 'local',
      paneKey: callerPaneKey,
      terminalHandle: caller.handle,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: caller.handle,
      originHostId: 'local'
    })
    if (callerAgent.outcome === 'name_taken') {
      throw new Error('fixture setup failed: name_taken')
    }

    const callerEvidence = {
      terminalHandle: caller.handle,
      paneKey: callerPaneKey,
      launchToken: 'token-caller'
    }
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === callerEvidence.terminalHandle &&
        evidence.paneKey === callerEvidence.paneKey &&
        evidence.launchToken
      ) {
        return {
          hostScope: { kind: 'local', hostId: 'local' },
          paneKey: callerPaneKey,
          terminalHandle: caller.handle,
          processIncarnation: 'proc-1',
          launchTokenHash: 'hash'
        }
      }
      return null
    })

    return {
      callerHandle: caller.handle,
      callerPaneKey,
      successorPaneKey,
      successorAgentId: successorAgent.agent.id
    }
  }

  afterEach(async () => {
    db?.close()
    _resetRetiredHandlesIndexForTest()
    await cleanupOrcaHome?.()
  })

  it.each([
    ['positive control: display-name-shaped retired handle', DISPLAY_NAME_RETIRED_HANDLE],
    ['real term_<uuid> retired handle (attempt-2 N2)', REAL_RETIRED_HANDLE]
  ])(
    'send: a `to` matching a retired chair handle (%s) resolves to agent:<successor>, runs C4 sender attestation, and wakes a REAL parked waiter',
    async (_label, retiredHandle) => {
      await writeRetiredHandlesFixture(retiredHandle)
      const { callerHandle, callerPaneKey, successorPaneKey, successorAgentId } = await setup()

      // A REAL parked waiter — not a spy on notifyMessageArrived — proves the resolved handle
      // is the one the send path actually wakes (p2).
      const waiting = runtime.waitForMessage(`agent:${successorAgentId}`, {
        typeFilter: ['status'],
        timeoutMs: 5_000
      })

      const ctx: RpcContext = {
        runtime,
        orchestrationCompatibilityEvidence: {
          terminalHandle: callerHandle,
          paneKey: callerPaneKey,
          launchToken: 'token-caller'
        }
      } as RpcContext

      const m = method('orchestration.send')
      const sent = (await m.handler(
        m.params!.parse({
          from: callerHandle,
          to: retiredHandle,
          subject: 'status after succession'
        }),
        ctx
      )) as { message: { id: string } }

      const stored = db.getMessageById(sent.message.id)
      // B7/N2: the row lands in agent:<id>, not the stale retired handle.
      expect(stored?.to_handle).toBe(`agent:${successorAgentId}`)
      expect(stored?.recipient_pane_key).toBe(successorPaneKey)
      // C4: the sender's real directory identity was stamped (attested, not the choke's bare from).
      expect(stored?.sender_agent_id).not.toBeNull()

      // The real waiter parked on the resolved `agent:<successorAgentId>` handle actually wakes.
      const result = await waiting
      expect(result).toBe('notified')
    }
  )

  it('send: a forged --from against a retired-handle target is refused forbidden (proves C4 ran, not skipped)', async () => {
    await writeRetiredHandlesFixture()
    const { callerHandle, callerPaneKey } = await setup()

    const ctx: RpcContext = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: callerHandle,
        paneKey: callerPaneKey,
        launchToken: 'token-caller'
      }
    } as RpcContext

    const m = method('orchestration.send')
    await expect(
      m.handler(
        m.params!.parse({
          from: 'someone-else',
          to: RETIRED_HANDLE,
          subject: 'forged'
        }),
        ctx
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('reply: a message addressed FROM a retired chair handle resolves the reply target to agent:<successor> and wakes it', async () => {
    await writeRetiredHandlesFixture()
    const { callerHandle, callerPaneKey, successorAgentId } = await setup()

    // A message left behind by the now-retired incumbent (its `to`/thread predates succession).
    const originalInsert = db.insertGatedMessage({
      from: RETIRED_HANDLE,
      to: callerHandle,
      subject: 'pre-succession question',
      body: 'what is the status?',
      runId: 'run_peer_local',
      verb: 'send'
    })
    if (originalInsert.outcome !== 'stored') {
      throw new Error('fixture setup failed: original message refused')
    }

    const wakeSpy = vi.spyOn(runtime, 'notifyMessageArrived')

    const ctx: RpcContext = {
      runtime,
      orchestrationCompatibilityEvidence: {
        terminalHandle: callerHandle,
        paneKey: callerPaneKey,
        launchToken: 'token-caller'
      }
    } as RpcContext

    const m = method('orchestration.reply')
    const replied = (await m.handler(
      m.params!.parse({
        id: originalInsert.message.id,
        body: 'here is the status'
      }),
      ctx
    )) as { message: { id: string } }

    const stored = db.getMessageById(replied.message.id)
    expect(stored?.to_handle).toBe(`agent:${successorAgentId}`)
    expect(wakeSpy).toHaveBeenCalledWith(
      `agent:${successorAgentId}`,
      'status',
      expect.any(String),
      null
    )
  })
})
