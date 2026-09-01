import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NO_PANE_IDENTITY_NEXT_STEPS,
  NO_REGISTERED_IDENTITY_NEXT_STEPS,
  resolveCallerAgent
} from './orchestration-caller-identity'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'

describe('NO_PANE_IDENTITY_NEXT_STEPS', () => {
  it('names the automatic reattest retry and the fresh-pane fallback, platform-agnostically', () => {
    expect(NO_PANE_IDENTITY_NEXT_STEPS).toEqual(
      expect.arrayContaining([
        expect.stringContaining('re-attests this pane automatically'),
        expect.stringContaining('relaunch this agent in a fresh Orca pane')
      ])
    )
    for (const step of NO_PANE_IDENTITY_NEXT_STEPS) {
      expect(step).not.toContain('ORCA_AGENT_HOOK_ENDPOINT')
      expect(step).not.toContain('$ORCA_')
      expect(step).not.toContain('%ORCA_')
    }
  })

  it('is frozen so no call site can mutate the shared array', () => {
    expect(Object.isFrozen(NO_PANE_IDENTITY_NEXT_STEPS)).toBe(true)
  })
})

// S10-15 D6/D7: no_pane_identity used to conflate "unattested" with "attested but no agents
// row" — split into two distinct, differently-actionable codes.
describe('NO_REGISTERED_IDENTITY_NEXT_STEPS', () => {
  it('register-first, and says relaunching will not help', () => {
    expect(NO_REGISTERED_IDENTITY_NEXT_STEPS[0]).toContain('orca agents register')
    expect(
      NO_REGISTERED_IDENTITY_NEXT_STEPS.some((step) =>
        step.includes('relaunching it will not help')
      )
    ).toBe(true)
  })

  it('is frozen so no call site can mutate the shared array', () => {
    expect(Object.isFrozen(NO_REGISTERED_IDENTITY_NEXT_STEPS)).toBe(true)
  })
})

describe('S10-15 D7 test 1: resolveCallerAgent splits no_pane_identity vs no_registered_identity', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  afterEach(() => {
    db?.close()
  })

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  }

  it('unattested -> no_pane_identity, with NO_PANE_IDENTITY_NEXT_STEPS unchanged', () => {
    setup()
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue(null)
    expect(() => resolveCallerAgent(db, runtime, undefined)).toThrow(
      expect.objectContaining({
        code: 'no_pane_identity',
        data: { nextSteps: NO_PANE_IDENTITY_NEXT_STEPS }
      })
    )
  })

  it('attested + no agents row -> no_registered_identity, nextSteps[0] starts "orca agents register"', () => {
    setup()
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue({
      paneKey: 'tab:unregistered-pane',
      terminalHandle: 'term_unreg',
      processIncarnation: 'proc-1',
      hostScope: { kind: 'local', hostId: 'local' },
      launchTokenHash: 'hash'
    })
    try {
      resolveCallerAgent(db, runtime, undefined)
      throw new Error('expected resolveCallerAgent to throw')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('no_registered_identity')
      const nextSteps = (error as { data?: { nextSteps?: string[] } }).data?.nextSteps ?? []
      expect(nextSteps[0]).toMatch(/^orca agents register/)
    }
  })
})
