// S10-21a C3-v2 (Ruling 34 Addendum 13): test-only fixture helper. Every `pty.test.ts` /
// `lane-pinned-spawn.test.ts` runtime stub that constructs a covered (`claude`) launch now needs
// `getOrchestrationDb()` to reach admission's HOST_MINTED/UNRECORDED/SELF_RESUME paths instead of
// refusing `launch_store_unavailable` — a dependency those fixtures predate. This is the ONE
// shared helper the ~30 call sites use, backed by the SAME real in-memory OrchestrationDb
// construction agent-launch-sessions.test.ts / agent-directory tests already use, rather than a
// hand-rolled store mock.
//
// Why a plain object with an enumerated default list, NOT a Proxy: pty.ts gates several runtime
// methods with `typeof runtime.foo === 'function'` duck-typing (`resolveTerminalPane` at
// `resolveStablePaneOwner`, pty.ts:707) — a catch-all Proxy makes EVERY property look callable,
// which flips those guards on and activates code paths (stable-pane resolution, etc.) this
// fixture never intended to exercise. A plain object correctly leaves an unlisted property
// `undefined`, so `typeof` guards and double-optional (`runtime?.foo?.()`) call sites behave
// exactly as they did when `runtime` was `undefined` outright.
//
// The list below covers exactly the SINGLE-optional (`runtime?.foo(`) and unguarded-non-optional
// (`runtime.foo(`) call sites pty.ts's spawn path reaches unconditionally — found by grepping
// `runtime\?\.[a-zA-Z]+\(` (excluding ones ALSO reachable via `?.` on the call, which are already
// no-op-safe) and `[^.?a-zA-Z]runtime\.[a-zA-Z]+\(` (excluding ones behind a `typeof` guard).
import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from '../runtime/orchestration/db'

function noOpRuntimeDefaults(): Record<string, (...args: unknown[]) => undefined> {
  const names = [
    // Single-optional (`runtime?.foo(`), not also `?.`-guarded on the call itself.
    'clearHeadlessTerminalBuffer',
    'emitDaemonPtyTransientFact',
    'getDriver',
    'getPtyOutputSequence',
    'isResizeSuppressed',
    'notePtyDataGap',
    'notifyPtyProviderTransportDisconnected',
    'onExternalPtyResize',
    'onPtyData',
    'onPtyExit',
    'onPtySpawned',
    'preAllocateHandleForPty',
    'recordRemoteDesktopHostReclaimTarget',
    'recordRendererGeometry',
    'registerPreAllocatedHandleForPty',
    'registerPty',
    'resetPtyModelAfterMigrationFailure',
    'setPtyController',
    'setPtyTransientFactDelegation',
    // Non-optional (`runtime.foo(`), NOT behind a `typeof runtime.foo === 'function'` guard —
    // `resolveTerminalPane` is deliberately excluded; it IS such a guard and must stay absent.
    'createPreAllocatedTerminalHandle'
  ]
  const defaults: Record<string, (...args: unknown[]) => undefined> = {}
  for (const name of names) {
    defaults[name] = () => undefined
  }
  return defaults
}

export function makeRuntimeStubWithStore<T extends Record<string, unknown>>(
  partial?: T
): T & { getOrchestrationDb: () => OrchestrationDb; getLaunchGenerationId: () => string } {
  const store = new OrchestrationDb(':memory:')
  // S10-21a C3-v2c (errata 5(o)): one id per stub construction, same "one per instance" contract
  // as `OrcaRuntimeService`'s own `launchGenerationId`.
  const launchGenerationId = randomUUID()
  return {
    ...noOpRuntimeDefaults(),
    ...(partial ?? ({} as T)),
    getOrchestrationDb: () => store,
    getLaunchGenerationId: () => launchGenerationId
  }
}
