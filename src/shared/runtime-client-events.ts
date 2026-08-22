import type { CreateWorktreeResult } from './worktree/create-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from './worktree/launch-types'
import type { SshConnectionState } from './ssh-types'
import type { TerminalSideEffectBatch } from './terminal-side-effect-facts'
import type { RuntimeNativeChatLaunchDraftResolution } from './runtime-types'

// Why: the runtime-wide roster kind. `host` is the single synthetic participant absorbing the
// renderer bridge and every other anonymous local caller; the other two are host-observed device
// scopes, never a client-declared field.
export type RuntimeTerminalPresenceKind = 'runtime' | 'mobile' | 'host'

export type RuntimeTerminalPresenceParticipant = {
  // Why: opaque and process-local — never the registry deviceId, which is the relay binding identity
  // and the on-disk navigation key. Nothing may persist against it.
  participantId: string
  label: string
  kind: RuntimeTerminalPresenceKind
  // Why: terminal HANDLES, not ptyIds. ptyId is an internal runtime identifier no wire surface publishes.
  attachedTerminals: string[]
  // Why: resolved per LISTENER at fan-out. Nothing else lets a client learn its own participantId, so a
  // single shared payload would render one of the two readers as their own peer.
  self: boolean
}

export type RuntimeClientEvent =
  | { type: 'reposChanged' }
  | { type: 'worktreesChanged'; repoId: string }
  | ({ type: 'nativeChatLaunchDraftResolved' } & RuntimeNativeChatLaunchDraftResolution)
  | { type: 'terminalSideEffects'; batch: TerminalSideEffectBatch }
  // Why: SSH connections live on the runtime host; paired clients have no IPC
  // channel for ssh:state-changed, so without this event their reconnect
  // overlays never learn the host connected (STA-1468).
  | { type: 'sshStateChanged'; targetId: string; state: SshConnectionState }
  | {
      type: 'worktreeTerminalSleepState'
      worktreeId: string
      generation: number
      phase: 'started' | 'committed' | 'cancelled' | 'woken'
      ptyIds: string[]
      terminalHandles: string[]
    }
  // Why membership only: `typing`/`writing` are per-PTY and ride the terminal stream alone (W4). A
  // roster that carried them would republish this broadcast on every keystroke, to every client.
  | {
      type: 'terminalPresence'
      /** Broadcast-only, and NOT an ordering or dedupe key. The publisher is created lazily and torn
       *  down with the last subscriber, so it restarts at 0 across a subscriber gap, and a subscribe
       *  snapshot reuses the current value without advancing it. A consumer that needs ordering must
       *  compare the payload, which is exactly what the publisher itself does. */
      seq: number
      participants: RuntimeTerminalPresenceParticipant[]
      // Why present-only-when-true: the participant cap is a bound, and a client must be able to say
      // "there are more" without inventing rows it was never sent.
      truncated?: true
    }
  | {
      type: 'linearLinkedIssueUpdated'
      worktreeId: string
      identifier: string
      workspaceId: string
    }
  | {
      type: 'activateWorktree'
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: WorktreeStartupLaunch
      defaultTabs?: WorktreeDefaultTabsLaunch
    }

export type RuntimeClientEventStreamMessage =
  | ({ type: 'ready'; subscriptionId: string } & {
      snapshot?: {
        repos?: unknown[]
        sshStates?: { targetId: string; state: SshConnectionState }[]
      }
    })
  | RuntimeClientEvent
  | { type: 'end' }

export type RuntimeTerminalPresenceClientEvent = Extract<
  RuntimeClientEvent,
  { type: 'terminalPresence' }
>

export type RuntimeActivateWorktreeEvent = Extract<RuntimeClientEvent, { type: 'activateWorktree' }>

export function toRuntimeActivateWorktreeEvent(
  repoId: string,
  worktreeId: string,
  setup?: CreateWorktreeResult['setup'],
  startup?: WorktreeStartupLaunch,
  defaultTabs?: CreateWorktreeResult['defaultTabs']
): RuntimeActivateWorktreeEvent {
  return {
    type: 'activateWorktree',
    repoId,
    worktreeId,
    ...(setup ? { setup } : {}),
    ...(startup ? { startup } : {}),
    ...(defaultTabs ? { defaultTabs } : {})
  }
}
