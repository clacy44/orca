// S10-22a WAVE 1 (b1-slice1-succession.md; D-R215 §Protocol step 3, amendment A6b): the resume
// context renderer. Pure — no I/O, no clock, no randomness — so `chair-succession-store.ts` can
// render at seal time and `chair-resume-context.test.ts` can assert the exact text.
import type { ResumeContextInput } from './chair-succession-types'

export const RESUME_CONTEXT_MAX_BYTES = 48 * 1024
const FENCE = '````'

export type RenderResumeContextError = {
  code: 'resume_context_too_large'
  reason: string
}

export type RenderResumeContextResult =
  | { ok: true; text: string }
  | { ok: false; error: RenderResumeContextError }

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.join(', ') : 'none'
}

function renderCharterBlock(input: ResumeContextInput): string {
  const { charter } = input
  const header = `# SUCCESSION CONTEXT ${input.successionId}`
  const precedence = `The charter at ${charter.path} (sha256 ${charter.sha256}) governs this session; this context is subordinate to it and to the ledger.`
  if (charter.mode === 'reference') {
    return `${header}\n${precedence}`
  }
  return `${header}\n${precedence}\n\n${FENCE}\n${charter.text ?? ''}\n${FENCE}`
}

function renderRunBinding(input: ResumeContextInput): string {
  const { runBinding } = input
  return [
    '## Run binding',
    `Chair: ${runBinding.chair}`,
    `Agent id: ${runBinding.agentId}`,
    `Run id: ${runBinding.runId}`,
    `Generation: ${runBinding.generation}`,
    `Handle: ${runBinding.handle}`,
    `Lane: ${runBinding.lane}`,
    `Worktree: ${runBinding.worktree}`
  ].join('\n')
}

function renderObligations(input: ResumeContextInput): string {
  const { obligations } = input
  return [
    '## Obligations',
    `Acked deliveries: ${listOrNone(obligations.ackedDeliveryIds)}`,
    `Outstanding deliveries: ${listOrNone(obligations.outstandingDeliveryIds)}`,
    `Retired handle: ${obligations.retiredHandle ?? 'none'}`,
    `Pending peer question threads: ${listOrNone(obligations.pendingPeerQuestionThreadIds)}`,
    `Pact turns held: ${obligations.pactTurnsHeld}`
  ].join('\n')
}

function renderBoard(input: ResumeContextInput): string {
  const { board } = input
  const worktrees =
    board.worktrees.length > 0
      ? board.worktrees.map((w) => `- ${w.path} (${w.branch} @ ${w.tip})`).join('\n')
      : '- none'
  const tasks =
    board.unfinishedTasks.length > 0
      ? board.unfinishedTasks.map((t) => `- ${t.id} ${t.title} [${t.state}]`).join('\n')
      : '- none'
  const seats =
    board.liveSeats.length > 0
      ? board.liveSeats.map((s) => `- ${s.name} ${s.pane} [${s.state}]`).join('\n')
      : '- none'
  return [
    '## Board',
    'Worktrees:',
    worktrees,
    'Unfinished tasks:',
    tasks,
    'Live seats:',
    seats
  ].join('\n')
}

function renderCheckpoint(input: ResumeContextInput): string {
  return ['## Checkpoint', FENCE, input.checkpointText, FENCE].join('\n')
}

/** Renders the full resume context. Section order and the END marker are fixed by the brief —
 * do not reorder without updating `chair-resume-context.test.ts`. */
export function renderResumeContext(input: ResumeContextInput): RenderResumeContextResult {
  const text = [
    renderCharterBlock(input),
    renderRunBinding(input),
    renderObligations(input),
    renderBoard(input),
    renderCheckpoint(input),
    `END SUCCESSION CONTEXT ${input.checkpointSha}`
  ].join('\n\n')

  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > RESUME_CONTEXT_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'resume_context_too_large',
        reason: `rendered resume context is ${bytes} bytes, exceeds ${RESUME_CONTEXT_MAX_BYTES}`
      }
    }
  }
  return { ok: true, text }
}
