// S10-21a C3-v2c (errata 5(p) v2.1 §D "R5"). Compile-time check: `ensureAgentSession`'s new
// third (`internal`) parameter carries `restoreProvenance` only to in-process callers — it must
// never be reachable through `RuntimeEnsureAgentSessionRequest`, the wire-adjacent request type
// the RPC handler (`rpc/methods/agent-session.ts`) decodes. If a future edit adds a
// `restoreProvenance`/`internal` field to that type, this file fails to type-check.
import { describe, expect, it } from 'vitest'
import type { RuntimeEnsureAgentSessionRequest } from '../../shared/agent-session-host-authority'

type RequestKeys = keyof Extract<RuntimeEnsureAgentSessionRequest, { kind: 'explicit' }>
type AutomaticRequestKeys = keyof Extract<RuntimeEnsureAgentSessionRequest, { kind: 'automatic' }>

// `true` iff `'restoreProvenance'`/`'internal'` is NOT a key of either request shape.
type AssertAbsent<K extends string> = K extends RequestKeys | AutomaticRequestKeys ? never : true

const _restoreProvenanceAbsent: AssertAbsent<'restoreProvenance'> = true
const _internalAbsent: AssertAbsent<'internal'> = true

describe('ensureAgentSession internal param (compile-time fence)', () => {
  it('RuntimeEnsureAgentSessionRequest carries neither restoreProvenance nor internal', () => {
    // The assertion is the module compiling at all; this just gives the fence a test to live in.
    expect(_restoreProvenanceAbsent).toBe(true)
    expect(_internalAbsent).toBe(true)
  })
})
