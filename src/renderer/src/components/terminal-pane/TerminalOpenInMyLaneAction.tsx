import type { ReactElement } from 'react'
import { LogIn } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import type { TerminalCredentialLaneAttribution } from './terminal-credential-lane-attribution'
import { shouldOfferOpenInMyLane } from './terminal-open-in-lane-action'

/**
 * The "Open in my lane" affordance on ANOTHER person's terminal (S9 §2h/§5): it re-opens that
 * terminal's work under the viewer's OWN credential lane via `terminal.openInMyLane`. Whether it is
 * offered is the shipped three-part predicate — the host must advertise the capability, the row must
 * be attributed to a person, and it must not already be the viewer's own lane — so this renders
 * nothing unless `shouldOfferOpenInMyLane` says yes, and never shows a stale button to an old host.
 */
export function TerminalOpenInMyLaneAction({
  capabilitySupported,
  attribution,
  viewerOwnsLane,
  busy,
  rootClassName,
  onOpen
}: {
  capabilitySupported: boolean
  attribution: TerminalCredentialLaneAttribution
  viewerOwnsLane: boolean
  busy: boolean
  rootClassName?: string
  onOpen: () => void
}): ReactElement | null {
  if (!shouldOfferOpenInMyLane({ capabilitySupported, attribution, viewerOwnsLane })) {
    return null
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={rootClassName}
      disabled={busy}
      onClick={onOpen}
      data-testid="open-in-my-lane"
    >
      <LogIn className="size-3.5" aria-hidden="true" />
      {translate(
        'auto.components.terminal.pane.TerminalOpenInMyLaneAction.open',
        'Open in my lane'
      )}
    </Button>
  )
}
