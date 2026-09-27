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
    configureHostIntegrityForTests({ probe: probeOf('high') })
    const result = (await handler('status.get')(undefined, { runtime } as never)) as {
      hostIntegrity?: { level: string; agentLaunch: string; warning?: string }
    }
    expect(result.hostIntegrity).toMatchObject({
      level: 'high',
      agentLaunch: 'refused',
      warning: expect.stringContaining('refused')
    })
  })
})
