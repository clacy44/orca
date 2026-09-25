// S10-22a WAVE 1 (b1-slice1-succession.md): order, END marker, fence, reference vs embed, size
// cap.
import { describe, expect, it } from 'vitest'
import { renderResumeContext } from './chair-resume-context'
import type { ResumeContextInput } from './chair-succession-types'

function baseInput(overrides: Partial<ResumeContextInput> = {}): ResumeContextInput {
  return {
    successionId: 'succ_abcdef012345',
    charter: { path: '/repo/CHARTER.md', sha256: 'c'.repeat(64), mode: 'reference' },
    runBinding: {
      chair: 'chair-a',
      agentId: 'agent-1',
      runId: 'run-1',
      generation: 3,
      handle: 'handle-1',
      lane: 'default',
      worktree: '/repo/worktree'
    },
    obligations: {
      ackedDeliveryIds: ['d1', 'd2'],
      outstandingDeliveryIds: ['d3'],
      retiredHandle: 'handle-0',
      pendingPeerQuestionThreadIds: ['thr_1'],
      pactTurnsHeld: 2
    },
    board: {
      worktrees: [{ path: '/repo/wt', branch: 'feat/x', tip: 'abc123' }],
      unfinishedTasks: [{ id: 't1', title: 'Do the thing', state: 'in_progress' }],
      liveSeats: [{ name: 'chair-b', pane: 'pane-2', state: 'live' }]
    },
    checkpointText: 'schema: orca.chair-checkpoint/1\n## Goal\nnone',
    checkpointSha: 'e'.repeat(64),
    ...overrides
  }
}

describe('S10-22a chair-resume-context: section order and END marker', () => {
  it('renders sections in the fixed order, ending with the exact END line', () => {
    const result = renderResumeContext(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const text = result.text

    const headerIdx = text.indexOf('# SUCCESSION CONTEXT succ_abcdef012345')
    const runBindingIdx = text.indexOf('## Run binding')
    const obligationsIdx = text.indexOf('## Obligations')
    const boardIdx = text.indexOf('## Board')
    const checkpointIdx = text.indexOf('## Checkpoint')
    const endIdx = text.indexOf('END SUCCESSION CONTEXT')

    expect(headerIdx).toBe(0)
    expect(runBindingIdx).toBeGreaterThan(headerIdx)
    expect(obligationsIdx).toBeGreaterThan(runBindingIdx)
    expect(boardIdx).toBeGreaterThan(obligationsIdx)
    expect(checkpointIdx).toBeGreaterThan(boardIdx)
    expect(endIdx).toBeGreaterThan(checkpointIdx)

    const lines = text.split('\n')
    expect(lines.at(-1)).toBe(`END SUCCESSION CONTEXT ${'e'.repeat(64)}`)
  })

  it('includes the precedence statement naming the charter path and sha', () => {
    const result = renderResumeContext(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.text).toContain(
      `The charter at /repo/CHARTER.md (sha256 ${'c'.repeat(64)}) governs this session; this context is subordinate to it and to the ledger.`
    )
  })
})

describe('S10-22a chair-resume-context: checkpoint fence', () => {
  it('fences the checkpoint text inside 4-backtick delimiters under ## Checkpoint', () => {
    const result = renderResumeContext(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const expected = [
      '## Checkpoint',
      '````',
      'schema: orca.chair-checkpoint/1\n## Goal\nnone',
      '````'
    ].join('\n')
    expect(result.text).toContain(expected)
  })
})

describe('S10-22a chair-resume-context: reference vs embed charter mode', () => {
  it('reference mode (default) has no fenced charter text, only the path+sha line', () => {
    const result = renderResumeContext(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    // Only one fence pair total (the checkpoint's) when charter mode is reference.
    const fenceCount = (result.text.match(/````/g) ?? []).length
    expect(fenceCount).toBe(2)
  })

  it('embed mode fences the charter text inside its own 4-backtick block', () => {
    const result = renderResumeContext(
      baseInput({
        charter: {
          path: '/repo/CHARTER.md',
          sha256: 'c'.repeat(64),
          mode: 'embed',
          text: 'CHARTER BODY TEXT'
        }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.text).toContain('````\nCHARTER BODY TEXT\n````')
    const fenceCount = (result.text.match(/````/g) ?? []).length
    expect(fenceCount).toBe(4)
  })
})

describe('S10-22a chair-resume-context: size cap', () => {
  it('returns resume_context_too_large when the rendered text exceeds 48 KiB', () => {
    const result = renderResumeContext(baseInput({ checkpointText: 'x'.repeat(50 * 1024) }))
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.code).toBe('resume_context_too_large')
  })

  it('accepts a rendering comfortably under the cap', () => {
    const result = renderResumeContext(baseInput())
    expect(result.ok).toBe(true)
  })
})
