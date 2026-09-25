// S10-21d b4: `exportChairsManifest` split out of chairs-restore.ts (max-lines) — pure code
// motion, no behaviour change. See chairs-restore.ts for the RPC surface and its own doc.
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { AGENT_DIRECTORY_READ_CAP } from '../../orchestration/agent-directory'
import {
  CHAIRS_MANIFEST_EFFORTS,
  type ChairsManifest,
  type ChairsManifestEffort,
  type ChairsManifestEntry
} from '../../orchestration/chairs-manifest'
import type { OrchestrationDb } from '../../orchestration/db'
import { pathExists, writeFileAtomic, readManifest } from './chairs-restore'

export type ExportSkipRow = { name: string; reason: 'no_pane' | 'no_launch_row' | 'no_worktree' }
export type PriorSuccessionFields = {
  succession?: ChairsManifestEntry['succession']
  launchArgs?: string[]
}

export async function exportChairsManifest(
  params: { manifestPath?: string; force?: boolean },
  path: string,
  db: OrchestrationDb,
  hostId: string
): Promise<{
  path: string
  manifest: ChairsManifest
  skipped: ExportSkipRow[]
  omittedQuarantined: number
}> {
  // [S10-21d b3b, D-R165 H2 fix] Existence, not parseability. [L3 fix] mkdir only `path`'s parent.
  const existed = await pathExists(path)
  if (!params.force && existed) {
    throw new OrchestrationError(
      'chairs_manifest_exists',
      `${path} already exists; pass --force to overwrite`
    )
  }
  // [Wave 2 contract] `--force` carries a prior manifest's succession/launchArgs forward by chair
  // name (export otherwise rebuilds every field fresh; a prior parse failure contributes nothing).
  const priorByName = new Map<string, PriorSuccessionFields>()
  if (existed) {
    const prior = await readManifest(path)
    if (prior.ok) {
      for (const entry of prior.manifest.chairs) {
        priorByName.set(entry.name, { succession: entry.succession, launchArgs: entry.launchArgs })
      }
    }
  }
  // [G1-10o B4/C28 fix, D-R170 M2/M3 PARTIAL, re-sourced per D-R171 NM-5 — see D-R170 M2
  // deviation in RETURN] Pass listAgents' OWN read ceiling explicitly (AGENT_DIRECTORY_READ_CAP,
  // exported by agent-directory.ts alongside the clamp it names) so the *default* of 100
  // cannot silently shorten the manifest below it. D-R170's fix used DIRECTORY_LIVE_CAP —
  // the REGISTRATION ceiling, a numerically-identical but independent literal invited to
  // change on its own (see orchestration-agents-register.ts) — which NM-5 showed would go
  // silent the moment the two drift: requesting more than listAgents' internal clamp is
  // silently reduced back to it, so this refusal can only ever fire when the requested
  // limit and the clamp agree.
  //
  // D-R170's own smallest fix for M2 (request `AGENT_DIRECTORY_READ_CAP + 1`, refuse only
  // when `agents.length > AGENT_DIRECTORY_READ_CAP`) is NOT applied here: `listAgents`
  // clamps its OWN internal limit to `Math.min(Math.max(params.limit ?? 100, 1),
  // AGENT_DIRECTORY_READ_CAP)` (agent-directory.ts) — independent of whatever limit the
  // caller requests. Requesting one more than the cap is silently reduced back to it inside
  // listAgents, so `agents.length` can never exceed the cap and `agents.length >
  // AGENT_DIRECTORY_READ_CAP` can never be true — the truncation refusal would become
  // permanently unreachable, which is worse than the pre-fix over-refusal: a host with more
  // real chairs than the cap would now export a silently-short manifest with no warning at
  // all. Kept at `>=` (the pre-D-R170 behavior) so the guard stays loud; it still
  // over-refuses a host with EXACTLY the cap's worth of real chairs (the residual M2
  // names), but that is a known false-positive, not a silent truncation. Actually
  // distinguishing "exactly the cap" from "more than the cap" requires listAgents itself to
  // report whether it trimmed anything (e.g. a total-before-slice or a `truncated` flag) —
  // out of this dispatch's scope; flagged for the chair.
  const { agents, omitted } = db.listAgents({
    hostId,
    includeDerived: false,
    includeQuarantined: false,
    limit: AGENT_DIRECTORY_READ_CAP
  })
  if (agents.length >= AGENT_DIRECTORY_READ_CAP) {
    throw new OrchestrationError(
      'chairs_export_truncated',
      `${agents.length} registered chairs meets or exceeds the directory's hard cap of ` +
        `${AGENT_DIRECTORY_READ_CAP}; refusing to write a manifest that may silently omit ` +
        'chairs. Retire or tombstone stale directory rows (orca agents retire) so the ' +
        'host falls below the cap.'
    )
  }
  const chairs: ChairsManifestEntry[] = []
  const skipped: ExportSkipRow[] = []
  for (const agent of agents) {
    if (!agent.pane_key) {
      skipped.push({ name: agent.display_name, reason: 'no_pane' })
      continue
    }
    const launch = db.newestLaunchForPane(hostId, agent.pane_key)
    if (!launch) {
      skipped.push({ name: agent.display_name, reason: 'no_launch_row' })
      continue
    }
    const worktree = agent.worktree_id
      ? `id:${agent.worktree_id}`
      : agent.worktree_path
        ? `path:${agent.worktree_path}`
        : null
    if (!worktree) {
      skipped.push({ name: agent.display_name, reason: 'no_worktree' })
      continue
    }
    chairs.push({
      name: agent.display_name,
      ...(agent.role ? { role: agent.role } : {}),
      worktree,
      agent: 'claude',
      conversationId: launch.session_id,
      // [S10-21d b3b, D-R165 H1 fix] machine-distinct id, never the orchestration-
      // compatibility constant (always 'local') — see ChairsRestoreExecutorDeps's own doc.
      host: hostname(),
      // [S10-21d bD C1, D-R168 MEDIUM-1 fix] the composed tree carries pref_model/pref_effort
      // on agent_launch_sessions (agent-launch-sessions.ts:71-74) — capture them so a pinned
      // chair survives export/restart/restore instead of silently resetting to defaults. An
      // out-of-set effort is omitted (never written unvalidated); model is independent of
      // that check and always included when present.
      ...(launch.pref_model ? { model: launch.pref_model } : {}),
      ...(launch.pref_effort &&
      CHAIRS_MANIFEST_EFFORTS.includes(launch.pref_effort as ChairsManifestEffort)
        ? { effort: launch.pref_effort as ChairsManifestEffort }
        : {}),
      ...priorByName.get(agent.display_name)
    })
  }
  const manifest: ChairsManifest = { version: 1, chairs }
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path, manifest, skipped, omittedQuarantined: omitted.quarantined }
}
