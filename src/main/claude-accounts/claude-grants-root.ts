import { join } from 'node:path'
import { app } from 'electron'

export const CLAUDE_GRANTS_DIRNAME = 'claude-grants'

/**
 * Root of the per-grant Claude credential lanes (S9 §2f). No lane is provisioned yet;
 * the capture guard must already refuse this tree so a lane cannot be laundered into a
 * permanent managed account the moment lanes ship.
 */
export function getClaudeGrantsRoot(): string {
  return join(app.getPath('userData'), CLAUDE_GRANTS_DIRNAME)
}
