// Why a pure resolver beside the chip: HOW a terminal row attributes its Claude credential is the
// part with rules (S9 §2h) — a `'grant'` row is pinned to a person and carries the owner label; a
// `'host'` or `'shared-runtime'` row is the shared credential and names no person; a `'remote'` or
// `'wsl'` row is labelled for where it runs; and a `'unknown'` row is a pre-S9 pane that must never
// be attributed to anyone. The rules must be assertable without a DOM, so the chip's copy is the
// only thing that lives in the component.
import type { RuntimeTerminalCredentialLane } from '../../../../shared/runtime-types'
import {
  resolveTerminalLaneAccountChipState,
  type TerminalLaneAccountChipState
} from './terminal-lane-account-chip-state'
import type {
  RuntimeTerminalLaneAccountLabel,
  RuntimeTerminalLaneUsage
} from '../../../../shared/runtime-types'

/**
 * What one terminal row's credential attribution renders as (S9 §2h).
 *
 *   - `owned`     — `'grant'`: pinned to a principal's lane, so it carries the owner label and,
 *                   for the caller's own lane, the usage bar (§2k). The account chip state is the
 *                   already-resolved `owner · account` join.
 *   - `shared`    — `'host'` (the shared `~/.claude`) or `'shared-runtime'` (the OpenClaude
 *                   downgrade of §2a consequence 3). Both name no person; `source` says which.
 *   - `labelled`  — `'remote'` or `'wsl'`: neither can carry a host lane, so the row is labelled
 *                   for where it runs rather than owned.
 *   - `unattributed` — `'unknown'`, and the fail-closed answer for a `'grant'` row whose owner the
 *                   projection could not yet join. Never attributed to a person.
 */
export type TerminalCredentialLaneAttribution =
  | { kind: 'owned'; account: TerminalLaneAccountChipState }
  | { kind: 'shared'; source: 'host' | 'runtime' }
  | { kind: 'labelled'; laneKind: 'remote' | 'wsl' }
  | { kind: 'unattributed' }

export function resolveTerminalCredentialLaneAttribution(source: {
  credentialLane?: RuntimeTerminalCredentialLane
  laneAccountLabel?: RuntimeTerminalLaneAccountLabel
  laneUsage?: RuntimeTerminalLaneUsage
}): TerminalCredentialLaneAttribution {
  switch (source.credentialLane) {
    case 'grant': {
      const account = resolveTerminalLaneAccountChipState({
        laneAccountLabel: source.laneAccountLabel,
        laneUsage: source.laneUsage
      })
      // Why fall through to unattributed: a `'grant'` row with no resolvable owner is one the host
      // could not join to a person, so attributing it would be a claim the projection did not make.
      return account ? { kind: 'owned', account } : { kind: 'unattributed' }
    }
    case 'host':
      return { kind: 'shared', source: 'host' }
    case 'shared-runtime':
      return { kind: 'shared', source: 'runtime' }
    case 'remote':
      return { kind: 'labelled', laneKind: 'remote' }
    case 'wsl':
      return { kind: 'labelled', laneKind: 'wsl' }
    // Why `unknown` and the absent field share the fail-closed answer: a pre-S9 restored pane
    // publishes no `credentialLane` at all, and it is exactly as un-attributable as `'unknown'`.
    case 'unknown':
    case undefined:
      return { kind: 'unattributed' }
  }
}
