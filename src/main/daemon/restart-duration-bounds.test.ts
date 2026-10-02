import { describe, expect, it } from 'vitest'
import * as bounds from './restart-duration-bounds'
import { CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './client'
import {
  HEALTH_CHECK_TIMEOUT_MS,
  KILL_WAIT_MS,
  SIGKILL_CONFIRM_WAIT_MS,
  WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS
} from './daemon-health'
import { IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS } from './session'
import { WINDOWS_ROOT_IDENTITY_TIMEOUT_MS } from '../windows-pty-root-identity'
import { WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS } from '../windows-process-tree-kill'

// The spawn-fence wait is DERIVED from these copies, so each is pinned to its source of truth.
describe('restart-duration-bounds: copies equal their sources', () => {
  it('the dispose wait equals session.ts IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS', () => {
    expect(bounds.DAEMON_SHUTDOWN_DISPOSE_MS).toBe(IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS)
  })

  it('both step-3 RPC bounds equal client.ts REQUEST_TIMEOUT_MS', () => {
    expect(bounds.DAEMON_LIST_SESSIONS_RPC_MS).toBe(REQUEST_TIMEOUT_MS)
    expect(bounds.DAEMON_SHUTDOWN_RPC_MS).toBe(REQUEST_TIMEOUT_MS)
  })

  it('the win32 dispose sweep equals the root-identity probe plus taskkill bounds', () => {
    expect(bounds.WIN32_DISPOSE_TREE_KILL_MS).toBe(
      WINDOWS_ROOT_IDENTITY_TIMEOUT_MS + WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS
    )
  })

  it('the shutdown RPC bound covers one dispose wait plus the win32 sweep', () => {
    expect(bounds.DAEMON_SHUTDOWN_RPC_MS).toBeGreaterThanOrEqual(
      IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS + bounds.WIN32_DISPOSE_TREE_KILL_MS
    )
  })

  it('the escalation bound covers the identity queries, SIGTERM wait and SIGKILL confirm daemon-health.ts can spend', () => {
    // initial identity + post-SIGTERM recheck + the gate's own post-kill recheck, each a CIM query on win32
    const worst = 3 * WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS + KILL_WAIT_MS + SIGKILL_CONFIRM_WAIT_MS
    expect(bounds.DAEMON_KILL_ESCALATION_MS).toBeGreaterThanOrEqual(worst)
  })

  it('the launcher probe bound covers two connects and the health check', () => {
    expect(bounds.STEP4_LAUNCHER_PROBES_MS).toBeGreaterThanOrEqual(
      2 * CONNECT_TIMEOUT_MS + HEALTH_CHECK_TIMEOUT_MS
    )
  })
})

describe('restart-duration-bounds: the fence outlasts every counted stage', () => {
  it('is the sum of the stages plus the margin', () => {
    const stages =
      bounds.RESTART_DRAIN_MS +
      bounds.RESTART_RESPAWN_QUIESCE_MS +
      bounds.DAEMON_LIST_SESSIONS_RPC_MS +
      bounds.DAEMON_SHUTDOWN_RPC_MS +
      bounds.DAEMON_SELF_SHUTDOWN_WAIT_MS +
      bounds.DAEMON_RPC_SHUTDOWN_PROCESS_EXIT_WAIT_MS +
      bounds.DAEMON_KILL_ESCALATION_MS +
      bounds.STEP4_LAUNCHER_PROBES_MS +
      bounds.DAEMON_STARTUP_MS +
      bounds.RESTART_PLAN_MS
    expect(bounds.RESTART_SPAWN_FENCE_MS).toBeGreaterThan(stages)
    expect(bounds.RESTART_SPAWN_FENCE_MS - stages).toBe(bounds.RESTART_SPAWN_FENCE_MARGIN_MS)
  })
})
