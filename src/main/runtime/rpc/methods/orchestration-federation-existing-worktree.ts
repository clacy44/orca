// S10-19 W-3: the "reuse an existing worktree" branch of federationAttachStart, split out of
// orchestration-federation.ts to stay under the max-lines ratchet. Not the new-top-level branch
// (that one also touches `setup`/`setupSource` state and stays in the main handler).
import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PaneCredentialLane } from '../../pane-credential-lane-registry'
import { assertPeerDispatchTarget } from '../../runtime-peer-rpc-allowlist'
import type { FederationEffect } from './orchestration-federation-effects'
import type { prepareFederationAttachmentWorkerStart } from './orchestration-worker-start-validation'

export async function resolveExistingFederatedWorktree(args: {
  runtime: OrcaRuntimeService
  worktreeSelector: string
  isPeerCaller: boolean
  credentialLane: PaneCredentialLane
  agent: TuiAgent | undefined
  launch: ReturnType<typeof prepareFederationAttachmentWorkerStart>['launch']
  terminalHandle: string | undefined
  taskId: string
  effects: FederationEffect[]
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  terminalHandle: string
  failedStageOverride?: 'terminal_create'
}> {
  const worktree = await args.runtime
    .showManagedTerminalWorkspace(args.worktreeSelector)
    .catch(() => {
      throw new OrchestrationError(
        'worktree_not_found_on_server',
        `Worktree ${args.worktreeSelector} was not found on the selected worker server.`
      )
    })
  // §4.1 (frozen predicate, G-4): default-deny for an existing worktree — a peer caller may only
  // land on one whose repo is on federationDispatchRepos (default EMPTY).
  if (args.isPeerCaller) {
    const targetAdmission = assertPeerDispatchTarget(
      { kind: 'exact', repoId: worktree.repoId },
      args.runtime.getFederationDispatchRepos()
    )
    if (targetAdmission.refused) {
      throw new OrchestrationError(targetAdmission.wireCode, targetAdmission.message)
    }
  }
  args.effects.push(
    { kind: 'worktree', action: 'reused', id: worktree.id },
    { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
  )
  if (args.terminalHandle) {
    const terminal = await args.runtime.showTerminal(args.terminalHandle)
    if (terminal.worktreeId !== worktree.id) {
      throw new OrchestrationError(
        'terminal_worktree_mismatch',
        `Terminal ${args.terminalHandle} does not belong to worktree ${worktree.id}.`
      )
    }
    if (!(await args.runtime.isTerminalRunningAgent(args.terminalHandle))) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Terminal ${args.terminalHandle} is not running a recognized agent.`
      )
    }
    args.effects.push({
      kind: 'terminal',
      role: 'agent',
      action: 'reused',
      id: args.terminalHandle
    })
    return { worktree, terminalHandle: args.terminalHandle }
  }
  const terminal = await args.runtime.createTerminal(`id:${worktree.id}`, {
    credentialLane: args.credentialLane,
    // Why: agent ids are not shell commands (`cursor` is the desktop app, its CLI is
    // `cursor-agent`); resolve through the TUI agent config.
    startupAgent: args.agent,
    ...(args.launch.preferences ? { launchPreferences: args.launch.preferences } : {}),
    title: `worker-${args.taskId}`,
    presentation: 'background'
  })
  args.effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: terminal.handle })
  return { worktree, terminalHandle: terminal.handle, failedStageOverride: 'terminal_create' }
}
