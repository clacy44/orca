// Lifted out of AccountLaneStatusSection.tsx (S9-L2 extraction, hard 400-line `.tsx` ceiling):
// the lane-residency badge shared by LaneRow and RemoteHostRow.
import { translate } from '@/i18n/i18n'
import type { RuntimeTerminalLaneState } from '../../../../shared/runtime-types'

// The lane residency states this section paints. It is the shipped `RuntimeTerminalLaneState`
// (loaded | absent | reauth-required) PLUS `restart-required` — §2h's degraded value the wire does
// not carry yet (§10(e)) — so the badge is correct the moment that value ships.
export type LaneStateForDisplay = RuntimeTerminalLaneState | 'restart-required'

export function laneStateBadge(state: LaneStateForDisplay): {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
} {
  switch (state) {
    case 'loaded':
      return {
        label: translate('auto.components.settings.AccountLaneStatusSection.loaded', 'Loaded'),
        variant: 'default'
      }
    case 'absent':
      return {
        label: translate('auto.components.settings.AccountLaneStatusSection.absent', 'Absent'),
        variant: 'outline'
      }
    case 'reauth-required':
      return {
        label: translate(
          'auto.components.settings.AccountLaneStatusSection.reauth',
          'Reauth required'
        ),
        variant: 'destructive'
      }
    case 'restart-required':
      return {
        label: translate(
          'auto.components.settings.AccountLaneStatusSection.restart',
          'Restart required'
        ),
        variant: 'secondary'
      }
  }
}
