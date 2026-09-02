import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { assertPeerDispatchIds, clampPeerAttachTimeoutMs } from '../../runtime-peer-rpc-allowlist'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import {
  appendFederationSetupEffect,
  appendFederationTerminalEffects,
  type FederationEffect
} from './orchestration-federation-effects'
import type { WorkerSetupReceipt } from './orchestration-worker-topology'
import {
  monitorFederatedSetup,
  persistFederatedReadinessStage,
  persistFederatedSetupSpawnFailure,
  persistFederatedSetupWaitOutcome
} from './orchestration-federation-setup'
import { FederationAttachStartParams } from './orchestration-federation-start-schema'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'
import { prepareFederationAttachmentWorkerStart } from './orchestration-worker-start-validation'
import {
  sendFullDispatchPaste,
  sendPeerDispatchMailPointer
} from './orchestration-federation-dispatch-input-send'
import { resolveExistingFederatedWorktree } from './orchestration-federation-existing-worktree'

export const ORCHESTRATION_FEDERATION_ATTACH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationAttachStart',
    params: FederationAttachStartParams,
    handler: async (params, { runtime, orchestrationMutation, accessProfile }) => {
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'Federated worker attachment requires a durable retry request.'
        )
      }
      const isPeerCaller = accessProfile === 'peer'
      // RISK 1 (S10-19 §0.2 / E.2): dispatchId/taskId are peer-chosen and become preamble
      // interpolations under the peer profile below — validated against the host's own id
      // grammar BEFORE any row is created or any effect runs, effect-free.
      if (isPeerCaller) {
        const idsAdmission = assertPeerDispatchIds({
          dispatchId: params.dispatchId,
          taskId: params.taskId
        })
        if (idsAdmission.refused) {
          throw new OrchestrationError(idsAdmission.wireCode, idsAdmission.message)
        }
      }
      if (params.worktree === 'current' || params.worktree === 'new-child') {
        throw new OrchestrationError(
          'invalid_argument',
          'A remote worker requires an exact existing worktree or new-top-level.'
        )
      }
      const createsWorktree = params.worktree === 'new-top-level'
      // §4.1 (frozen predicate): new-top-level is admitted unconditionally for a peer caller — no
      // repo check is possible before it exists. The exact-existing-worktree branch is checked
      // after resolution, below (worktree.repoId is not known until then).
      const { agent, launch } = prepareFederationAttachmentWorkerStart({
        params,
        createsWorktree,
        runtime
      })
      if (createsWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo as string,
          existingPlacement: 'an exact existing folder workspace'
        })
      }

      // Why: no source pane (`lineage.noParent`) and no pairedDeviceId — the link's own binding
      // is the only authority, and an unticked link fails closed (§2a, §7 q8).
      const credentialLane = runtime.resolveFederatedLinkCredentialLane(
        orchestrationMutation.callerFingerprint
      )
      const db = runtime.getOrchestrationDb()
      db.createRemoteDispatchAttachment({
        dispatchId: params.dispatchId,
        taskId: params.taskId,
        homePeerFingerprint: orchestrationMutation.callerFingerprint,
        protocolVersion: params.protocolVersion,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      const effects: FederationEffect[] = []
      let failedStage = createsWorktree ? 'worktree_create' : 'worktree_resolve'
      let worktree
      let terminalHandle = params.terminal
      const setupSource = createsWorktree
        ? (params.setupSource ?? (params.setup ? 'explicit_request' : 'orchestration_default'))
        : 'existing_worktree'
      let setup: WorkerSetupReceipt = {
        requested: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        effective: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        source: setupSource,
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: createsWorktree ? 'not_configured' : 'not_applicable'
      }
      try {
        if (createsWorktree) {
          db.recordRemoteAttachmentStage({
            dispatchId: params.dispatchId,
            stage: 'worktree_creating'
          })
          const setupDecision = params.setup ?? 'run'
          const created = await runtime.createManagedWorktree({
            credentialLane,
            repoSelector: params.repo as string,
            name: params.name as string,
            baseBranch: params.baseBranch,
            displayName: params.displayName,
            comment: params.comment,
            // setupDecision runs setup without the legacy runHooks activation side effect.
            runHooks: false,
            setupDecision,
            awaitTerminalProvisioning: true,
            observeSetupCompletion: true,
            createdWithAgent: agent as TuiAgent,
            startupAgent: agent as TuiAgent,
            ...(launch.preferences ? { startupLaunchPreferences: launch.preferences } : {}),
            activate: false,
            lineage: { noParent: true }
          })
          worktree = created.worktree
          terminalHandle = created.startupTerminal?.handle
          effects.push({
            kind: 'worktree',
            action: 'created_top_level',
            id: created.worktree.id
          })
          setup = {
            requested: setupDecision,
            effective: setupDecision,
            source: setupSource,
            hookFound: created.setupReceipt?.hookFound ?? false,
            startupPolicy: created.setupReceipt?.startupPolicy ?? 'start-immediately',
            state: created.setupReceipt?.state ?? 'not_configured'
          }
          if (!terminalHandle) {
            throw new Error(
              created.warning ?? 'Agent-first worktree creation returned no terminal.'
            )
          }
          const listed = await runtime.listTerminals(`id:${created.worktree.id}`, undefined, {
            includeVisualLayouts: false
          })
          appendFederationTerminalEffects(
            effects,
            listed.terminals,
            terminalHandle,
            created.setupReceipt?.terminalHandle
          )
          appendFederationSetupEffect(effects, setup)
        } else {
          const resolved = await resolveExistingFederatedWorktree({
            runtime,
            worktreeSelector: params.worktree,
            isPeerCaller,
            credentialLane,
            agent,
            launch,
            terminalHandle,
            taskId: params.taskId,
            effects
          })
          worktree = resolved.worktree
          terminalHandle = resolved.terminalHandle
          if (resolved.failedStageOverride) {
            failedStage = resolved.failedStageOverride
          }
        }
        if (!worktree || !terminalHandle) {
          throw new Error('Federated worker topology did not resolve.')
        }
        const setupStage = {
          db,
          dispatchId: params.dispatchId,
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          effects
        }
        if (persistFederatedSetupSpawnFailure(setupStage)) {
          failedStage = 'setup_start'
          throw new Error('Setup terminal failed to start before the gated agent launch.')
        }
        persistFederatedReadinessStage(setupStage)
        failedStage = 'agent_readiness'
        // §14B: a peer-supplied timeoutMs is clamped, never extended past the host's ceiling
        // (G-5) — a paired FULL caller keeps today's plain default, unclamped.
        const wait = await runtime.waitForTerminal(terminalHandle, {
          condition: 'tui-idle',
          timeoutMs: isPeerCaller
            ? clampPeerAttachTimeoutMs(params.timeoutMs)
            : (params.timeoutMs ?? 60_000)
        })
        persistFederatedSetupWaitOutcome({ ...setupStage, wait })
        if (!wait.satisfied) {
          if (setup.state === 'failed') {
            failedStage = 'setup_wait'
          }
          throw new Error(
            wait.blockedReason
              ? `Agent startup blocked: ${wait.blockedReason}`
              : `Agent did not become ready (${wait.status}).`
          )
        }
        const paneKey = runtime.getTerminalPaneKey(terminalHandle)
        const processIncarnation = runtime.getTerminalProcessIncarnation(terminalHandle)
        if (!paneKey || !processIncarnation) {
          throw new Error('stable_pane_required')
        }
        const capability = db.prepareRemoteAttachmentAuthority({
          dispatchId: params.dispatchId,
          paneKey,
          processIncarnation,
          worktreeId: worktree.id,
          terminalHandle,
          setupState: setup.state,
          effects
        })
        failedStage = 'dispatch_input'
        const cliCommand = runtime.getTerminalOrchestrationCliCommand(terminalHandle)
        const sendArgs = {
          db,
          runtime,
          dispatchId: params.dispatchId,
          taskId: params.taskId,
          taskSpec: params.taskSpec,
          terminalHandle,
          capability,
          cliCommand
        }
        // Ruling 24(a): PEER never types taskSpec (mail pointer only); FULL keeps the paste,
        // stripped of submit bytes and gated on live foreground agent ownership.
        const { attachment, inputEvidence } = isPeerCaller
          ? await sendPeerDispatchMailPointer({ ...sendArgs, effects })
          : await sendFullDispatchPaste({ ...sendArgs, devMode: params.devMode, effects })
        monitorFederatedSetup({ ...setupStage, runtime })
        // Why the peer arms it: the home has no way to look at this terminal, so an observation
        // about it can only be made here and reaches the coordinator through the relay queue.
        runtime.armDispatchInputObserver(params.dispatchId, {
          dispatchId: params.dispatchId,
          taskId: params.taskId,
          terminalHandle,
          taskSpec: params.taskSpec,
          submittedAt: Date.parse(inputEvidence.submittedAt),
          processIncarnation
        })
        return {
          dispatchId: params.dispatchId,
          state: attachment.state,
          stage: attachment.stage,
          runtimeEpoch: runtime.getRuntimeId(),
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          launch: launch.receipt,
          inputEvidence,
          effects,
          residualResources: []
        }
      } catch (error) {
        return failFederatedAttachmentWithReceipt({
          db,
          dispatchId: params.dispatchId,
          runtimeEpoch: runtime.getRuntimeId(),
          failedStage,
          error,
          setup,
          launch: launch.receipt
        })
      }
    }
  })
]
