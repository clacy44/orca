// S10-19 W-3: the "reuse an existing worktree" branch of federationAttachStart, split out of
// orchestration-federation.ts to stay under the max-lines ratchet. Not the new-top-level branch
// (that one also touches `setup`/`setupSource` state and stays in the main handler).
import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PaneCredentialLane } from '../../pane-credential-lane-registry'
import {
  assertPeerDispatchTarget,
  WORKTREE_NOT_FEDERATED_REFUSAL
} from '../../runtime-peer-rpc-allowlist'
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
  // Review finding 7: the base behavior set failedStage BEFORE calling createTerminal, so a
  // throw from the create call itself reported 'terminal_create'. This module returns its
  // result only on success, so the caller's local failedStage must be updated synchronously,
  // right before the call that can throw — not after it returns.
  setFailedStage: (stage: 'terminal_create') => void
}): Promise<{
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  terminalHandle: string
}> {
  // W-5..W-7 review · worktree oracle (Ruling 24(z)) / NEG-14: a peer refusal must be
  // byte-identical whether the selector resolved to a non-federated repo or did not resolve at
  // all — otherwise `worktree_not_found_on_server` vs `worktree_not_federated` is a
  // worktree-existence oracle. For a peer caller, a resolution failure throws the SAME
  // `worktree_not_federated` refusal assertPeerDispatchTarget would throw for an existing,
  // non-federated repo (never a repoId-bearing message).
  const worktree = await args.runtime
    .showManagedTerminalWorkspace(args.worktreeSelector)
    .catch(() => {
      if (args.isPeerCaller) {
        throw new OrchestrationError(
          WORKTREE_NOT_FEDERATED_REFUSAL.wireCode,
          WORKTREE_NOT_FEDERATED_REFUSAL.message,
          { effectsApplied: false, nextSteps: WORKTREE_NOT_FEDERATED_REFUSAL.nextSteps }
        )
      }
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
      throw new OrchestrationError(targetAdmission.wireCode, targetAdmission.message, {
        effectsApplied: false,
        nextSteps: targetAdmission.nextSteps
      })
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
  args.setFailedStage('terminal_create')
  const terminal = await args.runtime.createTerminal(`id:${worktree.id}`, {
    restoreProvenance: { kind: 'none' },
    credentialLane: args.credentialLane,
    // Why: agent ids are not shell commands (`cursor` is the desktop app, its CLI is
    // `cursor-agent`); resolve through the TUI agent config.
    startupAgent: args.agent,
    ...(args.launch.preferences ? { launchPreferences: args.launch.preferences } : {}),
    title: `worker-${args.taskId}`,
    presentation: 'background'
  })
  args.effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: terminal.handle })
  return { worktree, terminalHandle: terminal.handle }
}
