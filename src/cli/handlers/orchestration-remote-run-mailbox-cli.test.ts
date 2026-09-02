import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'
import {
  ORCHESTRATION_REMOTE_RUN_MAILBOX_RUNTIME_CAPABILITY,
  ORCHESTRATION_REMOTE_RUN_MAILBOX_UNSUPPORTED_MESSAGE
} from '../../shared/protocol-version'

function statusWith(capabilities: string[]): { result: { capabilities: string[] } } {
  return { result: { capabilities } }
}

function supportedStatus(): { result: { capabilities: string[] } } {
  return statusWith([
    'runtime.status.compat.v1',
    ORCHESTRATION_REMOTE_RUN_MAILBOX_RUNTIME_CAPABILITY
  ])
}

// S10-19 §9.2: a federation-peer grant stamps a peerAccess block on status.get; a full pairing
// never does. C-1/C-2/C-3 key the client-side identity suppression off this, not off `.remote`.
function peerStatus(): { result: { capabilities: string[]; peerAccess: Record<string, unknown> } } {
  return {
    result: {
      capabilities: [
        'runtime.status.compat.v1',
        ORCHESTRATION_REMOTE_RUN_MAILBOX_RUNTIME_CAPABILITY
      ],
      peerAccess: { profile: 'peer', version: 'orchestration.peer-allowlist.v1', methods: [] }
    }
  }
}

function invoke(command: string, flags: Map<string, string | boolean>, isRemote: boolean) {
  return ORCHESTRATION_HANDLERS[command]({
    flags,
    client: { call: callMock, isRemote },
    cwd: '/tmp/repo',
    json: true
  } as never)
}

function paramsOf(callIndex: number): Record<string, unknown> {
  return callMock.mock.calls[callIndex][1] as Record<string, unknown>
}

function methodsCalled(): string[] {
  return callMock.mock.calls.map((call) => call[0] as string)
}

beforeEach(() => {
  callMock.mockReset()
  getTerminalHandleMock.mockReset()
  process.env.ORCA_TERMINAL_HANDLE = 'term_caller'
  process.env.ORCA_PANE_KEY = 'tab_caller:dddddddd-dddd-4ddd-8ddd-dddddddddddd'
})

afterEach(() => {
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
  if (originalPaneKey === undefined) {
    delete process.env.ORCA_PANE_KEY
  } else {
    process.env.ORCA_PANE_KEY = originalPaneKey
  }
})

describe('orchestration check --run --environment', () => {
  it('negotiates the capability and opts in to the peer Run mailbox', async () => {
    callMock
      .mockResolvedValueOnce(supportedStatus())
      .mockResolvedValueOnce({ result: { messages: [], count: 0, runId: 'run_1' } })

    await invoke('orchestration check', new Map([['run', 'run_1']]), true)

    expect(methodsCalled()).toEqual(['status.get', 'orchestration.check'])
    expect(paramsOf(1)).toMatchObject({ run: 'run_1', remoteRunMailbox: true })
    // Why: a local pane key names nothing on the peer.
    expect(paramsOf(1).terminalPaneKey).toBeUndefined()
  })

  it('reports the capability gap instead of the peer refusing an unbound coordinator', async () => {
    callMock
      .mockResolvedValueOnce(statusWith(['runtime.status.compat.v1']))
      .mockRejectedValueOnce(new RuntimeClientError('run_required', 'No Run is bound.'))

    await expect(invoke('orchestration check', new Map([['run', 'run_1']]), true)).rejects.toThrow(
      ORCHESTRATION_REMOTE_RUN_MAILBOX_UNSUPPORTED_MESSAGE
    )
    expect(paramsOf(1).remoteRunMailbox).toBeUndefined()
  })

  it('leaves unrelated peer failures untouched', async () => {
    callMock
      .mockResolvedValueOnce(statusWith(['runtime.status.compat.v1']))
      .mockRejectedValueOnce(new RuntimeClientError('run_not_found', 'Run run_1 was not found.'))

    await expect(invoke('orchestration check', new Map([['run', 'run_1']]), true)).rejects.toThrow(
      'Run run_1 was not found.'
    )
  })

  it('never probes or opts in for a local check', async () => {
    callMock.mockResolvedValueOnce({ result: { messages: [], count: 0, runId: 'run_1' } })

    await invoke('orchestration check', new Map([['run', 'run_1']]), false)

    expect(methodsCalled()).toEqual(['orchestration.check'])
    expect(paramsOf(0).remoteRunMailbox).toBeUndefined()
    expect(paramsOf(0).terminalPaneKey).toBe(process.env.ORCA_PANE_KEY)
  })

  it('never probes for a remote check that reads the caller handle mailbox', async () => {
    callMock.mockResolvedValueOnce({ result: { messages: [], count: 0 } })

    await invoke('orchestration check', new Map(), true)

    expect(methodsCalled()).toEqual(['orchestration.check'])
    expect(paramsOf(0).remoteRunMailbox).toBeUndefined()
  })
})

describe('orchestration send --to run: --environment', () => {
  it('opts in when posting into a peer Run mailbox', async () => {
    callMock
      .mockResolvedValueOnce(supportedStatus())
      .mockResolvedValueOnce({ result: { message: { id: 'msg_1' } } })

    await invoke(
      'orchestration send',
      new Map([
        ['to', 'run:run_1'],
        ['subject', 'Cross-runtime instruction']
      ]),
      true
    )

    expect(methodsCalled()).toEqual(['status.get', 'orchestration.send'])
    expect(paramsOf(1)).toMatchObject({ to: 'run:run_1', remoteRunMailbox: true })
  })

  // W-5..W-7 review F5 / Ruling 24(w): `orca orchestration send --to dispatch:<id>
  // --environment <peer>` is the documented follow-up flow and must WORK — the CLI now probes
  // peerAccess for every remote send, not only --run/--to run:, so a peer grant's `from`
  // suppression fires here too instead of the server refusing the call outright.
  // Prior expectation ("does not probe when sending to a Dispatch on the peer") described the
  // defect this fix removes: a `--to dispatch:` send skipped the probe, so `from` was always
  // sent and a peer grant refused `forbidden` (F5 in the W-5..W-7 review).
  it('F5: probes peerAccess and omits from when sending to a Dispatch on a peer grant', async () => {
    callMock
      .mockResolvedValueOnce(peerStatus())
      .mockResolvedValueOnce({ result: { message: { id: 'msg_1' } } })
    getTerminalHandleMock.mockResolvedValue('term_caller')

    await invoke(
      'orchestration send',
      new Map([
        ['to', 'dispatch:dispatch_1'],
        ['subject', 'Follow-up']
      ]),
      true
    )

    expect(methodsCalled()).toEqual(['status.get', 'orchestration.send'])
    expect(paramsOf(1)).toMatchObject({ to: 'dispatch:dispatch_1', remoteRunMailbox: true })
    expect(paramsOf(1).from).toBeUndefined()
  })

  it('a full-profile remote send to a Dispatch still probes but keeps offering from (no peerAccess block)', async () => {
    callMock
      .mockResolvedValueOnce(supportedStatus())
      .mockResolvedValueOnce({ result: { message: { id: 'msg_1' } } })
    getTerminalHandleMock.mockResolvedValue('term_caller')

    await invoke(
      'orchestration send',
      new Map([
        ['to', 'dispatch:dispatch_1'],
        ['subject', 'Follow-up']
      ]),
      true
    )

    expect(methodsCalled()).toEqual(['status.get', 'orchestration.send'])
    expect(paramsOf(1).from).toBe('term_caller')
  })

  it('a local (non-remote) send to a Dispatch never probes', async () => {
    callMock.mockResolvedValueOnce({ result: { message: { id: 'msg_1' } } })
    getTerminalHandleMock.mockResolvedValue('term_caller')

    await invoke(
      'orchestration send',
      new Map([
        ['to', 'dispatch:dispatch_1'],
        ['subject', 'Follow-up']
      ]),
      false
    )

    expect(methodsCalled()).toEqual(['orchestration.send'])
  })
})

describe('orchestration reply --environment', () => {
  it('opts in for every remote reply because only the peer knows if --id is a question', async () => {
    callMock
      .mockResolvedValueOnce(supportedStatus())
      .mockResolvedValueOnce({ result: { message: { id: 'msg_2' } } })

    await invoke(
      'orchestration reply',
      new Map([
        ['id', 'msg_1'],
        ['body', 'Use the release branch.']
      ]),
      true
    )

    expect(methodsCalled()).toEqual(['status.get', 'orchestration.reply'])
    expect(paramsOf(1)).toMatchObject({ id: 'msg_1', remoteRunMailbox: true })
  })

  it('explains the capability gap when the peer fences the reply on Run binding', async () => {
    callMock
      .mockResolvedValueOnce(statusWith(['runtime.status.compat.v1']))
      .mockRejectedValueOnce(
        new RuntimeClientError('consumer_fenced', 'This coordinator terminal is no longer bound.')
      )

    await expect(
      invoke(
        'orchestration reply',
        new Map([
          ['id', 'msg_1'],
          ['body', 'Use the release branch.']
        ]),
        true
      )
    ).rejects.toThrow(ORCHESTRATION_REMOTE_RUN_MAILBOX_UNSUPPORTED_MESSAGE)
  })

  it('stays a plain local reply when the runtime is not remote', async () => {
    callMock.mockResolvedValueOnce({ result: { message: { id: 'msg_2' } } })

    await invoke(
      'orchestration reply',
      new Map([
        ['id', 'msg_1'],
        ['body', 'Local answer.']
      ]),
      false
    )

    expect(methodsCalled()).toEqual(['orchestration.reply'])
    expect(paramsOf(0).remoteRunMailbox).toBeUndefined()
  })
})

// S10-19 C-1/C-2/C-3/C-4: once negotiateRemoteRunMailbox learns the callee is a federation-peer
// grant (peerAccess present on status.get), the CLI stops offering local pane identity — the
// peer server refuses it outright (§8.1/§8.2).
describe('S10-19 W-5: client-side peer-identity suppression', () => {
  it('C-1: check omits terminal (not just terminalPaneKey) against a peer grant', async () => {
    callMock
      .mockResolvedValueOnce(peerStatus())
      .mockResolvedValueOnce({ result: { messages: [], count: 0, runId: 'run_1' } })

    await invoke('orchestration check', new Map([['run', 'run_1']]), true)

    expect(paramsOf(1).terminal).toBeUndefined()
    expect(paramsOf(1).terminalPaneKey).toBeUndefined()
  })

  it('a full-profile remote check still offers terminal (no peerAccess block)', async () => {
    callMock
      .mockResolvedValueOnce(supportedStatus())
      .mockResolvedValueOnce({ result: { messages: [], count: 0, runId: 'run_1' } })
    getTerminalHandleMock.mockResolvedValue('term_caller')

    await invoke('orchestration check', new Map([['run', 'run_1']]), true)

    expect(paramsOf(1).terminal).toBe('term_caller')
  })

  it('C-2: send omits from and senderPaneKey against a peer grant', async () => {
    callMock
      .mockResolvedValueOnce(peerStatus())
      .mockResolvedValueOnce({ result: { message: { id: 'msg_1' } } })
    getTerminalHandleMock.mockResolvedValue('term_caller')

    await invoke(
      'orchestration send',
      new Map([
        ['to', 'run:run_1'],
        ['subject', 'Cross-runtime instruction']
      ]),
      true
    )

    expect(paramsOf(1).from).toBeUndefined()
    expect(paramsOf(1).senderPaneKey).toBeUndefined()
  })

  it('C-3: reply omits from against a peer grant', async () => {
    callMock
      .mockResolvedValueOnce(peerStatus())
      .mockResolvedValueOnce({ result: { message: { id: 'msg_2' } } })
    getTerminalHandleMock.mockResolvedValue('term_caller')

    await invoke(
      'orchestration reply',
      new Map([
        ['id', 'msg_1'],
        ['body', 'Use the release branch.']
      ]),
      true
    )

    expect(paramsOf(1).from).toBeUndefined()
  })

  it('C-4: the compatibilityAck follow-up carries remoteRunMailbox and omits terminal against a peer grant', async () => {
    callMock
      .mockResolvedValueOnce(peerStatus())
      .mockResolvedValueOnce({
        result: {
          messages: [],
          count: 0,
          runId: 'run_1',
          legacyCompatibility: { ackMessageIds: ['msg_1'] }
        }
      })
      .mockResolvedValueOnce({ result: {} })

    await invoke('orchestration check', new Map([['run', 'run_1']]), true)

    expect(methodsCalled()).toEqual(['status.get', 'orchestration.check', 'orchestration.check'])
    expect(paramsOf(2)).toMatchObject({ remoteRunMailbox: true })
    expect(paramsOf(2).terminal).toBeUndefined()
  })
})
