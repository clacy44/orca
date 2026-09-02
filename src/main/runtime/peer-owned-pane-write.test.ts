// S10-19 W-4 (INV-P-013/R21): the choke. T-1..T-12 (scoped to what this tree evidences — see
// PEER_PROMPT_KEYSTROKES's own doc comment for the authored-cell scope).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_TUI_AGENTS } from '../../shared/tui-agent-display-names'
import { RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import {
  PEER_PROMPT_KEYSTROKES,
  writeToPeerOwnedPane,
  type PeerPromptChoice
} from './peer-owned-pane-write'
import { peerRefusal } from './runtime-peer-rpc-allowlist'

function rawDb(db: OrchestrationDb): {
  prepare: (sql: string) => {
    run: (...args: unknown[]) => unknown
    get: (...args: unknown[]) => unknown
  }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}

function insertPeerAttachment(
  db: OrchestrationDb,
  dispatchId: string,
  overrides: Partial<{
    homeFingerprint: string
    terminalHandle: string
    runtimeEpoch: string
    agentExitedAt: string | null
    blockedConsumedAt: string | null
  }> = {}
): void {
  rawDb(db)
    .prepare(
      `INSERT INTO remote_dispatch_attachments
         (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, stage,
          terminal_handle, agent_exited_at, blocked_consumed_at)
       VALUES (?, 'task_x', ?, ?, 'ready', 'input_accepted', ?, ?, ?)`
    )
    .run(
      dispatchId,
      overrides.homeFingerprint ?? 'fp_peer',
      overrides.runtimeEpoch ?? 'epoch-current',
      overrides.terminalHandle ?? 'term_peer',
      overrides.agentExitedAt ?? null,
      overrides.blockedConsumedAt ?? null
    )
}

function setup(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('epoch-current')
  return { db, runtime }
}

describe('S10-19 W-4: writeToPeerOwnedPane happy paths (T-1)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('codex accept_trust writes {text:"1",enter:true} and reserves the single shot', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_codex1')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: 'codex'
    })
    const sendTerminal = vi.spyOn(s.runtime, 'sendTerminal').mockResolvedValue({
      handle: 'term_peer',
      accepted: true,
      bytesWritten: 1
    })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_codex1',
      choice: 'accept_trust'
    })
    expect(result).toEqual({ refused: false })
    expect(sendTerminal).toHaveBeenCalledWith('term_peer', { text: '1', enter: true })
    const row = db.getRemoteDispatchAttachment('disp_codex1')
    expect(row?.blocked_consumed_at).not.toBeNull()
  })

  it('codex decline writes {text:"2",enter:true}', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_codex2')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: 'codex'
    })
    const sendTerminal = vi.spyOn(s.runtime, 'sendTerminal').mockResolvedValue({
      handle: 'term_peer',
      accepted: true,
      bytesWritten: 1
    })
    await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_codex2',
      choice: 'decline'
    })
    expect(sendTerminal).toHaveBeenCalledWith('term_peer', { text: '2', enter: true })
  })

  it('claude accept_trust writes {text:"y",enter:true}', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_claude1')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: 'claude'
    })
    const sendTerminal = vi.spyOn(s.runtime, 'sendTerminal').mockResolvedValue({
      handle: 'term_peer',
      accepted: true,
      bytesWritten: 1
    })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_claude1',
      choice: 'accept_trust'
    })
    expect(result).toEqual({ refused: false })
    expect(sendTerminal).toHaveBeenCalledWith('term_peer', { text: 'y', enter: true })
  })
})

describe('S10-19 W-4: refusals (T-2, T-3)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('claude decline is refused prompt_state_unknown, never guessed', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_claude_decline')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: 'claude'
    })
    const sendTerminal = vi.spyOn(s.runtime, 'sendTerminal')
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_claude_decline',
      choice: 'decline'
    })
    expect(result).toMatchObject({ refused: true, code: 'prompt_state_unknown' })
    expect(sendTerminal).not.toHaveBeenCalled()
  })

  it('an unauthored agent (e.g. gemini) refuses prompt_state_unknown', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_gemini')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: 'gemini'
    })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_gemini',
      choice: 'accept_trust'
    })
    expect(result).toMatchObject({ refused: true, code: 'prompt_state_unknown' })
  })

  it('agent: null refuses prompt_state_unknown', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_nullagent')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: null
    })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_nullagent',
      choice: 'accept_trust'
    })
    expect(result).toMatchObject({ refused: true, code: 'prompt_state_unknown' })
  })

  it("state 'clear' refuses prompt_not_present", async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_clear')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({ state: 'clear' })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_clear',
      choice: 'accept_trust'
    })
    expect(result).toMatchObject({ refused: true, code: 'prompt_not_present' })
  })

  it("state 'unknown' refuses prompt_state_unknown", async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_unk')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({ state: 'unknown' })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_unk',
      choice: 'accept_trust'
    })
    expect(result).toMatchObject({ refused: true, code: 'prompt_state_unknown' })
  })

  it('a non-owning caller (fingerprint mismatch) refuses pane_not_peer_owned', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_other', { homeFingerprint: 'fp_someone_else' })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_other',
      choice: 'accept_trust'
    })
    expect(result).toMatchObject({ refused: true, code: 'pane_not_peer_owned' })
  })

  it('T-3: refusal envelopes share the exact shape the ONE builder produces', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_shape')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({ state: 'clear' })
    const result = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_shape',
      choice: 'accept_trust'
    })
    expect(result).toEqual(
      peerRefusal('prompt_not_present', `Dispatch disp_shape has no prompt awaiting an answer.`)
    )
  })
})

describe('S10-19 W-4: single-shot reservation (T-5, T-5d, T-5r)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('T-5: a second call after a successful answer refuses prompt_already_answered, never re-writes', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_twice')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: 'codex'
    })
    const sendTerminal = vi.spyOn(s.runtime, 'sendTerminal').mockResolvedValue({
      handle: 'term_peer',
      accepted: true,
      bytesWritten: 1
    })
    const first = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_twice',
      choice: 'accept_trust'
    })
    expect(first).toEqual({ refused: false })
    const second = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_twice',
      choice: 'accept_trust'
    })
    expect(second).toMatchObject({ refused: true, code: 'prompt_already_answered' })
    expect(sendTerminal).toHaveBeenCalledTimes(1)
  })

  it('T-5d/T-5r: a write failure releases the shot — a retried call can still succeed', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_retry')
    vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
      state: 'blocked',
      reason: 'codex-trust-workspace',
      agent: 'codex'
    })
    // Three sendTerminal calls total: the failed keystroke write, the guarded recovery
    // interrupt writeToPeerOwnedPane's own catch attempts after it, and the retried keystroke
    // write — all three resolve/reject via this queue, in that order.
    const sendTerminal = vi
      .spyOn(s.runtime, 'sendTerminal')
      .mockRejectedValueOnce(new Error('terminal_not_writable'))
      .mockResolvedValueOnce({ handle: 'term_peer', accepted: true, bytesWritten: 1 })
      .mockResolvedValueOnce({ handle: 'term_peer', accepted: true, bytesWritten: 1 })
    const first = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_retry',
      choice: 'accept_trust'
    })
    expect(first).toMatchObject({ refused: true, code: 'pane_write_unavailable' })
    expect(db.getRemoteDispatchAttachment('disp_retry')?.blocked_consumed_at).toBeNull()
    const second = await writeToPeerOwnedPane({
      ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
      dispatchId: 'disp_retry',
      choice: 'accept_trust'
    })
    expect(second).toEqual({ refused: false })
    expect(sendTerminal).toHaveBeenCalledTimes(3)
  })
})

describe('S10-19 W-4: T-6/T-6b/T-6c — the keystroke table is the only authority', () => {
  it('T-6: exactly the evidenced cells are authored (2 for codex, 1 for claude); every other of the 36×6×2 combinations is unauthored', () => {
    let authoredCount = 0
    for (const agent of ALL_TUI_AGENTS) {
      for (const reason of RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS) {
        for (const choice of ['accept_trust', 'decline'] as PeerPromptChoice[]) {
          if (PEER_PROMPT_KEYSTROKES[agent]?.[reason]?.[choice]) {
            authoredCount++
          }
        }
      }
    }
    expect(authoredCount).toBe(3)
  })

  it('T-6b: the authored cells are exactly codex/codex-trust-workspace/{accept_trust,decline} and claude/codex-trust-workspace/accept_trust', () => {
    expect(PEER_PROMPT_KEYSTROKES.codex?.['codex-trust-workspace']?.accept_trust).toEqual({
      text: '1',
      enter: true
    })
    expect(PEER_PROMPT_KEYSTROKES.codex?.['codex-trust-workspace']?.decline).toEqual({
      text: '2',
      enter: true
    })
    expect(PEER_PROMPT_KEYSTROKES.claude?.['codex-trust-workspace']?.accept_trust).toEqual({
      text: 'y',
      enter: true
    })
    expect(PEER_PROMPT_KEYSTROKES.claude?.['codex-trust-workspace']?.decline).toBeUndefined()
  })

  it('T-6c: writeToPeerOwnedPane drives the REAL table — deleting a cell from it changes the outcome', async () => {
    const s = setup()
    const db = s.db
    try {
      insertPeerAttachment(db, 'disp_realtable')
      vi.spyOn(s.runtime, 'getPeerPromptState').mockReturnValue({
        state: 'blocked',
        reason: 'codex-trust-workspace',
        agent: 'codex'
      })
      const sendTerminal = vi.spyOn(s.runtime, 'sendTerminal').mockResolvedValue({
        handle: 'term_peer',
        accepted: true,
        bytesWritten: 1
      })
      const saved = PEER_PROMPT_KEYSTROKES.codex!['codex-trust-workspace']!.accept_trust
      delete (PEER_PROMPT_KEYSTROKES.codex!['codex-trust-workspace'] as Record<string, unknown>)
        .accept_trust
      try {
        const result = await writeToPeerOwnedPane({
          ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
          dispatchId: 'disp_realtable',
          choice: 'accept_trust'
        })
        expect(result).toMatchObject({ refused: true, code: 'prompt_state_unknown' })
        expect(sendTerminal).not.toHaveBeenCalled()
      } finally {
        ;(
          PEER_PROMPT_KEYSTROKES.codex!['codex-trust-workspace'] as Record<string, unknown>
        ).accept_trust = saved
      }
    } finally {
      db.close()
      vi.restoreAllMocks()
    }
  })
})

describe('S10-19 W-4: rebind guard (T-7, T-11)', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('T-7: assertPeerPaneStillBound throws PeerPaneReboundError when the row has rebound to a different handle', async () => {
    const s = setup()
    db = s.db
    insertPeerAttachment(db, 'disp_rebind', { terminalHandle: 'term_original' })
    const { assertPeerPaneStillBound } = await import('./peer-owned-pane-write')
    expect(() => assertPeerPaneStillBound(s.runtime, 'disp_rebind', 'term_original')).not.toThrow()
    rawDb(db)
      .prepare(`UPDATE remote_dispatch_attachments SET terminal_handle = ? WHERE dispatch_id = ?`)
      .run('term_rebound', 'disp_rebind')
    expect(() => assertPeerPaneStillBound(s.runtime, 'disp_rebind', 'term_original')).toThrow()
  })
})

describe('S10-19 W-4: T-8, T-D1', () => {
  it('T-D1: the shared blocked-reason detector functions are untouched (structural — imported symbols still resolve)', async () => {
    const module = await import('./orca-runtime')
    expect(typeof module.OrcaRuntimeService.prototype.getTerminalWaitEvidence).toBe('function')
    expect(typeof module.OrcaRuntimeService.prototype.getPeerPromptState).toBe('function')
    expect(typeof module.OrcaRuntimeService.prototype.findPeerDismissedStartupModalIndex).toBe(
      'function'
    )
  })

  it('T-8: an attachment with no bound terminal_handle refuses pane_not_peer_owned rather than throwing', async () => {
    const s = setup()
    try {
      insertPeerAttachment(s.db, 'disp_nohandle')
      rawDb(s.db)
        .prepare(
          `UPDATE remote_dispatch_attachments SET terminal_handle = NULL WHERE dispatch_id = ?`
        )
        .run('disp_nohandle')
      const result = await writeToPeerOwnedPane({
        ctx: { runtime: s.runtime, callerFingerprint: 'fp_peer' },
        dispatchId: 'disp_nohandle',
        choice: 'accept_trust'
      })
      expect(result).toMatchObject({ refused: true, code: 'pane_not_peer_owned' })
    } finally {
      s.db.close()
    }
  })
})
