// Component bounds of one manual terminal-host restart. A spawn fenced by the restart waits
// RESTART_SPAWN_FENCE_MS, so that number is DERIVED here from the stages it must outlast, not guessed.
// Each copied bound is pinned to its source in restart-duration-bounds.test.ts.

/** Spawns already past the fence finish before the snapshot (pty.ts awaitRestartSpawnDrain). */
export const RESTART_DRAIN_MS = 10_000
/** The old adapter's in-flight respawn settles before step 3 kills anything. */
export const RESTART_RESPAWN_QUIESCE_MS = 30_000
/** Step 3's `listSessions` request (client.ts REQUEST_TIMEOUT_MS); a timeout is swallowed, so it only costs time. */
export const DAEMON_LIST_SESSIONS_RPC_MS = 30_000
/** Step 3's `shutdown` request (client.ts REQUEST_TIMEOUT_MS). It waits on one dispose. */
export const DAEMON_SHUTDOWN_RPC_MS = 30_000
/** One dispose wait (session.ts IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS); inside the shutdown RPC bound. */
export const DAEMON_SHUTDOWN_DISPOSE_MS = 8_000
/** FX-4a's win32 dispose sweep before the root force-kill: ancestry probe 3 s + taskkill 5 s; inside the shutdown RPC bound. */
export const WIN32_DISPOSE_TREE_KILL_MS = 8_000
export const DAEMON_SELF_SHUTDOWN_WAIT_MS = 5_000
/** Covers the daemon's second dispose after its listener closed and its PID record may be gone. */
export const DAEMON_RPC_SHUTDOWN_PROCESS_EXIT_WAIT_MS = 20_000
/** killStaleDaemon + the gate's own re-check: three identity queries (3 s each on win32), SIGTERM wait 3 s, SIGKILL confirm 1 s, endpoint probes. */
export const DAEMON_KILL_ESCALATION_MS = 15_000
/** Step 4's launcher before the fork: two connects (5 s each) and the health check (3 s). */
export const STEP4_LAUNCHER_PROBES_MS = 13_000
/** Step 4: the launcher's ready wait. */
export const DAEMON_STARTUP_MS = 10_000
/** The announcement's recovery-plan bound (pty.ts planMs). */
export const RESTART_PLAN_MS = 5_000
export const RESTART_SPAWN_FENCE_MARGIN_MS = 15_000

export const RESTART_SPAWN_FENCE_MS =
  RESTART_DRAIN_MS +
  RESTART_RESPAWN_QUIESCE_MS +
  DAEMON_LIST_SESSIONS_RPC_MS +
  DAEMON_SHUTDOWN_RPC_MS +
  DAEMON_SELF_SHUTDOWN_WAIT_MS +
  DAEMON_RPC_SHUTDOWN_PROCESS_EXIT_WAIT_MS +
  DAEMON_KILL_ESCALATION_MS +
  STEP4_LAUNCHER_PROBES_MS +
  DAEMON_STARTUP_MS +
  RESTART_PLAN_MS +
  RESTART_SPAWN_FENCE_MARGIN_MS
