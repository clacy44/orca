// S10-22a WAVE 2 (Wave 2 contract A7): restore, export and succession-confirm
// (chair-succession-accept.ts's `writeManifestLastSessionId`) must share ONE `withPaneLock` key,
// `chairs-manifest:<host>` — proven here at the lock primitive itself (chairs-restore.ts and
// chairs-succession.ts are exercised end to end elsewhere; this isolates the serialization
// contract without a full RPC/runtime double).
import { describe, expect, it } from 'vitest'
import { withPaneLock } from '../../../ipc/agent-launch-admission-lock'

describe('A7: chairs-manifest:<host> lock serializes a restore-style write against a succession-style write', () => {
  it("the second caller on the same key sees the first write's result", async () => {
    const key = 'chairs-manifest:test-host'
    let manifestLastSessionId: string | null = null
    const order: string[] = []

    // Mirrors chairs-restore.ts's restore handler: read -> compute -> write, all under the lock.
    const restoreWrite = withPaneLock(key, async () => {
      order.push('restore:start')
      const before = manifestLastSessionId
      await new Promise((resolve) => setTimeout(resolve, 20))
      manifestLastSessionId = 'sess-from-restore'
      order.push('restore:end')
      return before
    })

    // Mirrors chair-succession-accept.ts's writeManifestLastSessionId, on the SAME key.
    const successionWrite = withPaneLock(key, async () => {
      order.push('succession:start')
      const seenBeforeSuccession = manifestLastSessionId
      manifestLastSessionId = 'sess-from-succession'
      order.push('succession:end')
      return seenBeforeSuccession
    })

    const [restoreResult, successionResult] = await Promise.all([restoreWrite, successionWrite])

    // FIFO — restore was submitted first, so it fully completes before succession starts.
    expect(order).toEqual(['restore:start', 'restore:end', 'succession:start', 'succession:end'])
    expect(restoreResult).toBeNull()
    expect(successionResult).toBe('sess-from-restore')
    expect(manifestLastSessionId).toBe('sess-from-succession')
  })
})
