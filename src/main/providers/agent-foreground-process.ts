import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { resolveOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import { collectProcessDescendants } from '../../shared/process-tree-descendants'
import {
  getFreshProcessTableSnapshot,
  getProcessTableSnapshot,
  type ProcessTableRow
} from '../../shared/process-table-snapshot'
import {
  resolveWindowsAgentForegroundProcessWithAvailability,
  shouldInspectWindowsAgentForeground,
  type AgentForegroundResolutionOptions
} from './windows-agent-foreground-process'

export type { AgentForegroundResolutionOptions } from './windows-agent-foreground-process'

export type AgentForegroundProcessResolution = {
  available: boolean
  processName: string | null
}

function candidateScore(row: ProcessTableRow & { depth: number }): number {
  // Why: foreground descendants carry `+` in `ps stat` on Unix PTYs. Prefer
  // them, then prefer leaf/deeper wrappers so `node /path/bin/codex` beats the
  // parent shell but still lets the native child confirm the same identity.
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
}

export async function resolveAgentForegroundProcess(
  shellPid: number | null | undefined,
  fallbackProcess: string | null,
  options: AgentForegroundResolutionOptions = {}
): Promise<string | null> {
  return (await resolveAgentForegroundProcessWithAvailability(shellPid, fallbackProcess, options))
    .processName
}

export async function resolveAgentForegroundProcessWithAvailability(
  shellPid: number | null | undefined,
  fallbackProcess: string | null,
  options: AgentForegroundResolutionOptions = {}
): Promise<AgentForegroundProcessResolution> {
  if (!shellPid) {
    return { available: false, processName: fallbackProcess }
  }

  if (process.platform === 'win32') {
    if (
      !fallbackProcess ||
      (!shouldInspectWindowsAgentForeground(fallbackProcess) && !options.forceProcessScan)
    ) {
      return { available: true, processName: fallbackProcess }
    }
    const resolution = await resolveWindowsAgentForegroundProcessWithAvailability(
      shellPid,
      fallbackProcess,
      options
    )
    return {
      available: resolution.available,
      // Why: a forced confirmation scan that no longer sees the recognized
      // fallback is authoritative evidence that the agent exited meanwhile.
      processName:
        resolution.processName ??
        (options.forceProcessScan && recognizeAgentProcessFromCommandLine(fallbackProcess)
          ? null
          : fallbackProcess)
    }
  }

  try {
    const rows = options.fresh
      ? await getFreshProcessTableSnapshot()
      : await getProcessTableSnapshot()
    if (options.fresh && !rows.some((row) => row.pid === shellPid)) {
      return { available: false, processName: fallbackProcess }
    }
    return {
      available: true,
      processName: resolveAgentForegroundProcessFromPs(rows, shellPid, options) ?? fallbackProcess
    }
  } catch {
    // Why: a failed scan cannot prove fallback ownership; callers retain the last recognized agent.
    return { available: false, processName: fallbackProcess }
  }
}

function resolveAgentForegroundProcessFromPs(
  rows: ProcessTableRow[],
  shellPid: number,
  options: AgentForegroundResolutionOptions
): string | null {
  const shellRow = rows.find((row) => row.pid === shellPid)
  const { descendants, staleEdgesSkipped, cycleLength, cutIndex, cutBy } =
    collectProcessDescendants(rows, shellPid)
  if (staleEdgesSkipped > 0) {
    try {
      options.onTreeAnomaly?.({
        rows,
        descendants,
        staleEdgesSkipped,
        cycleLength,
        cutIndex,
        cutBy,
        fresh: options.fresh === true
      })
    } catch {
      // Diagnostics must not break the scan.
    }
  }
  const candidates = descendants.sort((a, b) => candidateScore(b) - candidateScore(a))
  // Why: `+` in `ps stat` marks the process holding the terminal foreground.
  // The root shell can hold it after Ctrl-Z, so use the whole PTY tree as the
  // foreground gate; otherwise a stopped agent child still masquerades as live.
  const foregroundIsKnown =
    shellRow?.stat.includes('+') === true ||
    candidates.some((candidate) => candidate.stat.includes('+'))
  for (const candidate of candidates) {
    if (foregroundIsKnown && !candidate.stat.includes('+')) {
      continue
    }
    const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
    if (recognized) {
      // Why: return the outer wrapper (omp) rather than the deeper wrapped child
      // (pi) of a shell→omp→pi tree — see resolveOuterWrapperForegroundProcess.
      return resolveOuterWrapperForegroundProcess(recognized, candidate, candidates)
    }
  }
  return null
}
