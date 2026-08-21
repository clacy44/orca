// Why: `dispatch_inactive` is on the structured-passthrough allowlist, so this `data` reaches
// the caller verbatim and the CLI renders each step as a `Next step:` line — the fence's only
// signpost. Steps name a route the sender can actually take, never generic advice.
export type DispatchInactiveRecoveryData = {
  effectsApplied: false
  nextSteps: string[]
}

const START_NEW_DISPATCH_STEP =
  'Start a new Dispatch for the follow-up work; this one no longer accepts coordinator mail.'

export function federatedDispatchInactiveRecoveryData(worker: {
  terminalHandle?: string | null
  environmentName?: string | null
}): DispatchInactiveRecoveryData {
  const nextSteps: string[] = []
  if (worker.terminalHandle) {
    // Why the conditional selector: the handle names a pane on the runtime that owns the worker,
    // so it needs `--environment` from the Run home and none on the worker's own runtime.
    const environment = worker.environmentName ? ` --environment ${worker.environmentName}` : ''
    nextSteps.push(
      `Reach the worker's terminal directly: orca terminal send --terminal ${worker.terminalHandle}${environment} --text "<message>" --enter`
    )
  }
  nextSteps.push(START_NEW_DISPATCH_STEP)
  return { effectsApplied: false, nextSteps }
}

export function localDispatchInactiveRecoveryData(
  workerTerminalHandle?: string | null
): DispatchInactiveRecoveryData {
  const nextSteps: string[] = []
  if (workerTerminalHandle) {
    // Why this mailbox: after settlement the worker's `check` reads its terminal handle, so that
    // address still has a reader while `dispatch:<id>` has none.
    nextSteps.push(
      `Send to the worker's terminal mailbox instead: orca orchestration send --to ${workerTerminalHandle} --subject "<subject>"`
    )
  }
  nextSteps.push(START_NEW_DISPATCH_STEP)
  return { effectsApplied: false, nextSteps }
}
