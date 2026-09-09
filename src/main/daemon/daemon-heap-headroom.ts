// D-R164 M1: RAM-aware daemon --max-old-space-size, mirroring
// src/main/startup/renderer-heap-headroom.ts's floor/cap/env-override shape. Unlike the renderer
// (which can fall back to Chromium's own physical-memory heuristic), the daemon fork has no such
// default to fall back to — R117 FIX 4 exists precisely because its old unset default let V8 grow
// to ~4GB before aborting — so this always returns a bound; there is no low-RAM "disable" case.
import { totalmem } from 'node:os'

const DAEMON_HEAP_ENV_VAR = 'ORCA_DAEMON_HEAP_MB'
const BYTES_PER_GIB = 1024 * 1024 * 1024
const DAEMON_HEAP_RAM_FRACTION = 0.4
export const DAEMON_HEAP_FLOOR_MB = 3072
// V8 pointer-compression cage hard limit, same as the renderer's.
export const DAEMON_HEAP_CAP_MB = 4096

function parseDaemonHeapOverrideMb(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined
  }
  return Math.floor(parsed)
}

/** Daemon fork's --max-old-space-size ceiling (MB). Pure so the RAM tiers and the env override
 *  are unit-testable without spawning a child process. */
export function computeDaemonHeapCeilingMb(totalMemoryBytes: number, envOverride?: string): number {
  const override = parseDaemonHeapOverrideMb(envOverride)
  if (override !== undefined) {
    return override
  }
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return DAEMON_HEAP_FLOOR_MB
  }
  const totalGib = totalMemoryBytes / BYTES_PER_GIB
  const targetMb = Math.floor(totalGib * DAEMON_HEAP_RAM_FRACTION * 1024)
  return Math.min(DAEMON_HEAP_CAP_MB, Math.max(DAEMON_HEAP_FLOOR_MB, targetMb))
}

export function resolveDaemonHeapCeilingMb(env: NodeJS.ProcessEnv = process.env): number {
  return computeDaemonHeapCeilingMb(totalmem(), env[DAEMON_HEAP_ENV_VAR])
}
