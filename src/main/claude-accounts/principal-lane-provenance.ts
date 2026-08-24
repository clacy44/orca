import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LANE_PROVENANCE_FILENAME = '.orca-lane-provenance'
export const LANE_PROVENANCE_PREFIX = 'lane:'

/**
 * The lane's provenance label — an opaque random token minted with the lane, never the
 * principalId and never a deviceId (S9 §2a/§2k). `provenance` is copied into published usage
 * metadata, so it must not be a second carrier of a host-minted identifier.
 *
 * It bounds INCIDENTAL disclosure only: R4 gives the other developer typing access to a lane
 * pane, and `env` there names the lane path outright. No later slice may treat it as secret.
 */
export function ensureLaneProvenanceLabel(laneDir: string): string {
  const existing = readLaneProvenanceLabel(laneDir)
  if (existing) {
    return existing
  }
  const label = randomBytes(16).toString('hex')
  writeFileSync(join(laneDir, LANE_PROVENANCE_FILENAME), `${label}\n`, {
    encoding: 'utf-8',
    mode: 0o600
  })
  return label
}

/**
 * The same label, or `null` when it could not be established.
 *
 * Minting is a filesystem WRITE, and the callers that need a label sit AFTER a sync has already
 * succeeded — including inside §2f's wipe window, where the lane directory can disappear between
 * the read and the write. A row that cannot be labelled is dropped, which fails closed (the lane
 * attracts no posts) instead of turning a successful sync into a rejection for every caller.
 */
export function ensureLaneProvenanceLabelOrNull(laneDir: string): string | null {
  try {
    return ensureLaneProvenanceLabel(laneDir)
  } catch (error) {
    console.warn('[lane-provenance] could not establish a lane provenance label:', error)
    return null
  }
}

export function readLaneProvenanceLabel(laneDir: string): string | null {
  const labelPath = join(laneDir, LANE_PROVENANCE_FILENAME)
  if (!existsSync(labelPath)) {
    return null
  }
  const label = readFileSync(labelPath, 'utf-8').trim()
  return /^[0-9a-f]{32}$/.test(label) ? label : null
}

/**
 * `lane:<opaqueLabel>` — deliberately NOT `managed:`-prefixed, because `isManagedClaudeAuth`
 * (`rate-limits/claude-fetcher.ts:492`) gates CLI usage supplementation on that prefix and lane
 * usage arrives by the statusline path instead (§2k).
 */
export function formatLaneProvenance(label: string): string {
  return `${LANE_PROVENANCE_PREFIX}${label}`
}
