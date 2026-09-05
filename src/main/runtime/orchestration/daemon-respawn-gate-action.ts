// S10-21a C7f/C7g (Ruling 34 Addenda 24/25): the post-spawn-commit gate's pure decision — given
// the pane's newest daemon_died/rebind verb and this launch's admission classification, what
// pty.ts's :6939 gate should do. Extracted for direct unit coverage; pty.ts performs the actual
// DB/notice side effects the returned action names.
import type { LaunchAdmissionClassification } from '../../ipc/agent-launch-admission-support'
import type { DaemonRespawnGateVerb } from './agent-daemon-respawn-gate'

export type DaemonRespawnGateAction =
  | { kind: 'refresh' }
  | { kind: 'refuse_fresh_session' }
  | { kind: 'notice_only' }
  | { kind: 'none' }

export function resolveDaemonRespawnGateAction(
  newestVerb: DaemonRespawnGateVerb | null,
  classification: LaunchAdmissionClassification | undefined
): DaemonRespawnGateAction {
  // A newer 'rebind' (this gate's own prior fire, or C5's Layer-2 rebind) always outranks an
  // older 'daemon_died' — the gate never re-fires once the pane is resolved.
  if (newestVerb !== 'daemon_died') {
    return { kind: 'none' }
  }
  if (classification === 'host_resume' || classification === 'self_resume_host') {
    return { kind: 'refresh' }
  }
  if (classification === 'host_minted') {
    return { kind: 'refuse_fresh_session' }
  }
  if (classification === 'self_resume_caller') {
    // The contest path (ctx.contestedLineage) already fires from admission itself.
    return { kind: 'notice_only' }
  }
  return { kind: 'none' }
}
