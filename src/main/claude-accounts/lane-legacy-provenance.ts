/**
 * Detects an `unverified-legacy` lane (S9 design §6's S9-L3 migration, §3's migration row): a
 * lane whose `.credentials.json` predates the per-lane login model — a pre-upgrade pushed lane,
 * like the live VPS lane — because it has never written `claude-accounts/index.json`. Orca cannot
 * reason about that credential's provenance: it is never presented as a lane-owned grant in the
 * account store (the index simply has no row for it), it is never wiped on sight (a working box
 * stays working), and it is never promoted. The first successful lane login replaces it — the
 * ordinary capture path (`lane-login-capture.ts`) already rewrites `.credentials.json` and writes
 * an index row unconditionally, so no special-cased "migration" write exists or is needed here.
 */
import { isLaneLoaded } from './principal-lane-credential-sweep'
import { getLaneAccountsRoot, readLaneAccountIndexRaw } from './lane-account-index'

export function isUnverifiedLegacyLane(laneDir: string): boolean {
  if (!isLaneLoaded(laneDir)) {
    return false
  }
  return readLaneAccountIndexRaw(getLaneAccountsRoot(laneDir)).kind === 'missing'
}
