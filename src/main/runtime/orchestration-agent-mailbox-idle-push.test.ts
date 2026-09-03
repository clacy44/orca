// Ruling 32 Addendum 11 (F2/F-17): the idle-edge push (deliverPendingMessagesForLeaf/
// ...ForPty) resolved the bare handle, run: mailbox and dispatch: mailbox for a pane going
// busy->idle, but never agent:<id> — a registered pane's directory-addressed mail got no wake
// header on this edge, pull-only until its next `check`. This proves the resolver the wiring
// calls: a live, non-quarantined, non-derived, non-tombstoned registered pane resolves to its
// agent:<id> mailbox; every other state resolves to null (same guard `check`'s durable branch
// uses, orchestration.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'

type RuntimeInternals = {
  resolveAgentMailboxForPaneKey: (paneKey: string) => string | null
  deliverPendingMessagesForLeaf: (leaf: { tabId: string; leafId: string }) => void
  deliverPendingMessages: (target: unknown, options?: { mailboxHandle?: string }) => void
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

describe('resolveAgentMailboxForPaneKey (Ruling 32 Addendum 11 F2)', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  }

  afterEach(() => {
    db?.close()
  })

  it('resolves a live registered pane to its agent:<id> mailbox', () => {
    setup()
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'alpha',
      role: null,
      hostId: 'local',
      paneKey: 'tabA:leaf-aaa',
      terminalHandle: 'term_a',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_a',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    expect(internals(runtime).resolveAgentMailboxForPaneKey('tabA:leaf-aaa')).toBe(
      `agent:${created.agent.id}`
    )
  })

  it('resolves to null for a pane with no registered agent row at all', () => {
    setup()
    expect(internals(runtime).resolveAgentMailboxForPaneKey('tabZ:leaf-zzz')).toBeNull()
  })

  it('resolves to null for a quarantined agent row', () => {
    setup()
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'beta',
      role: null,
      hostId: 'local',
      paneKey: 'tabB:leaf-bbb',
      terminalHandle: 'term_b',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_b',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    db.setAgentQuarantine({ id: created.agent.id, quarantined: true, reasonCode: 'test' })
    expect(internals(runtime).resolveAgentMailboxForPaneKey('tabB:leaf-bbb')).toBeNull()
  })

  it('resolves to null for a derived row — the pane owner never opted in', () => {
    setup()
    db.upsertDerivedAgentForPane({
      hostId: 'local',
      paneKey: 'tabC:leaf-ccc',
      terminalHandle: 'term_c',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null
    })
    expect(internals(runtime).resolveAgentMailboxForPaneKey('tabC:leaf-ccc')).toBeNull()
  })

  it('resolves to null for a tombstoned (retired) row', () => {
    setup()
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'gamma',
      role: null,
      hostId: 'local',
      paneKey: 'tabD:leaf-ddd',
      terminalHandle: 'term_d',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_d',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    db.retireAgent(created.agent.id)
    expect(internals(runtime).resolveAgentMailboxForPaneKey('tabD:leaf-ddd')).toBeNull()
  })

  // H4d (Ruling 32 Addendum 13): the resolver alone is already proven above — this proves the
  // F2 WIRING itself, that deliverPendingMessagesForLeaf actually calls deliverPendingMessages
  // with mailboxHandle 'agent:<id>' for a registered pane (~:35103-35106).
  it('deliverPendingMessagesForLeaf calls deliverPendingMessages with mailboxHandle agent:<id> for a registered pane', () => {
    setup()
    const created = db.upsertAgentByPaneSuffix({
      displayName: 'delta',
      role: null,
      hostId: 'local',
      paneKey: 'tabE:leaf-eee',
      terminalHandle: 'term_e',
      processIncarnation: 'inc1',
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'term_e',
      originHostId: 'local'
    })
    if (created.outcome === 'name_taken') {
      throw new Error('fixture setup failed')
    }
    const deliver = vi
      .spyOn(internals(runtime), 'deliverPendingMessages')
      .mockImplementation(() => {})

    internals(runtime).deliverPendingMessagesForLeaf({ tabId: 'tabE', leafId: 'leaf-eee' })

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tabE', leafId: 'leaf-eee' }),
      { mailboxHandle: `agent:${created.agent.id}` }
    )
  })
})
