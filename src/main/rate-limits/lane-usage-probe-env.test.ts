/**
 * S9 §2k, round 3's third major: the hidden usage probe never reaches a `PtyProvider`, so the
 * provider's pane-identity scrub and its win32 lane-key collapse have to run here or the new
 * paneKey join misattributes one principal's usage onto another's row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveClaudeCommandMock, spawnMock } = vi.hoisted(() => ({
  resolveClaudeCommandMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('../codex-cli/command', () => ({ resolveClaudeCommand: resolveClaudeCommandMock }))
vi.mock('node-pty', () => ({ spawn: spawnMock }))

import { fetchViaPty } from './claude-pty'
import { PANE_IDENTITY_ENV_KEYS } from '../../shared/pane-identity-env'
import { buildLaneUsageAuthPreparation } from './lane-usage-pull'

const LANE_A = '11111111-1111-4111-8111-111111111111'
const LANE_DIR = `/data/claude-lanes/${LANE_A}`

function mockTerm() {
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    kill: vi.fn()
  }
}

function spawnEnvOfLaneProbe(): Record<string, string> {
  return spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>
}

describe('the lane usage probe env', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveClaudeCommandMock.mockReturnValue('claude')
    spawnMock.mockReturnValue(mockTerm())
  })

  it('carries none of the inherited pane identity Orca itself was launched with', async () => {
    // The documented case: Orca launched FROM an Orca terminal, so its own env names another
    // principal's pane. Posting that key would land this lane's usage on that pane's row.
    for (const key of PANE_IDENTITY_ENV_KEYS) {
      process.env[key] = `inherited-${key}`
    }
    try {
      const controller = new AbortController()
      const probe = fetchViaPty({
        authPreparation: buildLaneUsageAuthPreparation({
          laneId: LANE_A,
          configDir: LANE_DIR,
          provenance: `lane:${'a'.repeat(32)}`,
          identity: null
        }),
        signal: controller.signal
      })
      while (spawnMock.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const env = spawnEnvOfLaneProbe()
      controller.abort()
      await probe
      expect(env).toBeDefined()
      for (const key of PANE_IDENTITY_ENV_KEYS) {
        expect(env[key]).toBeUndefined()
      }
      expect(env.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
    } finally {
      for (const key of PANE_IDENTITY_ENV_KEYS) {
        delete process.env[key]
      }
    }
  })
})

/**
 * Windows-only: the collapse is `process.platform`-gated inside `collapseLaneEnvKeys`, so this
 * arm cannot be observed off `win32` and is never faked green.
 */
describe.runIf(process.platform === 'win32')('the win32 lane-key collapse (§2m(5))', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveClaudeCommandMock.mockReturnValue('claude')
    spawnMock.mockReturnValue(mockTerm())
  })

  it('leaves only the lane’s own CLAUDE_CONFIG_DIR key in the probe env', async () => {
    process.env.Claude_Config_Dir = 'C:\\Users\\dev\\.claude'
    try {
      const controller = new AbortController()
      const probe = fetchViaPty({
        authPreparation: buildLaneUsageAuthPreparation({
          laneId: LANE_A,
          configDir: LANE_DIR,
          provenance: `lane:${'a'.repeat(32)}`,
          identity: null
        }),
        signal: controller.signal
      })
      while (spawnMock.mock.calls.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const env = spawnEnvOfLaneProbe()
      controller.abort()
      await probe

      const laneKeys = Object.keys(env).filter((key) => /^claude_config_dir$/i.test(key))
      expect(laneKeys).toEqual(['CLAUDE_CONFIG_DIR'])
      expect(env.CLAUDE_CONFIG_DIR).toBe(LANE_DIR)
    } finally {
      delete process.env.Claude_Config_Dir
    }
  })
})
