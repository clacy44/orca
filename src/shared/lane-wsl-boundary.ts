import { basename } from 'node:path/win32'
import { ClaudeLaneRefusal } from './claude-lane-refusals'
import { hasClaudeLaneSegment } from './lane-path-containment'

/**
 * The two rules that decide a lane at the WSL boundary — sited where the RESOLVED shell is (S9 §2a).
 *
 * `PtySpawnOptions` carries no resolved shell and no `isWsl`, so neither rule is evaluable at the
 * spawn anchor: the value is computed inside the provider, from cwd-derived WSL info, the worktree
 * context, the Windows shell setting, a per-tab `shellOverride` and a `projectRuntime`. Both rules
 * therefore live two steps from the export gate that reads the same value.
 */

/** The export gate's own predicate, deliberately not the broader `isWslShell` beside it. */
function isWslShellPath(shellPath: string | undefined): boolean {
  return shellPath !== undefined && basename(shellPath).toLowerCase() === 'wsl.exe'
}

/**
 * A lane path is a host-side `<userData>\claude-lanes\<id>`; a Linux-side `claude` handed one
 * either hard-fails or silently creates an empty config dir sitting at a login prompt — while the
 * pane still renders `credentialLane: 'grant'` and bills its usage to the lane owner. S9e is what
 * makes a lane WSL-visible; until then a lane pane that resolves to `wsl.exe` is refused.
 */
export function assertLaneShellSupported(
  credentialLane: { principalId: string } | undefined,
  shellPath: string | undefined
): void {
  if (credentialLane && isWslShellPath(shellPath)) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_wsl_shell_unsupported',
      'This terminal is pinned to your personal Claude credential lane, and that lane is a Windows directory WSL cannot read, so Orca did not start it inside WSL. Open this terminal with a Windows shell, or use a terminal that is not pinned to a lane.'
    )
  }
}

/**
 * The invariant, asserted rather than repaired: no lane path is present in a spawn env that takes
 * the WSL branch. It is stated over the env because the daemon rebuilds its own env in its own
 * process and carries no lane field — and because a lane path crossing WSLENV is the harm,
 * whichever variable carried it and whichever classifier disagreed about the pane.
 */
export function assertNoLanePathCrossesWsl(
  env: Record<string, string>,
  shellPath: string | undefined
): void {
  if (!isWslShellPath(shellPath)) {
    return
  }
  const offender = Object.entries(env).find(([, value]) => hasClaudeLaneSegment(value))
  if (offender) {
    // Why the second sentence: the daemon arm has no lane field, so the test is the DIRECTORY
    // NAME — a folder of your own called `claude-lanes` trips this, and the message has to say
    // so or the refusal is unexplainable from the outside (§2a, and the fail-closed reading of
    // `hasClaudeLaneSegment`).
    throw new ClaudeLaneRefusal(
      'terminal.lane_wsl_shell_unsupported',
      `Orca did not start this terminal: ${offender[0]} points inside a "claude-lanes" directory, which is where this machine keeps personal Claude credential lanes and which a WSL distribution cannot read. If that path is your own directory that happens to carry the name, rename it; otherwise open this terminal with a Windows shell instead.`
    )
  }
}
