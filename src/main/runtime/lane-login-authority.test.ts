import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { LaneCredentialCoordinator } from '../claude-accounts/lane-credential-coordinator'
import { provisionPrincipalLane } from '../claude-accounts/principal-credential-lane'
import { resetLaneWipePendingForTests } from '../claude-accounts/lane-wipe-pending'
import type { LaneStatusFrame } from './lane-status-stream'
import { LaneWireService } from './lane-wire-service'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

/** Verbatim, matching `lane-login-url-parser.ts`'s private `PASTE_CODE_PROMPT`. */
const PASTE_PROMPT = 'Paste code here if prompted > '
const GOOD_URL = `https://platform.claude.com/oauth/authorize?redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/code/callback'
)}`

type SpawnOptions = { onStdoutChunk?: (chunk: string) => void }

class FakeLoginChild {
  handle = { writeStdin: vi.fn(), kill: vi.fn(() => this.exit(null)) }
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
vi.mock('../claude-accounts/claude-cli-child-process', () => ({
  spawnClaudeCliChildProcess: spawnMocks.spawnClaudeCliChildProcess
}))

const LANE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const LANE_B = '11112222-3333-4444-8555-666677778888'

let loginChildren: FakeLoginChild[] = []
const createdDirs: string[] = []

function feedGoodLoginPrompt(child: FakeLoginChild): void {
  child.feed(`Open this link:\n${GOOD_URL}\n${PASTE_PROMPT}`)
}

beforeEach(() => {
  loginChildren = []
  resetLaneWipePendingForTests()
  spawnMocks.spawnClaudeCliChildProcess.mockReset()
  spawnMocks.spawnClaudeCliChildProcess.mockImplementation(
    (args: string[], _configDir: unknown, _timeoutMs: number, options: SpawnOptions = {}) => {
      if (args[0] === 'auth' && args[1] === 'login') {
        const child = new FakeLoginChild(options)
        loginChildren.push(child)
        return { handle: child.handle, result: child.resultPromise }
      }
      // 'auth status --json' — no identity, so a submitted code never reaches `captured` in these
      // tests (the authority matrix does not need it to; the identity-mismatch tests do exercise it).
      return {
        handle: { writeStdin: vi.fn(), kill: vi.fn() },
        result: Promise.resolve({ code: 0 })
      }
    }
  )
})

afterEach(() => {
  resetLaneWipePendingForTests()
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeHarness(
  designations: Record<string, string | null> = { [LANE_A]: 'device-a', [LANE_B]: 'device-b' }
) {
  const userData = mkdtempSync(join(tmpdir(), 'orca-lane-login-authority-'))
  createdDirs.push(userData)
  const lanesRoot = join(userData, 'claude-lanes')
  provisionPrincipalLane(LANE_A, { lanesRoot, platform: 'linux' })
  provisionPrincipalLane(LANE_B, { lanesRoot, platform: 'linux' })
  // Not the live `claude --version` probe: this suite's outcome must not depend on whichever CLI
  // build happens to be installed on the box running it.
  const coordinator = new LaneCredentialCoordinator({
    laneOptions: { lanesRoot, platform: 'linux' },
    assertLoginCliVersionSupported: () => {}
  })
  const bindings = new Map<string, string>([
    ['device-a', LANE_A],
    ['device-a2', LANE_A],
    ['device-b', LANE_B]
  ])
  const service = new LaneWireService({
    principals: {
      principalOf: (deviceId) => bindings.get(deviceId) ?? null,
      delegatedGrantIdOf: (principalId) => designations[principalId] ?? null
    },
    coordinator,
    switchGate: { begin: () => {}, end: () => {} },
    platform: 'linux'
  })
  return { service }
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return isClaudeLaneRefusal(error) ? error.code : `untyped:${String(error)}`
  }
  return 'no_refusal'
}

describe('LaneLoginAuthority (S9-L1 §modules D — the authority matrix)', () => {
  it('refuses loginStart when the lane has no designated login device', async () => {
    const { service } = makeHarness({ [LANE_A]: null, [LANE_B]: 'device-b' })
    expect(await refusalCode(() => service.loginAuthority.loginStart('device-a', 'a@x.com'))).toBe(
      'accounts.lane.no_login_device_designated'
    )
    expect(spawnMocks.spawnClaudeCliChildProcess).not.toHaveBeenCalled()
  })

  it('refuses loginStart from a bound grant that is not the designated one', async () => {
    const { service } = makeHarness()
    expect(await refusalCode(() => service.loginAuthority.loginStart('device-a2', 'a@x.com'))).toBe(
      'accounts.lane.login_not_designated'
    )
    expect(spawnMocks.spawnClaudeCliChildProcess).not.toHaveBeenCalled()
  })

  it('gives the authorization URL only in the loginStart reply — the status frame a second grant of the SAME principal sees carries no URL field', async () => {
    const { service } = makeHarness()
    const framesOnA2: LaneStatusFrame[] = []
    service.stream.subscribe({ deviceId: 'device-a2', principalId: LANE_A }, 'conn-a2', (frame) =>
      framesOnA2.push(frame)
    )

    const startPromise = service.loginAuthority.loginStart('device-a', 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    const result = await startPromise

    expect(result.authorizationUrl).toBe(GOOD_URL)
    const started = framesOnA2.find((frame) => frame.type === 'login-started')
    expect(started).toBeDefined()
    // The type itself carries no `authorizationUrl`/`authorizeUrl` field — this asserts the
    // SERIALIZED frame never smuggles one in anyway.
    expect(JSON.stringify(started)).not.toContain(GOOD_URL)
  })

  it('lets grant B see nothing about the SAME lane if it is not the owning grant of a session', async () => {
    const { service } = makeHarness()
    const startPromise = service.loginAuthority.loginStart('device-a', 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise

    // device-a2 is bound to the SAME principal (LANE_A) but did not start this session.
    expect(
      await refusalCode(() =>
        service.loginAuthority.loginSubmitCode('device-a2', sessionId, '123456')
      )
    ).toBe('accounts.lane.login_session_unknown')
    expect(
      await refusalCode(() => service.loginAuthority.loginCancel('device-a2', sessionId))
    ).toBe('accounts.lane.login_session_unknown')
    expect(() => service.loginAuthority.loginStatus('device-a2', sessionId)).toThrow()
  })

  it('refuses a wrong session id identically to a real session owned by someone else (no existence leak)', async () => {
    const { service } = makeHarness()
    expect(
      await refusalCode(() =>
        service.loginAuthority.loginSubmitCode('device-a', 'no-such-session', '123456')
      )
    ).toBe('accounts.lane.login_session_unknown')
  })

  it('lets the OWNING grant cancel its own session and publishes login-failed(login_cancelled)', async () => {
    const { service } = makeHarness()
    const framesOnA: LaneStatusFrame[] = []
    service.stream.subscribe({ deviceId: 'device-a', principalId: LANE_A }, 'conn-a', (frame) =>
      framesOnA.push(frame)
    )
    const startPromise = service.loginAuthority.loginStart('device-a', 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise

    const result = await service.loginAuthority.loginCancel('device-a', sessionId)

    expect(result).toEqual({ cancelled: true })
    expect(framesOnA.at(-1)).toMatchObject({
      type: 'login-failed',
      loginSessionId: sessionId,
      code: 'accounts.lane.login_cancelled'
    })
  })

  it('loginStatus for the owning grant reports only that session and no other lane', async () => {
    const { service } = makeHarness()
    const startPromise = service.loginAuthority.loginStart('device-a', 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise

    const status = service.loginAuthority.loginStatus('device-a', sessionId)

    expect(status.sessionId).toBe(sessionId)
    expect(status.laneId).toBe(LANE_A)
    expect(JSON.stringify(status)).not.toContain(LANE_B)
  })

  it('a caller unidentified on this host is refused before any lane is touched', async () => {
    const { service } = makeHarness()
    expect(await refusalCode(() => service.loginAuthority.loginStart(null, 'a@x.com'))).toBe(
      'accounts.lane.caller_unidentified'
    )
    expect(spawnMocks.spawnClaudeCliChildProcess).not.toHaveBeenCalled()
  })
})

describe('LaneLoginAuthority §modules E — the host-inline entry point', () => {
  it('loginStartInline succeeds with NO designation at all (exempt from (i-a)/(i-b))', async () => {
    const { service } = makeHarness({ [LANE_A]: null })
    const startPromise = service.loginAuthority.loginStartInline(LANE_A, 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    const result = await startPromise
    expect(result.authorizationUrl).toBe(GOOD_URL)
  })

  it('"two entry points, one session": a grant-started session blocks an inline start on the SAME lane', async () => {
    const { service } = makeHarness()
    const startPromise = service.loginAuthority.loginStart('device-a', 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    await startPromise
    expect(
      await refusalCode(() => service.loginAuthority.loginStartInline(LANE_A, 'a@x.com'))
    ).toBe('accounts.lane.login_already_in_flight')
  })

  it('"two entry points, one session": an inline-started session blocks a grant start on the SAME lane', async () => {
    const { service } = makeHarness()
    const startPromise = service.loginAuthority.loginStartInline(LANE_A, 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    await startPromise
    expect(await refusalCode(() => service.loginAuthority.loginStart('device-a', 'a@x.com'))).toBe(
      'accounts.lane.login_already_in_flight'
    )
    // MP: scoping the single-in-flight lock to the RPC surface (`hasInFlightSession` keyed only
    // on grant-started sessions) would leave this green while two `claude` children raced one
    // `<lane>/claude-accounts` root — asserted directly: only ONE login child was ever spawned.
    expect(spawnMocks.spawnClaudeCliChildProcess).toHaveBeenCalledTimes(1)
  })

  it('no grant — the designated one included — may submitCode into a CLI-started session', async () => {
    const { service } = makeHarness()
    const startPromise = service.loginAuthority.loginStartInline(LANE_A, 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise
    expect(
      await refusalCode(() => service.loginAuthority.loginSubmitCode('device-a', sessionId, '1'))
    ).toBe('accounts.lane.login_session_unknown')
  })

  it('loginSubmitCodeInline refuses a session it did not start (a grant-started one, or a wrong lane)', async () => {
    const { service } = makeHarness()
    const grantStart = service.loginAuthority.loginStart('device-a', 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await grantStart
    expect(
      await refusalCode(() =>
        service.loginAuthority.loginSubmitCodeInline(LANE_A, sessionId, '123456')
      )
    ).toBe('accounts.lane.login_session_unknown')
    expect(
      await refusalCode(() =>
        service.loginAuthority.loginSubmitCodeInline(LANE_B, 'no-such-session', '123456')
      )
    ).toBe('accounts.lane.login_session_unknown')
  })

  it("loginCancelInline cancels the lane's in-flight inline session and publishes login-failed", async () => {
    const { service } = makeHarness()
    const framesOnA: LaneStatusFrame[] = []
    service.stream.subscribe({ deviceId: 'device-a', principalId: LANE_A }, 'conn-a', (frame) =>
      framesOnA.push(frame)
    )
    const startPromise = service.loginAuthority.loginStartInline(LANE_A, 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    await startPromise

    const result = await service.loginAuthority.loginCancelInline(LANE_A)

    expect(result).toEqual({ cancelled: true })
    expect(framesOnA.at(-1)).toMatchObject({
      type: 'login-failed',
      code: 'accounts.lane.login_cancelled'
    })
  })

  it('loginCancelInline never cancels a GRANT-started session (asymmetric ownership, same as submit)', async () => {
    const { service } = makeHarness()
    const startPromise = service.loginAuthority.loginStart('device-a', 'a@x.com')
    feedGoodLoginPrompt(loginChildren[0])
    await startPromise
    // MP: dropping the `owner.kind !== 'host-inline'` check in `loginCancelInline` would let this
    // succeed and cancel a session the host-inline caller never started.
    expect(await refusalCode(() => service.loginAuthority.loginCancelInline(LANE_A))).toBe(
      'accounts.lane.login_session_unknown'
    )
  })

  it('loginCancelInline with nothing in flight refuses login_session_unknown', async () => {
    const { service } = makeHarness()
    expect(await refusalCode(() => service.loginAuthority.loginCancelInline(LANE_A))).toBe(
      'accounts.lane.login_session_unknown'
    )
  })
})
