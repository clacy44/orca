import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import type * as RuntimeClientModule from '../runtime-client'
import { encodePairingOffer } from '../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../runtime/environments'
import { AGENT_ASK_REPLY_HANDLERS } from './agents-ask-reply'

// S10-8 R1 (transport inversion): a `name@host` ask must resolve the remote id over a direct
// read on the target's own client (fine — reads tolerate an unattested caller) but never send
// the ask itself over that client. `getDefaultUserDataPath` is stubbed to a real temp env store
// (mirrors agents-shared.test.ts's own fixture) so `resolveAgentAcrossHost`'s DEFAULT
// `hostClientFactory` runs unmodified; `RuntimeClient` is stubbed only so that factory never
// opens a real socket — its `.call` is a spy this file asserts against directly.
const remoteClientCall = vi.fn()
vi.mock('../runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeClientModule>()
  class FakeRuntimeClient {
    call = remoteClientCall
  }
  return {
    ...actual,
    getDefaultUserDataPath: () => testUserDataPath,
    RuntimeClient: FakeRuntimeClient
  }
})

let testUserDataPath = ''

function pairingCode(): string {
  return encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

describe('agents ask/reply CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    remoteClientCall.mockReset()
    process.exitCode = undefined
  })

  it('ask: resolves the name to agent:<id> and asks with no --thread/--to needed ("one command to start")', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: {
          answer: 'rebase onto 12ddb0a first',
          messageId: 'msg_a1',
          threadId: 'thr_9fk2',
          timedOut: false,
          timeoutMs: 47_000
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'did db.ts land yet?']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.agents.get', { name: 'backend-merge' })
    expect(call).toHaveBeenCalledWith(
      'orchestration.ask',
      expect.objectContaining({ to: 'agent:agt_them', question: 'did db.ts land yet?' }),
      expect.anything()
    )
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('rebase onto 12ddb0a first')
    expect(printed).toContain('Continue: orca agents reply --thread thr_9fk2 --body "..."')
  })

  it('ask: `name@host` resolves the id over the REMOTE client but sends the ask over the LOCAL client, carrying `host` (R1)', async () => {
    testUserDataPath = mkdtempSync(join(tmpdir(), 'orca-agents-ask-reply-'))
    const saved = addEnvironmentFromPairingCode(testUserDataPath, {
      name: 'Private VPS',
      pairingCode: pairingCode()
    })
    remoteClientCall.mockResolvedValue({
      result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
    })
    const localCall = vi.fn().mockResolvedValue({
      result: {
        answer: 'yes',
        messageId: 'msg_a1',
        threadId: 'thr_9fk2',
        timedOut: false,
        timeoutMs: 1_000
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge@Private VPS'],
        ['question', 'did db.ts land yet?']
      ]),
      client: { call: localCall } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    // The read went to the remote client the saved environment resolves to...
    expect(remoteClientCall).toHaveBeenCalledWith('orchestration.agents.get', {
      name: 'backend-merge'
    })
    // ...but the ask itself went ONLY to the caller's own local client, never remoteClientCall,
    // carrying the resolved id AND the host for the local runtime to relay.
    expect(remoteClientCall).not.toHaveBeenCalledWith('orchestration.ask', expect.anything())
    expect(localCall).toHaveBeenCalledWith(
      'orchestration.ask',
      expect.objectContaining({
        to: 'agent:agt_them',
        host: 'Private VPS',
        question: 'did db.ts land yet?'
      }),
      expect.anything()
    )
    void saved
    expect(String(log.mock.calls[0]?.[0])).toContain('yes')
  })

  it('ask: refuses a quarantined target before ever calling orchestration.ask', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_bad', displayName: 'evil-agent', quarantined: true } }
        })
      }
      throw new Error('must not reach orchestration.ask')
    })
    await expect(
      AGENT_ASK_REPLY_HANDLERS['agents ask']({
        flags: new Map<string, string | boolean>([
          ['name', 'evil-agent'],
          ['question', 'hi']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'agent_quarantined' })
  })

  it('ask: a timeout exits 0 and points at agents wait instead of re-asking', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: {
          answer: null,
          messageId: 'msg_a1',
          threadId: 'thr_9fk2',
          timedOut: true,
          timeoutMs: 600_000
        }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'hi']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(process.exitCode).toBeUndefined()
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain(
      'Resume without re-asking: orca agents wait --thread thr_9fk2 --for reply'
    )
  })

  // S10-15 review M-6: a cross-host ask has no local `orchestration.wait --thread` that can
  // ever resolve (R9/R10/R11's reply-relay/resume machinery was cut) — the timeout hint must
  // not advertise a wait that can never come back.
  it('ask: a cross-host (name@host) timeout points at re-asking, never "agents wait" (M-6)', async () => {
    testUserDataPath = mkdtempSync(join(tmpdir(), 'orca-agents-ask-reply-'))
    addEnvironmentFromPairingCode(testUserDataPath, {
      name: 'Private VPS',
      pairingCode: pairingCode()
    })
    remoteClientCall.mockResolvedValue({
      result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
    })
    const localCall = vi.fn().mockResolvedValue({
      result: {
        answer: null,
        messageId: 'msg_a1',
        threadId: 'thr_9fk2',
        timedOut: true,
        timeoutMs: 600_000
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge@Private VPS'],
        ['question', 'hi']
      ]),
      client: { call: localCall } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(process.exitCode).toBeUndefined()
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).not.toContain('orca agents wait --thread')
    expect(printed).toContain('cannot be resumed with "wait"')
    expect(printed).toContain('orca agents ask <name>@<host>')
  })

  it('ask --json emits the bare RPC result, not an envelope', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: { answer: 'ok', messageId: 'msg_a1', threadId: 'thr_1', timedOut: false }
      })
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'hi']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: true
    } as never)
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ answer: 'ok' })
  })

  it('ask --acknowledge-gate passes acknowledgeGate through to the RPC', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.agents.get') {
        return Promise.resolve({
          result: { agent: { id: 'agt_them', displayName: 'backend-merge', quarantined: false } }
        })
      }
      return Promise.resolve({
        result: { answer: 'ok', messageId: 'msg_a1', threadId: 'thr_1', timedOut: false }
      })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents ask']({
      flags: new Map<string, string | boolean>([
        ['name', 'backend-merge'],
        ['question', 'merge gate FAIL: CVE-2025-1234, fix is a version bump'],
        ['acknowledge-gate', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith(
      'orchestration.ask',
      expect.objectContaining({ acknowledgeGate: true }),
      expect.anything()
    )
  })

  it('reply --id replies directly to a message id', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { message: { id: 'msg_b2', thread_id: 'thr_9fk2' }, duplicate: false }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents reply']({
      flags: new Map<string, string | boolean>([
        ['id', 'msg_a1'],
        ['body', 'rebase onto 12ddb0a first']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.reply', {
      id: 'msg_a1',
      body: 'rebase onto 12ddb0a first',
      acknowledgeGate: undefined
    })
    expect(String(log.mock.calls[0]?.[0])).toContain('Replied msg_b2')
  })

  it('reply --thread resolves to the latest message on the thread', async () => {
    const call = vi.fn().mockImplementation((method: string) => {
      if (method === 'orchestration.threads.get') {
        return Promise.resolve({
          result: { messages: [{ id: 'msg_old' }, { id: 'msg_a1' }] }
        })
      }
      return Promise.resolve({
        result: { message: { id: 'msg_b2', thread_id: 'thr_9fk2' }, duplicate: false }
      })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents reply']({
      flags: new Map<string, string | boolean>([
        ['thread', 'thr_9fk2'],
        ['body', 'reply text']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(call).toHaveBeenCalledWith('orchestration.reply', {
      id: 'msg_a1',
      body: 'reply text',
      acknowledgeGate: undefined
    })
  })

  it('reply --thread on an empty thread fails clearly instead of calling reply with an undefined id', async () => {
    const call = vi.fn().mockResolvedValue({ result: { messages: [] } })
    await expect(
      AGENT_ASK_REPLY_HANDLERS['agents reply']({
        flags: new Map<string, string | boolean>([
          ['thread', 'thr_empty'],
          ['body', 'reply text']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('reply requires exactly one of --thread or --id', async () => {
    const call = vi.fn()
    await expect(
      AGENT_ASK_REPLY_HANDLERS['agents reply']({
        flags: new Map<string, string | boolean>([
          ['thread', 'thr_1'],
          ['id', 'msg_1'],
          ['body', 'x']
        ]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp',
        json: false
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('reply surfaces a duplicate answer distinctly', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { message: { id: 'msg_b2', thread_id: 'thr_9fk2' }, duplicate: true }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await AGENT_ASK_REPLY_HANDLERS['agents reply']({
      flags: new Map<string, string | boolean>([
        ['id', 'msg_a1'],
        ['body', 'same answer again']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp',
      json: false
    } as never)
    expect(String(log.mock.calls[0]?.[0])).toContain('duplicate of a previous answer')
  })
})
