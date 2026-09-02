// S10-19 W-4 (INV-P-013/R21, chair rulings 20/22/24): the choke. One function may put
// peer-selected input on a PTY — writeToPeerOwnedPane — and its whole payload is a literal in
// the host's own source, selected by (launchAgent × blocked_reason × choice).
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  peerOwnedAttachmentOrRefusal,
  peerRefusal,
  type PeerAdmissionContext
} from './runtime-peer-rpc-allowlist'

export type PeerPromptChoice = 'accept_trust' | 'decline'

export type PeerPromptKeystroke = { readonly text: string; readonly enter: boolean }

// §D / T-6 / T-9: the ONE keystroke table — the only place a byte sequence appears for this
// choke. Exactly two TuiAgent members are authored (Ruling 24(b)); every other of the 36
// members, and `agent: null`, refuse prompt_state_unknown by falling through to `undefined`
// here. Scoped to what this tree evidences: codex-trust-workspace's "1. Yes... / 2. No, exit"
// choice (dispatch-input-observer.test.ts's own SYNTHESIZED_TRUST_GATE_TAIL fixture) and
// Claude's accept (claude-pty.ts:179 TRUST_PROMPT_RE, :477-478 `term.write('y\r')`). Claude's
// decline is refused, not guessed. No other (agent, reason) cell is authored — widening this
// table is a separate, evidenced change, never a guess.
export const PEER_PROMPT_KEYSTROKES: Partial<
  Record<
    TuiAgent,
    Partial<
      Record<
        RuntimeTerminalWaitBlockedReason,
        Partial<Record<PeerPromptChoice, PeerPromptKeystroke>>
      >
    >
  >
> = {
  codex: {
    'codex-trust-workspace': {
      accept_trust: { text: '1', enter: true },
      decline: { text: '2', enter: true }
    }
  },
  claude: {
    'codex-trust-workspace': {
      accept_trust: { text: 'y', enter: true }
    }
  }
}

// §D: internal throw only — never a wire code. Rebound between the ownership read and the write
// itself classifies as pane_not_peer_owned, never as pane_write_unavailable.
export class PeerPaneReboundError extends Error {}

// §D / review B2(c): internal throw only, classifies as agent_not_live — either
// isTerminalRunningAgent or isPeerPaneForegroundAgentLive failed the re-check run inside the
// write flight, immediately before a byte lands.
export class PeerPaneAgentNotLiveError extends Error {}

export type PeerPaneWriteRefusal = ReturnType<typeof peerRefusal>
export type PeerPaneWrite = { readonly refused: false }

function lookUpKeystroke(
  agent: TuiAgent | null,
  reason: RuntimeTerminalWaitBlockedReason,
  choice: PeerPromptChoice
): PeerPromptKeystroke | undefined {
  return agent ? PEER_PROMPT_KEYSTROKES[agent]?.[reason]?.[choice] : undefined
}

// §6.3 step 2: the row must still be exactly the one the ownership read saw — same handle, same
// runtime epoch, not exited — immediately before the write. Throws PeerPaneReboundError (never a
// wire code directly) so the caller's catch classifies it uniformly with any other rebind.
export function assertPeerPaneStillBound(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  expectedHandle: string
): void {
  const row = runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
  if (
    !row ||
    row.terminal_handle !== expectedHandle ||
    row.agent_exited_at !== null ||
    row.runtime_epoch !== runtime.getRuntimeId()
  ) {
    throw new PeerPaneReboundError(`Dispatch ${dispatchId} rebound before the prompt write.`)
  }
}

// §6.3 step 2 (attacker 3-adjacent): the SAME blocked prompt the caller resolved a keystroke
// for must still be there immediately before the write — a title/tail change between the read
// and the write (the agent answered it itself, or moved on) must never send a stale keystroke.
export function assertRecordedPromptStillPresent(
  runtime: OrcaRuntimeService,
  handle: string,
  expectedReason: RuntimeTerminalWaitBlockedReason
): void {
  const current = runtime.getPeerPromptState(handle)
  if (current.state !== 'blocked' || current.reason !== expectedReason) {
    throw new PeerPaneReboundError(`Prompt on ${handle} is no longer ${expectedReason}.`)
  }
}

export function classifyPeerPaneWriteFailure(error: unknown): PeerPaneWriteRefusal {
  if (error instanceof PeerPaneReboundError) {
    return peerRefusal('pane_not_peer_owned', error.message)
  }
  if (error instanceof PeerPaneAgentNotLiveError) {
    return peerRefusal('agent_not_live', error.message)
  }
  return peerRefusal(
    'pane_write_unavailable',
    error instanceof Error ? error.message : 'The prompt write failed.'
  )
}

// §6.3 step 3 (Ruling 24(a)/(c), frozen): the ONE re-check closure, run by writeTerminalAction's
// own beforeWrite — inside the write flight, and re-run before EVERY byte (each text chunk, and
// again before the suffix across the 500ms text→suffix gap, per writeTerminalAction's own
// contract). Both liveness conjuncts: isTerminalRunningAgent (design conjunct b) and
// isPeerPaneForegroundAgentLive (conjunct c) — either failing means "not live", never "assume
// live".
function buildPeerPaneWriteGuard(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  handle: string,
  reason: RuntimeTerminalWaitBlockedReason
): () => Promise<void> {
  return async () => {
    assertPeerPaneStillBound(runtime, dispatchId, handle)
    assertRecordedPromptStillPresent(runtime, handle, reason)
    const [runningAgent, foregroundLive] = await Promise.all([
      runtime.isTerminalRunningAgent(handle),
      runtime.isPeerPaneForegroundAgentLive(handle)
    ])
    if (!runningAgent || !foregroundLive) {
      throw new PeerPaneAgentNotLiveError(`Agent on ${handle} is not live.`)
    }
  }
}

// Why guarded, and why best-effort: only ever sent to a pane this call already proved is
// peer-owned and still showing the SAME blocked prompt — a defensive Ctrl-C so a write that
// failed mid-flight never leaves a half-typed keystroke sitting in the shell. Never throws; a
// failure here must not shadow the original write failure the caller is already returning.
// Carries the same beforeWrite re-check as the keystroke write itself (review B2 smallest fix).
export async function sendGuardedRecoveryInterrupt(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  handle: string,
  reason: RuntimeTerminalWaitBlockedReason
): Promise<void> {
  try {
    await runtime.sendTerminal(
      handle,
      { interrupt: true },
      { beforeWrite: buildPeerPaneWriteGuard(runtime, dispatchId, handle, reason) }
    )
  } catch {
    // Best-effort — see doc comment above.
  }
}

// §6.3 steps 1-3: ownership + metering (W-3's peerOwnedAttachmentOrRefusal) -> resolve the
// keystroke from the ONE table above -> reserve the single shot -> write INSIDE the same PTY
// write flight (writeTerminalAction's claimStructuredPtyWrite), re-checking rebind/prompt/
// liveness via beforeWrite immediately before each byte (Ruling 20(i) — FROZEN) -> on any
// failure, release the shot ONLY if no byte was written (Ruling 20(b): a failed answer never
// burns the shot UNLESS the host actually typed something) and attempt the guarded recovery
// interrupt.
export async function writeToPeerOwnedPane(args: {
  ctx: PeerAdmissionContext
  dispatchId: string
  choice: PeerPromptChoice
}): Promise<PeerPaneWrite | PeerPaneWriteRefusal> {
  const { ctx, dispatchId, choice } = args
  const owned = peerOwnedAttachmentOrRefusal(ctx, dispatchId)
  if (owned.refused) {
    return owned
  }
  const handle = owned.row.terminal_handle
  if (!handle) {
    return peerRefusal('pane_not_peer_owned', `Dispatch ${dispatchId} has no bound terminal.`)
  }
  const state = ctx.runtime.getPeerPromptState(handle)
  if (state.state === 'unknown') {
    return peerRefusal('prompt_state_unknown', 'Prompt state could not be determined.')
  }
  if (state.state === 'clear') {
    return peerRefusal(
      'prompt_not_present',
      `Dispatch ${dispatchId} has no prompt awaiting an answer.`
    )
  }
  const keystroke = lookUpKeystroke(state.agent, state.reason, choice)
  if (!keystroke) {
    return peerRefusal(
      'prompt_state_unknown',
      `No authored keystroke exists for this agent/prompt/choice combination.`
    )
  }
  const reserved = ctx.runtime.getOrchestrationDb().reservePeerPromptAnswer(dispatchId)
  if (!reserved) {
    return peerRefusal(
      'prompt_already_answered',
      `Dispatch ${dispatchId}'s prompt was already answered.`
    )
  }
  let sawWrite = false
  try {
    await ctx.runtime.sendTerminal(
      handle,
      { text: keystroke.text, enter: keystroke.enter },
      {
        beforeWrite: buildPeerPaneWriteGuard(ctx.runtime, dispatchId, handle, state.reason),
        afterWrite: () => {
          sawWrite = true
        }
      }
    )
    return { refused: false }
  } catch (error) {
    // Ruling 20(b): a partial write (text landed, the suffix's re-check refused) still consumed
    // the shot — afterWrite already fired for the text before the suffix's beforeWrite threw.
    if (!sawWrite) {
      ctx.runtime.getOrchestrationDb().releasePeerPromptAnswer(dispatchId)
    }
    await sendGuardedRecoveryInterrupt(ctx.runtime, dispatchId, handle, state.reason)
    return classifyPeerPaneWriteFailure(error)
  }
}
