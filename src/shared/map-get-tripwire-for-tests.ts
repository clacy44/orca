import { vi } from 'vitest'

export const MAP_GET_TRIPWIRE_LIMIT = 100_000

export type MapGetTripwire = { readonly tripped: boolean; readonly calls: number; restore(): void }

// Why: a runaway tree walk never returns; a throwing Map#get turns it into a fast, deterministic failure.
export function installMapGetTripwire(limit: number = MAP_GET_TRIPWIRE_LIMIT): MapGetTripwire {
  let calls = 0
  let tripped = false
  const original = Map.prototype.get
  const spy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown
  ) {
    calls += 1
    if (calls > limit) {
      tripped = true
      throw new Error(`Map#get tripwire: more than ${limit} calls`)
    }
    return original.call(this, key)
  })
  return {
    get tripped() {
      return tripped
    },
    get calls() {
      return calls
    },
    restore: () => spy.mockRestore()
  }
}
