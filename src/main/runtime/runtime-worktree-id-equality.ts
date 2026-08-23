import { splitWorktreeId } from '../../shared/worktree/id'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

/**
 * How the runtime compares two worktree ids, in one place because more than the runtime asks.
 *
 * A bare `!==` on ids that differ only in path spelling is a mis-answer with consequences on
 * every host Orca supports but the one it was written on: the lane wake's partition reads the
 * same records `clearSleepingAgentRecord` writes, and a record the partition misses falls
 * through to the renderer wake, which mints an unbound pane on the shared credential (S9 §2a).
 */
export function runtimePathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

/**
 * Why: runtime identity is per *workspace*, not per checkout dir. Folder projects back
 * several independent workspaces with one directory, separated only by the
 * `::workspace:<uuid>` suffix that filesystem callers must strip; stripping it here
 * instead lets one session steal a sibling's PTYs. Normalize only path spelling, so
 * Windows/WSL/SSH ids still match themselves across hosts.
 */
export function runtimeWorktreeIdsEqual(left: string, right: string): boolean {
  const parsedLeft = splitWorktreeId(left)
  const parsedRight = splitWorktreeId(right)
  return parsedLeft && parsedRight
    ? parsedLeft.repoId === parsedRight.repoId &&
        runtimePathsEqual(parsedLeft.worktreePath, parsedRight.worktreePath)
    : left === right
}
