import { beforeEach, describe, expect, it } from 'vitest'
import type { DeviceEntry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { TerminalPresenceRegistry } from './terminal-presence-registry'
import {
  HOST_PARTICIPANT_ID,
  TERMINAL_PRESENCE_MAX_PARTICIPANTS,
  buildTerminalPresenceRows,
  resolveHostPresenceLabel
} from './terminal-presence-snapshot'

// Why: the disclosure control is only real if the secret exists in the data the snapshot is derived
// from, so the fixture is a whole registry row and the connection is mapped off it exactly as
// runtime-rpc.ts's onReady consumer does.
const ANA_DEVICE: DeviceEntry = {
  deviceId: 'device-ana',
  name: 'Ana laptop',
  token: 'token-ana-secret',
  scope: 'runtime',
  pairedAt: 1,
  lastSeenAt: 2
}
let registry: TerminalPresenceRegistry

function connectAna(connectionId: string): string {
  return registry.registerConnection({
    connectionId,
    pairedDeviceId: ANA_DEVICE.deviceId,
    label: ANA_DEVICE.name,
    kind: ANA_DEVICE.scope
  }).participantId
}

function rows(established: readonly string[]) {
  return buildTerminalPresenceRows({
    registry,
    hasEstablishedSubscription: (connectionId) => established.includes(connectionId)
  })
}

beforeEach(() => {
  registry = new TerminalPresenceRegistry()
})

describe('terminal presence identity and aggregation', () => {
  it('mints one participantId per grant and collapses that grant to one row', () => {
    const first = connectAna('conn-shared-control')
    const second = connectAna('conn-terminal')
    expect(second).toBe(first)

    registry.attach('pty-1', 'multiplex:conn-terminal:1', 'conn-terminal')
    registry.attach('pty-2', 'multiplex:conn-terminal:2', 'conn-terminal')

    const { participants } = rows(['conn-shared-control', 'conn-terminal'])
    const ana = participants.filter((row) => row.participantId === first)
    expect(ana).toHaveLength(1)
    expect(ana[0].attachedPtyIds.sort()).toEqual(['pty-1', 'pty-2'])
    expect(ana[0].label).toBe('Ana laptop')
  })

  it('publishes nothing for a one-shot socket that holds no subscription', () => {
    connectAna('conn-one-shot')
    // Why: the negative control for the publication threshold — every remote `orca` command opens
    // exactly this socket, and a flashing roster row per command is the failure it prevents.
    expect(rows([]).participants.map((row) => row.participantId)).toEqual([HOST_PARTICIPANT_ID])
    expect(rows(['conn-one-shot']).participants).toHaveLength(2)
  })

  it('keeps the participant while a sibling socket of the same grant survives', () => {
    connectAna('conn-window-a')
    connectAna('conn-window-b')
    registry.releaseConnection('conn-window-a')

    expect(rows(['conn-window-b']).participants).toHaveLength(2)
    registry.releaseConnection('conn-window-b')
    expect(rows(['conn-window-b']).participants.map((row) => row.participantId)).toEqual([
      HOST_PARTICIPANT_ID
    ])
  })

  it('sweeps a released connection out of every attachment it held', () => {
    connectAna('conn-terminal')
    registry.attach('pty-1', 'multiplex:conn-terminal:1', 'conn-terminal')
    registry.releaseConnection('conn-terminal')
    expect(registry.attachmentsOf('pty-1').size).toBe(0)
  })

  it('leaves the reserved host attachment for the PTY teardown, not a stream teardown', () => {
    registry.attachHost('pty-1')
    registry.attach('pty-1', 'multiplex:conn-terminal:1', 'conn-terminal')
    registry.detach('pty-1', 'multiplex:conn-terminal:1')
    expect(Array.from(registry.attachmentsOf('pty-1').keys())).toEqual(['host'])
    registry.releasePty('pty-1')
    expect(registry.attachmentsOf('pty-1').size).toBe(0)
  })

  it('never resolves the reserved host attachment through a connection lookup', () => {
    connectAna('conn-terminal')
    registry.attachHost('pty-1')
    const [, ana] = rows(['conn-terminal']).participants
    // Why: the host key carries connectionId null; folding it into a peer's union would credit that
    // peer with a terminal it never attached to.
    expect(ana.attachedPtyIds).toEqual([])
  })

  it('rotates participantIds across a host restart and persists nothing', () => {
    const before = connectAna('conn-terminal')
    const afterRestart = new TerminalPresenceRegistry()
    const after = afterRestart.registerConnection({
      connectionId: 'conn-terminal',
      pairedDeviceId: ANA_DEVICE.deviceId,
      label: ANA_DEVICE.name,
      kind: ANA_DEVICE.scope
    }).participantId
    expect(after).not.toBe(before)
  })
})

describe('terminal presence payload shape', () => {
  it('carries neither the registry deviceId nor the device token', () => {
    connectAna('conn-terminal')
    registry.attach('pty-1', 'multiplex:conn-terminal:1', 'conn-terminal')
    const built = rows(['conn-terminal'])
    const serialized = JSON.stringify(built)
    expect(serialized).not.toContain(ANA_DEVICE.deviceId)
    expect(serialized).not.toContain(ANA_DEVICE.token)
    // Why: substring checks only catch what the fixture happens to name — pinning the key set is what
    // makes a newly threaded field (ctx.clientId IS a device token) fail loudly instead of shipping.
    for (const row of built.participants) {
      expect(Object.keys(row).sort()).toEqual([
        'attachedPtyIds',
        'kind',
        'label',
        'participantId',
        'self',
        'since'
      ])
    }
  })

  it('synthesizes the host row with no socket, no subscription and no attachments', () => {
    const [host] = rows([]).participants
    expect(host).toEqual({
      participantId: HOST_PARTICIPANT_ID,
      label: resolveHostPresenceLabel(),
      kind: 'host',
      self: false,
      attachedPtyIds: [],
      since: expect.any(Number)
    })
    expect(host.label).toMatch(/ \(host\)$/)
  })

  it('marks exactly one row self, resolved per listener', () => {
    const participantId = connectAna('conn-terminal')
    const forAna = buildTerminalPresenceRows({
      registry,
      hasEstablishedSubscription: () => true,
      selfParticipantId: participantId
    })
    const forHost = buildTerminalPresenceRows({
      registry,
      hasEstablishedSubscription: () => true,
      selfParticipantId: HOST_PARTICIPANT_ID
    })
    expect(forAna.participants.filter((row) => row.self).map((row) => row.participantId)).toEqual([
      participantId
    ])
    expect(forHost.participants.filter((row) => row.self).map((row) => row.participantId)).toEqual([
      HOST_PARTICIPANT_ID
    ])
  })

  it('bounds the participant list and flags the truncation', () => {
    const connectionIds: string[] = []
    for (let index = 0; index < TERMINAL_PRESENCE_MAX_PARTICIPANTS + 5; index += 1) {
      const connectionId = `conn-${index}`
      connectionIds.push(connectionId)
      registry.registerConnection({
        connectionId,
        pairedDeviceId: `device-${index}`,
        label: `Peer ${index}`,
        kind: 'runtime'
      })
    }
    const bounded = rows(connectionIds)
    expect(bounded.participants).toHaveLength(TERMINAL_PRESENCE_MAX_PARTICIPANTS)
    expect(bounded.truncated).toBe(true)
    // Why: the negative control — an under-cap roster must not claim truncation.
    expect(rows(connectionIds.slice(0, 3)).truncated).toBeUndefined()
  })
})

describe('OrcaRuntimeService.hasEstablishedSubscription', () => {
  it('answers only for a connection that still holds a live subscription', async () => {
    const runtime = new OrcaRuntimeService(null)
    expect(runtime.hasEstablishedSubscription('conn-one-shot')).toBe(false)

    runtime.registerSubscriptionCleanup(
      'terminal-multiplex:conn-terminal',
      () => {},
      'conn-terminal'
    )
    expect(runtime.hasEstablishedSubscription('conn-terminal')).toBe(true)
    expect(runtime.hasEstablishedSubscription('conn-one-shot')).toBe(false)

    // Why: subscription teardown settles asynchronously, so the index drops on the next tick.
    await runtime.cleanupSubscriptionAndWait('terminal-multiplex:conn-terminal')
    expect(runtime.hasEstablishedSubscription('conn-terminal')).toBe(false)
  })
})
