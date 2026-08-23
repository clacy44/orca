import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
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

export type LaneMirrorOptions = {
  entries?: readonly string[]
  platform?: NodeJS.Platform
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
  options: LaneMirrorOptions = {}
): LaneMirrorResult {
  const entries = options.entries ?? LANE_MIRRORED_USER_CONTENT
  const platform = options.platform ?? process.platform
  mkdirSync(laneDir, { recursive: true, mode: 0o700 })
  const mirrored: string[] = []
  const absent: string[] = []
  for (const entry of entries) {
    const source = join(hostConfigDir, entry)
    if (!existsSync(source)) {
      absent.push(entry)
      continue
    }
    const target = join(laneDir, entry)
    // Why: dereference symlinks rather than copying them — a link in the host config dir would
    // otherwise resolve inside the lane against whatever its owner re-points it at later.
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      force: true
    })
    applyLaneContentModes(target, platform)
    mirrored.push(entry)
  }
  return { mirrored, absent }
}

/**
 * `cpSync` preserves the SOURCE mode, and the shared config dir carries the ordinary 0644/0755.
 * A lane's rule is directory 0700, files 0600 (§2a), so the copied tree is re-moded rather than
 * left as the one place in a lane where that invariant has counterexamples.
 *
 * Skipped on win32, where the mode bit is inert and the lane's DACL is the control.
 */
function applyLaneContentModes(target: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    return
  }
  const isDirectory = statSync(target).isDirectory()
  chmodSync(target, isDirectory ? 0o700 : 0o600)
  if (!isDirectory) {
    return
  }
  for (const child of readdirSync(target)) {
    applyLaneContentModes(join(target, child), platform)
  }
}
