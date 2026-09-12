// [D-R190, MAX-LINES] Shared same-generation-holder fixture + settle drive for the two R170 e2e
// cases in dead-holder-adoption-e2e.test.ts (mirrors that file's own inline R142 fixture),
// factored into its own file so the test file stays under its 800-line ratchet.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { vi, expect } from 'vitest'
import type { OrchestrationDb } from './db'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { ControllerInventory } from './agent-process-identity'

export async function runSameGenHolderE2ECase(params: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  hostId: string
  settlingDetail: string
  tmpPrefix: string
  sessionId: string
  displayName: string
  beforeSettle?: (holderPaneKey: string) => void
  afterSettled: (holderPaneKey: string) => Promise<void>
}): Promise<string> {
  const { db, runtime, hostId, settlingDetail, tmpPrefix, sessionId, displayName } = params
  const tempHome = await mkdtemp(join(tmpdir(), tmpPrefix))
  process.env.HOME = tempHome
  const projectDir = join(tempHome, '.claude', 'projects', 'proj')
  await mkdir(projectDir, { recursive: true })
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`
  )
  const sameGen = runtime.getLaunchGenerationId()
  const holderPaneKey = `tab-old:${randomUUID()}`
  const holderPtyId = `pty-${randomUUID()}`
  const holderIncarnationId = randomUUID()
  const created = db.upsertAgentByPaneSuffix({
    displayName,
    role: null,
    hostId,
    paneKey: holderPaneKey,
    terminalHandle: null,
    processIncarnation: `${holderPtyId}:${holderIncarnationId}`,
    worktreeId: null,
    worktreePath: null,
    branch: null,
    title: null,
    agentLabel: null,
    originHandle: null,
    originHostId: hostId
  })
  if (created.outcome === 'name_taken') {
    throw new Error('fixture setup failed')
  }
  const launched = db.recordLaunch({
    hostId,
    paneKey: holderPaneKey,
    agentType: 'claude',
    sessionId,
    launchGeneration: sameGen,
    executionHostId: hostId,
    evidence: 'host_launch'
  })
  if (!launched.ok) {
    throw new Error('fixture launch row failed')
  }
  params.beforeSettle?.(holderPaneKey)
  const deadInventory: ControllerInventory = {
    allLivePtyIds: new Set(),
    terminalIdentityByPtyId: new Map()
  }
  vi.spyOn(runtime, 'takeControllerInventoryForSweep').mockResolvedValue(deadInventory)
  vi.useFakeTimers()
  try {
    vi.setSystemTime(1_700_000_000_000)
    const firstAttempt = await runtime.requestChairRestore({
      worktreeSelector: 'id:wt-1',
      sessionId,
      displayName
    })
    expect(firstAttempt).toEqual({
      ok: false,
      reason: 'same_generation_settling',
      holderPaneKey,
      detail: settlingDetail
    })
    vi.setSystemTime(1_700_000_000_000 + 11_000)
    await params.afterSettled(holderPaneKey)
  } finally {
    vi.useRealTimers()
  }
  return tempHome
}
