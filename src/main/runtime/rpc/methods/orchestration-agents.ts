// S10-1b: agents.register / list / get / find / quarantine. Identity comes ONLY from
// runtime.verifyOrchestrationCompatibilityCaller — deliberately not added to
// CURRENT_AUTHORITY_PREFLIGHT_METHODS (orchestration-legacy-compatibility.ts), so each method
// verifies directly rather than inheriting send's confirm-a-claim path (CONTAINMENT #1). Each
// verb lives in its own file (orchestration-agents-*.ts) to stay under the max-lines ratchet;
// this index just concatenates them the way ORCHESTRATION_RUN_METHODS etc. are spread upstream.
import type { RpcMethod } from '../core'
import { ORCHESTRATION_AGENTS_REGISTER_METHODS } from './orchestration-agents-register'
import { ORCHESTRATION_AGENTS_DIRECTORY_METHODS } from './orchestration-agents-directory'
import { ORCHESTRATION_AGENTS_FIND_METHODS } from './orchestration-agents-find'
import { ORCHESTRATION_AGENTS_QUARANTINE_METHODS } from './orchestration-agents-quarantine'
import { ORCHESTRATION_AGENTS_RELINK_METHODS } from './orchestration-agents-relink'
import { ORCHESTRATION_AGENTS_RETIRE_METHODS } from './orchestration-agents-retire'

export const ORCHESTRATION_AGENT_METHODS: RpcMethod[] = [
  ...ORCHESTRATION_AGENTS_REGISTER_METHODS,
  ...ORCHESTRATION_AGENTS_DIRECTORY_METHODS,
  ...ORCHESTRATION_AGENTS_FIND_METHODS,
  ...ORCHESTRATION_AGENTS_QUARANTINE_METHODS,
  ...ORCHESTRATION_AGENTS_RELINK_METHODS,
  ...ORCHESTRATION_AGENTS_RETIRE_METHODS
]
