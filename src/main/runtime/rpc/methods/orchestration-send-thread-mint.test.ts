// S10-2b deferral (ruling 8): orchestration.send to agent:<id> with no explicit --thread-id
// mints (or reuses) a peer thread and carries {threadId, threadCreated, gateFlags} back.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

describe('orchestration.send: send-side thread minting', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  const ctx: RpcContext = {} as RpcContext

  function method(name: string) {
    const found = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  // C4 (D-R177 F5) fixture correction: a send whose recipient resolves to an agent: now
  // requires the SENDER to be an attested, registered caller too. This fixture's shared `ctx`
  // never attests anyone; the two thread-minting tests below are about mint/reuse/pin behavior
  // for an otherwise-legitimate sender, so they now attest+register the sender explicitly rather
  // than relying on the (no longer sufficient) directory row alone.
  async function callAttested(
    name: string,
    params: Record<string, unknown>,
    evidence: { terminalHandle: string; paneKey: string; launchToken: string }
  ): Promise<unknown> {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    const attestedCtx: RpcContext = {
      runtime,
      orchestrationCompatibilityEvidence: evidence
    } as RpcContext
    return m.handler(parsed, attestedCtx)
  }

  async function setup(): Promise<{
    senderHandle: string
    senderPaneKey: string
    senderAgentId: string
    recipientAgentId: string
  }> {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-a',
          worktreeId: 'repo-1::/tmp/wa',
          title: 'Claude',
          activeLeafId: 'pane:a',
          layout: null
        },
        {
          tabId: 'tab-b',
          worktreeId: 'repo-1::/tmp/wa',
          title: 'Claude',
          activeLeafId: 'pane:b',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-a',
          worktreeId: 'repo-1::/tmp/wa',
          leafId: 'pane:a',
          paneRuntimeId: 1,
          ptyId: 'pty-a',
          paneTitle: null
        },
        {
          tabId: 'tab-b',
          worktreeId: 'repo-1::/tmp/wa',
          leafId: 'pane:b',
          paneRuntimeId: 2,
          ptyId: 'pty-b',
          paneTitle: null
        }
      ]
    })
    const { terminals } = await runtime.listTerminals()
    const sender = terminals.find((t) => t.tabId === 'tab-a')
    const recipient = terminals.find((t) => t.tabId === 'tab-b')
    if (!sender || !recipient) {
      throw new Error('fixture setup failed: expected two live terminals')
    }
    const senderPaneKey = `${sender.tabId}:${sender.leafId}`
    const recipientPaneKey = `${recipient.tabId}:${recipient.leafId}`
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === sender.handle) {
        return senderPaneKey
      }
      if (handle === recipient.handle) {
        return recipientPaneKey
      }
      return null
    })

    const senderAgent = db.upsertAgentByPaneSuffix({
      displayName: 'sender-agent',
      role: null,
      hostId: 'local',
      paneKey: senderPaneKey,
      terminalHandle: sender.handle,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: sender.handle,
      originHostId: 'local'
    })
    const recipientAgent = db.upsertAgentByPaneSuffix({
      displayName: 'recipient-agent',
      role: null,
      hostId: 'local',
      paneKey: recipientPaneKey,
      terminalHandle: recipient.handle,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: recipient.handle,
      originHostId: 'local'
    })
    if (senderAgent.outcome === 'name_taken' || recipientAgent.outcome === 'name_taken') {
      throw new Error('fixture setup failed: name_taken')
    }
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (evidence?.terminalHandle === sender.handle && evidence.paneKey === senderPaneKey) {
        return {
          hostScope: { kind: 'local', hostId: 'local' },
          paneKey: senderPaneKey,
          terminalHandle: sender.handle,
          processIncarnation: 'proc-1',
          launchTokenHash: 'hash'
        }
      }
      return null
    })

    return {
      senderHandle: sender.handle,
      senderPaneKey,
      senderAgentId: senderAgent.agent.id,
      recipientAgentId: recipientAgent.agent.id
    }
  }

  afterEach(() => {
    db?.close()
  })

  it('mints a thread on the first agent:<id> send with no --thread-id, and reuses it on the second', async () => {
    const { senderHandle, senderPaneKey, senderAgentId, recipientAgentId } = await setup()
    const senderEvidence = {
      terminalHandle: senderHandle,
      paneKey: senderPaneKey,
      launchToken: 'token-sender'
    }

    const first = (await callAttested(
      'orchestration.send',
      {
        from: senderHandle,
        to: `agent:${recipientAgentId}`,
        subject: 'hello'
      },
      senderEvidence
    )) as { message: { id: string }; threadId: string; threadCreated: boolean }
    expect(first.threadId).toBeTruthy()
    expect(first.threadCreated).toBe(true)
    expect(db.isThreadParticipant(first.threadId, senderAgentId)).toBe(true)
    expect(db.isThreadParticipant(first.threadId, recipientAgentId)).toBe(true)
    expect(db.getMessageById(first.message.id)?.thread_id).toBe(first.threadId)

    const second = (await callAttested(
      'orchestration.send',
      {
        from: senderHandle,
        to: `agent:${recipientAgentId}`,
        subject: 'hello again'
      },
      senderEvidence
    )) as { threadId: string; threadCreated: boolean }
    expect(second.threadId).toBe(first.threadId)
    expect(second.threadCreated).toBe(false)
  })

  it('an explicit --thread-id is never overridden by minting', async () => {
    const { senderHandle, senderPaneKey, senderAgentId, recipientAgentId } = await setup()
    const { thread } = db.createThread({
      subject: 'explicit',
      createdByAgentId: senderAgentId,
      participants: [
        { participantKey: senderAgentId, agentId: senderAgentId },
        { participantKey: recipientAgentId, agentId: recipientAgentId }
      ]
    })
    const result = (await callAttested(
      'orchestration.send',
      {
        from: senderHandle,
        to: `agent:${recipientAgentId}`,
        subject: 'hi',
        threadId: thread.id
      },
      { terminalHandle: senderHandle, paneKey: senderPaneKey, launchToken: 'token-sender' }
    )) as { threadId: string; threadCreated: boolean }
    expect(result.threadId).toBe(thread.id)
    expect(result.threadCreated).toBe(false)
  })

  // SCENARIO_CORRECTION (C4/D-R177 F5, not named in brief b1b — flagged for chair review): this
  // test's SUBJECT was that an unregistered, unattested sender's send to an agent: recipient is
  // ACCEPTED (just without a fabricated thread participant) — exactly the pre-C4 hole C4 closes
  // (mirrored by orchestration-send-local-caller-identity.test.ts's "unattested local send to
  // agent → refused, zero rows" case). Updated to assert the new fail-closed refusal rather than
  // silently keep asserting the superseded permissive behavior.
  it('an unregistered sender (no directory row) is refused before any thread or message is created', async () => {
    const { recipientAgentId } = await setup()
    await expect(
      call('orchestration.send', {
        from: 'term_unregistered',
        to: `agent:${recipientAgentId}`,
        subject: 'anonymous'
      })
    ).rejects.toMatchObject({ code: 'no_pane_identity' })
  })
})
