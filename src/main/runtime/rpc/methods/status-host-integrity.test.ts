// INV-P-023: status.get's optional hostIntegrity field. Handler lookup idiom from updater.test.ts:13-19.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureRemoteServerUpdater } from '../../remote-server-updater'
import { STATUS_METHODS } from './status'
import {
  configureHostIntegrityForTests,
  resetHostIntegrityForTests
} from '../../../host-integrity/host-integrity-guard'
import type { IntegrityProbe } from '../../../host-integrity/windows-integrity-level'

function handler(name: string) {
  const method = STATUS_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`Missing method ${name}`)
  }
  return method.handler
}

function probeOf(level: IntegrityProbe['level']): () => Promise<IntegrityProbe> {
  return async () => ({ level, detail: 'test' })
}

describe('status.get: INV-P-023 hostIntegrity', () => {
  const runtime = {
    getRuntimeId: () => 'runtime-rpc',
    getStatus: () => ({ runtimeId: 'runtime-rpc', liveTabCount: 2, liveLeafCount: 3 })
  }

  beforeEach(() => {
    resetHostIntegrityForTests()
    configureRemoteServerUpdater({
      getSnapshot: vi.fn(() => ({
        appVersion: '1.5.0',
        runtimeId: 'runtime-rpc',
        support: {
          installMode: 'interactive' as const,
          automatic: true,
          reason: 'available' as const
        },
        status: { state: 'available' as const, version: '1.5.1', changelog: null }
      })),
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn()
    })
  })

  afterEach(() => resetHostIntegrityForTests())

  it('default (n/a): no hostIntegrity key', async () => {
    configureHostIntegrityForTests({ probe: probeOf('n/a') })
    const result = (await handler('status.get')(undefined, { runtime } as never)) as Record<
      string,
      unknown
    >
    expect('hostIntegrity' in result).toBe(false)
  })

  it('configured high: result.hostIntegrity matches the refusal view', async () => {
    // N8: peekRuntimeHostIntegrity() never awaits the first probe — settle it first (env:{}
    // starts detection) so this asserts the populated-field shape, not the pending-probe case
    // (that's T6 below).
    configureHostIntegrityForTests({ probe: probeOf('high'), env: {} })
    await Promise.resolve()
    await Promise.resolve()
    const result = (await handler('status.get')(undefined, { runtime } as never)) as {
      hostIntegrity?: { level: string; agentLaunch: string; warning?: string }
    }
    expect(result.hostIntegrity).toMatchObject({
      level: 'high',
      agentLaunch: 'refused',
      warning: expect.stringContaining('refused')
    })
  })

  it('T6: returns promptly with no hostIntegrity while the first probe is pending, and with the field once it settled', async () => {
    let settle!: (probe: IntegrityProbe) => void
    const pending = new Promise<IntegrityProbe>((resolve) => {
      settle = resolve
    })
    configureHostIntegrityForTests({ probe: () => pending, env: {} })

    const first = (await handler('status.get')(undefined, { runtime } as never)) as Record<
      string,
      unknown
    >
    expect('hostIntegrity' in first).toBe(false)

    settle({ level: 'high', detail: 'test' })
    await pending
    await Promise.resolve()
    await Promise.resolve()

    const second = (await handler('status.get')(undefined, { runtime } as never)) as {
      hostIntegrity?: { level: string; agentLaunch: string }
    }
    expect(second.hostIntegrity).toMatchObject({ level: 'high', agentLaunch: 'refused' })
  })
})
