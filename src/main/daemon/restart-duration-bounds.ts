// Component bounds of one manual terminal-host restart. A spawn fenced by the restart waits
// RESTART_SPAWN_FENCE_MS, so that number is DERIVED here from the stages it must outlast, not guessed.

/** Spawns already past the fence finish before the snapshot (pty.ts awaitRestartSpawnDrain). */
export const RESTART_DRAIN_MS = 10_000
/** The old adapter's in-flight respawn settles before step 3 kills anything. */
export const RESTART_RESPAWN_QUIESCE_MS = 30_000
/** The shutdown RPC replies after one dispose (session.ts IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS). */
export const DAEMON_SHUTDOWN_DISPOSE_MS = 8_000
export const DAEMON_SELF_SHUTDOWN_WAIT_MS = 5_000
/** Covers the daemon's second dispose after its listener closed and its PID record may be gone. */
export const DAEMON_RPC_SHUTDOWN_PROCESS_EXIT_WAIT_MS = 20_000
/** SIGTERM wait 3 s + SIGKILL confirm 1 s (daemon-health.ts) + endpoint re-probe. */
export const DAEMON_KILL_ESCALATION_MS = 5_000
/** Step 4: the launcher's ready wait. */
export const DAEMON_STARTUP_MS = 10_000
/** The announcement's recovery-plan bound (pty.ts planMs). */
export const RESTART_PLAN_MS = 5_000
const RESTART_SPAWN_FENCE_MARGIN_MS = 15_000

export const RESTART_SPAWN_FENCE_MS =
  RESTART_DRAIN_MS +
  RESTART_RESPAWN_QUIESCE_MS +
  DAEMON_SHUTDOWN_DISPOSE_MS +
  DAEMON_SELF_SHUTDOWN_WAIT_MS +
  DAEMON_RPC_SHUTDOWN_PROCESS_EXIT_WAIT_MS +
  DAEMON_KILL_ESCALATION_MS +
  DAEMON_STARTUP_MS +
  RESTART_PLAN_MS +
  RESTART_SPAWN_FENCE_MARGIN_MS
