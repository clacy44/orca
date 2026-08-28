import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsModule from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import { readLaneAccountIndex } from './lane-account-index'
import { markLaneWipePending, resetLaneWipePendingForTests } from './lane-wipe-pending'

/** Lets one specific `rmSync` call (matched by a predicate on its path) throw EPERM, the ordinary
 * win32/network-mount shape when a just-exited child's handles are not yet released — the probe
 * P-D/P-E (review finding) needs to arm the reap's own sweep to fail without touching every other
 * `rmSync` this suite's setup/teardown relies on. */
const fsFailureMocks = vi.hoisted(() => ({
  failRmSyncWhen: null as ((path: string) => boolean) | null
}))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFsModule>()
  return {
    ...original,
    rmSync: (path: unknown, options?: Parameters<typeof original.rmSync>[1]) => {
      const predicate = fsFailureMocks.failRmSyncWhen
      if (predicate && typeof path === 'string' && predicate(path)) {
        fsFailureMocks.failRmSyncWhen = null
        const error = new Error('EPERM: operation not permitted, rmdir') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return original.rmSync(path as string, options)
    }
  }
})

/** Verbatim, matching `lane-login-url-parser.ts`'s private `PASTE_CODE_PROMPT` — deliberately NO
 * trailing newline (a line-buffered feed would hang). */
const PASTE_PROMPT = 'Paste code here if prompted > '
const GOOD_URL = `https://platform.claude.com/oauth/authorize?redirect_uri=${encodeURIComponent(
  'https://platform.claude.com/oauth/code/callback'
)}`

type SpawnOptions = { onStdoutChunk?: (chunk: string) => void }

class FakeLoginChild {
  handle = {
    writeStdin: vi.fn(),
    kill: vi.fn((error?: Error) => this.exit(error ?? new Error('killed')))
  }
  resultPromise: Promise<{ code: number | null }>
  private resolveResult!: (value: { code: number | null }) => void
  private rejectResult!: (error: unknown) => void
  private settled = false

  constructor(private readonly options: SpawnOptions) {
    this.resultPromise = new Promise((res, rej) => {
      this.resolveResult = res
      this.rejectResult = rej
    })
  }

  feed(chunk: string): void {
    this.options.onStdoutChunk?.(chunk)
  }

  exit(codeOrError: number | Error | null = 0): void {
    if (this.settled) {
      return
    }
    this.settled = true
    if (codeOrError instanceof Error) {
      this.rejectResult(codeOrError)
    } else {
      this.resolveResult({ code: codeOrError })
    }
  }
}

const spawnMocks = vi.hoisted(() => ({ spawnClaudeCliChildProcess: vi.fn() }))
vi.mock('./claude-cli-child-process', () => ({
  spawnClaudeCliChildProcess: spawnMocks.spawnClaudeCliChildProcess
}))

import {
  LaneLoginSessionRegistry,
  LOGIN_TIMEOUT_MS,
  MAX_LOGIN_CODE_ATTEMPTS
} from './lane-login-session'

const HOST_INLINE = { kind: 'host-inline' as const }

describe('LaneLoginSessionRegistry (S9-L1 A1)', () => {
  let laneDir = ''
  let loginChildren: FakeLoginChild[] = []
  let statusScript: string | null = 'not-scripted'

  const authState = {
    serializeLaneWrite: async <T>(_laneId: string, run: () => Promise<T>): Promise<T> => run()
  }

  // Not the live `claude --version` probe: this suite's outcome must not depend on whichever CLI
  // build happens to be installed on the box running it. `lane-login-cli-version-gate.test.ts`
  // covers the gate itself, including the mutation proof that removing the probe turns it red.
  const passingCliVersionGate = (): void => {}

  function makeRegistry(): LaneLoginSessionRegistry {
    return new LaneLoginSessionRegistry({
      authState,
      assertCliVersionSupported: passingCliVersionGate
    })
  }

  function feedGoodLoginPrompt(child: FakeLoginChild): void {
    child.feed(`Open this link:\n${GOOD_URL}\n${PASTE_PROMPT}`)
  }

  /** The fake login child never touches disk (it only prints), so a test that drives a session
   * through to capture must plant what a real `claude auth login` would itself have written into
   * its own isolated auth dir — matching the LAST login spawn's own `configDir.windowsPath`. */
  function plantCapturedCredentials(email: string): void {
    const authDir = spawnMocks.spawnClaudeCliChildProcess.mock.calls.findLast(
      (call) => call[0][0] === 'auth' && call[0][1] === 'login'
    )![1].windowsPath
    writeFileSync(
      join(authDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })
    )
    writeFileSync(
      join(authDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } })
    )
  }

  /** A reprompt is a FRESH rising edge — reset the "showing" state first, exactly as a real
   * rejection message (something that does not end in the prompt) would. */
  function feedReprompt(child: FakeLoginChild): void {
    child.feed('\nThat code was not accepted.\n')
    child.feed(PASTE_PROMPT)
  }

  beforeEach(() => {
    laneDir = mkdtempSync(join(tmpdir(), 'orca-lane-login-session-'))
    loginChildren = []
    statusScript = JSON.stringify({ email: 'a@x.com' })
    resetLaneWipePendingForTests()
    spawnMocks.spawnClaudeCliChildProcess.mockReset()
    spawnMocks.spawnClaudeCliChildProcess.mockImplementation(
      (args: string[], _configDir: unknown, _timeoutMs: number, options: SpawnOptions = {}) => {
        if (args[0] === 'auth' && args[1] === 'login') {
          const child = new FakeLoginChild(options)
          loginChildren.push(child)
          return { handle: child.handle, result: child.resultPromise }
        }
        // 'auth status --json'
        if (statusScript !== null) {
          options.onStdoutChunk?.(statusScript)
        }
        return {
          handle: { writeStdin: vi.fn(), kill: vi.fn() },
          result: Promise.resolve({ code: 0 })
        }
      }
    )
  })

  afterEach(() => {
    resetLaneWipePendingForTests()
    rmSync(laneDir, { recursive: true, force: true })
  })

  it('registers the session SYNCHRONOUSLY: a cancel issued right after start() (no await) still sees it', async () => {
    const registry = makeRegistry()

    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    // No `await` above: this runs in the SAME synchronous tick as `start`'s own synchronous
    // prefix (obligation (4″)'s induction step) — the spawn mock has already been invoked.
    expect(loginChildren).toHaveLength(1)
    registry.cancelLaneLoginSessions('lane-1')

    await expect(startPromise).rejects.toMatchObject({ code: 'accounts.lane.login_cancelled' })
    expect(loginChildren[0].handle.kill).toHaveBeenCalledTimes(1)
    // MP anchor: if the session were inserted into the map AFTER an `await` (e.g. after the
    // mkdir), this synchronous cancel would find nothing and the login would proceed to mint a
    // URL for a session the caller had already tried to cancel.
  })

  it('relays the authorization URL read off the LIVE stream, not a later accumulated buffer', async () => {
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[0])

    const { authorizationUrl, expiresAt } = await startPromise

    expect(authorizationUrl).toBe(GOOD_URL)
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + LOGIN_TIMEOUT_MS)
  })

  it('mints the login directory with the marker written before the URL is even read', async () => {
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    // The marker must already be on disk by the time the child is spawned — assert BEFORE
    // feeding the URL back.
    const [, configDir] = spawnMocks.spawnClaudeCliChildProcess.mock.calls[0]
    expect(existsSync(join(configDir.windowsPath, '.orca-managed-claude-auth'))).toBe(true)
    feedGoodLoginPrompt(loginChildren[0])
    await startPromise
  })

  it('refuses accounts.lane.wipe_in_progress and spawns nothing when the lane is wipe-pending', async () => {
    const registry = makeRegistry()
    markLaneWipePending('lane-1')

    await expect(
      registry.start({ laneId: 'lane-1', laneDir, expectedEmail: 'a@x.com', owner: HOST_INLINE })
    ).rejects.toMatchObject({ code: 'accounts.lane.wipe_in_progress' })
    expect(spawnMocks.spawnClaudeCliChildProcess).not.toHaveBeenCalled()
  })

  it('refuses accounts.lane.login_store_full at eight logins already indexed, spawning nothing', async () => {
    const registry = makeRegistry()
    const accountsRoot = join(laneDir, 'claude-accounts')
    mkdirSync(accountsRoot, { recursive: true })
    const rows = Array.from({ length: 8 }, (_unused, i) => ({
      laneAccountId: `1111111${i}-1111-4111-8111-11111111111${i}`,
      email: `n${i}@x.com`,
      label: null,
      active: false,
      capturedAt: '2026-01-01T00:00:00.000Z'
    }))
    writeFileSync(join(accountsRoot, 'index.json'), JSON.stringify(rows))

    await expect(
      registry.start({ laneId: 'lane-1', laneDir, expectedEmail: 'a@x.com', owner: HOST_INLINE })
    ).rejects.toMatchObject({ code: 'accounts.lane.login_store_full' })
    expect(spawnMocks.spawnClaudeCliChildProcess).not.toHaveBeenCalled()
  })

  it('refuses a second loginStart on the same lane while one is in flight, spawning no second child', async () => {
    const registry = makeRegistry()
    const first = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })

    await expect(
      registry.start({ laneId: 'lane-1', laneDir, expectedEmail: 'b@x.com', owner: HOST_INLINE })
    ).rejects.toMatchObject({ code: 'accounts.lane.login_already_in_flight' })
    expect(loginChildren).toHaveLength(1)

    feedGoodLoginPrompt(loginChildren[0])
    await first
  })

  it('two entry points share ONE lock: a grant-started session blocks the host-inline path too', async () => {
    const registry = makeRegistry()
    const first = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: { kind: 'grant', deviceId: 'device-1' }
    })

    await expect(
      registry.start({ laneId: 'lane-1', laneDir, expectedEmail: 'a@x.com', owner: HOST_INLINE })
    ).rejects.toMatchObject({ code: 'accounts.lane.login_already_in_flight' })

    feedGoodLoginPrompt(loginChildren[0])
    await first
  })

  it('submitCode writes to stdin only after the paste-code prompt has fired, and completes on a matching identity', async () => {
    const registry = makeRegistry()
    const { sessionId } = await (async () => {
      const p = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      feedGoodLoginPrompt(loginChildren[0])
      return p
    })()
    plantCapturedCredentials('a@x.com')

    const submit = registry.submitCode(sessionId, '123456')
    loginChildren[0].exit(0)
    const result = await submit

    expect(loginChildren[0].handle.writeStdin).toHaveBeenCalledWith('123456\n')
    expect(result).toEqual({
      status: 'completed',
      identity: { email: 'a@x.com' },
      attemptsRemaining: MAX_LOGIN_CODE_ATTEMPTS - 1
    })
    expect(registry.statusOf(sessionId)?.state).toBe('captured')
    const rows = readLaneAccountIndex(join(laneDir, 'claude-accounts'))
    expect(rows).toHaveLength(1)
    expect(rows[0].active).toBe(true)
  })

  it('submitCode surfaces login_identity_mismatch when the captured identity does not match', async () => {
    statusScript = JSON.stringify({ email: 'someone-else@x.com' })
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise
    plantCapturedCredentials('a@x.com') // the CLI's own capture — expectedEmail is 'a@x.com' but
    // `auth status --json` (scripted above) reports 'someone-else@x.com': I6 must fail on THAT.

    const submit = registry.submitCode(sessionId, '123456')
    loginChildren[0].exit(0)

    await expect(submit).rejects.toMatchObject({ code: 'accounts.lane.login_identity_mismatch' })
    expect(readLaneAccountIndex(join(laneDir, 'claude-accounts'))).toEqual([])
  })

  it('submitCode against an unknown session id is refused before any stdin write', async () => {
    const registry = makeRegistry()

    await expect(registry.submitCode('nope', '000000')).rejects.toMatchObject({
      code: 'accounts.lane.login_session_unknown'
    })
  })

  it('P-A: a child that exits with no submitCode ever made is reaped on the exit event, freeing the lane for a new login', async () => {
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[0])
    await startPromise
    const firstAuthDir = spawnMocks.spawnClaudeCliChildProcess.mock.calls.findLast(
      (call) => call[0][0] === 'auth' && call[0][1] === 'login'
    )![1].windowsPath

    // The ordinary "browser never came back / CLI gave up" path: the child exits on its own with
    // no `submitCode` ever made.
    loginChildren[0].exit(1)
    // Let the exit's `.then` chain (which drives `onChildSettled`) settle before asserting.
    await Promise.resolve()
    await Promise.resolve()

    expect(registry.statusOfLane('lane-1')).toBeNull()
    expect(existsSync(firstAuthDir)).toBe(false)

    // The single-in-flight lock must not still be pinned: a second start on the same lane
    // succeeds and spawns a fresh child, rather than refusing `login_already_in_flight` forever.
    const second = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[1])
    await expect(second).resolves.toMatchObject({ sessionId: expect.any(String) })
    expect(loginChildren).toHaveLength(2)
  })

  it('P-B: submitCode rejecting login_identity_mismatch reaps the session, freeing the lane for a new login', async () => {
    statusScript = JSON.stringify({ email: 'someone-else@x.com' })
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise
    plantCapturedCredentials('a@x.com')

    const submit = registry.submitCode(sessionId, '123456')
    loginChildren[0].exit(0)
    await expect(submit).rejects.toMatchObject({ code: 'accounts.lane.login_identity_mismatch' })

    expect(registry.statusOf(sessionId)?.state).toBe('cancelled')
    expect(registry.statusOfLane('lane-1')).toBeNull()

    // The most likely operator error (mistyped/wrong-case --email) must not make the lane
    // un-loginnable for the rest of the host process.
    statusScript = JSON.stringify({ email: 'a@x.com' })
    const second = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[1])
    await expect(second).resolves.toMatchObject({ sessionId: expect.any(String) })
  })

  it('a submit buffered on the paste prompt is login_session_unknown if the child crashes first, never a raw stdin write', async () => {
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    // The URL alone is enough for `start()` to resolve — the prompt never fires, so a submit
    // must buffer on `awaitPasteReady` rather than proceed.
    loginChildren[0].feed(`Open this link:\n${GOOD_URL}\n`)
    const { sessionId } = await startPromise

    const submit = registry.submitCode(sessionId, '123456')
    // The child crashes before ever printing the paste prompt — the buffered submit must wake on
    // the exit flush and refuse, not sit forever, and MUST NOT then write into the dead pipe.
    loginChildren[0].exit(1)

    await expect(submit).rejects.toMatchObject({ code: 'accounts.lane.login_session_unknown' })
    expect(loginChildren[0].handle.writeStdin).not.toHaveBeenCalled()
  })

  // A CLI whose prompt text has drifted from PASTE_CODE_PROMPT never fires `pasteReady` — a
  // submit parked on it must be bounded by the login TTL and surface `login_session_expired`,
  // never `login_session_unknown` (S9 design rev 39 §4's version-gate backstops).
  it('a submit parked on a changed paste prompt is login_session_expired at the TTL, never login_session_unknown', async () => {
    vi.useFakeTimers()
    try {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      loginChildren[0].feed(`Open this link:\n${GOOD_URL}\nEnter the code here >> `)
      const { sessionId } = await startPromise

      const submit = registry.submitCode(sessionId, '123456')
      // Attached before advancing the fake timer: the reject happens INSIDE that advance, and an
      // unhandled `submit` at that microtask checkpoint would otherwise surface as a spurious
      // unhandled-rejection warning, not a real assertion failure.
      const settled = submit.then(
        () => 'resolved' as const,
        (error: unknown) => (isClaudeLaneRefusal(error) ? error.code : 'other')
      )
      await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS + 1)

      expect(await settled).toBe('accounts.lane.login_session_expired')
      expect(loginChildren[0].handle.writeStdin).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a submit past the TTL is login_session_expired with destructive cleanup, never a raw stdin error', async () => {
    let now = Date.now()
    const registry = new LaneLoginSessionRegistry({
      authState,
      now: () => now,
      assertCliVersionSupported: passingCliVersionGate
    })
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise
    now += LOGIN_TIMEOUT_MS + 1

    await expect(registry.submitCode(sessionId, '123456')).rejects.toMatchObject({
      code: 'accounts.lane.login_session_expired'
    })
    expect(loginChildren[0].handle.writeStdin).not.toHaveBeenCalled()
    expect(loginChildren[0].handle.kill).toHaveBeenCalledTimes(1)
    expect(registry.statusOf(sessionId)?.state).toBe('cancelled')
  })

  it('review r2 minor: a failed cancel sweep does not replace the login_session_expired refusal with a raw fs error', async () => {
    let now = Date.now()
    const registry = new LaneLoginSessionRegistry({
      authState,
      now: () => now,
      assertCliVersionSupported: passingCliVersionGate
    })
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise
    const authDir = spawnMocks.spawnClaudeCliChildProcess.mock.calls.findLast(
      (call) => call[0][0] === 'auth' && call[0][1] === 'login'
    )![1].windowsPath
    const laneAccountId = basename(dirname(authDir))
    now += LOGIN_TIMEOUT_MS + 1
    // Arms the ONE rmSync call `submitCode`'s own `await this.cancel(sessionId)` makes while
    // unwinding the TTL expiry — capture never starts on this path, so this is the only rmSync
    // in flight. Proves the caller's already-decided refusal survives a transient sweep failure
    // instead of being replaced by the raw EPERM it used to throw before delegating `cancel` to
    // `reapLoginSessionSilently` (review r2 minor).
    fsFailureMocks.failRmSyncWhen = (path) => path.endsWith(laneAccountId)

    const submit = registry.submitCode(sessionId, '123456')

    await expect(submit).rejects.toMatchObject({ code: 'accounts.lane.login_session_expired' })
    // The failed sweep left `swept` false, same retryable state as the detached-reap case.
    expect(registry.statusOf(sessionId)?.state).toBe('cancelled')
  })

  it('the background TTL timer cancels an abandoned session and tears down its process group', async () => {
    vi.useFakeTimers()
    try {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      feedGoodLoginPrompt(loginChildren[0])
      const { sessionId } = await startPromise

      await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS)

      expect(registry.statusOf(sessionId)?.state).toBe('cancelled')
      expect(loginChildren[0].handle.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds wrong-code retries at MAX_LOGIN_CODE_ATTEMPTS, then refuses and tears the child down', async () => {
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    feedGoodLoginPrompt(loginChildren[0])
    const { sessionId } = await startPromise
    const child = loginChildren[0]

    // MAX_LOGIN_CODE_ATTEMPTS - 1 wrong codes each re-prompt and return `rejected` with a
    // shrinking `attemptsRemaining`; the one that would exhaust the cap ends the session instead
    // of reporting zero attempts left to retry with.
    for (let attempt = 1; attempt < MAX_LOGIN_CODE_ATTEMPTS; attempt += 1) {
      const submit = registry.submitCode(sessionId, 'wrong')
      // Yield one microtask so `submitCode`'s synchronous prefix (through `awaitPasteReady`) has
      // registered its reprompt-edge baseline BEFORE the fake child's stdout "arrives" — exactly
      // as a real child's stdout event could never fire synchronously within the caller's own
      // tick.
      await Promise.resolve()
      feedReprompt(child)
      const result = await submit
      expect(result).toEqual({
        status: 'rejected',
        identity: null,
        attemptsRemaining: MAX_LOGIN_CODE_ATTEMPTS - attempt
      })
    }

    const finalSubmit = registry.submitCode(sessionId, 'wrong-final')
    await Promise.resolve()
    feedReprompt(child)

    await expect(finalSubmit).rejects.toMatchObject({ code: 'accounts.lane.login_code_rejected' })
    expect(child.handle.kill).toHaveBeenCalledTimes(1)
    expect(registry.statusOf(sessionId)?.state).toBe('cancelled')
  })

  it('cancelLaneLoginSessions cancels every session of that lane and none of another', async () => {
    const registry = makeRegistry()
    const a = registry.start({
      laneId: 'lane-a',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    const otherLaneDir = mkdtempSync(join(tmpdir(), 'orca-lane-login-session-b-'))
    const b = registry.start({
      laneId: 'lane-b',
      laneDir: otherLaneDir,
      expectedEmail: 'b@x.com',
      owner: HOST_INLINE
    })
    const [childA, childB] = loginChildren

    registry.cancelLaneLoginSessions('lane-a')

    expect(childA.handle.kill).toHaveBeenCalledTimes(1)
    expect(childB.handle.kill).not.toHaveBeenCalled()

    childB.exit(new Error('cleanup'))
    await Promise.allSettled([a, b])
    rmSync(otherLaneDir, { recursive: true, force: true })
  })

  it('sweepCancelledLoginDirs removes the half-written directory only for sessions this lane just cancelled', async () => {
    const registry = makeRegistry()
    const startPromise = registry.start({
      laneId: 'lane-1',
      laneDir,
      expectedEmail: 'a@x.com',
      owner: HOST_INLINE
    })
    const [, configDir] = spawnMocks.spawnClaudeCliChildProcess.mock.calls[0]
    const laneAccountDir = join(configDir.windowsPath, '..')
    expect(existsSync(laneAccountDir)).toBe(true)

    registry.cancelLaneLoginSessions('lane-1')
    expect(existsSync(laneAccountDir)).toBe(true) // state transition ONLY — no sweep yet

    await registry.sweepCancelledLoginDirs('lane-1')
    expect(existsSync(laneAccountDir)).toBe(false)

    await expect(startPromise).rejects.toThrow()
  })

  it('never lets the submitted code or the authorization URL reach console output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      feedGoodLoginPrompt(loginChildren[0])
      const { sessionId } = await startPromise
      plantCapturedCredentials('a@x.com')
      const submit = registry.submitCode(sessionId, 'SECRET-CODE-VALUE')
      loginChildren[0].exit(0)
      await submit

      const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      const serialized = allCalls.map((call) => call.map(String).join(' ')).join('\n')
      expect(serialized).not.toContain('SECRET-CODE-VALUE')
      expect(serialized).not.toContain(GOOD_URL)
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('every thrown refusal is a typed ClaudeLaneRefusal', async () => {
    const registry = makeRegistry()
    markLaneWipePending('lane-1')
    try {
      await registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      expect.unreachable()
    } catch (error) {
      expect(isClaudeLaneRefusal(error)).toBe(true)
    }
  })

  it('P-D/P-E: a reap whose sweep throws does not escape as an unhandled rejection, and leaves the credential retryably swept', async () => {
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      feedGoodLoginPrompt(loginChildren[0])
      const { sessionId } = await startPromise
      const authDir = spawnMocks.spawnClaudeCliChildProcess.mock.calls.findLast(
        (call) => call[0][0] === 'auth' && call[0][1] === 'login'
      )![1].windowsPath
      // A complete credential, exactly what a real capture would leave at rest mid-login.
      writeFileSync(
        join(authDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } })
      )
      const laneAccountId = basename(dirname(authDir))
      fsFailureMocks.failRmSyncWhen = (path) => path.endsWith(laneAccountId)

      // The ordinary "browser never came back / CLI gave up" path the reap exists to serve.
      loginChildren[0].exit(1)
      // Let the exit's `.then` chain (`onChildSettled` -> the detached reap) run to completion,
      // including whatever turn Node needs to flag a rejection as unhandled if one escaped.
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      expect(unhandled).toEqual([])
      // The failed sweep must not have latched `swept`: the credential is still at rest, so the
      // wipe fence's own destructive half (filtered on `!session.swept`) would still reach it
      // rather than skipping it forever.
      expect(existsSync(join(authDir, '.credentials.json'))).toBe(true)
      expect(registry.statusOf(sessionId)?.state).toBe('cancelled')

      // Retry once the transient failure clears: a later cancel actually sweeps it.
      fsFailureMocks.failRmSyncWhen = null
      await registry.cancel(sessionId)
      expect(existsSync(authDir)).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      fsFailureMocks.failRmSyncWhen = null
    }
  })

  describe('§2b prompt refusal — a non-relayable authorize URL rejects loginStart promptly', () => {
    // The real 2.1.250 shape (§4): `claude.com` + `/cai/oauth/authorize`, a `platform.claude.com`
    // redirect — observed via a live, throwaway `claude auth login --claudeai` run (killed before
    // completion, never submitted). Negative control for the timing test below: this shape must
    // still relay normally, not be swept up by the same refusal.
    const REAL_CLI_SHAPE_URL = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(
      'https://platform.claude.com/oauth/code/callback'
    )}`

    // Design rev 39 §2: a non-relayable URL is skipped, not refused on — the refusal is raised on
    // the paste-prompt edge (the CLI's own "done printing the URL" signal) when nothing relayable
    // preceded it. A child that prints only the decoy and then STALLS (no prompt, no exit) is
    // bounded by LOGIN_TIMEOUT_MS and surfaces login_session_expired, never a silent hang.
    it('loginStart rejects login_url_unparsed promptly when a fake CLI prints an evil.example.com authorize URL and then the paste prompt — settles before a 500ms timer, kills the child, sweeps its dir', async () => {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      const authDir = spawnMocks.spawnClaudeCliChildProcess.mock.calls.findLast(
        (call) => call[0][0] === 'auth' && call[0][1] === 'login'
      )![1].windowsPath
      const laneAccountDir = dirname(authDir)
      expect(existsSync(laneAccountDir)).toBe(true)

      // Swallow the rejection on this branch of the race so it isn't reported as unhandled —
      // `startPromise` itself is still asserted on below.
      const settledWithin500ms = Promise.race([
        startPromise.then(
          () => 'resolved' as const,
          () => 'rejected' as const
        ),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
      ])

      const evilUrl = `https://evil.example.com/oauth/authorize?redirect_uri=${encodeURIComponent(
        'https://platform.claude.com/oauth/code/callback'
      )}`
      loginChildren[0].feed(`Open this link:\n${evilUrl}\n${PASTE_PROMPT}`)

      expect(await settledWithin500ms).toBe('rejected')
      await expect(startPromise).rejects.toMatchObject({ code: 'accounts.lane.login_url_unparsed' })
      expect(loginChildren[0].handle.kill).toHaveBeenCalledTimes(1)
      expect(existsSync(laneAccountDir)).toBe(false)
    })

    // §2 / §5 "printed URL only": the loopback browser-opener variant printed AHEAD of the hosted
    // URL must not refuse the login — the hosted URL that follows is relayed (mutation proof:
    // deciding on the first candidate turns this red).
    it('loginStart relays the hosted URL when a non-relayable loopback variant is printed first', async () => {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      const loopbackUrl = `https://claude.com/cai/oauth/authorize?redirect_uri=${encodeURIComponent(
        'http://localhost:54231/callback'
      )}`
      loginChildren[0].feed(`browser opener: ${loopbackUrl}\n`)
      loginChildren[0].feed(`Open this link:\n${REAL_CLI_SHAPE_URL}\n${PASTE_PROMPT}`)

      const { authorizationUrl } = await startPromise
      expect(authorizationUrl).toBe(REAL_CLI_SHAPE_URL)
      expect(loginChildren[0].handle.kill).not.toHaveBeenCalled()
    })

    // A decoy-only child that never reaches the prompt is bounded by the session timeout, not
    // parked forever: the TTL arm reaps it with login_session_expired.
    it('loginStart on a child that prints only a non-relayable URL and then stalls ends in login_session_expired at the TTL, not a hang', async () => {
      vi.useFakeTimers()
      try {
        const registry = makeRegistry()
        const startPromise = registry.start({
          laneId: 'lane-1',
          laneDir,
          expectedEmail: 'a@x.com',
          owner: HOST_INLINE
        })
        const settled = startPromise.then(
          () => 'resolved' as const,
          (error: unknown) => (isClaudeLaneRefusal(error) ? error.code : 'other')
        )
        const evilUrl = `https://evil.example.com/oauth/authorize?redirect_uri=${encodeURIComponent(
          'https://platform.claude.com/oauth/code/callback'
        )}`
        loginChildren[0].feed(`Open this link:\n${evilUrl}\n`)
        await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS + 1)
        expect(await settled).toBe('accounts.lane.login_session_expired')
      } finally {
        vi.useRealTimers()
      }
    })

    it('negative control: the real 2.1.250 URL shape relays normally, not refused', async () => {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })
      loginChildren[0].feed(`Open this link:\n${REAL_CLI_SHAPE_URL}\n${PASTE_PROMPT}`)

      const { authorizationUrl } = await startPromise
      expect(authorizationUrl).toBe(REAL_CLI_SHAPE_URL)
    })

    // Regression: a child that reaches the paste-code prompt without ever printing a relayable
    // URL (or any URL at all) must refuse promptly off the prompt edge — the prompt IS the CLI's
    // own "done printing the URL" signal — never park the caller for the full LOGIN_TIMEOUT_MS
    // waiting on a candidate that will never arrive.
    it('loginStart rejects login_url_unparsed promptly when the child reaches the paste prompt having printed no URL at all — settles before a 500ms timer', async () => {
      const registry = makeRegistry()
      const startPromise = registry.start({
        laneId: 'lane-1',
        laneDir,
        expectedEmail: 'a@x.com',
        owner: HOST_INLINE
      })

      const settledWithin500ms = Promise.race([
        startPromise.then(
          () => 'resolved' as const,
          () => 'rejected' as const
        ),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500))
      ])

      loginChildren[0].feed(`Opening browser to sign in...\n${PASTE_PROMPT}`)

      expect(await settledWithin500ms).toBe('rejected')
      await expect(startPromise).rejects.toMatchObject({ code: 'accounts.lane.login_url_unparsed' })
    })
  })
})
