// Why: the relay is only useful while the worker can still send or receive — every
// other state settles the Dispatch, so an armed timer would poll a dead peer forever.
const FEDERATION_RELAY_ACTIVE_WORKER_STATES = new Set(['starting', 'ready', 'stopping'])

export type FederationRelayArmingCandidate = {
  dispatchId: string
  workerState: string | undefined
}

export function isFederationRelayActiveWorkerState(state: string | undefined): boolean {
  return state !== undefined && FEDERATION_RELAY_ACTIVE_WORKER_STATES.has(state)
}

// Why: at boot the queued mail on both sides is already durable; scanning for
// still-active federated dispatches resumes delivery without waiting for an RPC to
// touch the Run.
export function selectFederationRelayResumeDispatchIds(
  candidates: readonly FederationRelayArmingCandidate[]
): string[] {
  const resumed: string[] = []
  for (const candidate of candidates) {
    if (
      isFederationRelayActiveWorkerState(candidate.workerState) &&
      !resumed.includes(candidate.dispatchId)
    ) {
      resumed.push(candidate.dispatchId)
    }
  }
  return resumed
}
