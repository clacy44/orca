// Ruling 32 Addendum 10 (A1/A2, F-5b): a bare display name addressed with `orchestration.send
// --to <name>` used to store `to_handle` as the literal name whenever the name resolved in the
// LOCAL directory — no `agent:` binding, no recipient_pane_key, no thread, no wake — because no
// read path ever scans a bare-name mailbox. This binds the name to the agent's mailbox at send
// time instead, mirroring an explicit `agent:<id>` target.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'

describe('orchestration.send: bare display-name resolution (Ruling 32 Addendum 10 A1/A2)', () => {
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

  async function setup(): Promise<{
    callerHandle: string
    callerPaneKey: string
    alphaPaneKey: string
    alphaAgentId: string
  }> {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime

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
          tabId: 'tab-alpha',
          worktreeId: 'repo-1::/tmp/wa',
          title: 'Claude',
          activeLeafId: 'pane:alpha',
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
          tabId: 'tab-alpha',
          worktreeId: 'repo-1::/tmp/wa',
          leafId: 'pane:alpha',
          paneRuntimeId: 2,
          ptyId: 'pty-alpha',
          paneTitle: null
        }
      ]
    })
    const { terminals } = await runtime.listTerminals()
    const caller = terminals.find((t) => t.tabId === 'tab-caller')
    const alpha = terminals.find((t) => t.tabId === 'tab-alpha')
    if (!caller || !alpha) {
      throw new Error('fixture setup failed: expected two live terminals')
    }
    const callerPaneKey = `${caller.tabId}:${caller.leafId}`
    const alphaPaneKey = `${alpha.tabId}:${alpha.leafId}`
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === caller.handle) {
        return callerPaneKey
      }
      if (handle === alpha.handle) {
        return alphaPaneKey
      }
      return null
    })

    const alphaAgent = db.upsertAgentByPaneSuffix({
      displayName: 'alpha',
      role: null,
      hostId: 'local',
      paneKey: alphaPaneKey,
      terminalHandle: alpha.handle,
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: alpha.handle,
      originHostId: 'local'
    })
    if (alphaAgent.outcome === 'name_taken') {
      throw new Error('fixture setup failed: name_taken')
    }
    return {
      callerHandle: caller.handle,
      callerPaneKey,
      alphaPaneKey,
      alphaAgentId: alphaAgent.agent.id
    }
  }

  afterEach(() => {
    db?.close()
  })

  it('T-A1: a bare display name that resolves locally binds pane key + thread; check as that agent returns it', async () => {
    const { callerHandle, alphaPaneKey, alphaAgentId } = await setup()

    const sent = (await call('orchestration.send', {
      from: callerHandle,
      to: 'alpha',
      subject: 'hello alpha'
    })) as { message: { id: string }; threadId?: string; threadCreated?: boolean }

    const stored = db.getMessageById(sent.message.id)
    expect(stored?.to_handle).toBe(`agent:${alphaAgentId}`)
    expect(stored?.recipient_pane_key).toBe(alphaPaneKey)

    const checked = (await call('orchestration.check', {
      terminal: `agent:${alphaAgentId}`
    })) as { messages: { subject: string }[]; count: number }
    expect(checked.count).toBe(1)
    expect(checked.messages.map((m) => m.subject)).toEqual(['hello alpha'])
  })

  it('T-A2: a quarantined name-holder refuses agent_quarantined instead of storing a silent bare row', async () => {
    const { callerHandle, alphaAgentId } = await setup()
    db.setAgentQuarantine({ id: alphaAgentId, quarantined: true, reasonCode: 'test' })

    await expect(
      call('orchestration.send', { from: callerHandle, to: 'alpha', subject: 'hello' })
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  it('T-A5 (Ruling 32 Addendum 13): a peer caller sending --to <bare registered name> is refused forbidden before the name ever resolves', async () => {
    await setup()
    const getAgentByNameSpy = vi.spyOn(db, 'getAgentByName')

    const ctx: RpcContext = {
      runtime,
      accessProfile: 'peer',
      pairedDeviceId: 'dev_peer_1',
      clientKind: 'runtime',
      authenticatedCallerFingerprint: 'peer_fp_1',
      orchestrationMutation: {
        callerFingerprint: 'peer_fp_1',
        requestId: 'request_peer_bare_name',
        method: 'orchestration.send',
        payloadHash: 'payload_peer_bare_name'
      }
    } as RpcContext

    const m = method('orchestration.send')
    const parsed = m.params!.parse({
      to: 'alpha',
      subject: 'hi peer',
      remoteRunMailbox: true
    })
    await expect(m.handler(parsed, ctx)).rejects.toMatchObject({ code: 'forbidden' })
    expect(getAgentByNameSpy).not.toHaveBeenCalled()
  })

  it('T-A3 (no regression): a live terminal handle that is not a registered name is still stored bare, with its live pane key', async () => {
    const { callerHandle } = await setup()
    // A third, unregistered-but-live terminal: worker-one.
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
          tabId: 'tab-alpha',
          worktreeId: 'repo-1::/tmp/wa',
          title: 'Claude',
          activeLeafId: 'pane:alpha',
          layout: null
        },
        {
          tabId: 'tab-worker-one',
          worktreeId: 'repo-1::/tmp/wa',
          title: 'Claude',
          activeLeafId: 'pane:worker-one',
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
          tabId: 'tab-alpha',
          worktreeId: 'repo-1::/tmp/wa',
          leafId: 'pane:alpha',
          paneRuntimeId: 2,
          ptyId: 'pty-alpha',
          paneTitle: null
        },
        {
          tabId: 'tab-worker-one',
          worktreeId: 'repo-1::/tmp/wa',
          leafId: 'pane:worker-one',
          paneRuntimeId: 3,
          ptyId: 'pty-worker-one',
          paneTitle: null
        }
      ]
    })
    const { terminals } = await runtime.listTerminals()
    const workerOne = terminals.find((t) => t.tabId === 'tab-worker-one')
    if (!workerOne) {
      throw new Error('fixture setup failed: expected worker-one terminal')
    }
    const workerOnePaneKey = `${workerOne.tabId}:${workerOne.leafId}`
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === workerOne.handle) {
        return workerOnePaneKey
      }
      return null
    })

    const sent = (await call('orchestration.send', {
      from: callerHandle,
      to: workerOne.handle,
      subject: 'hello worker-one'
    })) as { message: { id: string } }
    const stored = db.getMessageById(sent.message.id)
    expect(stored?.to_handle).toBe(workerOne.handle)
    expect(stored?.recipient_pane_key).toBe(workerOnePaneKey)
  })
})
