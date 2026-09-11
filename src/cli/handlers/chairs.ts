import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'

// Why local, mirrored types rather than importing from src/main/runtime/orchestration/*: the CLI
// is its own tsconfig project (config/tsconfig.tc.cli.json) and never compiles main-process
// sources directly — same convention as every other src/cli/handlers/*.ts file (e.g. agents.ts's
// own AgentView/ListResult), matching the RPC's JSON response shape by hand.
type ChairsRestorePlanAction =
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

type ChairsRestorePlan = {
  actions: ChairsRestorePlanAction[]
  remote: { name: string; host: string }[]
}

type ChairsRestoreResultRow =
  | {
      name: string
      kind: 'skip_live' | 'rebind' | 'launch'
      paneKey: string
      recorded: string | null
      minted: string
      paneLive: boolean
      attested: boolean | null
      autoRestoreArmed: boolean
      ok: boolean
    }
  | {
      name: string
      kind: 'refuse'
      reason: string
      holderPaneKey: string
      ok: false
      detail?: string
    }
  | { name: string; kind: 'error'; reason: string; ok: false; detail?: string }

export type ChairsManifestEntry = {
  name: string
  role?: string
  worktree: string
  agent: 'claude'
  conversationId: string
  lastSessionId?: string
  host?: string
  model?: string
  effort?: string
}

export type ChairsManifest = { version: 1; chairs: ChairsManifestEntry[] }

type RestoreResult = {
  path: string
  plan: ChairsRestorePlan
  rows: ChairsRestoreResultRow[]
  exitNonZero: boolean
  dryRun: boolean
}

type StatusResult = { path: string; plan: ChairsRestorePlan }

export type ExportSkipReason = 'no_pane' | 'no_launch_row' | 'no_worktree'
export type ExportSkip = { name: string; reason: ExportSkipReason }
// [D-R170 M4] `skipped`/`omittedQuarantined` are optional — this method is local-only and not
// protocol-version-gated (added fields are non-breaking), so a CLI from this branch must not
// throw against an older running daemon that predates them.
export type ExportResult = {
  path: string
  manifest: ChairsManifest
  skipped?: ExportSkip[]
  omittedQuarantined?: number
}

function formatPlanLine(action: ChairsRestorePlan['actions'][number]): string {
  switch (action.kind) {
    case 'skip_live':
      return `${action.name}: skip (${action.reason})`
    case 'rebind':
      return `${action.name}: rebind session ${action.sessionId} (${action.reason})`
    case 'launch':
      return `${action.name}: launch session ${action.sessionId} (${action.reason})`
    case 'refuse':
      return `${action.name}: REFUSED (${action.reason})`
  }
}

function formatRemote(plan: ChairsRestorePlan): string[] {
  return plan.remote.map(
    (entry) => `${entry.name}@${entry.host}: pending — run \`orca chairs restore\` on ${entry.host}`
  )
}

function formatRow(row: ChairsRestoreResultRow): string {
  if (row.kind === 'refuse') {
    const detail = row.detail ? ` — ${row.detail}` : ''
    return `${row.name}  REFUSED  ${row.reason} (held on ${row.holderPaneKey})${detail}`
  }
  if (row.kind === 'error') {
    const detail = row.detail ? ` — ${row.detail}` : ''
    return `${row.name}  ERROR  ${row.reason}${detail}`
  }
  const status = row.ok ? 'ok' : 'SHORT'
  return (
    `${row.name}  [${status}]  pane=${row.paneKey} recorded=${row.recorded ?? '-'} ` +
    `minted=${row.minted} paneLive=${row.paneLive} ` +
    `reported=${row.attested === null ? 'unknown' : row.attested} autoRestoreArmed=${row.autoRestoreArmed}`
  )
}

function formatRestoreResult(result: RestoreResult): string {
  const lines: string[] = []
  if (result.dryRun) {
    lines.push('Plan (dry run, nothing changed):')
    lines.push(...result.plan.actions.map(formatPlanLine))
    lines.push(...formatRemote(result.plan))
    return lines.join('\n') || 'Nothing to do.'
  }
  lines.push(...result.rows.map(formatRow))
  lines.push(...formatRemote(result.plan))
  if (result.exitNonZero) {
    lines.push('One or more chairs are short — see above.')
  }
  return lines.join('\n') || 'Nothing to do.'
}

function formatStatusResult(result: StatusResult): string {
  const lines = result.plan.actions.map(formatPlanLine)
  lines.push(...formatRemote(result.plan))
  return lines.join('\n') || 'Nothing to do.'
}

const EXPORT_SKIP_REASON_TEXT: Record<ExportSkipReason, string> = {
  no_pane: 'no pane recorded',
  no_launch_row: 'no launch row recorded',
  no_worktree: 'no worktree recorded'
}

export function formatExportResult(result: ExportResult): string {
  // [D-R170 M4] Guard against an older daemon's response, which carries neither field.
  const skipped = result.skipped ?? []
  let line = `Wrote ${result.manifest.chairs.length} chair(s) to ${result.path}`
  if (skipped.length > 0) {
    const detail = skipped
      .map((s) => `${s.name} (${EXPORT_SKIP_REASON_TEXT[s.reason] ?? s.reason})`)
      .join(', ')
    line += `; skipped ${skipped.length}: ${detail}`
  }
  // [D-R170 M1] The `includeQuarantined: false` filter runs before the skip guards above and
  // is never reported by them — say so explicitly so a lifted quarantine doesn't silently
  // reappear as a partial restore later.
  if (result.omittedQuarantined && result.omittedQuarantined > 0) {
    line += `; omitted ${result.omittedQuarantined} quarantined`
  }
  return line
}

export const CHAIRS_HANDLERS: Record<string, CommandHandler> = {
  'chairs restore': async ({ flags, client, json }) => {
    const manifestPath = getOptionalStringFlag(flags, 'manifest')
    const only = getOptionalStringFlag(flags, 'only')
    const dryRun = flags.has('dry-run')
    const response = await client.call<RestoreResult>('orchestration.chairs.restore', {
      manifestPath,
      only,
      dryRun: dryRun ? true : undefined
    })
    printResult(response, json, formatRestoreResult)
    if (response.result.exitNonZero) {
      process.exitCode = 1
    }
  },
  'chairs status': async ({ flags, client, json }) => {
    const manifestPath = getOptionalStringFlag(flags, 'manifest')
    const only = getOptionalStringFlag(flags, 'only')
    const response = await client.call<StatusResult>('orchestration.chairs.status', {
      manifestPath,
      only
    })
    printResult(response, json, formatStatusResult)
  },
  'chairs export': async ({ flags, client, json }) => {
    const manifestPath = getOptionalStringFlag(flags, 'manifest')
    const force = flags.has('force')
    const response = await client.call<ExportResult>('orchestration.chairs.export', {
      manifestPath,
      force: force ? true : undefined
    })
    printResult(response, json, formatExportResult)
  }
}
