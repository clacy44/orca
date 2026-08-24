// Why beside the action: routing `terminal.openInMyLane` through the runtime client is the glue the
// pure predicate (terminal-open-in-lane-action.ts) deliberately does not own. A local host terminal
// goes to the local runtime; a remote host's terminal goes to that environment — the same target
// split terminal-fit-restore uses.
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'

export function resolveOpenInMyLaneTarget(ptyId: string): RuntimeClientTarget {
  const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}

/** Fire `terminal.openInMyLane` for the source terminal, focusing and activating the new one. */
export async function openTerminalInMyLane(ptyId: string): Promise<void> {
  await callRuntimeRpc(resolveOpenInMyLaneTarget(ptyId), 'terminal.openInMyLane', {
    sourcePtyId: ptyId,
    focus: true,
    activate: true
  })
}
