import {
  RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS,
  type RuntimeTerminalWaitBlockedReason
} from '../../../shared/runtime-types'

// Why deliberately partial: this is one regex pass over the tail already in memory at the instant
// the prompt was submitted, so it can only name a gate that was already rendered by then (A1
// section 2). Absence is not evidence the input landed — the post-ready observer covers the rest.
export type DispatchInputEvidence = {
  submittedAt: string
  blockedReason?: RuntimeTerminalWaitBlockedReason
}

type TerminalWaitEvidenceReader = {
  getTerminalWaitEvidence: (
    handle: string
  ) => { tailText: string; blockedReason: RuntimeTerminalWaitBlockedReason | null } | null
}

// Why never throws: the submit already succeeded when this runs, so a failure to read the tail must
// leave the receipt reporting a submit with no gate, not fail a worker-start that worked.
export function captureDispatchInputEvidence(
  runtime: TerminalWaitEvidenceReader,
  terminalHandle: string,
  submittedAt: number = Date.now()
): DispatchInputEvidence {
  const evidence = { submittedAt: new Date(submittedAt).toISOString() }
  let blockedReason: RuntimeTerminalWaitBlockedReason | null = null
  try {
    blockedReason = runtime.getTerminalWaitEvidence(terminalHandle)?.blockedReason ?? null
  } catch {
    blockedReason = null
  }
  return blockedReason ? { ...evidence, blockedReason } : evidence
}

// Why a whitelist and not a cast: the column is written by this runtime but read back after a
// restart and, on the federated path, arrives from a peer — an unrecognized shape must read as
// absent rather than reach a coordinator as a fabricated verdict.
export function parseDispatchInputEvidence(value: unknown): DispatchInputEvidence | null {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown
          } catch {
            return null
          }
        })()
      : value
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const candidate = parsed as { submittedAt?: unknown; blockedReason?: unknown }
  if (
    typeof candidate.submittedAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.submittedAt))
  ) {
    return null
  }
  return typeof candidate.blockedReason === 'string' &&
    RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS.includes(
      candidate.blockedReason as RuntimeTerminalWaitBlockedReason
    )
    ? {
        submittedAt: candidate.submittedAt,
        blockedReason: candidate.blockedReason as RuntimeTerminalWaitBlockedReason
      }
    : { submittedAt: candidate.submittedAt }
}
