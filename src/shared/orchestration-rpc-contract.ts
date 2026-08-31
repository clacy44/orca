import { ORCHESTRATION_CONTRACT_VERSION } from './protocol-version'

export type OrchestrationMigrationReason =
  | 'client_contract_missing'
  | 'client_contract_unsupported'
  | 'runtime_capability_missing'
  | 'command_retired'

export const ORCHESTRATION_SKILL_COMMAND_ARGS = [
  'skills',
  'get',
  'orchestration',
  '--full'
] as const

export const ORCHESTRATION_LEGACY_RUN_ID = 'run_legacy_local'

const ORCHESTRATION_MUTATION_METHODS = new Set([
  'orchestration.runCreate',
  'orchestration.runUse',
  'orchestration.send',
  'orchestration.reply',
  'orchestration.taskCreate',
  'orchestration.taskUpdate',
  'orchestration.dispatch',
  'orchestration.workerStart',
  'orchestration.workerStop',
  'orchestration.workerAbandon',
  'orchestration.workerRelease',
  'orchestration.workerRetain',
  'orchestration.ask',
  // S10-8 R2/R7 fix (review blocker): the RECEIVING half of a cross-host ask relay. Without this,
  // `isOrchestrationMutation` is false for it, so the dispatcher's OrchestrationMutationExecutor
  // never wraps it — no durable mutation receipt, no in-flight coalescing, and
  // callOrchestrationWorkerServer's pre-relay `status.get` capability precheck (orca-runtime.ts)
  // never runs for it either. Registering it here fixes all three at once: a retried relay with
  // the same orchestrationRequestId now dedups/coalesces on the receiving host instead of
  // minting a second question, and relaying to a pre-S10-8 peer now surfaces the typed
  // `orchestration_migration_required` disposition instead of a raw method-not-found.
  'orchestration.federatedAsk',
  'orchestration.gateCreate',
  'orchestration.gateResolve',
  'orchestration.reset',
  'orchestration.federationAttachStart',
  'orchestration.federationAck',
  'orchestration.federationImport',
  'orchestration.federationStop'
])

const RETIRED_ORCHESTRATION_METHODS = new Set(['orchestration.run', 'orchestration.runStop'])

export function isRetiredOrchestrationMethod(method: string): boolean {
  return RETIRED_ORCHESTRATION_METHODS.has(method)
}

export function isOrchestrationMutation(method: string, params: unknown): boolean {
  if (isRetiredOrchestrationMethod(method)) {
    return true
  }
  if (method === 'orchestration.check') {
    if (hasStringProperty(params, 'ack')) {
      return true
    }
    return !isExplicitReadOnlyCheck(params)
  }
  if (method === 'orchestration.dispatch') {
    return !hasTrueProperty(params, 'dryRun')
  }
  return ORCHESTRATION_MUTATION_METHODS.has(method)
}

export function orchestrationSkillRecoveryData(): {
  effectsApplied: false
  guide: { topic: 'orchestration'; full: true }
  nextCommandArgs: typeof ORCHESTRATION_SKILL_COMMAND_ARGS
  nextSteps: string[]
} {
  return {
    effectsApplied: false,
    guide: { topic: 'orchestration', full: true },
    nextCommandArgs: ORCHESTRATION_SKILL_COMMAND_ARGS,
    nextSteps: [
      'Using this same Orca CLI executable, run: skills get orchestration --full',
      'Read the returned guide completely and do not retry the previous command unchanged.'
    ]
  }
}

export function orchestrationMigrationData(reason: OrchestrationMigrationReason): ReturnType<
  typeof orchestrationSkillRecoveryData
> & {
  reason: OrchestrationMigrationReason
  requiredContractVersion: number
} {
  return {
    reason,
    requiredContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    ...orchestrationSkillRecoveryData()
  }
}

function isExplicitReadOnlyCheck(params: unknown): boolean {
  return (
    hasTrueProperty(params, 'peek') ||
    hasTrueProperty(params, 'all') ||
    hasFalseProperty(params, 'unread')
  )
}

function hasStringProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[property] === 'string'
  )
}

function hasTrueProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[property] === true
  )
}

function hasFalseProperty(value: unknown, property: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[property] === false
  )
}
