import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * User-level content that lives INSIDE the config dir and is therefore relocated as a unit by
 * `CLAUDE_CONFIG_DIR` — so an unmirrored lane starts with zero custom slash commands, zero user
 * subagents, zero user skills, zero custom output styles and no memory (S9 §2a items (ii), (xii)).
 *
 * Authored workspace tooling, not secrets. Transcripts are deliberately NOT here: they are the
 * other developer's content, and copying them into a credential directory defeats the wipe promise.
 */
export const LANE_MIRRORED_USER_CONTENT = [
  'CLAUDE.md',
  'memories',
  'agents',
  'commands',
  'skills',
  'output-styles'
] as const

export type LaneMirrorResult = {
  mirrored: string[]
  absent: string[]
}

/**
 * One-way host→lane, recomputed at lane creation and on hook refresh.
 *
 * A lane's own additions are never mirrored back: the lane is downstream of the host by design,
 * so a two-way sync would let one grant's file rewrite what every other lane reads.
 */
export function mirrorHostUserContentIntoLane(
  hostConfigDir: string,
  laneDir: string,
  entries: readonly string[] = LANE_MIRRORED_USER_CONTENT
): LaneMirrorResult {
  mkdirSync(laneDir, { recursive: true, mode: 0o700 })
  const mirrored: string[] = []
  const absent: string[] = []
  for (const entry of entries) {
    const source = join(hostConfigDir, entry)
    if (!existsSync(source)) {
      absent.push(entry)
      continue
    }
    // Why: dereference symlinks rather than copying them — a link in the host config dir would
    // otherwise resolve inside the lane against whatever its owner re-points it at later.
    cpSync(source, join(laneDir, entry), {
      recursive: true,
      dereference: true,
      force: true
    })
    mirrored.push(entry)
  }
  return { mirrored, absent }
}
