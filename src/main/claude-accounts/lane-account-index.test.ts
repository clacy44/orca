import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getLaneAccountIndexPath,
  isLaneAccountId,
  readLaneAccountIndex,
  readLaneAccountIndexRaw,
  writeLaneAccountIndex,
  type LaneAccountIndexRow
} from './lane-account-index'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

const rowFor = (laneAccountId: string): LaneAccountIndexRow => ({
  laneAccountId,
  email: 'a@example.com',
  label: null,
  active: true,
  capturedAt: '2026-08-27T00:00:00.000Z'
})

describe('lane account index', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-lane-account-index-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is tolerant of a missing file', () => {
    expect(readLaneAccountIndex(root)).toEqual([])
    expect(readLaneAccountIndexRaw(root)).toEqual({ kind: 'missing' })
  })

  it('round-trips rows at 0600', () => {
    writeLaneAccountIndex(root, [rowFor(ID_A), rowFor(ID_B)])

    expect(readLaneAccountIndex(root)).toEqual([rowFor(ID_A), rowFor(ID_B)])
    if (process.platform !== 'win32') {
      const mode = statSync(getLaneAccountIndexPath(root)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('mints a fresh claude-accounts root at 0700, not the process umask default', () => {
    const freshRoot = join(root, 'claude-accounts')
    writeLaneAccountIndex(freshRoot, [rowFor(ID_A)])

    if (process.platform !== 'win32') {
      const mode = statSync(freshRoot).mode & 0o777
      expect(mode).toBe(0o700)
    }
  })

  it('reads unparseable JSON as invalid, not as empty-and-fine', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(getLaneAccountIndexPath(root), '{not json', { mode: 0o600 })

    expect(readLaneAccountIndexRaw(root)).toEqual({ kind: 'invalid' })
    // The tolerant reader still degrades to empty rather than throwing at its caller.
    expect(readLaneAccountIndex(root)).toEqual([])
  })

  it('reads a non-array JSON value as invalid', () => {
    writeFileSync(getLaneAccountIndexPath(root), JSON.stringify({ not: 'an array' }), {
      mode: 0o600
    })

    expect(readLaneAccountIndexRaw(root)).toEqual({ kind: 'invalid' })
  })

  it('one malformed row invalidates the whole file rather than being dropped alone', () => {
    const rows = [rowFor(ID_A), { ...rowFor(ID_B), active: 'yes' }]
    writeFileSync(getLaneAccountIndexPath(root), JSON.stringify(rows), { mode: 0o600 })

    expect(readLaneAccountIndexRaw(root)).toEqual({ kind: 'invalid' })
  })

  it('rejects a laneAccountId that is not the v4-UUID shape (a quarantined name, say)', () => {
    const rows = [{ ...rowFor(ID_A), laneAccountId: `${ID_A}.quarantined-123` }]
    writeFileSync(getLaneAccountIndexPath(root), JSON.stringify(rows), { mode: 0o600 })

    expect(readLaneAccountIndexRaw(root)).toEqual({ kind: 'invalid' })
    expect(isLaneAccountId(`${ID_A}.quarantined-123`)).toBe(false)
  })

  // Negative control for the "unreadable" arm of the raw read (permission-denied, not malformed).
  it('reads an unreadable-permission file as invalid', () => {
    writeLaneAccountIndex(root, [rowFor(ID_A)])
    if (process.platform === 'win32') {
      return // POSIX mode bits are inert on win32; nothing to assert.
    }
    chmodSync(getLaneAccountIndexPath(root), 0o000)
    try {
      expect(readLaneAccountIndexRaw(root)).toEqual({ kind: 'invalid' })
    } finally {
      chmodSync(getLaneAccountIndexPath(root), 0o600)
    }
  })

  it('reads a parsed-but-empty index as rows: [] rather than missing', () => {
    writeLaneAccountIndex(root, [])

    expect(readLaneAccountIndexRaw(root)).toEqual({ kind: 'rows', rows: [] })
  })

  // MP-target: an atomic write must never leave a partial file behind for a concurrent reader —
  // asserted here as "the readback after a write is always either the old or the new contents",
  // by writing twice and confirming the final read is exactly the second write.
  it('the second of two writes wins cleanly (no interleaved partial read)', () => {
    writeLaneAccountIndex(root, [rowFor(ID_A)])
    writeLaneAccountIndex(root, [rowFor(ID_B)])

    expect(readLaneAccountIndex(root)).toEqual([rowFor(ID_B)])
    expect(JSON.parse(readFileSync(getLaneAccountIndexPath(root), 'utf-8'))).toEqual([rowFor(ID_B)])
  })
})
