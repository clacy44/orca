// D-30a (T7): a deliberate quit leaves the detached daemon, and the chairs in it, running; only a dead dev parent shuts it down.
export function runQuitDaemonTeardown<T>(
  devParentShutdownRequested: boolean,
  teardown: { shutdown: () => T; disconnect: () => T }
): T {
  return devParentShutdownRequested ? teardown.shutdown() : teardown.disconnect()
}
