import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from './terminal'
import { terminalPresenceRegistry } from '../../terminal-presence-registry'
import { HOST_PARTICIPANT_ID } from '../../terminal-presence-snapshot'
import { TERMINAL_PRESENCE_ACTIVITY_TTL_MS } from '../../terminal-presence-activity-rows'
import type { RpcResponse } from '../core'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalShow,
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
  participant: {
    connectionId: string
    pairedDeviceId: string
    label: string
    kind?: 'runtime' | 'mobile'
  }
): string {
  const registered = terminalPresenceRegistry.registerConnection({
    connectionId: participant.connectionId,
    pairedDeviceId: participant.pairedDeviceId,
    label: participant.label,
    kind: participant.kind ?? 'runtime'
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

type RemoteIdentity = {
  connectionId?: string
  pairedDeviceId?: string
  clientKind?: 'mobile' | 'runtime'
}

async function dispatchOverRemoteSocket<TResult>(
  runtime: OrcaRuntimeService,
  method: string,
  identity: RemoteIdentity,
  params: Record<string, unknown>
): Promise<TResult> {
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    { id: 'req-1', authToken: 'tok', method, params },
    (message) => replies.push(message),
    identity
  )
  const response = JSON.parse(replies[0]!) as RpcResponse
  if (!('result' in response)) {
    throw new Error(`${method} failed: ${replies[0]}`)
  }
  return response.result as TResult
}

async function listOverRemoteSocket(
  runtime: OrcaRuntimeService,
  identity: RemoteIdentity,
  params: Record<string, unknown>
): Promise<RuntimeTerminalListResult> {
  return await dispatchOverRemoteSocket<RuntimeTerminalListResult>(
    runtime,
    'terminal.list',
    identity,
    params
  )
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
      participants: [{ participantId, label: 'Ana', kind: 'runtime', typing: true, writing: false }]
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
          preview: '',
          // Why present without being asked for: S9 §2h's lane fields are properties of the
          // TERMINAL, published on every row like `connected`, not of the presence projection.
          credentialLane: 'unknown'
        }
      ],
      topologyRevisions: { [REPO_WORKTREE_ID]: 0 },
      totalCount: 1,
      truncated: false
    })
  })

  // Why asserted on the walk and not on a timing: the participant index is keyed by connection, not by
  // PTY, so rebuilding it per row makes one `terminal.list` O(rows x connections) — and terminal.list is
  // both the path the roster fans out per peer and the one with a payload-size budget.
  it('walks the connections once for a whole response, not once per row', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-a', REPO_WORKTREE_ID)
    spawnPty(runtime, 'pty-b', REPO_WORKTREE_ID)
    spawnPty(runtime, 'pty-c', FOLDER_WORKSPACE_ID)
    attachParticipant('pty-a', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })
    const connections = vi.spyOn(terminalPresenceRegistry, 'connections')
    try {
      const result = await runtime.listTerminals(undefined, undefined, {
        presence: { selfParticipantId: null }
      })

      expect(result.terminals).toHaveLength(3)
      expect(connections).toHaveBeenCalledTimes(1)
      // Why the rows too: a hoisted index that dropped a participant would satisfy the count alone.
      expect(rowFor(result, 'pty-a').presence?.attachedCount).toBe(1)
      expect(rowFor(result, 'pty-b').presence?.attachedCount).toBe(0)
    } finally {
      connections.mockRestore()
    }
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
      {
        participantId: expect.any(String),
        label: 'Ana',
        kind: 'runtime',
        typing: true,
        writing: false
      }
    ])
    expect(rowFor(result, SSH_PTY_ID).presence?.participants).toEqual([
      {
        participantId: expect.any(String),
        label: 'Ben',
        kind: 'runtime',
        typing: false,
        writing: true
      }
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
      {
        participantId: anaParticipantId,
        label: 'Ana',
        kind: 'runtime',
        typing: true,
        writing: false,
        self: true
      }
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
        kind: 'host',
        typing: true,
        writing: false,
        self: true
      }
    ])
  })

  // Why the asymmetry is pinned: §2.1 declares the anonymous local caller and the renderer bridge one
  // participant, while host TYPING is finer because only the two guarded IPC writers stamp it — and the
  // reserved 'host' key is swept by no teardown, so not-typing is the row's ordinary state.
  it('marks the host row self for an anonymous local caller while it is not typing', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-local', REPO_WORKTREE_ID)
    const stampedAt = Date.now()
    // Why Date.now and not fake timers: listTerminals reads the module singleton registry, whose clock
    // is not injectable at this boundary, and freezing the timer loop would stall the dispatch itself.
    const now = vi.spyOn(Date, 'now').mockReturnValue(stampedAt)
    try {
      terminalPresenceRegistry.recordHostInteractiveInput('pty-local')
      now.mockReturnValue(stampedAt + TERMINAL_PRESENCE_ACTIVITY_TTL_MS + 1)

      const result = await listOverLocalSocket(runtime, { includePresence: true })

      expect(rowFor(result, 'pty-local').presence).toEqual({
        attachedCount: 1,
        participants: [
          {
            participantId: HOST_PARTICIPANT_ID,
            label: expect.any(String),
            kind: 'host',
            typing: false,
            writing: false,
            self: true
          }
        ]
      })
    } finally {
      now.mockRestore()
    }
  })

  it('counts one participant for a peer attached from two connections', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-shared', REPO_WORKTREE_ID)
    const participantId = attachParticipant('pty-shared', {
      connectionId: 'conn-ana-window-1',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })
    attachParticipant('pty-shared', {
      connectionId: 'conn-ana-window-2',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })

    const result = await runtime.listTerminals(undefined, undefined, {
      presence: { selfParticipantId: null }
    })

    // Why asserted on the count and the rows together: a count taken over connections would read 2 here
    // and disagree with the per-terminal roster beside it, which aggregates by participant.
    expect(rowFor(result, 'pty-shared').presence).toEqual({
      attachedCount: 1,
      participants: [{ participantId, label: 'Ana', kind: 'runtime', typing: true, writing: false }]
    })
  })

  it('gives a remote caller the host row unmarked when its own connection is untracked', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-local', REPO_WORKTREE_ID)
    terminalPresenceRegistry.recordHostInteractiveInput('pty-local')

    const result = await listOverRemoteSocket(
      runtime,
      { connectionId: 'conn-unknown', pairedDeviceId: 'device-unknown', clientKind: 'runtime' },
      { includePresence: true }
    )

    // Why this is the guard that matters: the anonymous fallback resolves to the host row, so a remote
    // caller the registry cannot place must fall through to NO self rather than inherit the local human's.
    expect(rowFor(result, 'pty-local').presence?.participants).toEqual([
      {
        participantId: HOST_PARTICIPANT_ID,
        label: expect.any(String),
        kind: 'host',
        typing: true,
        writing: false
      }
    ])
  })

  it('populates every row for a remote caller that is not itself attached', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-shared', REPO_WORKTREE_ID)
    attachParticipant('pty-shared', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })

    const result = await listOverRemoteSocket(
      runtime,
      { connectionId: 'conn-desktop', pairedDeviceId: 'device-desktop', clientKind: 'runtime' },
      { includePresence: true }
    )

    expect(rowFor(result, 'pty-shared').presence?.attachedCount).toBe(1)
  })

  // Why the Q5 control: §2.7 makes mobile a participant, not a suppressed class — it appears in W6
  // payloads AND receives them. Refusing the key would hand a phone the one shape §2.4's per-row
  // capability probe misreads, leaving a capable host looking pre-presence forever.
  it('serves a mobile-scope caller the key on every row and marks its own', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-shared', REPO_WORKTREE_ID)
    spawnPty(runtime, 'pty-idle', EMPTY_WORKTREE_ID)
    attachParticipant('pty-shared', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })
    const phoneParticipantId = attachParticipant('pty-shared', {
      connectionId: 'conn-phone',
      pairedDeviceId: 'device-phone',
      label: "Ben's phone",
      kind: 'mobile'
    })

    const result = await listOverRemoteSocket(
      runtime,
      { connectionId: 'conn-phone', pairedDeviceId: 'device-phone', clientKind: 'mobile' },
      { includePresence: true }
    )

    expect(result.terminals.map((terminal) => 'presence' in terminal)).toEqual([true, true])
    expect(
      rowFor(result, 'pty-shared').presence?.participants.filter(
        (participant) => participant.self === true
      )
    ).toEqual([
      {
        participantId: phoneParticipantId,
        label: "Ben's phone",
        kind: 'mobile',
        typing: true,
        writing: false,
        self: true
      }
    ])
  })
})

describe('terminal.list presence default direction', () => {
  // Why dispatched and not called on the runtime: `runtime.listTerminals` reads `opts.presence`, while
  // the guard that implements W6's default direction is `params.includePresence === true` in the
  // handler — and the adjacent `includeVisualLayouts` defaults the other way, so an inverted gate here
  // would ship presence to every pre-flag caller with the runtime-level control still green.
  it('leaves the whole dispatched payload byte-identical when the caller does not ask', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-orphan', REPO_WORKTREE_ID)
    attachParticipant('pty-orphan', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })
    const identity: RemoteIdentity = {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      clientKind: 'runtime'
    }
    const prePresencePayload = {
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
          preview: '',
          // Why present without being asked for: S9 §2h's lane fields are properties of the
          // TERMINAL, published on every row like `connected`, not of the presence projection.
          credentialLane: 'unknown'
        }
      ],
      topologyRevisions: { [REPO_WORKTREE_ID]: 0 },
      totalCount: 1,
      truncated: false
    }

    // Why the whole object and not `'presence' in terminal`: the assertion has to fail on a key the
    // pre-flag shape never had, wherever the boundary pass decided to put it.
    expect(await listOverRemoteSocket(runtime, identity, {})).toEqual(prePresencePayload)
    expect(
      await listOverRemoteSocket(runtime, identity, {
        includeVisualLayouts: false,
        includePresence: false
      })
    ).toEqual(prePresencePayload)
  })

  // Why here at all: `terminal.show` builds from the same two summary builders `terminal.list` does, so
  // moving population into a builder behind an option would keep every list-side control green while
  // show started publishing labels to callers that negotiated for nothing (§2.2 W6).
  it('never carries the key out of terminal.show, asked or not', async () => {
    const runtime = makeRuntime()
    spawnPty(runtime, 'pty-shown', REPO_WORKTREE_ID)
    attachParticipant('pty-shown', {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      label: 'Ana'
    })
    const identity: RemoteIdentity = {
      connectionId: 'conn-ana',
      pairedDeviceId: 'device-ana',
      clientKind: 'runtime'
    }
    const listed = await listOverRemoteSocket(runtime, identity, { includePresence: true })
    const terminal = rowFor(listed, 'pty-shown').handle
    expect(rowFor(listed, 'pty-shown').presence?.attachedCount).toBe(1)

    for (const params of [{ terminal }, { terminal, includePresence: true }]) {
      const shown = await dispatchOverRemoteSocket<{ terminal: RuntimeTerminalShow }>(
        runtime,
        'terminal.show',
        identity,
        params
      )
      expect('presence' in shown.terminal).toBe(false)
    }
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
