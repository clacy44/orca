// Series 3, item 4: `messages.sender_agent_id` is author provenance (S10-3 purge/quarantine
// target) and must be populated from the caller's directory row on EVERY send — point-to-point
// AND the group-address fan-out, which used to skip it (senderAgentId was computed only inside
// the point-to-point branch).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

describe('messages.sender_agent_id populated on every send', () => {
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

  async function call(name: string, params: Record<string, unknown>) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, ctx)
  }

  async function setup(): Promise<{
    senderHandle: string
    recipientHandle: string
    senderAgentId: string
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
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:a',
          layout: null
        },
        {
          tabId: 'tab-b',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:b',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-a',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:a',
          paneRuntimeId: 1,
          ptyId: 'pty-a',
          paneTitle: null
        },
        {
          tabId: 'tab-b',
          worktreeId: 'repo-1::/tmp/worktree-a',
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
    // Why a stubbed pane-key resolver and not the real one: this test only needs a stable,
    // known pane key to register the sender's directory row against — the real graph-to-pane-key
    // resolution path is covered elsewhere (R1-R5).
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === sender.handle ? senderPaneKey : null
    )

    const created = db.upsertAgentByPaneSuffix({
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
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed: name_taken')
    }
    return {
      senderHandle: sender.handle,
      recipientHandle: recipient.handle,
      senderAgentId: created.agent.id
    }
  }

  afterEach(() => {
    db?.close()
  })

  it('point-to-point send stamps the sender directory row id', async () => {
    const { senderHandle, recipientHandle, senderAgentId } = await setup()

    const result = (await call('orchestration.send', {
      from: senderHandle,
      to: recipientHandle,
      subject: 'point to point'
    })) as { message: { id: string } }

    expect(db.getMessageById(result.message.id)?.sender_agent_id).toBe(senderAgentId)
  })

  // MUTATION PROOF: before this fix, `senderAgentId` was computed only inside the
  // point-to-point branch — a group-address send (@all, @idle, ...) never reached that code and
  // every fanned-out row's sender_agent_id stayed NULL. Reverting the hoist that moved the
  // computation above the isGroupAddress branch reproduces that gap and fails this assertion.
  it('a group-address (@all) fan-out ALSO stamps the sender directory row id on every recipient row', async () => {
    const { senderHandle, senderAgentId } = await setup()

    const result = (await call('orchestration.send', {
      from: senderHandle,
      to: '@all',
      subject: 'broadcast'
    })) as { messages: { id: string }[]; recipients: number }

    expect(result.recipients).toBeGreaterThan(0)
    for (const message of result.messages) {
      expect(db.getMessageById(message.id)?.sender_agent_id).toBe(senderAgentId)
    }
  })

  it('an unregistered sender leaves sender_agent_id null (no fabricated provenance)', async () => {
    const { recipientHandle } = await setup()

    const result = (await call('orchestration.send', {
      from: 'term_unregistered',
      to: recipientHandle,
      subject: 'no directory row'
    })) as { message: { id: string } }

    expect(db.getMessageById(result.message.id)?.sender_agent_id).toBeNull()
  })

  // MUTATION PROOF (adversarial review S10-2b major #3): a quarantined sender's row must STILL
  // be stamped with its real sender_agent_id — the S10-2b original nulled it here, which reads
  // like containment but is the opposite: message-visibility-filter.ts's live-read predicate
  // only withholds a row when sender_agent_id resolves to a currently-quarantined agent, so a
  // nulled column made every post-quarantine send from that sender pass the withholding filter
  // instead of being caught by it (quarantine held for the past, never for the future).
  // Reverting to nulling here reproduces that gap. The CONTAINMENT #7 pane-name concern this
  // used to cite is handled independently, at render time, by orca-runtime.ts's
  // resolveSenderAgent callback re-checking `agent.quarantined === 1`.
  it('a quarantined sender still gets sender_agent_id stamped with its real directory row id', async () => {
    const { senderHandle, recipientHandle, senderAgentId } = await setup()
    db.setAgentQuarantine({ id: senderAgentId, quarantined: true, reasonCode: 'flagged' })

    const result = (await call('orchestration.send', {
      from: senderHandle,
      to: recipientHandle,
      subject: 'still talking while quarantined'
    })) as { message: { id: string } }

    expect(db.getMessageById(result.message.id)?.sender_agent_id).toBe(senderAgentId)
  })

  // MUTATION PROOF (adversarial review S10-2b major #3, LIVE PROBE E): the whole point of
  // stamping through quarantine is that the live-read withholding filter (getUnreadMessages /
  // orchestration.check, message-visibility-filter.ts) then actually catches every send made
  // AFTER quarantine, not just the ones made before it. Nulling sender_agent_id on the
  // quarantined branch (or any regression that stops stamping it) makes this delivered instead
  // of withheld.
  it('quarantine withholds a message sent to another pane AFTER the sender was quarantined', async () => {
    const { senderHandle, recipientHandle, senderAgentId } = await setup()

    await call('orchestration.send', {
      from: senderHandle,
      to: recipientHandle,
      subject: 'before',
      body: 'BEFORE-BODY'
    })
    db.setAgentQuarantine({ id: senderAgentId, quarantined: true, reasonCode: 'flagged' })
    await call('orchestration.send', {
      from: senderHandle,
      to: recipientHandle,
      subject: 'after',
      body: 'AFTER-BODY'
    })

    const unread = db.getUnreadMessages(recipientHandle)
    expect(unread.map((m) => m.subject)).toEqual([])
    expect(unread.map((m) => m.body)).toEqual([])
  })
})
