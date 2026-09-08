// S10-21d b4 (design-r105-r112 ITEM 2 D1/D4/D8; s10-21d-design-v1 DEC-2): `orca chairs
// restore|status|export` — the RPC surface. No --pane/--terminal flag exists anywhere on this
// surface (CONTAINMENT #1, src/cli/specs/agents.ts:4-5); the runtime chooses every pane. Cross-
// host entries (D8) are listed as pending with the exact command to run there — no remote
// execution.
//
// JUDGMENT CALL (see RETURN): `orca chairs restore` is meant to run from an ORDINARY shell right
// after a full app restart, not from inside a live, attested Orca pane — so it cannot require
// `verifyOrchestrationCompatibilityCaller` the way `orchestration.agents.register` does (that
// authority literally does not exist yet the first time this command is useful). The "same
// authority check ... for a host-side action" this brief names is read here as the RATE-LIMIT
// half of that check (host-keyed, since there is no pane to rate-limit by), not the pane-
// attestation half — flagged as a judgment call, not asserted as settled. [S10-21d b3b, D-R165
// M4 fix] What IS enforced regardless: no paired device (mobile or a runtime-kind peer) may call
// this surface at all — `assertLocalCaller` below refuses any `accessProfile`/`clientKind`-
// bearing caller, leaving only the local socket / in-process transports, which set neither.
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { readFile, writeFile, rename, mkdir, access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineMethod, type RpcMethod, type RpcContext } from '../core'
import { OptionalString, OptionalBoolean } from '../schemas'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { hostIdFor, rateLimited } from './agent-directory-rpc-view'
import {
  parseChairsManifest,
  type ChairsManifest,
  type ChairsManifestEntry
} from '../../orchestration/chairs-manifest'
import { planChairsRestore } from '../../orchestration/chairs-restore-plan'
import {
  gatherChairsRestoreLookups,
  runChairsRestore,
  type ChairsRestoreExecutorDeps,
  type ChairsRestoreResultRow
} from '../../orchestration/chairs-restore-execute'
import { resolveResumeTranscript } from '../../../startup/resolve-resume-transcript'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'

const HOUR_MS = 60 * 60 * 1000

function defaultManifestPath(): string {
  return join(homedir(), '.orca', 'chairs.json')
}

// [S10-21d b3b, D-R165 M4 fix] `accessProfile`/`clientKind` are unset only for the local socket
// and in-process callers (core.ts's own doc comments on both fields) — any paired device (mobile
// or a runtime-kind peer) sets one, so this is a strict local-transport gate, not an allowlist.
export function assertLocalCaller(ctx: Pick<RpcContext, 'accessProfile' | 'clientKind'>): void {
  if (ctx.accessProfile !== undefined || ctx.clientKind !== undefined) {
    throw new OrchestrationError(
      'forbidden',
      'orca chairs restore|status|export is local-transport only (no paired device).'
    )
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// [S10-21d b3b, D-R165 M2 fix] tmp-write + rename so a crash mid-write never leaves a truncated
// file the parser refuses whole (chairs-manifest.ts's own "refuse the whole file" contract).
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, path)
}

async function readManifest(
  path: string
): Promise<{ ok: true; manifest: ChairsManifest } | { ok: false; reason: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return { ok: false, reason: `manifest not found at ${path}` }
    }
    return { ok: false, reason: `cannot read manifest at ${path}: ${String(err)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, reason: `manifest at ${path} is not valid JSON: ${String(err)}` }
  }
  return parseChairsManifest(parsed)
}

function isPaneLiveFor(runtime: OrcaRuntimeService): (paneKey: string) => boolean {
  return (paneKey) => {
    const signals = runtime.getAgentDirectoryLivenessSignals(paneKey)
    return signals.terminalHandle !== null || signals.observedLive
  }
}

function buildExecutorDeps(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  hostId: string
): ChairsRestoreExecutorDeps {
  return {
    hostId,
    // [S10-21d b3b, D-R165 H1 fix] machine-distinct — see ChairsRestoreExecutorDeps's own doc.
    machineId: hostname(),
    getAgentByName: (h, name) => db.getAgentByName(h, name),
    paneHoldingSession: (h, sessionId) => db.paneHoldingSession(h, sessionId),
    newestLaunchForPane: (h, paneKey) => db.newestLaunchForPane(h, paneKey),
    isPaneLive: isPaneLiveFor(runtime),
    requestChairRestore: (request) => runtime.requestChairRestore(request),
    // [S10-21d b3b, D-R165 M5 fix] null (unwired) is distinct from a wired false — passed through.
    hasLiveHookReportOfSession: (sessionId) => runtime.hasLiveHookReportOfSession(sessionId),
    hasResumableTranscriptTurn: async (agentType, sessionId) => {
      const result = await resolveResumeTranscript(agentType, sessionId)
      return result !== null && 'hasTurn' in result && result.hasTurn
    }
  }
}

function onlySetFrom(only: string | undefined): Set<string> | undefined {
  if (!only) {
    return undefined
  }
  const names = only
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return names.length > 0 ? new Set(names) : undefined
}

// [S10-21d b3b, D-R165 L2 fix] planChairsRestore throws on an `only` name absent from the
// manifest — surfaced here as a typed refusal rather than an unhandled RPC exception.
function planOrRefuse(
  manifest: ChairsManifest,
  machineId: string,
  lookups: ReturnType<typeof gatherChairsRestoreLookups>,
  only: Set<string> | undefined
): ReturnType<typeof planChairsRestore> {
  try {
    return planChairsRestore(manifest, machineId, lookups, only)
  } catch (err) {
    throw new OrchestrationError(
      'chairs_restore_only_unknown',
      err instanceof Error ? err.message : String(err)
    )
  }
}

const ChairsRestoreParams = z.object({
  manifestPath: OptionalString,
  only: OptionalString,
  dryRun: OptionalBoolean
})

const ChairsExportParams = z.object({
  manifestPath: OptionalString,
  force: OptionalBoolean
})

export const CHAIRS_RESTORE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.chairs.restore',
    params: ChairsRestoreParams,
    handler: async (params, ctx) => {
      assertLocalCaller(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)
      const hostRate = db.checkAndBumpRate({
        subjectKey: `host:${hostId}`,
        verb: 'chairs_restore',
        windowMs: HOUR_MS,
        limit: 20
      })
      if (!hostRate.allowed) {
        throw rateLimited(hostRate.retryAfterMs)
      }
      const path = params.manifestPath ?? defaultManifestPath()
      const parsed = await readManifest(path)
      if (!parsed.ok) {
        throw new OrchestrationError('chairs_manifest_invalid', parsed.reason)
      }
      const only = onlySetFrom(params.only)
      const deps = buildExecutorDeps(runtime, db, hostId)
      if (params.dryRun) {
        const lookups = gatherChairsRestoreLookups(parsed.manifest, deps)
        const plan = planOrRefuse(parsed.manifest, deps.machineId, lookups, only)
        return {
          path,
          plan,
          rows: [] as ChairsRestoreResultRow[],
          exitNonZero: false,
          dryRun: true
        }
      }
      const summary = await runChairsRestore(parsed.manifest, deps, only)
      // [S10-21d b3b, D-R165 L5 fix] no rewrite when nothing changed; M2: atomic write.
      if (summary.changed) {
        await writeFileAtomic(path, `${JSON.stringify(parsed.manifest, null, 2)}\n`)
      }
      return {
        path,
        plan: summary.plan,
        rows: summary.rows,
        exitNonZero: summary.exitNonZero,
        dryRun: false
      }
    }
  }),
  defineMethod({
    name: 'orchestration.chairs.status',
    params: ChairsRestoreParams,
    handler: async (params, ctx) => {
      assertLocalCaller(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)
      const path = params.manifestPath ?? defaultManifestPath()
      const parsed = await readManifest(path)
      if (!parsed.ok) {
        throw new OrchestrationError('chairs_manifest_invalid', parsed.reason)
      }
      const only = onlySetFrom(params.only)
      const deps = buildExecutorDeps(runtime, db, hostId)
      const lookups = gatherChairsRestoreLookups(parsed.manifest, deps)
      const plan = planOrRefuse(parsed.manifest, deps.machineId, lookups, only)
      return { path, plan }
    }
  }),
  defineMethod({
    name: 'orchestration.chairs.export',
    params: ChairsExportParams,
    handler: async (params, ctx) => {
      assertLocalCaller(ctx)
      const { runtime } = ctx
      const db = runtime.getOrchestrationDb()
      const hostId = hostIdFor(runtime)
      const path = params.manifestPath ?? defaultManifestPath()
      // [S10-21d b3b, D-R165 H2 fix] Existence, not parseability — a non-manifest file at `path`
      // must not be silently overwritten either. [L3 fix] mkdir only `path`'s own parent, never
      // an unconditional `~/.orca` when `--manifest` points elsewhere.
      if (!params.force && (await pathExists(path))) {
        throw new OrchestrationError(
          'chairs_manifest_exists',
          `${path} already exists; pass --force to overwrite`
        )
      }
      const { agents } = db.listAgents({ hostId, includeDerived: false, includeQuarantined: false })
      const chairs: ChairsManifestEntry[] = []
      for (const agent of agents) {
        if (!agent.pane_key) {
          continue
        }
        const launch = db.newestLaunchForPane(hostId, agent.pane_key)
        if (!launch) {
          continue
        }
        const worktree = agent.worktree_id
          ? `id:${agent.worktree_id}`
          : agent.worktree_path
            ? `path:${agent.worktree_path}`
            : null
        if (!worktree) {
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
          host: hostname()
          // model/effort omitted: no pref_* columns exist on agent_launch_sessions in this lane.
        })
      }
      const manifest: ChairsManifest = { version: 1, chairs }
      await mkdir(dirname(path), { recursive: true })
      await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`)
      return { path, manifest }
    }
  })
]
