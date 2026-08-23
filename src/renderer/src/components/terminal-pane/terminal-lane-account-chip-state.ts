// Why a pure resolver beside the chip: what the two lane fields MEAN on screen is the part with
// rules — a peer sees the account label and no bar, a Windows host shows why there is no bar
// rather than a stale one — and the rules must be assertable without a DOM (S9 §2h/§2k).
import type {
  RuntimeTerminalLaneAccountLabel,
  RuntimeTerminalLaneUsage
} from '../../../../shared/runtime-types'

export type TerminalLaneAccountChipState = {
  /** "Ana · work", or just the owner when no account name was pushed (Q3). */
  label: string
  /** The tighter of the two windows, as a whole percent; absent for a peer's row (§2d). */
  usedPercent?: number
  /** Why there is no bar, where the host cannot pull it (§2k Fact 2). */
  unavailableReason?: string
}

export function resolveTerminalLaneAccountChipState(source: {
  laneAccountLabel?: RuntimeTerminalLaneAccountLabel
  laneUsage?: RuntimeTerminalLaneUsage
}): TerminalLaneAccountChipState | null {
  const label = source.laneAccountLabel
  if (!label?.owner) {
    return null
  }
  const state: TerminalLaneAccountChipState = {
    label: label.accountName ? `${label.owner} · ${label.accountName}` : label.owner
  }
  if (source.laneUsage?.unavailableReason) {
    return { ...state, unavailableReason: source.laneUsage.unavailableReason }
  }
  // Why the MAX and not the session window alone: the bar is a warning, and the weekly window is
  // the one that bites after a long day. An absent window is not zero and must not win the max.
  const percents = [
    source.laneUsage?.session?.usedPercent,
    source.laneUsage?.weekly?.usedPercent
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return percents.length > 0 ? { ...state, usedPercent: Math.round(Math.max(...percents)) } : state
}
