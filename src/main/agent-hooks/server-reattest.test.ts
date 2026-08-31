// S10-5: the /reattest route lets a CLI that hit no_pane_identity re-establish this pane's
// current-runtime authority observation after a runtime restart wiped it from memory, without
// waiting for an incidental agent hook to refire. Security equivalence with the real hook POST
// channel (same token gate, same recordCurrentAuthorityObservation) is asserted here; the
// end-to-end refusal proof for a forged pane with no matching restored receipt lives in
// orchestration-compatibility-authority.test.ts, next to verifyOrchestrationCompatibilityCaller.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-reattest', LEAF)

describe('/reattest', () => {
  let server: AgentHookServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
  })

  async function startServer(userDataPath?: string): Promise<{
    port: number
    token: string
    post: (body: unknown, headers?: Record<string, string>) => Promise<Response>
  }> {
    server = new AgentHookServer()
    await server.start({ env: 'production', ...(userDataPath ? { userDataPath } : {}) })
    const env = server.buildPtyEnv()
    const port = Number(env.ORCA_AGENT_HOOK_PORT)
    const token = env.ORCA_AGENT_HOOK_TOKEN!
    const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/reattest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          ...headers
        },
        body: JSON.stringify(body)
      })
    return { port, token, post }
  }

  it('records a current authority observation for a well-formed body', async () => {
    const { post } = await startServer()
    const res = await post({
      paneKey: PANE,
      terminalHandle: 'term-1',
      launchToken: 'launch-secret'
    })
    expect(res.status).toBe(204)
    const observations = server!.getCurrentAuthorityObservations()
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({ paneKey: PANE, connectionId: null })
    // Why: never echo the raw secret back into observed state — only its hash travels onward.
    expect(JSON.stringify(observations)).not.toContain('launch-secret')
  })

  it('rejects a request missing the hook token the same way every other route does', async () => {
    const { post } = await startServer()
    const res = await post(
      { paneKey: PANE, terminalHandle: 'term-1', launchToken: 'launch-secret' },
      { 'X-Orca-Agent-Hook-Token': 'wrong-token' }
    )
    expect(res.status).toBe(403)
    expect(server!.getCurrentAuthorityObservations()).toHaveLength(0)
  })

  it.each([
    [
      'malformed paneKey',
      { paneKey: 'not-a-pane-key', terminalHandle: 'term-1', launchToken: 'x' }
    ],
    ['missing terminalHandle', { paneKey: PANE, launchToken: 'x' }],
    ['missing launchToken', { paneKey: PANE, terminalHandle: 'term-1' }],
    [
      'oversized launchToken',
      { paneKey: PANE, terminalHandle: 'term-1', launchToken: 'x'.repeat(129) }
    ],
    [
      'oversized terminalHandle',
      { paneKey: PANE, terminalHandle: 'h'.repeat(257), launchToken: 'x' }
    ]
  ])('refuses %s with 400 and records nothing', async (_label, body) => {
    const { post } = await startServer()
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(server!.getCurrentAuthorityObservations()).toHaveLength(0)
  })

  it('rate-limits repeated reattest requests for the same pane', async () => {
    const { post } = await startServer()
    const body = { paneKey: PANE, terminalHandle: 'term-1', launchToken: 'launch-secret' }
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- Why: each call must land before the next to exercise the fixed window sequentially.
      const res = await post(body)
      expect(res.status).toBe(204)
    }
    const limited = await post(body)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).not.toBeNull()
  })

  describe('rate-limit window bounding (S10-5 review F3)', () => {
    it('evicts stale-window entries for other panes once their window has expired', async () => {
      const { post } = await startServer()
      const paneA = makePaneKey('tab-a', LEAF)
      const paneB = makePaneKey('tab-b', LEAF)

      const first = await post({ paneKey: paneA, terminalHandle: 'term-1', launchToken: 'x' })
      expect(first.status).toBe(204)
      expect(server!.getReattestRateWindowEntryCount()).toBe(1)

      // Same window: paneB's check adds a second live entry, paneA's is not yet stale.
      const second = await post({ paneKey: paneB, terminalHandle: 'term-1', launchToken: 'y' })
      expect(second.status).toBe(204)
      expect(server!.getReattestRateWindowEntryCount()).toBe(2)

      // Why: fake only Date (not timers) so the real HTTP client/server keep working while
      // Date.now() jumps past the rate-limit window.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 61_000)
        // Why: a fresh check for paneA now falls in a new window — its own stale entry is
        // replaced, and paneB's now-stale entry (a different key) is swept in the same pass.
        const third = await post({ paneKey: paneA, terminalHandle: 'term-1', launchToken: 'x' })
        expect(third.status).toBe(204)
        expect(server!.getReattestRateWindowEntryCount()).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('clears the rate-limit map on stop()/start() reset, so budgets do not survive a restart', async () => {
      server = new AgentHookServer()
      await server.start({ env: 'production' })
      const env = server.buildPtyEnv()
      const port = Number(env.ORCA_AGENT_HOOK_PORT)
      const token = env.ORCA_AGENT_HOOK_TOKEN!
      const post = (body: unknown): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/reattest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify(body)
        })
      const body = { paneKey: PANE, terminalHandle: 'term-1', launchToken: 'launch-secret' }
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- Why: exhaust the budget sequentially.
        const res = await post(body)
        expect(res.status).toBe(204)
      }
      const limited = await post(body)
      expect(limited.status).toBe(429)
      expect(server!.getReattestRateWindowEntryCount()).toBeGreaterThan(0)

      server!.stop()
      expect(server!.getReattestRateWindowEntryCount()).toBe(0)

      await server!.start({ env: 'production' })
      const env2 = server!.buildPtyEnv()
      const port2 = Number(env2.ORCA_AGENT_HOOK_PORT)
      const token2 = env2.ORCA_AGENT_HOOK_TOKEN!
      const res = await fetch(`http://127.0.0.1:${port2}/reattest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token2 },
        body: JSON.stringify(body)
      })
      // Why: a restart must not inherit the pre-restart pane's exhausted budget.
      expect(res.status).toBe(204)
    })
  })

  describe('closed-tab admission gate (S10-5 review F1)', () => {
    let userDataPath: string

    beforeEach(() => {
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-reattest-closed-tab-'))
    })

    afterEach(() => {
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('records no observation and persists no commitment for a pane whose tab was closed', async () => {
      const tabId = 'tab-reattest'
      const pane = makePaneKey(tabId, LEAF)
      const victimHash = createHash('sha256').update('victim-token').digest('hex')
      const { post } = await startServer(userDataPath)

      // Why: seed a legitimate observation first (as a fresh pane, e.g. a runtime-restart
      // reattest) so we can prove the attacker's /reattest, issued after the tab closes, never
      // displaces it in memory or on disk with the attacker's own token hash.
      const legit = await post({
        paneKey: pane,
        terminalHandle: 'term-1',
        launchToken: 'victim-token'
      })
      expect(legit.status).toBe(204)
      expect(server!.getCurrentAuthorityObservations()).toHaveLength(1)
      expect(server!.getCurrentAuthorityObservations()[0]).toMatchObject({
        paneKey: pane,
        launchTokenHash: victimHash
      })

      server!.dropStatusEntriesByTabPrefix(tabId)

      const forged = await post({
        paneKey: pane,
        terminalHandle: 'term-1',
        launchToken: 'attacker-token'
      })
      // Why: same idiom as a forged hook POST against a closed-tab pane — 204 (no-op), not an error.
      expect(forged.status).toBe(204)

      const observationsAfter = server!.getCurrentAuthorityObservations()
      const attackerObservation = observationsAfter.find(
        (o) => o.paneKey === pane && o.launchTokenHash !== victimHash
      )
      expect(attackerObservation).toBeUndefined()

      server!.flushStatusPersistSync()
      const onDisk = JSON.parse(readFileSync(server!.lastStatusPath!, 'utf8'))
      const persistedCommitment = onDisk.authorityCommitments[pane]
      if (persistedCommitment) {
        expect(persistedCommitment.launchTokenHash).toBe(victimHash)
      }
    })
  })
})
