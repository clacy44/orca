// S10-19 W-3 review M4/M6: sendPeerDispatchMailPointer is the real production caller
// federationAttachStart (orchestration-federation.ts:241) delegates to for the peer profile —
// this drives it directly against a real OrcaRuntimeService/OrchestrationDb/pty flight (not a
// mocked sendTerminalAgentPrompt), which is what actually exercises the write-then-ready
// ordering (M4) and the fresh-foreground beforeWrite conjunct (M6). Standing up the full
// federationAttachStart RPC handler (worktree resolution, capability minting) for equivalent
// coverage was judged disproportionate — this is the function the review cited by name and the
// one whose own internal ordering/conjunct the findings are about.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { AGENT_PROMPT_SUBMIT } from '../../../../shared/agent-prompt-injection'
import {
  sendFullDispatchPaste,
  sendPeerDispatchMailPointer
} from './orchestration-federation-dispatch-input-send'

const TEST_WORKTREE_ID = 'repo-1::/tmp/worktree-peer-mail'

// Why direct internals and not syncWindowGraph + listTerminals: listTerminals resolves the
// worktree through the store's repo/worktree catalogue, which a bare `new OrcaRuntimeService()`
// (no store) has none of. sendTerminalAgentPrompt only needs handleByPtyId + ptysById + handles
// — the same three maps issuePtyHandle itself populates — so this mints a handle the same way a
// real spawn does, without standing up the whole worktree graph.
function registerAgentPtyAndGetHandle(runtime: OrcaRuntimeService, ptyId: string): string {
  const handle = `term_${ptyId}`
  const internals = runtime as unknown as {
    runtimeId: string
    ptysById: Map<string, Record<string, unknown>>
    handleByPtyId: Map<string, string>
    handles: Map<string, Record<string, unknown>>
  }
  internals.ptysById.set(ptyId, {
    ptyId,
    incarnationId: 'inc-1',
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    isWsl: false,
    wslDistro: null,
    connected: true,
    lastExitCode: null,
    paneKey: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    waitBlockedAt: null,
    lastAgentStatus: null,
    title: null,
    titleUpdatedAt: 0,
    lastOscTitle: null,
    lastOscTitleAt: 0,
    launchAgent: 'codex',
    foregroundAgent: 'codex'
  })
  internals.handleByPtyId.set(ptyId, handle)
  internals.handles.set(handle, {
    handle,
    runtimeId: internals.runtimeId,
    rendererGraphEpoch: 0,
    worktreeId: TEST_WORKTREE_ID,
    tabId: `pty:${ptyId}`,
    leafId: `pty:${ptyId}`,
    ptyId,
    ptyGeneration: 0
  })
  return handle
}

// [R203 T-Q] A launched, fenced Claude pane — noteTerminalSpawnCommand isn't driven here (no
// window graph / onPtyData ceremony), so the fence is armed directly on the record, mirroring
// the r197/shell-title fixtures' own direct-field idiom.
function registerFencedClaudePtyAndGetHandle(runtime: OrcaRuntimeService, ptyId: string): string {
  const handle = `term_${ptyId}`
  const internals = runtime as unknown as {
    runtimeId: string
    ptysById: Map<string, Record<string, unknown>>
    handleByPtyId: Map<string, string>
    handles: Map<string, Record<string, unknown>>
  }
  internals.ptysById.set(ptyId, {
    ptyId,
    incarnationId: 'inc-1',
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    isWsl: false,
    wslDistro: null,
    connected: true,
    lastExitCode: null,
    paneKey: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    waitBlockedAt: null,
    lastAgentStatus: null,
    title: null,
    titleUpdatedAt: 0,
    lastOscTitle: null,
    lastOscTitleAt: 0,
    launchAgent: 'claude',
    foregroundAgent: 'claude',
    launchPromptFenceSince: Date.now()
  })
  internals.handleByPtyId.set(ptyId, handle)
  internals.handles.set(handle, {
    handle,
    runtimeId: internals.runtimeId,
    rendererGraphEpoch: 0,
    worktreeId: TEST_WORKTREE_ID,
    tabId: `pty:${ptyId}`,
    leafId: `pty:${ptyId}`,
    ptyId,
    ptyGeneration: 0
  })
  return handle
}

function createStartingAttachment(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  dispatchId: string
): void {
  db.createRemoteDispatchAttachment({
    dispatchId,
    taskId: 'task_peer_mail',
    homePeerFingerprint: 'fp_home_peer',
    protocolVersion: 1,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: {
      callerFingerprint: 'fp_home_peer',
      requestId: `req_${dispatchId}`,
      method: 'orchestration.federationAttachStart',
      payloadHash: 'payload_hash'
    }
  })
}

describe('S10-19 W-3 review M4: sendPeerDispatchMailPointer marks ready only AFTER the write', () => {
  it('a successful mail insert + preamble write ends with the attachment ready', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const handle = registerAgentPtyAndGetHandle(runtime, 'pty-peer-mail-ok')
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'codex',
        confirmForegroundProcess: async () => 'codex',
        listProcesses: async () => []
      })
      const dispatchId = 'disp_peer_mail_ok'
      createStartingAttachment(db, runtime, dispatchId)
      expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('starting')

      // [R200 / INV-P-LAUNCH-EDGE] a launched Claude pane is ready only on its own prompt
      // evidence, not on the foreground process alone.
      runtime.onPtyData('pty-peer-mail-ok', '\x1b]0;✳ peer\x07', 100)

      await sendPeerDispatchMailPointer({
        db,
        runtime,
        dispatchId,
        taskId: 'task_peer_mail',
        taskSpec: 'do the thing',
        terminalHandle: handle,
        effects: []
      })

      const row = db.getRemoteDispatchAttachment(dispatchId)
      expect(row?.state).toBe('ready')
    } finally {
      db.close()
    }
  }, 10_000)

  it('review M4: a preamble write failure leaves the row in "starting" — never marked ready — so failRemoteAttachment can still act', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const handle = registerAgentPtyAndGetHandle(runtime, 'pty-peer-mail-write-fail')
      // Foreground never live — the write's beforeWrite conjunct (M6) always refuses.
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'bash',
        confirmForegroundProcess: async () => 'bash',
        listProcesses: async () => []
      })
      const dispatchId = 'disp_peer_mail_write_fail'
      createStartingAttachment(db, runtime, dispatchId)

      await expect(
        sendPeerDispatchMailPointer({
          db,
          runtime,
          dispatchId,
          taskId: 'task_peer_mail',
          taskSpec: 'do the thing',
          terminalHandle: handle,
          effects: []
        })
      ).rejects.toThrow()

      const row = db.getRemoteDispatchAttachment(dispatchId)
      expect(row?.state).toBe('starting')
      // The row being still 'starting' is exactly what lets the RPC handler's catch route this
      // through failRemoteAttachment (WHERE state = 'starting') to a receipt instead of throwing
      // dispatch_inactive out of the handler (review finding 4's silent-orphan class).
      expect(() => db.failRemoteAttachment(dispatchId, 'input', 'x', false)).not.toThrow()
      expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('failed')
    } finally {
      db.close()
    }
  }, 10_000)
})

describe('S10-19 W-3 review M6: the peer preamble write carries the same fresh-foreground conjunct as the FULL paste', () => {
  it('a foreground that is not the agent refuses the preamble write rather than typing the host-constant pointer blind', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const handle = registerAgentPtyAndGetHandle(runtime, 'pty-peer-mail-guard')
      const writes: string[] = []
      runtime.setPtyController({
        write: (_id, data) => {
          writes.push(data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'bash',
        confirmForegroundProcess: async () => 'bash', // a login shell, not the agent
        listProcesses: async () => []
      })
      const dispatchId = 'disp_peer_mail_guard'
      createStartingAttachment(db, runtime, dispatchId)

      await expect(
        sendPeerDispatchMailPointer({
          db,
          runtime,
          dispatchId,
          taskId: 'task_peer_mail',
          taskSpec: 'do the thing',
          terminalHandle: handle,
          effects: []
        })
      ).rejects.toThrow('agent_not_live')

      // Nothing reached the pane — the guard fires before the first byte of the preamble.
      expect(writes).toHaveLength(0)
    } finally {
      db.close()
    }
  }, 10_000)

  it('a live agent foreground lets the host-constant preamble through', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const handle = registerAgentPtyAndGetHandle(runtime, 'pty-peer-mail-live')
      const writes: string[] = []
      runtime.setPtyController({
        write: (_id, data) => {
          writes.push(data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'codex',
        confirmForegroundProcess: async () => 'codex',
        listProcesses: async () => []
      })
      const dispatchId = 'disp_peer_mail_live'
      createStartingAttachment(db, runtime, dispatchId)

      // [R200 / INV-P-LAUNCH-EDGE] a launched Claude pane is ready only on its own prompt
      // evidence, not on the foreground process alone.
      runtime.onPtyData('pty-peer-mail-live', '\x1b]0;✳ peer\x07', 100)

      await sendPeerDispatchMailPointer({
        db,
        runtime,
        dispatchId,
        taskId: 'task_peer_mail',
        taskSpec: 'do the thing',
        terminalHandle: handle,
        effects: []
      })

      expect(writes.length).toBeGreaterThan(0)
      expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('ready')
    } finally {
      db.close()
    }
  }, 10_000)
})

describe('R203 T-Q: sendFullDispatchPaste awaits the launch-prompt fence with a bounded, remaining budget', () => {
  it('the fence clears mid-wait — the promise resolves, exactly one paste and one submit are written', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const ptyId = 'pty-full-paste-fenced-clear'
      const handle = registerFencedClaudePtyAndGetHandle(runtime, ptyId)
      const writes: string[] = []
      runtime.setPtyController({
        write: (_id, data) => {
          writes.push(data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'claude',
        confirmForegroundProcess: async () => 'claude',
        listProcesses: async () => []
      })
      const dispatchId = 'disp_full_paste_fenced_clear'
      createStartingAttachment(db, runtime, dispatchId)

      const sendPromise = sendFullDispatchPaste({
        db,
        runtime,
        dispatchId,
        taskId: 'task_full_paste',
        taskSpec: 'do the thing',
        terminalHandle: handle,
        effects: [],
        awaitLaunchPromptFenceMs: 60_000
      })

      // t=2s: the agent's own prompt evidence clears the fence while the bounded wait is
      // still polling (every 250ms).
      await vi.advanceTimersByTimeAsync(2_000)
      const pty = (
        runtime as unknown as {
          ptysById: Map<string, { launchPromptFenceSince: number | null }>
        }
      ).ptysById.get(ptyId)
      if (!pty) {
        throw new Error('fixture setup failed: no pty record for ptyId')
      }
      pty.launchPromptFenceSince = null

      // The poll notices the clear within 250ms, then writeTerminalAgentPrompt's own Claude
      // render gate runs its 8s hard timeout (no render marker in this fixture).
      await vi.advanceTimersByTimeAsync(8_500)
      await sendPromise

      const submitWrites = writes.filter((w) => w === AGENT_PROMPT_SUBMIT)
      const pasteWrites = writes.filter((w) => w.includes('do the thing'))
      expect(pasteWrites).toHaveLength(1)
      expect(submitWrites).toHaveLength(1)
      expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('ready')
    } finally {
      db.close()
    }
  }, 15_000)

  it('the budget is exhausted with the fence still held — rejects terminal_awaiting_launch_prompt, nothing written', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    try {
      runtime.setOrchestrationDb(db)
      const ptyId = 'pty-full-paste-fenced-timeout'
      const handle = registerFencedClaudePtyAndGetHandle(runtime, ptyId)
      const writes: string[] = []
      runtime.setPtyController({
        write: (_id, data) => {
          writes.push(data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => 'claude',
        confirmForegroundProcess: async () => 'claude',
        listProcesses: async () => []
      })
      const dispatchId = 'disp_full_paste_fenced_timeout'
      createStartingAttachment(db, runtime, dispatchId)

      const sendPromise = sendFullDispatchPaste({
        db,
        runtime,
        dispatchId,
        taskId: 'task_full_paste',
        taskSpec: 'do the thing',
        terminalHandle: handle,
        effects: [],
        awaitLaunchPromptFenceMs: 3_000
      })
      const rejection = expect(sendPromise).rejects.toThrow('terminal_awaiting_launch_prompt')

      // Fence never clears — budget exhausted.
      await vi.advanceTimersByTimeAsync(3_000)
      await rejection

      expect(writes).toHaveLength(0)
      expect(db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('starting')
    } finally {
      db.close()
    }
  }, 15_000)
})
