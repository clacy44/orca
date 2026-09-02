// S10-19 W-4 review M5 (Ruling 20(b)): getPeerPromptState must key on the peer-specific detector
// (findPeerDismissedStartupModalIndex), anchored on the pane's OSC title — not satisfiable by
// the worker's own printed output, which a peer's task text CAN provoke. Before this fix the
// function existed but nothing called it (dead code), so a worker made to echo the trust-gate
// sentinel after it had already reached ready would still report a fresh 'blocked' prompt state.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const TRUST_GATE_SENTINEL_TAIL = [
  '  OpenAI Codex',
  '',
  '  Do you trust the files in this folder?',
  '  > 1. Yes, allow Codex to run in this folder',
  '    2. No, exit'
].join('\n')

describe('S10-19 W-4 review M5: getPeerPromptState wires the peer-specific dismissal detector', () => {
  it('a worker that reached ready and then merely PRINTS the trust-gate sentinel (peer-forgeable output) produces no prompt state', () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: TRUST_GATE_SENTINEL_TAIL,
      blockedReason: 'codex-trust-workspace',
      // A real ready-state OSC title never looks like a live confirm/trust prompt — this is
      // the signal task text cannot forge.
      title: 'codex — src/main/runtime/orca-runtime.ts'
    })
    const state = runtime.getPeerPromptState('term_peer')
    expect(state).toEqual({ state: 'clear' })
  })

  it('a genuinely live trust prompt (title still looks like the prompt) still reports blocked', () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: TRUST_GATE_SENTINEL_TAIL,
      blockedReason: 'codex-trust-workspace',
      title: 'Do you trust this workspace?'
    })
    const state = runtime.getPeerPromptState('term_peer')
    expect(state).toMatchObject({ state: 'blocked', reason: 'codex-trust-workspace' })
  })

  // W-5..W-7 review finding 7 (Ruling 24 addendum 4(ee)): this test previously asserted the
  // GAP as intended behaviour — with no title evidence, a blocked reason came only from the
  // peer-forgeable tail. The fix REFUSES prompt_state_unknown instead of trusting the tail.
  it('finding 7 / 24(ee): no title evidence at all refuses prompt_state_unknown — the tail alone is peer-forgeable', () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: TRUST_GATE_SENTINEL_TAIL,
      blockedReason: 'codex-trust-workspace',
      title: null
    })
    const state = runtime.getPeerPromptState('term_peer')
    expect(state).toEqual({ state: 'unknown' })
  })

  it('finding 7 / 24(ee): empty-string title evidence also refuses prompt_state_unknown', () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: TRUST_GATE_SENTINEL_TAIL,
      blockedReason: 'codex-trust-workspace',
      title: ''
    })
    const state = runtime.getPeerPromptState('term_peer')
    expect(state).toEqual({ state: 'unknown' })
  })

  it('clear evidence (no blocked reason at all) stays clear regardless of title', () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue({
      tailText: 'ordinary output, nothing pending',
      blockedReason: null,
      title: 'codex — ready'
    })
    expect(runtime.getPeerPromptState('term_peer')).toEqual({ state: 'clear' })
  })

  it('unknown evidence (handle stale/exited) stays unknown', () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getTerminalWaitEvidence').mockReturnValue(null)
    expect(runtime.getPeerPromptState('term_peer')).toEqual({ state: 'unknown' })
  })
})
