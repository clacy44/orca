// S10-21d b4 (design-r105-r112 ITEM 2 D4/D7/D8; s10-21d-design-v1 DEC-2): the PURE planner for
// `orca chairs restore` — no IO, no DB, no runtime calls. The executor (chairs-restore-execute.ts)
// gathers every input below (directory rows, liveness signals, session holders) and hands them
// here as plain data; this module only decides what to DO, never does it, so the decision table
// is unit-testable without a runtime or a database.
import type { ChairsManifest, ChairsManifestEntry } from './chairs-manifest'

/** What the executor already knows about ONE chair name's row on this host, gathered up front
 * (db.getAgentByName + runtime.getAgentDirectoryLivenessSignals) — never re-derived here. */
export type ChairOwnRowLookup = {
  paneKey: string | null
  isLive: boolean
}

/** Who currently holds the manifest entry's target session id on this host (db.paneHoldingSession
 * + liveness), gathered up front — distinct from `ownRow` above: the holder may be a DIFFERENT
 * identity than the manifest's own chair name (a live-elsewhere collision), or the SAME pane the
 * chair's own row already names (in which case `skip_live` already covers it). */
export type ChairSessionHolderLookup = {
  paneKey: string | null
  isLive: boolean
}

export type ChairPlanLookup = {
  ownRow: ChairOwnRowLookup | null
  holder: ChairSessionHolderLookup
}

export type ChairsRestorePlanAction =
  | { name: string; kind: 'skip_live'; reason: string; paneKey: string }
  | {
      name: string
      kind: 'rebind'
      reason: string
      sessionId: string
      holderPaneKey: string | null
    }
  | { name: string; kind: 'launch'; reason: string; sessionId: string }
  | { name: string; kind: 'refuse'; reason: string; holderPaneKey: string }

export type ChairsRestorePlan = {
  actions: ChairsRestorePlanAction[]
  remote: { name: string; host: string }[]
}

/** manifest entry's own resume target: the live head if one was ever recorded, else the
 * immutable seed — same rule the executor uses to write `lastSessionId` back. */
export function chairTargetSessionId(entry: ChairsManifestEntry): string {
  return entry.lastSessionId ?? entry.conversationId
}

/** Pure decision table (D4/D7/D8): per chair, cross-host entries go to `remote` untouched (D8, no
 * remote execution); local entries resolve to exactly one of skip_live / rebind / launch / refuse,
 * per the `only` filter when given. `lookups` must carry an entry for every LOCAL chair name in
 * `manifest.chairs` — a missing key is a planner bug in the caller, not a manifest defect, so it
 * throws rather than silently mis-planning. */
export function planChairsRestore(
  manifest: ChairsManifest,
  localHostId: string,
  lookups: ReadonlyMap<string, ChairPlanLookup>,
  only?: ReadonlySet<string>
): ChairsRestorePlan {
  // [S10-21d b3b, D-R165 L2 fix] An `only` name absent from the manifest was previously silently
  // dropped (the loop below simply never visits it) — refuse loudly instead of a no-op that
  // reads as success.
  if (only) {
    const knownNames = new Set(manifest.chairs.map((entry) => entry.name))
    const unknown = [...only].filter((name) => !knownNames.has(name))
    if (unknown.length > 0) {
      throw new Error(`chairs-restore-plan: --only names unknown chair(s): ${unknown.join(', ')}`)
    }
  }

  const actions: ChairsRestorePlanAction[] = []
  const remote: { name: string; host: string }[] = []

  for (const entry of manifest.chairs) {
    if (only && !only.has(entry.name)) {
      continue
    }
    if (entry.host !== undefined && entry.host !== localHostId) {
      remote.push({ name: entry.name, host: entry.host })
      continue
    }
    const lookup = lookups.get(entry.name)
    if (!lookup) {
      throw new Error(`chairs-restore-plan: no lookup gathered for chair "${entry.name}"`)
    }
    const sessionId = chairTargetSessionId(entry)

    if (lookup.ownRow && lookup.ownRow.isLive && lookup.ownRow.paneKey !== null) {
      // [S10-21d b3b, D-R165 L1 fix] The live pane may not be the one holding THIS entry's
      // target session — checked here, before the holder-collision branch below ever runs for
      // this entry, so that case would otherwise read as an unqualified "already registered".
      const runningDifferentSession = lookup.holder.paneKey !== lookup.ownRow.paneKey
      actions.push({
        name: entry.name,
        kind: 'skip_live',
        reason: `already registered and live on pane ${lookup.ownRow.paneKey}${runningDifferentSession ? ' (running a different session)' : ''}`,
        paneKey: lookup.ownRow.paneKey
      })
      continue
    }

    // D2's "id held by a live pane elsewhere": the target session's holder resolves live and is
    // not the chair's own (already-handled-above) row.
    if (
      lookup.holder.paneKey !== null &&
      lookup.holder.isLive &&
      lookup.holder.paneKey !== lookup.ownRow?.paneKey
    ) {
      actions.push({
        name: entry.name,
        kind: 'refuse',
        reason: `conversation ${sessionId} is live on pane ${lookup.holder.paneKey} — fork it manually instead`,
        holderPaneKey: lookup.holder.paneKey
      })
      continue
    }

    if (lookup.ownRow) {
      actions.push({
        name: entry.name,
        kind: 'rebind',
        reason: `registered row exists on a dead pane (${lookup.ownRow.paneKey ?? 'no pane'})`,
        sessionId,
        holderPaneKey: lookup.holder.paneKey ?? lookup.ownRow.paneKey
      })
      continue
    }

    actions.push({
      name: entry.name,
      kind: 'launch',
      reason: 'no registered row on this host for this chair name',
      sessionId
    })
  }

  return { actions, remote }
}
