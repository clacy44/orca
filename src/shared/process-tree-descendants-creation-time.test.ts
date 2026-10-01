// F1 (G1): with creation times the PID-reuse cycle is cut exactly; the midpoint guess is only the
// fallback for edges that lack them.
import { describe, expect, it } from 'vitest'
import { collectProcessDescendants } from './process-tree-descendants'

type Row = { pid: number; ppid: number; createdAtMs?: number }

describe('collectProcessDescendants with creation times', () => {
  it("(a) A=3: a holder of explorer's dead parent PID does not pull explorer's subtree in", () => {
    // explorer(7000) lost its parent 6996; claude was later handed PID 6996.
    const rows: Row[] = [
      { pid: 7000, ppid: 6996, createdAtMs: 100 },
      { pid: 910, ppid: 7000, createdAtMs: 110 }, // chrome, explorer's child
      { pid: 920, ppid: 910, createdAtMs: 120 },
      { pid: 400, ppid: 7000, createdAtMs: 200 }, // main
      { pid: 500, ppid: 400, createdAtMs: 300 }, // daemon
      { pid: 600, ppid: 500, createdAtMs: 400 }, // shell
      { pid: 6996, ppid: 600, createdAtMs: 500 }, // claude
      { pid: 800, ppid: 6996, createdAtMs: 600 } // hook
    ]
    const result = collectProcessDescendants(rows, 600)
    expect(result.descendants.map((d) => d.pid).sort((a, b) => a - b)).toEqual([800, 6996])
    expect(result.staleEdgesSkipped).toBe(1)
    expect(result.cutBy).toBe('creation-time')
    expect(result.cycleLength).toBe(5)
    expect(result.cutIndex).toBe(3)
  })

  it('(b) A=1: a depth-2 agent holding the dead main PID is not dropped', () => {
    // daemon(500) outlived main(400); node claude later got PID 400.
    const rows: Row[] = [
      { pid: 500, ppid: 400, createdAtMs: 100 },
      { pid: 600, ppid: 500, createdAtMs: 200 },
      { pid: 700, ppid: 600, createdAtMs: 300 }, // cmd
      { pid: 400, ppid: 700, createdAtMs: 400 } // node claude
    ]
    const result = collectProcessDescendants(rows, 600)
    expect(result.descendants.map((d) => d.pid).sort((a, b) => a - b)).toEqual([400, 700])
    expect(result.staleEdgesSkipped).toBe(1)
    expect(result.cutBy).toBe('creation-time')
    expect(result.cutIndex).toBe(1)
  })

  it('falls back to the midpoint split when creation times are missing', () => {
    const rows: Row[] = [
      { pid: 7000, ppid: 6996 },
      { pid: 400, ppid: 7000 },
      { pid: 500, ppid: 400 },
      { pid: 600, ppid: 500 },
      { pid: 700, ppid: 600 },
      { pid: 6996, ppid: 700 }
    ]
    const result = collectProcessDescendants(rows, 600)
    expect(result.descendants.map((d) => d.pid).sort((a, b) => a - b)).toEqual([700, 6996])
    expect(result.cutBy).toBe('midpoint')
    expect(result.cycleLength).toBe(6)
    expect(result.cutIndex).toBe(3)
  })

  it('leaves an acyclic table with consistent creation times untouched', () => {
    const rows: Row[] = [
      { pid: 1, ppid: 0, createdAtMs: 1 },
      { pid: 2, ppid: 1, createdAtMs: 2 },
      { pid: 3, ppid: 2, createdAtMs: 3 }
    ]
    const result = collectProcessDescendants(rows, 1)
    expect(result.descendants.map((d) => [d.pid, d.depth])).toEqual([
      [2, 1],
      [3, 2]
    ])
    expect(result.staleEdgesSkipped).toBe(0)
  })
})
