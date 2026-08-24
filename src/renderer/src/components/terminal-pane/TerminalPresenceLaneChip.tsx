import { useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { useAppStore } from '../../store'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { useTerminalCredentialLane } from '@/lib/pane-manager/terminal-credential-lane-state'
import { TerminalPresenceChip } from './TerminalPresenceChip'
import type { TerminalPresenceChipState } from './terminal-presence-chip-state'
import {
  resolveTerminalCredentialLaneAttribution,
  type TerminalCredentialLaneAttribution
} from './terminal-credential-lane-attribution'
import { resolveTerminalLaneAccountChipState } from './terminal-lane-account-chip-state'
import { TerminalOpenInMyLaneAction } from './TerminalOpenInMyLaneAction'
import { openTerminalInMyLane } from './open-terminal-in-my-lane'

// The already-translated note for a non-owned attribution (S9 §2h): a shared credential names no
// person, and a remote/WSL pane is labelled for where it runs rather than owned.
function laneNoteFor(attribution: TerminalCredentialLaneAttribution): string | null {
  switch (attribution.kind) {
    case 'shared':
      return translate(
        'auto.components.terminal.pane.TerminalPresenceLaneChip.shared',
        'Shared credential'
      )
    case 'labelled':
      return attribution.laneKind === 'remote'
        ? translate(
            'auto.components.terminal.pane.TerminalPresenceLaneChip.remote',
            'Runs on a remote host'
          )
        : translate('auto.components.terminal.pane.TerminalPresenceLaneChip.wsl', 'Runs in WSL')
    case 'owned':
    case 'unattributed':
      return null
  }
}

/**
 * Per-pane wrapper that joins presence with this pane's credential-lane attribution (S9 §2h): it
 * reads the lane from the per-pane store, resolves it through the shipped attribution resolver, and
 * renders the presence chip's owner label + friendly account name + usage for an owned lane, the
 * shared/remote/WSL note otherwise, and — on another person's owned lane — the "Open in my lane"
 * action. It exists so the `useTerminalCredentialLane` hook is called once per pane, not in a map.
 */
export function TerminalPresenceLaneChip({
  ptyId,
  presenceState,
  rootClassName
}: {
  ptyId: string
  presenceState: TerminalPresenceChipState | null
  rootClassName?: string
}): ReactElement | null {
  const laneRow = useTerminalCredentialLane(ptyId)
  const attribution = resolveTerminalCredentialLaneAttribution(laneRow)
  const capabilitySupported = useAppStore((state) => {
    const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
    if (!environmentId) {
      // The local host runs this same binary, so its lane capability is always advertised.
      return true
    }
    return (
      state.runtimeStatusByEnvironmentId
        .get(environmentId)
        ?.status?.capabilities?.includes(AGENT_IDENTITY_LANES_RUNTIME_CAPABILITY) ?? false
    )
  })
  const [busy, setBusy] = useState(false)

  const lane =
    attribution.kind === 'owned'
      ? resolveTerminalLaneAccountChipState({
          laneAccountLabel: laneRow.laneAccountLabel,
          laneUsage: laneRow.laneUsage
        })
      : null
  const laneNote = laneNoteFor(attribution)
  const viewerOwnsLane = laneRow.credentialLaneOwner === true

  const onOpen = async (): Promise<void> => {
    setBusy(true)
    try {
      await openTerminalInMyLane(ptyId)
    } catch (error) {
      toast.error(
        translate(
          'auto.components.terminal.pane.TerminalPresenceLaneChip.openFailed',
          'Could not open this terminal in your lane.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <TerminalPresenceChip
        state={presenceState}
        lane={lane}
        laneNote={laneNote}
        rootClassName={rootClassName}
      />
      <TerminalOpenInMyLaneAction
        capabilitySupported={capabilitySupported}
        attribution={attribution}
        viewerOwnsLane={viewerOwnsLane}
        busy={busy}
        rootClassName="pointer-events-auto absolute right-2 top-2 z-50 shadow-xs"
        onOpen={() => void onOpen()}
      />
    </>
  )
}
