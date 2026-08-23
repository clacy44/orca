import { describe, expect, it } from 'vitest'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import {
  applyTerminalCredentialLaneRows,
  projectTerminalCredentialLane
} from './terminal-credential-lane-row'
import type { PaneCredentialLane } from './pane-credential-lane-registry'

const PRINCIPAL_ID = '11111111-2222-4333-8444-555555555555'
const LANE: PaneCredentialLane = { kind: 'principal', principalId: PRINCIPAL_ID }
const SHARED: PaneCredentialLane = { kind: 'shared' }

describe('projectTerminalCredentialLane', () => {
  it('labels a lane pane grant, with its residency beside it', () => {
    expect(projectTerminalCredentialLane({ lane: LANE, laneState: 'loaded' })).toEqual({
      credentialLane: 'grant',
      laneState: 'loaded'
    })
  })

  it('falls back to absent rather than claiming a residency the host has not proven', () => {
    expect(projectTerminalCredentialLane({ lane: LANE })).toEqual({
      credentialLane: 'grant',
      laneState: 'absent'
    })
  })

  it('labels an explicitly shared pane host, and an unbound one unknown', () => {
    expect(projectTerminalCredentialLane({ lane: SHARED })).toEqual({ credentialLane: 'host' })
    expect(projectTerminalCredentialLane({ lane: null })).toEqual({ credentialLane: 'unknown' })
  })

  it('labels a remote pane remote and a WSL pane wsl', () => {
    expect(projectTerminalCredentialLane({ lane: SHARED, connectionId: 'ssh-1' })).toEqual({
      credentialLane: 'remote'
    })
    expect(projectTerminalCredentialLane({ lane: SHARED, wslDistro: 'Ubuntu' })).toEqual({
      credentialLane: 'wsl'
    })
  })

  it('downgrades a lane pane observed running OpenClaude, and drops the residency claim', () => {
    expect(
      projectTerminalCredentialLane({
        lane: LANE,
        observedAgentTypes: ['openclaude'],
        laneState: 'loaded'
      })
    ).toEqual({ credentialLane: 'shared-runtime' })
  })

  it('does not downgrade a lane pane running Claude Code', () => {
    expect(
      projectTerminalCredentialLane({ lane: LANE, observedAgentTypes: ['claude'] })
    ).toMatchObject({ credentialLane: 'grant' })
  })
})

function terminalRow(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_1',
    ptyId: 'pty-1',
    worktreeId: 'repo::/tmp/wt',
    worktreePath: '/tmp/wt',
    branch: 'main',
    tabId: 'tab-1',
    leafId: '33333333-3333-4333-8333-333333333333',
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('applyTerminalCredentialLaneRows', () => {
  it('stamps every row, including a PTY-fallback row with no lane', () => {
    const rows = [terminalRow(), terminalRow({ handle: 'term_2', tabId: 'tab-2' })]

    applyTerminalCredentialLaneRows(rows, {
      laneOf: (_worktreeId, paneKey) => (paneKey.startsWith('tab-1') ? LANE : null)
    })

    expect(rows[0]).toMatchObject({ credentialLane: 'grant', laneState: 'absent' })
    expect(rows[1]).toMatchObject({ credentialLane: 'unknown' })
    expect(rows[1]?.laneState).toBeUndefined()
  })

  it('marks one owner label over a person’s two participants and no one else', () => {
    const rows = [
      terminalRow({
        presence: {
          attachedCount: 3,
          participants: [
            {
              participantId: 'p-desktop',
              label: 'Ana',
              kind: 'runtime',
              typing: false,
              writing: false
            },
            {
              participantId: 'p-phone',
              label: 'Ana',
              kind: 'mobile',
              typing: false,
              writing: false
            },
            {
              participantId: 'p-other',
              label: 'Bo',
              kind: 'runtime',
              typing: false,
              writing: false
            }
          ]
        }
      })
    ]

    applyTerminalCredentialLaneRows(rows, {
      laneOf: () => LANE,
      principalOfParticipant: (participantId) =>
        participantId === 'p-other' ? 'other-principal' : PRINCIPAL_ID
    })

    expect(rows[0]?.presence?.participants.map((p) => p.credentialLaneOwner)).toEqual([
      true,
      true,
      undefined
    ])
  })

  it('reads a lane residency once per principal, not once per row', () => {
    const rows = [terminalRow(), terminalRow({ handle: 'term_2', tabId: 'tab-2' })]
    const seen: string[] = []

    applyTerminalCredentialLaneRows(rows, {
      laneOf: () => LANE,
      laneStateOf: (principalId) => {
        seen.push(principalId)
        return 'loaded'
      }
    })

    expect(seen).toEqual([PRINCIPAL_ID])
    expect(rows[1]).toMatchObject({ laneState: 'loaded' })
  })

  describe("laneAccountLabel and laneUsage — Q7's per-row join (§2k)", () => {
    const USAGE = {
      session: { usedPercent: 61, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null
    }
    const LABEL = { owner: 'Ana', accountName: 'work' }

    it("surfaces both for the lane's own principal", () => {
      const rows = [terminalRow()]

      applyTerminalCredentialLaneRows(rows, {
        laneOf: () => LANE,
        laneStateOf: () => 'loaded',
        laneAccountLabelOf: () => LABEL,
        laneUsageOf: () => USAGE,
        callerPrincipalId: PRINCIPAL_ID
      })

      expect(rows[0]?.laneAccountLabel).toEqual(LABEL)
      expect(rows[0]?.laneUsage).toEqual(USAGE)
    })

    // §2d: zero reads as "no usage left to worry about"; omission reads as "not yours".
    it('shows a peer the label and OMITS the bar, never zeroes it', () => {
      const rows = [terminalRow()]

      applyTerminalCredentialLaneRows(rows, {
        laneOf: () => LANE,
        laneStateOf: () => 'loaded',
        laneAccountLabelOf: () => LABEL,
        laneUsageOf: () => USAGE,
        callerPrincipalId: 'other-principal'
      })

      expect(rows[0]?.laneAccountLabel).toEqual(LABEL)
      expect(rows[0]).not.toHaveProperty('laneUsage')
    })

    it('omits the bar for an anonymous caller with no principal at all', () => {
      const rows = [terminalRow()]

      applyTerminalCredentialLaneRows(rows, {
        laneOf: () => LANE,
        laneStateOf: () => 'loaded',
        laneUsageOf: () => USAGE
      })

      expect(rows[0]).not.toHaveProperty('laneUsage')
    })

    // Negative control: a row that is not running on the lane carries no claim about it.
    it('adds neither field to a shared, remote or OpenClaude-downgraded row', () => {
      const rows = [terminalRow(), terminalRow({ handle: 'term_2', tabId: 'tab-2' })]

      applyTerminalCredentialLaneRows(rows, {
        laneOf: (_worktreeId, paneKey) => (paneKey.startsWith('tab-2') ? LANE : SHARED),
        observedAgentTypesOf: () => ['openclaude'],
        laneStateOf: () => 'loaded',
        laneAccountLabelOf: () => LABEL,
        laneUsageOf: () => USAGE,
        callerPrincipalId: PRINCIPAL_ID
      })

      expect(rows[0]).not.toHaveProperty('laneAccountLabel')
      expect(rows[1]?.credentialLane).toBe('shared-runtime')
      expect(rows[1]).not.toHaveProperty('laneAccountLabel')
      expect(rows[1]).not.toHaveProperty('laneUsage')
    })
  })
})
