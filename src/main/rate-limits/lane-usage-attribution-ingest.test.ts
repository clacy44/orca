/**
 * S9 §2k, the ingest half: a lane terminal's statusline post lands on that lane's row rather than
 * being dropped against one host-wide config dir, and nothing host-minted rides the published row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { consumeCodexRateLimitResetCredit, fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMiniMaxRateLimits } from './minimax-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { readGrokAuthSession } from './grok-auth'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'
import { hasMiniMaxSessionCookie } from '../minimax/minimax-cookie-store'
import { REDACTED_LANE_PROVENANCE } from './claude-usage-attribution'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))
vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))
vi.mock('./gemini-usage-fetcher', () => ({ fetchGeminiRateLimits: vi.fn() }))
vi.mock('./kimi-fetcher', () => ({ fetchKimiRateLimits: vi.fn() }))
vi.mock('./opencode-go-usage-fetcher', () => ({ fetchOpenCodeGoRateLimits: vi.fn() }))
vi.mock('./minimax-fetcher', () => ({ fetchMiniMaxRateLimits: vi.fn() }))
vi.mock('./grok-fetcher', () => ({ fetchGrokRateLimits: vi.fn() }))
vi.mock('./grok-auth', () => ({ readGrokAuthSession: vi.fn() }))
vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(),
  readMiniMaxSessionCookie: vi.fn()
}))

const LANE_A = '11111111-1111-4111-8111-111111111111'
const PANE_A = 'tab-a:33333333-3333-4333-8333-333333333333'
const LANE_A_DIR = `/data/claude-lanes/${LANE_A}`
const LABEL_A = 'a'.repeat(32)
const SHARED_DIR = '/home/dev/.claude'

function unavailable(provider: string) {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'unavailable' as const
  }
}

async function serviceWithLaneA(): Promise<RateLimitService> {
  const service = new RateLimitService()
  service.setClaudeAuthPreparationResolver(async () => ({
    configDir: SHARED_DIR,
    envPatch: { CLAUDE_CONFIG_DIR: SHARED_DIR },
    stripAuthEnv: false,
    provenance: 'managed:acct-shared:host'
  }))
  service.setClaudeLaneAttributionResolver(() => [
    {
      laneId: LANE_A,
      configDir: LANE_A_DIR,
      provenance: `lane:${LABEL_A}`,
      identity: { accountUuid: 'acct-a', email: 'a@example.com', organizationUuid: null }
    }
  ])
  service.setClaudeUsagePaneLaneLookup((paneKey) =>
    paneKey === PANE_A ? { laneId: LANE_A } : null
  )
  // One fetch cycle is what captures the shared row and republishes the lane rows.
  await (service as unknown as { fetchAll: () => Promise<void> }).fetchAll()
  return service
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchClaudeRateLimits).mockResolvedValue(unavailable('claude') as never)
  vi.mocked(fetchManagedAccountUsage).mockResolvedValue(unavailable('claude') as never)
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(unavailable('codex') as never)
  vi.mocked(consumeCodexRateLimitResetCredit).mockResolvedValue(undefined as never)
  vi.mocked(fetchGeminiRateLimits).mockResolvedValue(unavailable('gemini') as never)
  vi.mocked(fetchKimiRateLimits).mockResolvedValue(unavailable('kimi') as never)
  vi.mocked(fetchMiniMaxRateLimits).mockResolvedValue(unavailable('minimax') as never)
  vi.mocked(fetchGrokRateLimits).mockResolvedValue(unavailable('grok') as never)
  vi.mocked(readGrokAuthSession).mockReturnValue({ status: 'missing' } as never)
  vi.mocked(hasMiniMaxSessionCookie).mockReturnValue(false)
  vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(unavailable('opencode-go') as never)
})

describe('ingestLiveClaudeRateLimits — lane attribution', () => {
  it("attributes a post carrying lane A's paneKey to lane A, not to the shared bar", async () => {
    const service = await serviceWithLaneA()

    service.ingestLiveClaudeRateLimits({
      // The stale inherited config dir names the SHARED lane; the pane binding still wins.
      configDir: SHARED_DIR,
      paneKey: PANE_A,
      fiveHour: { used_percentage: 61 },
      sevenDay: null
    })

    const claude = service.getState().claude
    expect(claude?.session?.usedPercent).toBe(61)
    expect(claude?.usageMetadata?.authProvenance).toBe(`lane:${LABEL_A}`)
  })

  it('publishes no principal id, device id or lane path on the peer-readable row', async () => {
    const service = new RateLimitService()
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: SHARED_DIR,
      envPatch: { CLAUDE_CONFIG_DIR: SHARED_DIR },
      stripAuthEnv: false,
      provenance: 'managed:acct-shared:host'
    }))
    // A lane row whose provenance leaked its principal id — the shape §2a forbids on the wire.
    service.setClaudeLaneAttributionResolver(() => [
      { laneId: LANE_A, configDir: LANE_A_DIR, provenance: `lane:${LANE_A}`, identity: null }
    ])
    service.setClaudeUsagePaneLaneLookup(() => ({ laneId: LANE_A }))
    await (service as unknown as { fetchAll: () => Promise<void> }).fetchAll()

    service.ingestLiveClaudeRateLimits({
      configDir: LANE_A_DIR,
      paneKey: PANE_A,
      fiveHour: { used_percentage: 12 },
      sevenDay: null
    })

    const provenance = service.getState().claude?.usageMetadata?.authProvenance
    expect(provenance).toBe(REDACTED_LANE_PROVENANCE)
    expect(provenance).not.toContain(LANE_A)
    expect(provenance).not.toContain(LANE_A_DIR)
  })

  // Negative control: the drop that predates S9 stays a drop.
  it('drops a post whose config dir belongs to no known lane and whose pane is unknown', async () => {
    const service = await serviceWithLaneA()

    service.ingestLiveClaudeRateLimits({
      configDir: '/some/other/dir',
      paneKey: null,
      fiveHour: { used_percentage: 99 },
      sevenDay: null
    })

    expect(service.getState().claude?.session).toBeNull()
  })

  it('attributes by config dir when the post carries no paneKey', async () => {
    const service = await serviceWithLaneA()

    service.ingestLiveClaudeRateLimits({
      configDir: LANE_A_DIR,
      fiveHour: { used_percentage: 44 },
      sevenDay: null
    })

    expect(service.getState().claude?.usageMetadata?.authProvenance).toBe(`lane:${LABEL_A}`)
  })
})
