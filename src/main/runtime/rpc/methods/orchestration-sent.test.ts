import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { makePaneKey } from '../../../../shared/stable-pane-id'

function request(id: string, method: string, params: Record<string, unknown>): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    method,
    params
  }
}

describe('orchestration.sent (BUG 3)', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined
  let dispatcher: RpcDispatcher

  function setup(deps?: ConstructorParameters<typeof OrcaRuntimeService>[2]): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(undefined, undefined, deps)
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  }

  afterEach(() => {
    db?.close()
    db = undefined
    runtime = undefined
  })

  it('reports queued for a message sent to a peer with no live terminal', async () => {
    setup()
    const message = db!.insertMessage({ from: 'term_a', to: 'term_ghost', subject: 'hi' })

    const response = await dispatcher.dispatch(
      request('sent-1', 'orchestration.sent', { id: message.id })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        delivery: {
          state: 'queued',
          recipient: { state: 'unresolved', lastSeenAt: null }
        }
      }
    })
  })

  it('reports read once the recipient marks it read', async () => {
    setup()
    const message = db!.insertMessage({ from: 'term_a', to: 'term_b', subject: 'hi' })
    db!.markAsRead([message.id])

    const response = await dispatcher.dispatch(
      request('sent-2', 'orchestration.sent', { id: message.id })
    )

    expect(response).toMatchObject({ ok: true, result: { delivery: { state: 'read' } } })
  })

  it('rejects an unknown message id', async () => {
    setup()

    const response = await dispatcher.dispatch(
      request('sent-3', 'orchestration.sent', { id: 'msg_missing' })
    )

    expect(response).toMatchObject({ ok: false })
  })

  // S10-11 R4: a message relayed cross-host (relayPeerAskToHost) mints its id on the TARGET
  // host's own store — this host never has a row for it. That must read as a typed, actionable
  // hint (retry with --environment <peer>), never the bare "Message not found" a raw Error gave.
  it('R4: an unknown message id answers a typed message_not_found hint naming --environment, not a bare "not found"', async () => {
    setup()

    const response = await dispatcher.dispatch(
      request('sent-cross-host', 'orchestration.sent', { id: 'msg_on_a_peer' })
    )

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'message_not_found',
        data: {
          nextSteps: expect.arrayContaining([expect.stringContaining('--environment')])
        }
      }
    })
  })

  // RPC-level integration (S10-0 review minor): drives the real ambient-push machinery
  // (deliverPendingMessagesForHandle against a live, idle leaf) rather than asserting on
  // runtime-private state directly, and reads the result back through the actual
  // `orchestration.sent` RPC handler — the same path a real CLI/RPC caller uses.
  it('reports pointed once deliverPendingMessagesForHandle writes into a live idle leaf', async () => {
    setup()
    const write = vi.fn().mockReturnValue(true)
    runtime!.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    } as never)
    runtime!.attachWindow(1)
    runtime!.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    const [terminal] = (await runtime!.listTerminals()).terminals
    // Why two frames: `lastAgentStatusObservedLive` only flips true once a live PTY frame is
    // actually observed — an idle-from-birth leaf reads as a cold restore, not a push-eligible one.
    runtime!.onPtyData('pty-1', ']0;Codex working', 100)
    runtime!.onPtyData('pty-1', ']0;Codex done', 101)

    const message = db!.insertMessage({ from: 'term_a', to: terminal.handle, subject: 'ping' })
    const preResponse = await dispatcher.dispatch(
      request('sent-pre', 'orchestration.sent', { id: message.id })
    )
    expect(preResponse).toMatchObject({ ok: true, result: { delivery: { state: 'queued' } } })

    runtime!.deliverPendingMessagesForHandle(terminal.handle)
    expect(write).toHaveBeenCalled()

    const response = await dispatcher.dispatch(
      request('sent-pointed', 'orchestration.sent', { id: message.id })
    )

    expect(response).toMatchObject({ ok: true, result: { delivery: { state: 'pointed' } } })
    // Still unread — pointed is "written into the pane", not "read by the recipient".
    expect(db!.getMessageById(message.id)?.read).toBe(0)
  })

  // S10-11 R4/T1: agent:<id> mail must resolve through the same mailbox mapping the push path
  // uses, not read to_handle as a literal terminal handle.
  it('resolves the recipient for agent:<id> mail the same as the bare handle it maps to', async () => {
    setup()
    const write = vi.fn().mockReturnValue(true)
    runtime!.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => null
    } as never)
    runtime!.attachWindow(1)
    const leafId = '44444444-4444-4444-8444-444444444444'
    runtime!.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    const [terminal] = (await runtime!.listTerminals()).terminals
    runtime!.onPtyData('pty-1', ']0;Codex working', 100)
    runtime!.onPtyData('pty-1', ']0;Codex done', 101)

    const agent = db!.upsertAgentByPaneSuffix({
      displayName: 'agent-a',
      role: null,
      hostId: 'local',
      paneKey: makePaneKey('tab-1', leafId),
      terminalHandle: terminal.handle,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: terminal.handle,
      originHostId: 'local'
    })
    const agentId = agent.outcome === 'created' ? agent.agent.id : ''

    const bareMessage = db!.insertMessage({ from: 'peer', to: terminal.handle, subject: 'bare' })
    const agentMessage = db!.insertMessage({
      from: 'peer',
      to: `agent:${agentId}`,
      subject: 'via id'
    })

    const bareResponse = await dispatcher.dispatch(
      request('sent-bare', 'orchestration.sent', { id: bareMessage.id })
    )
    const agentResponse = await dispatcher.dispatch(
      request('sent-agent', 'orchestration.sent', { id: agentMessage.id })
    )

    expect(agentResponse).toMatchObject({
      ok: true,
      result: { delivery: { state: 'queued', recipient: { state: 'connected' } } }
    })
    type SentResult = { result: { delivery: { recipient: { lastSeenAt: number | null } } } }
    expect((agentResponse as SentResult).result.delivery.recipient.lastSeenAt).not.toBeNull()
    // Same underlying leaf, same recipient presence either way it is addressed.
    expect((agentResponse as SentResult).result.delivery.recipient).toEqual(
      (bareResponse as SentResult).result.delivery.recipient
    )
  })

  // S10-9 R4: 'queued' must not read the same before and after an actual push attempt was
  // withheld — this is the honest-receipts distinction the sender-side `orchestration sent`
  // surface exists for.
  it('reports queued_awaiting_pane once an actual push attempt is withheld by the delivery gate', async () => {
    const leafId = '33333333-3333-4333-8333-333333333333'
    const paneKey = makePaneKey('tab-1', leafId)
    setup({
      getAgentStatusSnapshot: () => [
        {
          paneKey,
          state: 'working',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a'
        }
      ]
    })
    const write = vi.fn().mockReturnValue(true)
    runtime!.setPtyController({
      write,
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    } as never)
    runtime!.attachWindow(1)
    runtime!.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: null
        }
      ]
    })
    const [terminal] = (await runtime!.listTerminals()).terminals
    // Plain output, never an OSC title — no live title observation this generation at all.
    runtime!.onPtyData('pty-1', 'still working\n', 100)

    const message = db!.insertMessage({ from: 'term_a', to: terminal.handle, subject: 'ping' })
    const preResponse = await dispatcher.dispatch(
      request('sent-pre-withheld', 'orchestration.sent', { id: message.id })
    )
    expect(preResponse).toMatchObject({ ok: true, result: { delivery: { state: 'queued' } } })

    runtime!.deliverPendingMessagesForHandle(terminal.handle)
    expect(write).not.toHaveBeenCalled()

    const response = await dispatcher.dispatch(
      request('sent-withheld', 'orchestration.sent', { id: message.id })
    )
    expect(response).toMatchObject({
      ok: true,
      result: { delivery: { state: 'queued_awaiting_pane' } }
    })
  })
})
