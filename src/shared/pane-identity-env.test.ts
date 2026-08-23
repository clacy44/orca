/**
 * S9 §2k/§2m(5) — the probe's pane-identity scrub, which is load-bearing for cross-principal
 * usage attribution now that the posted paneKey is the join key.
 */
import { describe, expect, it } from 'vitest'
import { removeUnspecifiedPaneIdentityEnv } from './pane-identity-env'

describe('removeUnspecifiedPaneIdentityEnv', () => {
  it('drops inherited pane identity in the canonical casing', () => {
    const env = { ORCA_PANE_KEY: 'tab:leaf', ORCA_TAB_ID: 't', PATH: '/usr/bin' }

    removeUnspecifiedPaneIdentityEnv(env, undefined, 'linux')

    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  // The win32 half of the pairing beside `collapseLaneEnvKeys`: Win32 resolves the twin, so an
  // exact-case delete leaves the probe's `claude` posting a STALE paneKey.
  it('drops every casing of an inherited key on win32', () => {
    const env = { Orca_Pane_Key: 'stale-pane', orca_tab_id: 't', PATH: '/usr/bin' }

    removeUnspecifiedPaneIdentityEnv(env, undefined, 'win32')

    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  // Negative control: POSIX casing really is two variables, so only the exact key goes.
  it('keeps a differently-cased key off win32', () => {
    const env = { Orca_Pane_Key: 'not-the-same-variable', ORCA_PANE_KEY: 'stale' }

    removeUnspecifiedPaneIdentityEnv(env, undefined, 'linux')

    expect(env).toEqual({ Orca_Pane_Key: 'not-the-same-variable' })
  })

  it('keeps a key this spawn explicitly supplies, in either casing on win32', () => {
    const env = { ORCA_PANE_KEY: 'mine', Orca_Tab_Id: 'mine-too' }

    removeUnspecifiedPaneIdentityEnv(
      env,
      { ORCA_PANE_KEY: 'mine', ORCA_TAB_ID: 'mine-too' },
      'win32'
    )

    expect(env).toEqual({ ORCA_PANE_KEY: 'mine', Orca_Tab_Id: 'mine-too' })
  })
})
