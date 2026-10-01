// R1 (D-26b): windowsCandidateIsAncestor walked ppid links without a seen-set, so a cycle among
// the candidates spun the CPU forever without allocating.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMapGetTripwire, type MapGetTripwire } from '../../shared/map-get-tripwire-for-tests'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('./windows-foreground-process-rows', () => ({
  queryWindowsProcessDescendants: queryMock
}))

import { resolveWindowsAgentForegroundProcessWithAvailability } from './windows-agent-foreground-process'

const CODEX = 'node C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd'

function candidate(pid: number, ppid: number, depth: number) {
  return {
    pid,
    ppid,
    depth,
    name: 'node.exe',
    command: CODEX,
    executablePath: 'C:/Program Files/nodejs/node.exe'
  }
}

describe('windows agent foreground ancestor check on a ppid cycle', () => {
  let tripwire: MapGetTripwire | null = null

  afterEach(() => {
    tripwire?.restore()
    tripwire = null
  })

  it('returns instead of spinning when recognized candidates form a 2-cycle', async () => {
    // Candidate 1 is outside the 10 <-> 11 cycle, so walking up from either cycle member never meets it.
    queryMock.mockResolvedValue([candidate(1, 600, 1), candidate(10, 11, 2), candidate(11, 10, 2)])

    tripwire = installMapGetTripwire()
    const resolution = await resolveWindowsAgentForegroundProcessWithAvailability(
      600,
      'pwsh.exe',
      {}
    )
    tripwire.restore()

    expect(tripwire.tripped).toBe(false)
    expect(resolution).toEqual({ available: true, processName: 'codex' })
  })
})
