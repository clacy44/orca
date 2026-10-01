// Recheck N1/N3: creation-time cuts count only where the walk inspects them; the root's own link counts.
import { describe, expect, it } from 'vitest'
import { collectProcessDescendants } from './process-tree-descendants'

type Row = { pid: number; ppid: number; createdAtMs?: number }

const HEALTHY: Row[] = [
  { pid: 400, ppid: 1, createdAtMs: 100 },
  { pid: 500, ppid: 400, createdAtMs: 200 },
  { pid: 600, ppid: 500, createdAtMs: 300 },
  { pid: 700, ppid: 600, createdAtMs: 400 }
]

describe('creation-time cut scope', () => {
  it('N1: an unrelated stale orphan elsewhere in the table counts as nothing', () => {
    const rows: Row[] = [
      ...HEALTHY,
      // orphan 5000 lost its parent 4999; an unrelated newer process now holds PID 4999.
      { pid: 5000, ppid: 4999, createdAtMs: 50 },
      { pid: 4999, ppid: 1, createdAtMs: 900 }
    ]
    const result = collectProcessDescendants(rows, 600)
    expect(result.descendants.map((d) => d.pid)).toEqual([700])
    expect(result.staleEdgesSkipped).toBe(0)
    expect(result.cycleLength).toBe(0)
  })

  it('N1: a real cycle near the root still counts', () => {
    const rows: Row[] = [
      { pid: 7000, ppid: 6996, createdAtMs: 100 },
      { pid: 400, ppid: 7000, createdAtMs: 200 },
      { pid: 500, ppid: 400, createdAtMs: 300 },
      { pid: 600, ppid: 500, createdAtMs: 400 },
      { pid: 6996, ppid: 600, createdAtMs: 500 },
      { pid: 5000, ppid: 4999, createdAtMs: 50 },
      { pid: 4999, ppid: 1, createdAtMs: 900 }
    ]
    const result = collectProcessDescendants(rows, 600)
    expect(result.descendants.map((d) => d.pid)).toEqual([6996])
    expect(result.staleEdgesSkipped).toBe(1)
    expect(result.cutBy).toBe('creation-time')
  })

  it('N1: an old orphan whose dead parent PID is held by a descendant is kept out and counted', () => {
    const rows: Row[] = [
      ...HEALTHY,
      { pid: 5000, ppid: 700, createdAtMs: 10 } // older than its claimed parent 700
    ]
    const result = collectProcessDescendants(rows, 600)
    expect(result.descendants.map((d) => d.pid)).toEqual([700])
    expect(result.staleEdgesSkipped).toBe(1)
    expect(result.cutBy).toBe('creation-time')
  })

  it("N3: a cut on the root's own parent link is counted and labelled creation-time", () => {
    const rows: Row[] = [
      { pid: 600, ppid: 6996, createdAtMs: 100 },
      { pid: 6996, ppid: 600, createdAtMs: 500 }
    ]
    const result = collectProcessDescendants(rows, 600)
    expect(result.descendants.map((d) => d.pid)).toEqual([6996])
    expect(result.staleEdgesSkipped).toBe(1)
    expect(result.cutBy).toBe('creation-time')
    expect(result.cutIndex).toBe(0)
  })
})
