// S10-12 R3: an AppImage's app path is a FUSE mount (/tmp/.mount_*) owned by the serve
// process — it is unmounted the instant that process exits. A daemon left executing from
// inside it (or a serve process about to exit while one still is) is then running, or about
// to leave a daemon running, an unmapped-on-demand binary: latent SIGBUS/EIO, silent death,
// no log line — exactly production's "the restart took the panes with it" signature.
//
// (iii) from the chair ruling: detection + a loud warning + telemetry, unconditionally.
// (i)/(ii) — a stable copied-out entry path or holding the mount open for the daemon's
// lifetime — are not attempted here; see the S10-12 report for why.

import { track } from '../telemetry/client'

const APPIMAGE_MOUNT_PATH_PREFIX = '/tmp/.mount_'

/** True only for a real AppImage FUSE mount path on Linux — never trips on macOS/Windows,
 *  a dev checkout, or an extracted AppImage directory (R5 T3's negative case). */
export function isAtRiskOnAppImageMount(execPath: string): boolean {
  return process.platform === 'linux' && execPath.startsWith(APPIMAGE_MOUNT_PATH_PREFIX)
}

function trackQuietly(stage: 'daemon_spawn' | 'serve_exit'): void {
  try {
    track('daemon_linux_mount_risk', { stage })
  } catch {
    // Telemetry is best-effort; a dropped event must never block a daemon spawn or serve exit.
  }
}

/** Call once per daemon spawn, with the path about to be forked. Loud because there is no
 *  other point where this condition is this cheap to observe. */
export function warnIfDaemonSpawnAtRiskOnAppImageMount(entryPath: string): void {
  if (!isAtRiskOnAppImageMount(entryPath)) {
    return
  }
  console.warn(
    `[daemon] AT-RISK LAUNCH: spawning the daemon from inside an AppImage FUSE mount (${entryPath}). ` +
      'This mount is torn down when the current serve/app process exits, leaving the daemon executing ' +
      'an unmapped binary — a latent silent-death risk for every session it owns. See S10-12.'
  )
  trackQuietly('daemon_spawn')
}

/** Call once at serve exit, with the CURRENT process's own execPath (not the daemon's) — the
 *  condition that matters here is "this process is about to stop holding the mount open". */
export function warnIfServeExitAtRiskOnAppImageMount(execPath: string): void {
  if (!isAtRiskOnAppImageMount(execPath)) {
    return
  }
  console.warn(
    `[daemon] AT-RISK EXIT: this serve process is exiting from inside an AppImage FUSE mount (${execPath}). ` +
      'Any daemon it left running is now executing an unmapped binary and may die silently at any time. See S10-12.'
  )
  trackQuietly('serve_exit')
}
