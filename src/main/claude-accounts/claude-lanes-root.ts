import { join } from 'node:path'
import { app } from 'electron'
import { CLAUDE_LANES_DIRNAME } from '../../shared/lane-path-containment'

export { CLAUDE_LANES_DIRNAME }

/**
 * Root of the per-principal Claude credential lanes (S9 §2a: `<userData>/claude-lanes/
 * <principalId>/`). No lane is provisioned yet; the capture guard must already refuse this
 * tree so a lane cannot be laundered into a permanent managed account the moment lanes ship.
 */
export function getClaudeLanesRoot(): string {
  return join(app.getPath('userData'), CLAUDE_LANES_DIRNAME)
}
