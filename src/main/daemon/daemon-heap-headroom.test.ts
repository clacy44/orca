// D-R164 M1: sizing table for the daemon fork's --max-old-space-size, mirroring
// renderer-heap-headroom.test.ts's shape. No "disable below min RAM" case here — see the file
// header comment for why the daemon always returns a bound.
import { describe, expect, it } from 'vitest'
import { computeDaemonHeapCeilingMb } from './daemon-heap-headroom'

const GIB = 1024 * 1024 * 1024

describe('computeDaemonHeapCeilingMb', () => {
  it('floors at 3072 on low-RAM machines instead of going unbounded', () => {
    expect(computeDaemonHeapCeilingMb(2 * GIB)).toBe(3072)
    expect(computeDaemonHeapCeilingMb(4 * GIB)).toBe(3072) // 0.4*4 -> 1638 -> floored
    expect(computeDaemonHeapCeilingMb(7.5 * GIB)).toBe(3072)
  })

  it('raises the ceiling toward the 4096 pointer-compression cage, floored and capped', () => {
    expect(computeDaemonHeapCeilingMb(8 * GIB)).toBe(3276) // 0.4*8*1024 = 3276.8 -> floor(3276)
    expect(computeDaemonHeapCeilingMb(12 * GIB)).toBe(4096) // 0.4*12 -> 4915 -> capped
    expect(computeDaemonHeapCeilingMb(16 * GIB)).toBe(4096) // cage cap
    expect(computeDaemonHeapCeilingMb(128 * GIB)).toBe(4096) // cage cap, never higher
  })

  it('honors a positive ORCA_DAEMON_HEAP_MB override regardless of RAM', () => {
    expect(computeDaemonHeapCeilingMb(2 * GIB, '5000')).toBe(5000)
    expect(computeDaemonHeapCeilingMb(128 * GIB, '2048')).toBe(2048)
  })

  it('falls through to RAM tiers for a non-positive/blank/invalid override', () => {
    expect(computeDaemonHeapCeilingMb(16 * GIB, '0')).toBe(4096)
    expect(computeDaemonHeapCeilingMb(16 * GIB, '-1')).toBe(4096)
    expect(computeDaemonHeapCeilingMb(16 * GIB, '')).toBe(4096)
    expect(computeDaemonHeapCeilingMb(16 * GIB, 'abc')).toBe(4096)
  })

  it('floors at 3072 for a non-finite / non-positive RAM reading', () => {
    expect(computeDaemonHeapCeilingMb(Number.NaN)).toBe(3072)
    expect(computeDaemonHeapCeilingMb(0)).toBe(3072)
  })
})
