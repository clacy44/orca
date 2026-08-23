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
// §2m(4): on the Windows host the CLI's `%CLAUDE_CONFIG_DIR%` and Orca's stored lane path can
// legitimately differ in DRIVE-LETTER CASE, which `normalizeClaudeConfigDir` deliberately does not
// fold ("preserve Linux case sensitivity"). This is the pair that motivates the paneKey key.
const WIN_LANE_DIR = `C:\\ProgramData\\orca\\claude-lanes\\${LANE_A}`
const WIN_POSTED_DIR = `c:\\ProgramData\\orca\\claude-lanes\\${LANE_A}`

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

async function serviceWithLaneA(laneDir: string = LANE_A_DIR): Promise<RateLimitService> {
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
      configDir: laneDir,
      provenance: `lane:${LABEL_A}`
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
    // The shared account's own numbers, as a fetch would have left them.
    service.ingestLiveClaudeRateLimits({
      configDir: SHARED_DIR,
      paneKey: null,
      fiveHour: { used_percentage: 5 },
      sevenDay: null
    })

    service.ingestLiveClaudeRateLimits({
      // The stale inherited config dir names the SHARED lane; the pane binding still wins.
      configDir: SHARED_DIR,
      paneKey: PANE_A,
      fiveHour: { used_percentage: 61 },
      sevenDay: null
    })

    const lane = service.laneStatuslineUsageOf(LANE_A)
    expect(lane?.session?.usedPercent).toBe(61)
    expect(lane?.usageMetadata?.authProvenance).toBe(`lane:${LABEL_A}`)
    // The host-wide bar is peer-published; lane A's numbers must not have replaced it (§2d).
    const claude = service.getState().claude
    expect(claude?.session?.usedPercent).toBe(5)
    expect(claude?.usageMetadata?.authProvenance).toBe('managed:acct-shared:host')
  })

  // §5's named Windows fixture for the paneKey join: the posted dir and the stored lane dir spell
  // the same directory and differ only in drive-letter case, so the config-dir compare drops the
  // post (§2m(4)) and only the paneKey arm places it. This is the drop the key exists to remove.
  it('attributes a Windows-cased lane post by paneKey, where the config-dir compare cannot', async () => {
    const service = await serviceWithLaneA(WIN_LANE_DIR)

    service.ingestLiveClaudeRateLimits({
      configDir: WIN_POSTED_DIR,
      paneKey: PANE_A,
      fiveHour: { used_percentage: 61 },
      sevenDay: null
    })

    expect(service.laneStatuslineUsageOf(LANE_A)?.session?.usedPercent).toBe(61)
  })

  // Negative control for the same fixture: with no paneKey there is nothing but the case-sensitive
  // compare, and the post is dropped rather than guessed onto a bar.
  it('drops the same Windows-cased post when it carries no paneKey', async () => {
    const service = await serviceWithLaneA(WIN_LANE_DIR)

    service.ingestLiveClaudeRateLimits({
      configDir: WIN_POSTED_DIR,
      paneKey: null,
      fiveHour: { used_percentage: 61 },
      sevenDay: null
    })

    expect(service.laneStatuslineUsageOf(LANE_A)).toBeNull()
    expect(service.getState().claude?.session?.usedPercent).not.toBe(61)
  })

  // Negative control: the shared lane's own post still drives the host-wide bar.
  it('writes the host-wide bar for a post attributed to the shared lane', async () => {
    const service = await serviceWithLaneA()

    service.ingestLiveClaudeRateLimits({
      configDir: SHARED_DIR,
      paneKey: null,
      fiveHour: { used_percentage: 31 },
      sevenDay: null
    })

    expect(service.getState().claude?.session?.usedPercent).toBe(31)
    expect(service.laneStatuslineUsageOf(LANE_A)).toBeNull()
  })

  it('keeps the other window when a lane post carries only one, and forgets a wiped lane', async () => {
    const service = await serviceWithLaneA()

    service.ingestLiveClaudeRateLimits({
      configDir: LANE_A_DIR,
      paneKey: PANE_A,
      fiveHour: { used_percentage: 61 },
      sevenDay: { used_percentage: 12 }
    })
    service.ingestLiveClaudeRateLimits({
      configDir: LANE_A_DIR,
      paneKey: PANE_A,
      fiveHour: { used_percentage: 70 },
      sevenDay: null
    })

    expect(service.laneStatuslineUsageOf(LANE_A)?.session?.usedPercent).toBe(70)
    expect(service.laneStatuslineUsageOf(LANE_A)?.weekly?.usedPercent).toBe(12)

    // The lane is wiped: its attribution row disappears on the next tick, and so does its usage.
    service.setClaudeLaneAttributionResolver(() => [])
    await (service as unknown as { fetchAll: () => Promise<void> }).fetchAll()

    expect(service.laneStatuslineUsageOf(LANE_A)).toBeNull()
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
      { laneId: LANE_A, configDir: LANE_A_DIR, provenance: `lane:${LANE_A}` }
    ])
    service.setClaudeUsagePaneLaneLookup(() => ({ laneId: LANE_A }))
    await (service as unknown as { fetchAll: () => Promise<void> }).fetchAll()

    service.ingestLiveClaudeRateLimits({
      configDir: LANE_A_DIR,
      paneKey: PANE_A,
      fiveHour: { used_percentage: 12 },
      sevenDay: null
    })

    const provenance = service.laneStatuslineUsageOf(LANE_A)?.usageMetadata?.authProvenance
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

    expect(service.laneStatuslineUsageOf(LANE_A)?.usageMetadata?.authProvenance).toBe(
      `lane:${LABEL_A}`
    )
    expect(service.getState().claude?.session).toBeNull()
  })
})
