// S10-19 W-3 review M4/M6: sendPeerDispatchMailPointer is the real production caller
// federationAttachStart (orchestration-federation.ts:241) delegates to for the peer profile —
// this drives it directly against a real OrcaRuntimeService/OrchestrationDb/pty flight (not a
// mocked sendTerminalAgentPrompt), which is what actually exercises the write-then-ready
// ordering (M4) and the fresh-foreground beforeWrite conjunct (M6). Standing up the full
// federationAttachStart RPC handler (worktree resolution, capability minting) for equivalent
// coverage was judged disproportionate — this is the function the review cited by name and the
// one whose own internal ordering/conjunct the findings are about.
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { sendPeerDispatchMailPointer } from './orchestration-federation-dispatch-input-send'

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
