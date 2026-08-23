import { describe, expect, it } from 'vitest'
import { MAX_CLAUDE_LANE_WATERMARKS, normalizeClaudeLaneWatermarks } from './claude-lane-watermark'

const sha = 'a'.repeat(64)

describe('claude lane watermark normalization', () => {
  it('keeps a well-formed row verbatim', () => {
    expect(
      normalizeClaudeLaneWatermarks([
        {
          laneId: 'lane-1',
          identity: { accountUuid: 'acc', email: 'a@b.c', organizationUuid: 'org' },
          refreshTokenSha256: sha,
          expiresAt: 10
        }
      ])
    ).toEqual([
      {
        laneId: 'lane-1',
        identity: { accountUuid: 'acc', email: 'a@b.c', organizationUuid: 'org' },
        refreshTokenSha256: sha,
        expiresAt: 10,
        // Absent on an old row and on every row written before the hold existed: no hold.
        reauthRequired: false
      }
    ])
  })

  it('reads the reauth hold only from a literal true, so a corrupt row strands no lane', () => {
    const rows = normalizeClaudeLaneWatermarks([
      { laneId: 'held', identity: {}, reauthRequired: true },
      { laneId: 'truthy', identity: {}, reauthRequired: 'yes' },
      { laneId: 'absent', identity: {} }
    ])
    expect(rows.map((row) => row.reauthRequired)).toEqual([true, false, false])
  })

  it('drops a sha that is not one rather than comparing a push against it', () => {
    const [row] = normalizeClaudeLaneWatermarks([
      { laneId: 'lane-1', identity: {}, refreshTokenSha256: 'not-a-digest', expiresAt: 'soon' }
    ])
    expect(row?.refreshTokenSha256).toBeNull()
    expect(row?.expiresAt).toBeNull()
    expect(row?.identity).toEqual({ accountUuid: null, email: null, organizationUuid: null })
  })

  it.each([
    ['a non-array payload', { laneId: 'lane-1' } as unknown],
    ['a null entry', [null]],
    ['an entry with no lane id', [{ identity: {} }]],
    ['an entry with a non-object identity', [{ laneId: 'lane-1', identity: [] }]]
  ])('refuses %s', (_label, value) => {
    expect(normalizeClaudeLaneWatermarks(value)).toEqual([])
  })

  it('keeps one row per lane and bounds the list', () => {
    const rows = Array.from({ length: MAX_CLAUDE_LANE_WATERMARKS + 5 }, (_unused, index) => ({
      laneId: `lane-${index}`,
      identity: {},
      refreshTokenSha256: sha,
      expiresAt: index
    }))
    expect(normalizeClaudeLaneWatermarks(rows)).toHaveLength(MAX_CLAUDE_LANE_WATERMARKS)
    expect(
      normalizeClaudeLaneWatermarks([
        { laneId: 'lane-1', identity: {}, refreshTokenSha256: sha, expiresAt: 1 },
        { laneId: 'lane-1', identity: {}, refreshTokenSha256: sha, expiresAt: 2 }
      ])
    ).toHaveLength(1)
  })
})
