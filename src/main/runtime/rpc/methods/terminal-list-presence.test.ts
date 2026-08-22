import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from './terminal'
import { terminalPresenceRegistry } from '../../terminal-presence-registry'
import { HOST_PARTICIPANT_ID } from '../../terminal-presence-snapshot'
import type { RpcResponse } from '../core'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../../shared/runtime-types'

const REPO_WORKTREE_ID = 'repo-1::/tmp/worktree-a'
const EMPTY_WORKTREE_ID = 'repo-1::/tmp/worktree-b'
const FOLDER_WORKSPACE_ID = 'folder:folder-workspace-1'
const SSH_PTY_ID = 'ssh:host-a@@pty-7'
const NULL_PTY_LEAF_ID = '11111111-1111-4111-8111-111111111111'

// Why no repos: the roster only needs terminal rows, and an empty repo list keeps worktree resolution
// off the git binary — the rows then carry the empty branch a folder workspace also carries.
function makeStore() {
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => ({}),
    removeWorktreeMeta: () => {},
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' })
  }
}

function makeRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService(makeStore() as never)
}

function spawnPty(runtime: OrcaRuntimeService, ptyId: string, worktreeId: string): void {
  runtime.registerPty(ptyId, worktreeId)
  runtime.onPtySpawned(ptyId, `inc-${ptyId}`, { awaitsRegistration: false })
}

function attachParticipant(
  ptyId: string,
  participant: { connectionId: string; pairedDeviceId: string; label: string }
): string {
  const registered = terminalPresenceRegistry.registerConnection({
    connectionId: participant.connectionId,
    pairedDeviceId: participant.pairedDeviceId,
    label: participant.label,
    kind: 'runtime'
  })
  const subscriptionKey = `terminal-multiplex:${participant.connectionId}`
  terminalPresenceRegistry.attach(ptyId, subscriptionKey, participant.connectionId)
  terminalPresenceRegistry.recordInteractiveInput(ptyId, subscriptionKey)
  return registered.participantId
}

function rowFor(result: RuntimeTerminalListResult, ptyId: string | null): RuntimeTerminalSummary {
  const row = result.terminals.find((terminal) => terminal.ptyId === ptyId)
  if (!row) {
    throw new Error(`No terminal row for ptyId ${String(ptyId)}`)
  }
  return row
}

async function listOverRemoteSocket(
  runtime: OrcaRuntimeService,
  identity: { connectionId?: string; pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' },
  params: Record<string, unknown>
): Promise<RuntimeTerminalListResult> {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    { id: 'req-list', authToken: 'tok', method: 'terminal.list', params },
    (message) => replies.push(message),
    identity
  )
  const response = JSON.parse(replies[0]!) as RpcResponse
  if (!('result' in response)) {
    throw new Error(`terminal.list failed: ${replies[0]}`)
  }
  return response.result as RuntimeTerminalListResult
}

async function listOverLocalSocket(
  runtime: OrcaRuntimeService,
  params: Record<string, unknown>
): Promise<RuntimeTerminalListResult> {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  // Why dispatch and not dispatchStreaming: the Unix-socket CLI has no identity slot at all, which is
  // exactly the anonymity this path must be exercised through.
  const response = await dispatcher.dispatch({
    id: 'req-list',
    authToken: 'tok',
    method: 'terminal.list',
    params
  })
  if (!('result' in response)) {
    throw new Error('terminal.list failed')
  }
  return response.result as RuntimeTerminalListResult
}

beforeEach(() => {
  terminalPresenceRegistry.reset()
})

describe('terminal.list presence boundary pass', () => {
  it('carries the key on a graph-less PTY row that only the fallback builder produces', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-orphan', REPO_WORKTREE_ID)
    const participantId = attachParticipant('pty-orphan', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })

    const result = await runtime.listTerminals(undefined, undefined, {
      presence: { selfParticipantId: null }
    })

    const row = rowFor(result, 'pty-orphan')
    // Why asserted: this row exists only because the PTY-fallback loop pushed it, so a population pass
    // living inside the renderer-graph builder would leave it bare.
    expect(row.orphaned).toBe(true)
    expect(row.presence).toEqual({
      attachedCount: 1,
      participants: [{ participantId, label: 'Ana', typing: true, writing: false }]
    })
  })

  it('carries the empty presence object on a row with no PTY', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-orphan', REPO_WORKTREE_ID)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: EMPTY_WORKTREE_ID,
          title: '',
          activeLeafId: NULL_PTY_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: EMPTY_WORKTREE_ID,
          leafId: NULL_PTY_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: null,
          paneTitle: null,
          title: ''
        }
      ]
    } as never)

    const result = await runtime.listTerminals(undefined, undefined, {
      presence: { selfParticipantId: null }
    })

    expect(rowFor(result, null).presence).toEqual({ attachedCount: 0, participants: [] })
    // Why both in one response: the invariant the CLI's `'presence' in terminal` probe rests on is
    // per-response, so a fallback row and a PTY-less row must never disagree about carrying the key.
    expect(rowFor(result, 'pty-orphan').presence).toEqual({ attachedCount: 0, participants: [] })
  })

  it('omits the key from every row when the caller does not ask for presence', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-orphan', REPO_WORKTREE_ID)
    attachParticipant('pty-orphan', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })

    const result = await runtime.listTerminals()

    expect(result).toEqual({
      terminals: [
        {
          handle: expect.stringMatching(/^term_/),
          ptyId: 'pty-orphan',
          incarnationId: 'inc-pty-orphan',
          orphaned: true,
          worktreeId: REPO_WORKTREE_ID,
          worktreePath: '',
          branch: '',
          tabId: 'pty:pty-orphan',
          leafId: 'pty:pty-orphan',
          title: null,
          connected: true,
          writable: true,
          lastOutputAt: null,
          preview: ''
        }
      ],
      topologyRevisions: { [REPO_WORKTREE_ID]: 0 },
      totalCount: 1,
      truncated: false
    })
  })

  it('carries the column on a folder workspace with no branch and on an SSH-scoped terminal', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-folder', FOLDER_WORKSPACE_ID)
    spawnPty(runtime, SSH_PTY_ID, REPO_WORKTREE_ID)
    attachParticipant('pty-folder', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })
    terminalPresenceRegistry.registerConnection({
      connectionId: 'conn-ben',
      pairedDeviceId: 'device-ben',
      label: 'Ben',
      kind: 'runtime'
    })
    terminalPresenceRegistry.recordGrantWrite(SSH_PTY_ID, 'device-ben')

    const result = await runtime.listTerminals(undefined, undefined, {
      presence: { selfParticipantId: null }
    })

    const folderRow = rowFor(result, 'pty-folder')
    // Why asserted: a folder workspace has no branch at all, and the column must not depend on one.
    expect(folderRow.branch).toBe('')
    expect(folderRow.presence?.participants).toEqual([
      { participantId: expect.any(String), label: 'Ana', typing: true, writing: false }
    ])
    expect(rowFor(result, SSH_PTY_ID).presence?.participants).toEqual([
      { participantId: expect.any(String), label: 'Ben', typing: false, writing: true }
    ])
  })
})

describe('terminal.list presence caller scope', () => {
  it('marks the remote caller its own row and leaves the peer row unmarked', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-shared', REPO_WORKTREE_ID)
    const anaParticipantId = attachParticipant('pty-shared', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })
    attachParticipant('pty-shared', {
      connectionId: 'conn-ben',
      pairedDeviceId: 'device-ben',
      label: 'Ben'
    })

    const result = await listOverRemoteSocket(
      runtime,
      { connectionId: 'conn-ana', pairedDeviceId: 'device-ana', clientKind: 'runtime' },
      { includePresence: true }
    )

    const participants = rowFor(result, 'pty-shared').presence?.participants ?? []
    expect(participants).toHaveLength(2)
    expect(participants.filter((participant) => participant.self === true)).toEqual([
      { participantId: anaParticipantId, label: 'Ana', typing: true, writing: false, self: true }
    ])
    expect(participants.find((participant) => participant.label === 'Ben')).not.toHaveProperty(
      'self'
    )
  })

  it('marks the host row for an anonymous local caller that carries no identity', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-local', REPO_WORKTREE_ID)
    terminalPresenceRegistry.recordHostInteractiveInput('pty-local')

    const result = await listOverLocalSocket(runtime, { includePresence: true })

    expect(rowFor(result, 'pty-local').presence?.participants).toEqual([
      {
        participantId: HOST_PARTICIPANT_ID,
        label: expect.any(String),
        typing: true,
        writing: false,
        self: true
      }
    ])
  })

  it('populates nothing for a mobile-scope caller', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-shared', REPO_WORKTREE_ID)
    attachParticipant('pty-shared', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })

    const result = await listOverRemoteSocket(
      runtime,
      { connectionId: 'conn-phone', pairedDeviceId: 'device-phone', clientKind: 'mobile' },
      { includePresence: true }
    )

    // Why every row and not just this one: the gate is per-caller, so a phone must never see a response
    // where some rows carry the key — that is the shape the roster's capability probe would misread.
    expect(result.terminals).toHaveLength(1)
    expect(result.terminals.every((terminal) => !('presence' in terminal))).toBe(true)
  })
})

describe('terminal.list includePresence skew', () => {
  // Why a hand-copied schema: the question is what a host built BEFORE the flag existed does with it,
  // and the live schema can no longer answer that.
  const PRE_PRESENCE_TERMINAL_LIST_PARAMS = z.object({
    worktree: z.string().optional(),
    limit: z.number().optional(),
    handles: z.array(z.string()).max(64).optional(),
    requireFreshPtyLiveness: z.boolean().optional(),
    includeVisualLayouts: z.boolean().optional()
  })

  it('strips includePresence on a pre-presence host and keeps every other param', () => {
    expect(
      PRE_PRESENCE_TERMINAL_LIST_PARAMS.parse({
        limit: 5,
        includeVisualLayouts: false,
        includePresence: true
      })
    ).toEqual({ limit: 5, includeVisualLayouts: false })
  })

  it('keeps includePresence on a presence-capable host', () => {
    const method = TERMINAL_METHODS.find((entry) => entry.name === 'terminal.list')
    expect(method?.params?.parse({ includePresence: true, includeVisualLayouts: false })).toEqual({
      includePresence: true,
      includeVisualLayouts: false
    })
  })
})

// Why kept out of the suites above: it proves the pass is a boundary pass, not that presence is correct.
describe('terminal.list presence boundary placement', () => {
  it('reports the fallback row through the same array the renderer-graph loop fills', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-orphan', REPO_WORKTREE_ID)
    const buildVisualLayouts = vi.fn(() => [])
    Object.defineProperty(runtime, 'buildTerminalVisualLayouts', { value: buildVisualLayouts })

    const result = await runtime.listTerminals(undefined, undefined, {
      includeVisualLayouts: false,
      presence: { selfParticipantId: null }
    })

    expect(result.terminals.map((terminal) => 'presence' in terminal)).toEqual([true])
  })
})
