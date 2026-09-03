// Ruling 32 Addendum 10 (B3/F-17): orchestration.check silently fell through to the bare-handle
// branch and read `--terminal`'s literal mailbox whenever the attested caller's live pane
// resolved to a DIFFERENT terminal handle (a stale `--terminal`) — even though the caller has a
// registered, addressable `agent:<id>` mailbox this call never touched. This proves the loud
// notice + `mailbox` field fire instead of a silent empty read.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { OrchestrationDb, PEER_RUN_ID } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'

const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const EVIDENCE_B = { terminalHandle: 'term_b', paneKey: PANE_B, launchToken: 'token-b' }

function makeAuthority(): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey: PANE_B,
    terminalHandle: 'term_b',
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

describe('orchestration.check: attestation/pane-key mismatch (Ruling 32 Addendum 10 B3)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let agentId: string
  const ctx: RpcContext = { orchestrationCompatibilityEvidence: EVIDENCE_B } as RpcContext

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

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_b' ? PANE_B : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('proc-1')
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === EVIDENCE_B.terminalHandle &&
        evidence.paneKey === EVIDENCE_B.paneKey &&
        evidence.launchToken
      ) {
        return makeAuthority()
      }
      return null
    })
    ;(ctx as { runtime: OrcaRuntimeService }).runtime = runtime

    const created = db.upsertAgentByPaneSuffix({
      displayName: 'peer-b',
      role: 'peer agent',
      hostId: 'local',
      paneKey: PANE_B,
      terminalHandle: 'term_b',
      processIncarnation: 'proc-1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_b',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed: name_taken')
    }
    agentId = created.agent.id
  }

  afterEach(() => {
    db?.close()
  })

  it('T-B3: a mismatched --terminal reports the loud notice and the mailbox actually read, instead of a silent empty result', async () => {
    setup()
    // Mail addressed straight to the registered agent's own durable mailbox — proves the check
    // below genuinely skipped it rather than merely finding nothing.
    db.insertGatedMessage({
      from: 'someone',
      to: `agent:${agentId}`,
      subject: 'you have not seen this',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })

    const result = (await call('orchestration.check', { terminal: 'term_c' })) as {
      mailbox?: string
      mailboxMismatchNotice?: string
      count: number
    }
    expect(result.mailbox).toBe('term_c')
    expect(result.mailboxMismatchNotice).toBeDefined()
    expect(result.mailboxMismatchNotice).toContain(`agent:${agentId}`)
    expect(result.mailboxMismatchNotice).toContain('term_c')
    // The bare `term_c` mailbox genuinely has nothing — the notice is what proves the skip, not
    // a nonzero count on the wrong mailbox.
    expect(result.count).toBe(0)
  })

  it('a matching --terminal reads the real agent:<id> mailbox and carries no mismatch notice', async () => {
    setup()
    db.insertGatedMessage({
      from: 'someone',
      to: `agent:${agentId}`,
      subject: 'hello',
      type: 'status',
      priority: 'normal',
      runId: PEER_RUN_ID
    })

    const result = (await call('orchestration.check', { terminal: 'term_b' })) as {
      mailboxMismatchNotice?: string
      count: number
    }
    expect(result.mailboxMismatchNotice).toBeUndefined()
    expect(result.count).toBe(1)
  })
})
