import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAtRiskOnAppImageMount,
  warnIfDaemonSpawnAtRiskOnAppImageMount,
  warnIfServeExitAtRiskOnAppImageMount
} from './linux-appimage-mount-risk'
import { track } from '../telemetry/client'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('isAtRiskOnAppImageMount (S10-12 R3 T3)', () => {
  it('fires for a /tmp/.mount_* execPath on Linux', () => {
    withPlatform('linux', () => {
      expect(isAtRiskOnAppImageMount('/tmp/.mount_orca-lzzXmIA/orca-ide')).toBe(true)
    })
  })

  it('does not fire for an extracted AppImage directory', () => {
    withPlatform('linux', () => {
      expect(isAtRiskOnAppImageMount('/home/ubuntu/orca-fork/dist/linux-unpacked/orca-ide')).toBe(
        false
      )
      expect(isAtRiskOnAppImageMount('/opt/orca/orca-ide')).toBe(false)
    })
  })

  it('does not fire off Linux even for a matching path shape', () => {
    withPlatform('darwin', () => {
      expect(isAtRiskOnAppImageMount('/tmp/.mount_orca-lzzXmIA/orca-ide')).toBe(false)
    })
    withPlatform('win32', () => {
      expect(isAtRiskOnAppImageMount('/tmp/.mount_orca-lzzXmIA/orca-ide')).toBe(false)
    })
  })
})

describe('warnIfDaemonSpawnAtRiskOnAppImageMount / warnIfServeExitAtRiskOnAppImageMount', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(track).mockClear()
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('warns and tracks daemon_spawn only when at risk', () => {
    withPlatform('linux', () => {
      warnIfDaemonSpawnAtRiskOnAppImageMount('/tmp/.mount_orca-lzzXmIA/resources/daemon-entry.js')
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('AT-RISK LAUNCH')
    expect(track).toHaveBeenCalledWith('daemon_linux_mount_risk', { stage: 'daemon_spawn' })

    warnSpy.mockClear()
    vi.mocked(track).mockClear()
    withPlatform('linux', () => {
      warnIfDaemonSpawnAtRiskOnAppImageMount('/opt/orca/resources/daemon-entry.js')
    })
    expect(warnSpy).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalled()
  })

  it('warns and tracks serve_exit only when at risk', () => {
    withPlatform('linux', () => {
      warnIfServeExitAtRiskOnAppImageMount('/tmp/.mount_orca-lzzXmIA/orca-ide')
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('AT-RISK EXIT')
    expect(track).toHaveBeenCalledWith('daemon_linux_mount_risk', { stage: 'serve_exit' })
  })

  it('never throws when telemetry itself throws', () => {
    vi.mocked(track).mockImplementationOnce(() => {
      throw new Error('telemetry down')
    })
    expect(() =>
      withPlatform('linux', () =>
        warnIfDaemonSpawnAtRiskOnAppImageMount('/tmp/.mount_orca-x/daemon-entry.js')
      )
    ).not.toThrow()
  })
})
