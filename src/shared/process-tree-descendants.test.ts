import { describe, expect, it } from 'vitest'
import { collectProcessDescendants } from './process-tree-descendants'

type Row = { pid: number; ppid: number }

describe('collectProcessDescendants', () => {
  it('keeps depth-first order and depths on an acyclic tree', () => {
    const rows: Row[] = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 1 },
      { pid: 4, ppid: 2 },
      { pid: 5, ppid: 4 }
    ]
    const { descendants, staleEdgesSkipped } = collectProcessDescendants(rows, 1)
    expect(descendants.map((d) => [d.pid, d.depth])).toEqual([
      [3, 1],
      [2, 1],
      [4, 2],
      [5, 3]
    ])
    expect(staleEdgesSkipped).toBe(0)
  })

  it('returns nothing for a root with no children or an absent root', () => {
    expect(collectProcessDescendants([{ pid: 2, ppid: 1 }], 2).descendants).toEqual([])
    expect(collectProcessDescendants([{ pid: 2, ppid: 1 }], 99).descendants).toEqual([])
  })

  it('splits a cycle through the root at the midpoint and counts one stale edge', () => {
    const rows: Row[] = [
      { pid: 7000, ppid: 6996 },
      { pid: 400, ppid: 7000 },
      { pid: 500, ppid: 400 },
      { pid: 600, ppid: 500 },
      { pid: 700, ppid: 600 },
      { pid: 6996, ppid: 700 }
    ]
    const { descendants, staleEdgesSkipped } = collectProcessDescendants(rows, 600)
    expect(descendants.map((d) => d.pid).sort((a, b) => a - b)).toEqual([700, 6996])
    expect(staleEdgesSkipped).toBe(1)
  })

  it('terminates on a cycle that does not include the root, bounded by the row count', () => {
    const rows: Row[] = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 10, ppid: 11 }
    ]
    const { descendants, staleEdgesSkipped } = collectProcessDescendants(rows, 1)
    expect(descendants.length).toBeLessThanOrEqual(rows.length)
    expect(staleEdgesSkipped).toBeGreaterThanOrEqual(1)
  })

  it('never returns more rows than the table holds on a fully self-referential table', () => {
    const rows: Row[] = Array.from({ length: 50 }, (_, i) => ({
      pid: i + 1,
      ppid: ((i + 1) % 50) + 1
    }))
    const { descendants } = collectProcessDescendants(rows, 1)
    expect(descendants.length).toBeLessThanOrEqual(rows.length)
  })
})
