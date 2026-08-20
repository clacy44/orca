// Why: the relay is only useful while the worker can still send or receive — every
// other state settles the Dispatch, so an armed timer would poll a dead peer forever.
const FEDERATION_RELAY_ACTIVE_WORKER_STATES = new Set(['starting', 'ready', 'stopping'])

export function isFederationRelayActiveWorkerState(state: string | undefined): boolean {
  return state !== undefined && FEDERATION_RELAY_ACTIVE_WORKER_STATES.has(state)
}
