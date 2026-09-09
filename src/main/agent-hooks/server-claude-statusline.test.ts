// Why: locks the /statusline/claude loopback contract — form-encoded posts from the
// managed statusline script must reach the listener, and junk must fail open (204).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'

describe('AgentHookServer /statusline/claude', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  function post(body: string, token?: string): Promise<Response> {
    const env = server.buildPtyEnv()
    return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/statusline/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Orca-Agent-Hook-Token': token ?? env.ORCA_AGENT_HOOK_TOKEN
      },
      body
    })
  }

  it('forwards parsed rate limits to the statusline listener', async () => {
    const events: ClaudeStatusLineRateLimits[] = []
    server.setClaudeStatusLineListener((event) => {
      events.push(event)
    })

    const payload = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 12.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 40, resets_at: 1712059200 }
      }
    })
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const body = new URLSearchParams({
      paneKey,
      configDir: '/home/dev/managed',
      payload
    }).toString()

    await expect(post(body)).resolves.toMatchObject({ status: 204 })
    // The paneKey now reaches the listener: it is the lane attribution key (S9 §2k).
    expect(events).toEqual([
      {
        configDir: '/home/dev/managed',
        paneKey,
        fiveHour: { used_percentage: 12.5, resets_at: 1738425600 },
        sevenDay: { used_percentage: 40, resets_at: 1712059200 }
      }
    ])
  })

  it('rejects posts with a bad token and ignores payloads without rate limits', async () => {
    const events: ClaudeStatusLineRateLimits[] = []
    server.setClaudeStatusLineListener((event) => {
      events.push(event)
    })

    await expect(post('payload={}', 'wrong-token')).resolves.toMatchObject({ status: 403 })

    const noLimits = new URLSearchParams({
      paneKey: 'pane-1',
      payload: JSON.stringify({ context_window: { used_percentage: 8 } })
    }).toString()
    await expect(post(noLimits)).resolves.toMatchObject({ status: 204 })

    await expect(post('payload=not-json')).resolves.toMatchObject({ status: 204 })

    expect(events).toEqual([])
  })

  // [S10-21d R118, design (b)] onClaudeSessionPrefs — a separate slot, gated before it ever
  // fires: paneKey known, effort on the allow-list. Never logs the payload (assert only on the
  // listener's own received event, never on console output).
  describe('onClaudeSessionPrefs sink', () => {
    const paneKey = 'tab-1:22222222-2222-4222-8222-222222222222'

    function prefsBody(effort: string, model?: string): string {
      return new URLSearchParams({
        paneKey,
        payload: JSON.stringify({
          ...(model ? { model: { id: model } } : {}),
          effort: { level: effort }
        })
      }).toString()
    }

    it('fires with a valid effort level and known paneKey', async () => {
      const events: { paneKey: string; model?: string; effort: string }[] = []
      server.setClaudeSessionPrefsListener((event) => events.push(event))

      await expect(post(prefsBody('xhigh', 'claude-opus-4-8'))).resolves.toMatchObject({
        status: 204
      })
      expect(events).toEqual([{ paneKey, model: 'claude-opus-4-8', effort: 'xhigh' }])
    })

    it('never fires for an unrecognized effort level (fail closed)', async () => {
      const events: unknown[] = []
      server.setClaudeSessionPrefsListener((event) => events.push(event))

      await expect(post(prefsBody('ultracode'))).resolves.toMatchObject({ status: 204 })
      expect(events).toEqual([])
    })

    it('never fires with no paneKey', async () => {
      const events: unknown[] = []
      server.setClaudeSessionPrefsListener((event) => events.push(event))

      const body = new URLSearchParams({
        payload: JSON.stringify({ effort: { level: 'max' } })
      }).toString()
      await expect(post(body)).resolves.toMatchObject({ status: 204 })
      expect(events).toEqual([])
    })

    it('never fires when the payload carries no effort at all', async () => {
      const events: unknown[] = []
      server.setClaudeSessionPrefsListener((event) => events.push(event))

      const body = new URLSearchParams({
        paneKey,
        payload: JSON.stringify({ model: { id: 'claude-opus-4-8' } })
      }).toString()
      await expect(post(body)).resolves.toMatchObject({ status: 204 })
      expect(events).toEqual([])
    })

    it('still forwards to onClaudeStatusLine alongside onClaudeSessionPrefs', async () => {
      const statusLineEvents: ClaudeStatusLineRateLimits[] = []
      const prefsEvents: unknown[] = []
      server.setClaudeStatusLineListener((event) => statusLineEvents.push(event))
      server.setClaudeSessionPrefsListener((event) => prefsEvents.push(event))

      await post(prefsBody('high'))
      expect(statusLineEvents).toHaveLength(1)
      expect(prefsEvents).toHaveLength(1)
    })
  })
})
