import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { readLaneAccountIndex } from './lane-account-index'
import { resetLaneWipePendingForTests } from './lane-wipe-pending'
import { provisionPrincipalLane } from './principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

/** Verbatim, matching `lane-login-url-parser.ts`'s private `PASTE_CODE_PROMPT`. */
const PASTE_PROMPT = 'Paste code here if prompted > '
const GOOD_URL = `https://platform.claude.com/oauth/authorize?redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/code/callback'
)}`

type SpawnOptions = { onStdoutChunk?: (chunk: string) => void }

class FakeLoginChild {
  handle = {
    writeStdin: vi.fn(),
    kill: vi.fn(() => this.exit(null))
  }
  resultPromise: Promise<{ code: number | null }>
  private resolveResult!: (value: { code: number | null }) => void
  private settled = false

  constructor(private readonly options: SpawnOptions) {
    this.resultPromise = new Promise((res) => {
      this.resolveResult = res
    })
  }

  feed(chunk: string): void {
    this.options.onStdoutChunk?.(chunk)
  }

  exit(code: number | null = 0): void {
    if (this.settled) {
      return
    }
    this.settled = true
    this.resolveResult({ code })
  }
}

const spawnMocks = vi.hoisted(() => ({ spawnClaudeCliChildProcess: vi.fn() }))
vi.mock('./claude-cli-child-process', () => ({
  spawnClaudeCliChildProcess: spawnMocks.spawnClaudeCliChildProcess
}))

// Imported AFTER the mock so the module under test picks up the mocked spawn.
import { LaneCredentialCoordinator } from './lane-credential-coordinator'

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

/**
 * S9-L1 §fenceWiring "capture vs wipe" (plan 2b), at the COORDINATOR level: the SAME
 * `LaneCredentialCoordinator` production composes, so the login registry and the lifecycle share
 * ONE write queue for real, not stand-in recorder functions — the end-to-end companion to
 * `lane-login-capture.test.ts`'s unit-level proof that the in-turn re-check reads session state,
 * never the wipe-pending mark (that proof stays there, with a mocked `isStillCapturable`).
 *
 * A REAL wipe does more than flip a boolean: `sweepCancelledLoginDirs` removes the cancelled
 * session's `<laneAccountId>` directory INSIDE the wipe's own queue turn. Held against the capture
 * tail's `auth status --json` probe (outside any queue, exactly where I6 runs), that means whichever
 * guard the capture reaches first refuses it — `login_identity_mismatch` if the sweep deletes the
 * directory before the capture's credential read runs (this fixture's ordering), or
 * `login_cancelled` if the session-state re-check is reached first. Both are safe by the same
 * property this test pins: after a full explicit logout races an in-flight capture to completion,
 * NOTHING is ever promoted — no `.credentials.json`, no index row — regardless of which guard wins.
 */
describe('lane login capture vs an explicit logout racing it (S9-L1 §fenceWiring "capture vs wipe")', () => {
  let lanesRoot = ''
  let laneDir = ''
  let loginChildren: FakeLoginChild[] = []
  let releaseAuthStatus!: () => void
  let authStatusGate!: Promise<void>

  beforeEach(() => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-lane-capture-wipe-race-'))
    lanesRoot = join(userData, 'claude-lanes')
    provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
    laneDir = join(lanesRoot, LANE_A)
    loginChildren = []
    resetLaneWipePendingForTests()
    authStatusGate = new Promise<void>((resolve) => {
      releaseAuthStatus = resolve
    })
    spawnMocks.spawnClaudeCliChildProcess.mockReset()
    spawnMocks.spawnClaudeCliChildProcess.mockImplementation(
      (args: string[], _configDir: unknown, _timeoutMs: number, options: SpawnOptions = {}) => {
        if (args[0] === 'auth' && args[1] === 'login') {
          const child = new FakeLoginChild(options)
          loginChildren.push(child)
          return { handle: child.handle, result: child.resultPromise }
        }
        // 'auth status --json' — held on the gate, OUTSIDE any write queue, exactly where I6 runs.
        const result = authStatusGate.then(() => {
          options.onStdoutChunk?.(JSON.stringify({ email: 'a@x.com' }))
          return { code: 0 }
        })
        return { handle: { writeStdin: vi.fn(), kill: vi.fn() }, result }
      }
    )
  })

  afterEach(() => {
    resetLaneWipePendingForTests()
    rmSync(lanesRoot, { recursive: true, force: true })
  })

  it('promotes nothing when a full explicit logout races an in-flight capture to completion', async () => {
    // Not the live `claude --version` probe: this suite's outcome must not depend on whichever
    // CLI build happens to be installed on the box running it.
    const coordinator = new LaneCredentialCoordinator({
      laneOptions: { lanesRoot, platform: 'linux' },
      assertLoginCliVersionSupported: () => {}
    })

    const startPromise = coordinator.loginSessions.start({
      laneId: LANE_A,
      laneDir,
      expectedEmail: 'a@x.com',
      owner: { kind: 'host-inline' }
    })
    loginChildren[0].feed(`Open this link:\n${GOOD_URL}\n${PASTE_PROMPT}`)
    const { sessionId } = await startPromise

    // Plant what the real CLI would have written into its own isolated auth dir.
    const authDir = spawnMocks.spawnClaudeCliChildProcess.mock.calls.findLast(
      (call) => call[0][0] === 'auth' && call[0][1] === 'login'
    )![1].windowsPath
    writeFileSync(
      join(authDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })
    )
    writeFileSync(
      join(authDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } })
    )

    // submitCode writes the code, the child exits, and submitCode moves into the capture tail —
    // whose `auth status --json` probe is now blocked on `authStatusGate`, OUTSIDE any queue.
    const submitPromise = coordinator.loginSessions.submitCode(sessionId, '123456')
    loginChildren[0].exit(0)
    // Let the capture's probe actually start and block on the gate before the wipe runs.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // A FULL explicit logout runs to completion here — mark, synchronous cancel (session ->
    // cancelled), queue turn (which sweeps the now-cancelled session's directory), clear — all
    // BEFORE the capture is released to reach either of its own guards.
    const wipeOutcome = await coordinator.lifecycle.wipeOnExplicitLogout(LANE_A)
    expect(wipeOutcome.completed).toBe(true)

    releaseAuthStatus()

    const error = await submitPromise.catch((thrown: unknown) => thrown)
    expect(isClaudeLaneRefusal(error)).toBe(true)
    // Never `wipe_in_progress` — the mark is already cleared by the time the capture is released;
    // whichever OTHER guard fired, the mark itself must not be why.
    expect((error as { code: string }).code).not.toBe('accounts.lane.wipe_in_progress')
    expect(existsSync(join(laneDir, '.credentials.json'))).toBe(false)
    expect(readLaneAccountIndex(join(laneDir, 'claude-accounts'))).toEqual([])
    // The session itself is left `cancelled`, not stuck `live`/`child-exited` forever.
    expect(coordinator.loginSessions.statusOf(sessionId)?.state).toBe('cancelled')
  })
})
