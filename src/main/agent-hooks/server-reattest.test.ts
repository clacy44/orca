// S10-5: the /reattest route lets a CLI that hit no_pane_identity re-establish this pane's
// current-runtime authority observation after a runtime restart wiped it from memory, without
// waiting for an incidental agent hook to refire. Security equivalence with the real hook POST
// channel (same token gate, same recordCurrentAuthorityObservation) is asserted here; the
// end-to-end refusal proof for a forged pane with no matching restored receipt lives in
// orchestration-compatibility-authority.test.ts, next to verifyOrchestrationCompatibilityCaller.
import { afterEach, describe, expect, it } from 'vitest'
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

  async function startServer(): Promise<{
    port: number
    token: string
    post: (body: unknown, headers?: Record<string, string>) => Promise<Response>
  }> {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
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
})
