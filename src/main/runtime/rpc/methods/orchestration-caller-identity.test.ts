import { describe, expect, it } from 'vitest'
import { NO_PANE_IDENTITY_NEXT_STEPS } from './orchestration-caller-identity'

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
