import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchAdmissionRefusedError } from '../ipc/agent-launch-admission-errors'
import type { HostElevatedRefusedError } from '../ipc/agent-launch-admission-errors'
import type {
  DaemonIntegrityReport,
  ProcessIntegrityLevel
} from '../../shared/host-integrity-types'
import {
  assertHostIntegrityAllowsAgentLaunch,
  classifyDaemonIntegrity,
  configureHostIntegrityForTests,
  DAEMON_UNREPORTED_SENTENCE,
  hostIntegrityBlocker,
  hostIntegrityOverrideSentence,
  hostIntegrityRefusalSentence,
  isHostIntegrityBlockedForAgentProcesses,
  readRuntimeHostIntegrity,
  recordHostIntegrityStartupObservation,
  resetHostIntegrityForTests,
  startHostIntegrityDetection
} from './host-integrity-guard'
import type { IntegrityProbe } from './windows-integrity-level'

function probeOf(level: IntegrityProbe['level']): () => Promise<IntegrityProbe> {
  return async () => ({ level, detail: 'test' })
}

describe('startHostIntegrityDetection', () => {
  afterEach(() => resetHostIntegrityForTests())

  it('is idempotent: the probe is called exactly once across repeated calls', async () => {
    const probe = vi
      .fn()
      .mockResolvedValue({ level: 'medium', detail: 'x' } satisfies IntegrityProbe)
    configureHostIntegrityForTests({ probe })
    await startHostIntegrityDetection({ ORCA_ALLOW_ELEVATED: '1' })
    await startHostIntegrityDetection({ ORCA_ALLOW_ELEVATED: '0' })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('N4 (kills M2b): a later env change cannot switch the override on', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    await startHostIntegrityDetection({})
    await startHostIntegrityDetection({ ORCA_ALLOW_ELEVATED: '1' })
    const db = { writeAgentAudit: vi.fn() }
    await expect(
      assertHostIntegrityAllowsAgentLaunch({
        includeDaemon: false,
        agent: 'claude',
        paneKey: null,
        hostId: 'local',
        via: 'admission',
        recordOverride: true,
        getDb: () => db
      })
    ).rejects.toThrow(LaunchAdmissionRefusedError)
  })

  it.each(['true', ' 1'])("'%s' does not override", async (value) => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const db = { writeAgentAudit: vi.fn() }
    await startHostIntegrityDetection({ ORCA_ALLOW_ELEVATED: value })
    await expect(
      assertHostIntegrityAllowsAgentLaunch({
        includeDaemon: false,
        agent: 'claude',
        paneKey: null,
        hostId: 'local',
        via: 'admission',
        recordOverride: true,
        getDb: () => db
      })
    ).rejects.toThrow(LaunchAdmissionRefusedError)
  })
})

describe('resetHostIntegrityForTests', () => {
  afterEach(() => resetHostIntegrityForTests())

  it("T3: reset restores the configured default probe (the vitest setupFile's, not the real probe)", async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    resetHostIntegrityForTests()
    const result = await startHostIntegrityDetection()
    expect(result.level).toBe('n/a')
    // N10 (kills R7): the detail pins the vitest setupFile's probe, not the real one -- both
    // report 'n/a' on Linux, so the level alone does not discriminate a reset gone wrong.
    expect(result.detail).toBe('vitest default')
  })

  it('T3: the usage gate ignores the daemon (medium main + high daemon -> not blocked) (A5)', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium'), env: {}, daemon: () => 'high' })
    await startHostIntegrityDetection()
    expect(isHostIntegrityBlockedForAgentProcesses()).toBe(false)
  })
})

describe('hostIntegrityBlocker', () => {
  it.each<[ProcessIntegrityLevel, DaemonIntegrityReport | null, boolean, 'main' | 'daemon' | null]>(
    [
      ['high', null, true, 'main'],
      ['unknown', null, true, 'main'],
      ['low', null, true, 'main'],
      ['medium', 'high', true, 'daemon'],
      ['medium', 'high', false, null],
      ['medium', 'low', true, 'daemon'],
      ['medium', 'unknown', true, 'daemon'],
      ['medium', 'unreported', true, null],
      ['medium', 'inherited', true, null]
    ]
  )('main=%s daemon=%s includeDaemon=%s -> %s', (main, daemon, includeDaemon, expected) => {
    const result = hostIntegrityBlocker(main, daemon, includeDaemon)
    expect(result?.source ?? null).toBe(expected)
  })
})

describe('classifyDaemonIntegrity', () => {
  it('a nonce in the set -> inherited, even when the report is high', () => {
    expect(
      classifyDaemonIntegrity({ launchNonce: 'n1', integrityLevel: 'high' }, new Set(['n1']))
    ).toBe('inherited')
  })

  it('otherwise the report', () => {
    expect(
      classifyDaemonIntegrity({ launchNonce: 'n2', integrityLevel: 'high' }, new Set(['n1']))
    ).toBe('high')
  })

  it('no report -> unreported', () => {
    expect(classifyDaemonIntegrity({ launchNonce: 'n2' }, new Set())).toBe('unreported')
  })

  it('null identity -> unreported', () => {
    expect(classifyDaemonIntegrity(null, new Set())).toBe('unreported')
  })
})

describe('assertHostIntegrityAllowsAgentLaunch', () => {
  beforeEach(() => resetHostIntegrityForTests())
  afterEach(() => resetHostIntegrityForTests())

  it('main high, no override: throws HostElevatedRefusedError, instanceof LaunchAdmissionRefusedError', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const writeAgentAudit = vi.fn()
    let caught: unknown
    try {
      await assertHostIntegrityAllowsAgentLaunch({
        includeDaemon: false,
        agent: 'claude',
        paneKey: 'tab1:leaf-a',
        hostId: 'local',
        via: 'admission',
        recordOverride: true,
        getDb: () => ({ writeAgentAudit })
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LaunchAdmissionRefusedError)
    const err = caught as HostElevatedRefusedError
    expect(err.code).toBe('host_elevated_refused')
    expect(err.reasonCode).toBe('host_elevated_refused')
    expect(err.data.source).toBe('main')
    expect(writeAgentAudit).toHaveBeenCalledTimes(1)
    const row = writeAgentAudit.mock.calls[0][0]
    expect(row.outcome).toBe('refused')
    expect(row.reasonCode).toContain('main=high daemon=none agent=claude via=admission')
  })

  it('recordOverride:true resolves and writes one allowed_by_override row', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high'), env: { ORCA_ALLOW_ELEVATED: '1' } })
    const writeAgentAudit = vi.fn()
    await assertHostIntegrityAllowsAgentLaunch({
      includeDaemon: false,
      agent: 'claude',
      paneKey: null,
      hostId: 'local',
      via: 'admission',
      recordOverride: true,
      getDb: () => ({ writeAgentAudit })
    })
    expect(writeAgentAudit).toHaveBeenCalledTimes(1)
    expect(writeAgentAudit.mock.calls[0][0].outcome).toBe('allowed_by_override')
  })

  it('recordOverride:false resolves and writes no row', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high'), env: { ORCA_ALLOW_ELEVATED: '1' } })
    const writeAgentAudit = vi.fn()
    await assertHostIntegrityAllowsAgentLaunch({
      includeDaemon: false,
      agent: 'claude',
      paneKey: null,
      hostId: 'local',
      via: 'create_agent_session',
      recordOverride: false,
      getDb: () => ({ writeAgentAudit })
    })
    expect(writeAgentAudit).not.toHaveBeenCalled()
  })

  it('a writer that throws still leads to the refusal throw', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const writeAgentAudit = vi.fn(() => {
      throw new Error('db gone')
    })
    await expect(
      assertHostIntegrityAllowsAgentLaunch({
        includeDaemon: false,
        agent: 'claude',
        paneKey: null,
        hostId: 'local',
        via: 'admission',
        recordOverride: true,
        getDb: () => ({ writeAgentAudit })
      })
    ).rejects.toMatchObject({ code: 'host_elevated_refused' })
  })

  it('POSIX (n/a) resolves and getDb is never called', async () => {
    configureHostIntegrityForTests({ probe: probeOf('n/a') })
    const getDb = vi.fn()
    await assertHostIntegrityAllowsAgentLaunch({
      includeDaemon: false,
      agent: 'claude',
      paneKey: null,
      hostId: 'local',
      via: 'admission',
      recordOverride: true,
      getDb
    })
    expect(getDb).not.toHaveBeenCalled()
  })
})

describe('readRuntimeHostIntegrity', () => {
  beforeEach(() => resetHostIntegrityForTests())
  afterEach(() => resetHostIntegrityForTests())

  it('n/a -> undefined', async () => {
    configureHostIntegrityForTests({ probe: probeOf('n/a') })
    expect(await readRuntimeHostIntegrity()).toBeUndefined()
  })

  it('medium with no daemon', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium') })
    expect(await readRuntimeHostIntegrity()).toEqual({
      level: 'medium',
      main: 'medium',
      elevationAllowed: false,
      agentLaunch: 'allowed'
    })
  })

  it('high -> refused with the exact refusal sentence', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const view = await readRuntimeHostIntegrity()
    expect(view?.agentLaunch).toBe('refused')
    expect(view?.warning).toBe(hostIntegrityRefusalSentence('main', 'high'))
  })

  it('high with override -> allowed with the override sentence', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high'), env: { ORCA_ALLOW_ELEVATED: '1' } })
    const view = await readRuntimeHostIntegrity()
    expect(view?.agentLaunch).toBe('allowed')
    expect(view?.warning).toBe(hostIntegrityOverrideSentence('main', 'high'))
  })

  it('medium with daemon unreported', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium'), daemon: () => 'unreported' })
    const view = await readRuntimeHostIntegrity()
    expect(view?.daemon).toBe('unreported')
    expect(view?.warning).toBe(DAEMON_UNREPORTED_SENTENCE)
  })

  it('medium with daemon inherited', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium'), daemon: () => 'inherited' })
    const view = await readRuntimeHostIntegrity()
    expect(view?.daemon).toBe('medium')
    expect(view?.warning).toBeUndefined()
  })

  it('N4 (kills MG4): reports the worse of main and daemon (medium main, high daemon -> high)', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium'), daemon: () => 'high' })
    const view = await readRuntimeHostIntegrity()
    expect(view?.level).toBe('high')
    expect(view?.main).toBe('medium')
    expect(view?.daemon).toBe('high')
  })
})

// N3 (G1-10z3-attacker): the design's literal sentences (R266 design Q2 "Sentences"), copied by
// hand here rather than compared against the module's own builders — a mutant that rewrites the
// wording (M-sentence-drift) still calls these exports, so only a hand-copied literal catches it.
describe('T3: literal contract sentences (R266 design Q2)', () => {
  it('main refusal sentences (high/low/unknown)', () => {
    expect(hostIntegrityRefusalSentence('main', 'high')).toBe(
      "Orca's main process is running elevated (High integrity), so new agent sessions are refused. Relaunch Orca normally from the Start menu (not from an elevated shell), or set ORCA_ALLOW_ELEVATED=1 to allow them."
    )
    expect(hostIntegrityRefusalSentence('main', 'low')).toBe(
      "Orca's main process is running at Low integrity, so new agent sessions are refused. Relaunch Orca normally from the Start menu (not from an elevated shell), or set ORCA_ALLOW_ELEVATED=1 to allow them."
    )
    expect(hostIntegrityRefusalSentence('main', 'unknown')).toBe(
      "Orca's main process is running at an integrity level Orca could not verify, so new agent sessions are refused. Relaunch Orca normally from the Start menu (not from an elevated shell), or set ORCA_ALLOW_ELEVATED=1 to allow them."
    )
  })

  it('daemon refusal sentences (high/low/unknown)', () => {
    expect(hostIntegrityRefusalSentence('daemon', 'high')).toBe(
      "Orca's terminal daemon is running elevated (High integrity), so new agent sessions are refused. Restart the terminal daemon from this non-elevated Orca (Manage Sessions → Restart), or set ORCA_ALLOW_ELEVATED=1 to allow them."
    )
    expect(hostIntegrityRefusalSentence('daemon', 'low')).toBe(
      "Orca's terminal daemon is running at Low integrity, so new agent sessions are refused. Restart the terminal daemon from this non-elevated Orca (Manage Sessions → Restart), or set ORCA_ALLOW_ELEVATED=1 to allow them."
    )
    expect(hostIntegrityRefusalSentence('daemon', 'unknown')).toBe(
      "Orca's terminal daemon is running at an integrity level Orca could not verify, so new agent sessions are refused. Restart the terminal daemon from this non-elevated Orca (Manage Sessions → Restart), or set ORCA_ALLOW_ELEVATED=1 to allow them."
    )
  })

  it('the override sentence (main/high)', () => {
    expect(hostIntegrityOverrideSentence('main', 'high')).toBe(
      "Orca's main process is running elevated (High integrity) and ORCA_ALLOW_ELEVATED=1 is set, so agent sessions are allowed and inherit that integrity level."
    )
  })

  it('DAEMON_UNREPORTED_SENTENCE', () => {
    expect(DAEMON_UNREPORTED_SENTENCE).toBe(
      "Orca's terminal daemon predates the elevation guard and cannot report its integrity level; restart it (Manage Sessions → Restart) to verify it is not elevated."
    )
  })
})

describe('recordHostIntegrityStartupObservation', () => {
  beforeEach(() => resetHostIntegrityForTests())
  afterEach(() => resetHostIntegrityForTests())

  it('main high -> exactly one observed row, one console.warn call', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writeAudit = vi.fn()
    try {
      await recordHostIntegrityStartupObservation({ hostId: 'local', writeAudit })
      expect(writeAudit).toHaveBeenCalledTimes(1)
      expect(writeAudit.mock.calls[0][0].outcome).toBe('observed')
      expect(writeAudit.mock.calls[0][0].reasonCode).toBe('main=high daemon=none override=0')
      expect(
        warnSpy.mock.calls.filter((c) => String(c[0]).startsWith('[host-integrity] Orca'))
      ).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('medium with an inherited daemon -> no row', async () => {
    configureHostIntegrityForTests({ probe: probeOf('medium'), daemon: () => 'inherited' })
    const writeAudit = vi.fn()
    await recordHostIntegrityStartupObservation({ hostId: 'local', writeAudit })
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('a second call does nothing', async () => {
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writeAudit = vi.fn()
    try {
      await recordHostIntegrityStartupObservation({ hostId: 'local', writeAudit })
      await recordHostIntegrityStartupObservation({ hostId: 'local', writeAudit })
      expect(writeAudit).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
