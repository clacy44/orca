import { describe, expect, it } from 'vitest'

import {
  formatHeartbeatAge,
  formatOrchestrationWorkerShow,
  type OrchestrationWorkerShowResult
} from './orchestration-worker-show-format'

const BASE: OrchestrationWorkerShowResult = {
  dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' },
  worker: { state: 'ready', stage: 'input_accepted', agent_terminal_handle: 'term_worker' }
}

function lines(result: OrchestrationWorkerShowResult): string[] {
  return formatOrchestrationWorkerShow(result).split('\n')
}

describe('formatHeartbeatAge', () => {
  it('reports minutes under an hour and hours above it', () => {
    expect(formatHeartbeatAge(12 * 60_000)).toBe('12m')
    expect(formatHeartbeatAge(90 * 60_000)).toBe('1h30m')
    expect(formatHeartbeatAge(2_000)).toBe('0m')
  })
})

describe('formatOrchestrationWorkerShow', () => {
  it('keeps the pre-existing header line first', () => {
    expect(lines(BASE)[0]).toBe('ctx_1 task=task_1 [ready] stage=input_accepted')
  })

  it('renders the terminal line when the observation is exact', () => {
    const rendered = lines({
      ...BASE,
      terminal: { lastOutputAt: Date.parse('2026-08-21T09:00:00Z') },
      observation: { status: 'running', exactWorker: true, agentStatus: 'working' }
    })

    expect(rendered[1]).toBe(
      'terminal: status=running lastOutputAt=2026-08-21T09:00:00.000Z agent=working'
    )
  })

  it('names the gate and how long it has stood', () => {
    const rendered = lines({
      ...BASE,
      terminal: { lastOutputAt: Date.parse('2026-08-21T09:00:00Z') },
      observation: {
        status: 'running',
        exactWorker: true,
        agentStatus: 'permission',
        blockedSince: '2026-08-21T08:55:00.000Z'
      }
    })

    expect(rendered[1]).toBe(
      'terminal: status=running lastOutputAt=2026-08-21T09:00:00.000Z agent=permission blockedSince=2026-08-21T08:55:00.000Z'
    )
  })

  it('renders an absent agent verdict as unknown, never as stuck', () => {
    const rendered = lines({
      ...BASE,
      terminal: { lastOutputAt: null },
      observation: { status: 'running', exactWorker: true }
    })

    expect(rendered[1]).toBe('terminal: status=running lastOutputAt=never agent=unknown')
  })

  it('drops the terminal line for a non-exact observation', () => {
    const rendered = lines({
      ...BASE,
      terminal: null,
      observation: { status: 'identity_changed', exactWorker: false }
    })

    expect(rendered.some((line) => line.startsWith('terminal:'))).toBe(false)
  })

  it('renders never rather than an age of zero for a worker that has not heartbeated', () => {
    expect(lines(BASE)).toContain('liveness: lastHeartbeat=never')
  })

  it('renders the heartbeat and its age', () => {
    const rendered = lines({
      ...BASE,
      lastHeartbeatAt: '2026-08-21T09:00:00.000Z',
      heartbeatAgeMs: 12 * 60_000
    })

    expect(rendered).toContain('liveness: lastHeartbeat=2026-08-21T09:00:00.000Z age=12m')
  })

  it('stays terse when there is no mail', () => {
    expect(
      lines({ ...BASE, dispatchMailbox: { unread: 0, deliverable: true } }).some((line) =>
        line.startsWith('mail:')
      )
    ).toBe(false)
    expect(
      lines({ ...BASE, workerMail: { pending: 0, deliverable: true } }).some((line) =>
        line.startsWith('mail:')
      )
    ).toBe(false)
  })

  it('says unread for the local mailbox and pending for the federated relay queue', () => {
    expect(lines({ ...BASE, dispatchMailbox: { unread: 2, deliverable: true } })).toContain(
      'mail: unread=2 deliverable=true'
    )
    expect(lines({ ...BASE, workerMail: { pending: 2, deliverable: true } })).toContain(
      'mail: pending=2 deliverable=true'
    )
  })

  it('calls out mail stranded behind a settlement', () => {
    expect(lines({ ...BASE, dispatchMailbox: { unread: 1, deliverable: false } })).toContain(
      'mail: unread=1 deliverable=false — STRANDED: this mail is queued for a Dispatch whose worker no longer reads it'
    )
  })

  it('keeps the federated sync line and its error', () => {
    expect(
      lines({
        ...BASE,
        sync: { lastSyncAt: null, lastError: 'ECONNREFUSED', consecutiveFailures: 5 }
      })
    ).toContain('sync: lastSyncAt=never consecutiveFailures=5 lastError=ECONNREFUSED')
  })

  it('renders an unrecognized peer verdict as unknown without forging a line', () => {
    const rendered = lines({
      ...BASE,
      terminal: { lastOutputAt: Date.parse('2026-08-21T09:00:00Z') },
      observation: {
        status: 'running',
        exactWorker: true,
        agentStatus: 'stalled\nliveness: worker is dead'
      }
    })

    expect(rendered[1]).toBe(
      'terminal: status=running lastOutputAt=2026-08-21T09:00:00.000Z agent=unknown'
    )
    expect(rendered.some((line) => line.startsWith('liveness: worker is dead'))).toBe(false)
    expect(rendered).toEqual([
      'ctx_1 task=task_1 [ready] stage=input_accepted',
      'terminal: status=running lastOutputAt=2026-08-21T09:00:00.000Z agent=unknown',
      'liveness: lastHeartbeat=never'
    ])
  })

  it('renders an unrecognized peer terminal status as unknown', () => {
    expect(
      lines({
        ...BASE,
        terminal: { lastOutputAt: null },
        observation: { status: 'quarantined\nmail: unread=99', exactWorker: true }
      })[1]
    ).toBe('terminal: status=unknown lastOutputAt=never agent=unknown')
  })

  it('drops a blockedSince the peer did not send as a timestamp', () => {
    expect(
      lines({
        ...BASE,
        terminal: { lastOutputAt: null },
        observation: {
          status: 'running',
          exactWorker: true,
          agentStatus: 'permission',
          blockedSince: 'a while ago'
        }
      })[1]
    ).toBe('terminal: status=running lastOutputAt=never agent=permission')
  })

  it('renders never rather than throwing on a peer lastOutputAt that is not a number', () => {
    expect(
      lines({
        ...BASE,
        terminal: {
          lastOutputAt: 'yesterday'
        } as unknown as OrchestrationWorkerShowResult['terminal'],
        observation: { status: 'running', exactWorker: true }
      })[1]
    ).toBe('terminal: status=running lastOutputAt=never agent=unknown')
  })

  it('never dumps the terminal preview into text mode', () => {
    const rendered = formatOrchestrationWorkerShow({
      ...BASE,
      terminal: {
        lastOutputAt: Date.parse('2026-08-21T09:00:00Z'),
        preview: 'x'.repeat(5_000)
      } as OrchestrationWorkerShowResult['terminal'],
      observation: { status: 'running', exactWorker: true, agentStatus: 'working' }
    })

    expect(rendered).not.toContain('xxxx')
  })

  it('names the gate that was on screen when the dispatch prompt was written', () => {
    const rendered = lines({
      ...BASE,
      worker: {
        ...BASE.worker,
        inputEvidence: {
          submittedAt: '2026-08-22T12:00:00.000Z',
          blockedReason: 'codex-trust-workspace'
        }
      }
    })

    expect(rendered).toContain(
      'input: submittedAt=2026-08-22T12:00:00.000Z blockedReason=codex-trust-workspace — ' +
        'a gate was already on screen when the dispatch prompt was written'
    )
  })

  it('says nothing about a submit that saw no gate', () => {
    expect(
      formatOrchestrationWorkerShow({
        ...BASE,
        worker: {
          ...BASE.worker,
          inputEvidence: { submittedAt: '2026-08-22T12:00:00.000Z' }
        }
      })
    ).not.toContain('input:')
  })

  // Why: the field crosses the wire from a peer, so a class a newer peer invented must not render
  // on the home as though the home's own six-value vocabulary had grown.
  it('drops a blockedReason outside the six shipped values', () => {
    expect(
      formatOrchestrationWorkerShow({
        ...BASE,
        worker: {
          ...BASE.worker,
          inputEvidence: {
            submittedAt: '2026-08-22T12:00:00.000Z',
            blockedReason: 'peer-invented-auth-gate'
          }
        }
      })
    ).not.toContain('input:')
  })
})
