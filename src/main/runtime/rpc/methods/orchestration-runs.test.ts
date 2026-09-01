// S10-18: runCreate/runUse REBIND a pane's current Run. A paired (non-local) caller's
// declared `from` is untrusted; these verbs must refuse before any write unless the caller's
// own evidence independently attests it AS that handle. Local callers (pairedDeviceId
// undefined) and reads keep the pre-existing trust-the-declared-handle behavior.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUN_METHODS } from './orchestration-runs'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityCallerAuthority
} from '../../orca-runtime'
import type { RpcContext } from '../core'

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeAuthority(
  paneKey: string,
  terminalHandle: string
): OrchestrationCompatibilityCallerAuthority {
  return {
    hostScope: { kind: 'local', hostId: 'local' },
    paneKey,
    terminalHandle,
    processIncarnation: 'proc-1',
    launchTokenHash: 'hash'
  }
}

type Evidence = { terminalHandle: string; paneKey: string; launchToken: string }
const evidenceA: Evidence = { terminalHandle: 'term_a', paneKey: PANE_A, launchToken: 'lt-a' }

describe('orchestration.runCreate / orchestration.runUse — S10-18 paired-caller attestation', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_a' ? PANE_A : null
    )
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) => {
      if (
        evidence?.terminalHandle === 'term_a' &&
        evidence.paneKey === PANE_A &&
        evidence.launchToken === evidenceA.launchToken
      ) {
        return makeAuthority(PANE_A, 'term_a')
      }
      return null
    })
  }

  afterEach(() => {
    db?.close()
  })

  function method(name: string) {
    const found = ORCHESTRATION_RUN_METHODS.find((m) => m.name === name)
    if (!found) {
      throw new Error(`method not found: ${name}`)
    }
    return found
  }

  function ctx(extra?: Partial<RpcContext>): RpcContext {
    return { runtime, ...extra }
  }

  async function call(name: string, params: Record<string, unknown>, context: RpcContext) {
    const m = method(name)
    const parsed = m.params ? m.params.parse(params) : undefined
    return m.handler(parsed, context)
  }

  async function refusalCode(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await fn()
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }

  it('(a) a paired caller naming a live local handle with JUNK evidence is refused, no Run created', async () => {
    setup()
    const outcome = await refusalCode(() =>
      call(
        'orchestration.runCreate',
        { objective: 'obj', from: 'term_a' },
        ctx({
          pairedDeviceId: 'device-1',
          orchestrationCompatibilityEvidence: {
            terminalHandle: 'term_a',
            paneKey: PANE_A,
            launchToken: 'not-the-real-token'
          }
        })
      )
    )
    expect(outcome).toBe('no_pane_identity')
    expect(db.getCurrentRunForPane(PANE_A)).toBeUndefined()
  })

  it('(a) a paired caller naming a live local handle with JUNK evidence is refused for runUse, no Run rebound', async () => {
    setup()
    // Seed a real run via a local (unpaired) caller first.
    const created = (await call(
      'orchestration.runCreate',
      { objective: 'obj', from: 'term_a' },
      ctx({
        orchestrationCompatibilityEvidence: evidenceA
      })
    )) as { run: { id: string } }

    const outcome = await refusalCode(() =>
      call(
        'orchestration.runUse',
        { id: created.run.id, from: 'term_a' },
        ctx({
          pairedDeviceId: 'device-1',
          orchestrationCompatibilityEvidence: {
            terminalHandle: 'term_a',
            paneKey: PANE_A,
            launchToken: 'not-the-real-token'
          }
        })
      )
    )
    expect(outcome).toBe('no_pane_identity')
  })

  it('(b) a paired caller with NO evidence is refused', async () => {
    setup()
    const outcome = await refusalCode(() =>
      call(
        'orchestration.runCreate',
        { objective: 'obj', from: 'term_a' },
        ctx({ pairedDeviceId: 'device-1' })
      )
    )
    expect(outcome).toBe('no_pane_identity')
    expect(db.getCurrentRunForPane(PANE_A)).toBeUndefined()
  })

  it('(c) a local caller with no evidence behaves unchanged — Run is created', async () => {
    setup()
    const result = (await call(
      'orchestration.runCreate',
      { objective: 'obj', from: 'term_a' },
      ctx()
    )) as { run: { id: string; coordinator_handle: string } }
    expect(result.run.coordinator_handle).toBe('term_a')
    expect(db.getCurrentRunForPane(PANE_A)?.id).toBe(result.run.id)
  })

  it('a paired caller WITH genuine attesting evidence for the named handle succeeds', async () => {
    setup()
    const result = (await call(
      'orchestration.runCreate',
      { objective: 'obj', from: 'term_a' },
      ctx({
        pairedDeviceId: 'device-1',
        orchestrationCompatibilityEvidence: evidenceA
      })
    )) as { run: { id: string } }
    expect(db.getCurrentRunForPane(PANE_A)?.id).toBe(result.run.id)
  })

  it('(d) a paired caller reading via orchestration.runCurrent with a `from` handle and no evidence still works (trust-argument read path)', async () => {
    setup()
    await call(
      'orchestration.runCreate',
      { objective: 'obj', from: 'term_a' },
      ctx({ orchestrationCompatibilityEvidence: evidenceA })
    )
    const result = (await call(
      'orchestration.runCurrent',
      { from: 'term_a' },
      ctx({ pairedDeviceId: 'device-1' })
    )) as { run: { coordinator_handle: string } | null }
    expect(result.run?.coordinator_handle).toBe('term_a')
  })
})
