import type { ReactElement } from 'react'
import { Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { terminalPresenceLastSeenMinutes } from '../../../../shared/terminal-presence-last-seen'
import type { TerminalPresenceChipState } from './terminal-presence-chip-state'

// Why the LockChip pill geometry with no button: presence is awareness, not a lock, so the chip must
// read as ambient. Top-LEFT because the phone-driver chip owns top-right and both can be live at once.
const CHIP_CLASSES =
  'pointer-events-none absolute left-2 top-2 z-50 flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-card-foreground shadow-xs'

function chipCopy(state: TerminalPresenceChipState): string {
  switch (state.activity) {
    case 'typing':
      return translate(
        'auto.components.terminal.pane.TerminalPresenceChip.ca8b0b4bc6',
        '{{value0}} is typing',
        { value0: state.label }
      )
    case 'writing':
      return translate(
        'auto.components.terminal.pane.TerminalPresenceChip.13c1a5839d',
        '{{value0}} is writing',
        { value0: state.label }
      )
    case 'held':
      return translate(
        'auto.components.terminal.pane.TerminalPresenceChip.b9ac6c07ca',
        '{{value0}} is typing — press again',
        { value0: state.label }
      )
    case 'stale':
      // Why "attached" is still said: the phone has not left — nothing removes a row on silence — so the
      // honest reading is "still attached, but this is how long ago we last heard from it".
      return translate(
        'auto.components.terminal.pane.TerminalPresenceChip.stale',
        '{{value0}} attached · last seen {{value1}}m ago',
        {
          value0: state.label,
          value1: terminalPresenceLastSeenMinutes(state.lastSeenAt ?? 0, Date.now())
        }
      )
    case 'attached':
      return translate(
        'auto.components.terminal.pane.TerminalPresenceChip.d7e5962e29',
        'In use by {{value0}}',
        { value0: state.label }
      )
  }
}

export function TerminalPresenceChip({
  state,
  rootClassName
}: {
  state: TerminalPresenceChipState | null
  rootClassName?: string
}): ReactElement | null {
  if (!state) {
    return null
  }
  return (
    <div className={cn(CHIP_CLASSES, rootClassName)} data-presence-activity={state.activity}>
      <Users className="size-3 text-muted-foreground" aria-hidden="true" />
      <span>{chipCopy(state)}</span>
    </div>
  )
}
