import { hostname } from 'node:os'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DeviceEntry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import {
  HOST_ATTACHMENT_KEY,
  TerminalPresenceRegistry,
  terminalPresenceRegistry
} from './terminal-presence-registry'
import {
  HOST_PARTICIPANT_ID,
  TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS,
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

// Why: the graph resolves pty-N to terminal-N; an unmapped pty has no handle to publish.
const resolveTerminalHandle = (ptyId: string): string | null =>
  ptyId.startsWith('pty-') ? ptyId.replace('pty-', 'terminal-') : null

function rows(established: readonly string[]) {
  return buildTerminalPresenceRows({
    registry,
    hasEstablishedSubscription: (connectionId) => established.includes(connectionId),
    resolveTerminalHandle
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
    expect(ana[0].attachedTerminals.sort()).toEqual(['terminal-1', 'terminal-2'])
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
    expect(ana.attachedTerminals).toEqual([])
  })

  it('keeps a grant participantId across a reconnect and drops it only on revocation', () => {
    const before = connectAna('conn-window-a')
    registry.releaseConnection('conn-window-a')
    // Why: a mere disconnect must not re-mint — the peer would split into two roster rows.
    expect(connectAna('conn-window-b')).toBe(before)

    registry.forgetGrant(ANA_DEVICE.deviceId)
    expect(registry.getParticipantByConnection('conn-window-b')).toBeNull()
    expect(connectAna('conn-window-c')).not.toBe(before)
  })

  it('clears a revoked grant s writes at revocation, not at TTL', () => {
    connectAna('conn-terminal')
    registry.recordGrantWrite('pty-1', ANA_DEVICE.deviceId)
    const changed: string[] = []
    const stopWatching = registry.onChange((ptyId) => changed.push(ptyId))

    registry.forgetGrant(ANA_DEVICE.deviceId)
    stopWatching()

    // Why not left to the 3 s freshness test: the row is dropped either way, but a revoked device's
    // stamp outliving its revocation is the wrong default for a security-adjacent map, and the
    // surfaces only re-read on a change they are told about.
    expect(registry.grantWritesOf('pty-1').size).toBe(0)
    expect(changed).toContain('pty-1')
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
        'attachedTerminals',
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
      attachedTerminals: [],
      since: expect.any(Number)
    })
    // Why: the row already carries kind 'host', so a concatenated "(host)" suffix would only make a
    // peer-facing display name untranslatable and force a renderer to strip English by regex.
    expect(host.label).toBe(hostname() || 'This device')
    expect(host.label).not.toMatch(/\(host\)/)
  })

  it('stamps the host row since from the injected clock, not module load', () => {
    const clocked = new TerminalPresenceRegistry({ now: () => 1_700_000_000_000 })
    const [host] = buildTerminalPresenceRows({
      registry: clocked,
      hasEstablishedSubscription: () => false,
      resolveTerminalHandle
    }).participants
    expect(host.since).toBe(1_700_000_000_000)
  })

  it('resolves handles before applying the attached-terminal cap', () => {
    connectAna('conn-terminal')
    // Why: ptys with no live handle must not spend the cap — bounding ptyIds first and translating
    // afterwards silently ships a short list, which is the failure the ordering exists to prevent.
    for (let index = 0; index < TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS + 5; index += 1) {
      registry.attach(`orphan-${index}`, `orphan-key-${index}`, 'conn-terminal')
    }
    for (let index = 0; index < TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS; index += 1) {
      registry.attach(`pty-${index}`, `pty-key-${index}`, 'conn-terminal')
    }

    const [, ana] = rows(['conn-terminal']).participants
    expect(ana.attachedTerminals).toHaveLength(TERMINAL_PRESENCE_MAX_ATTACHED_TERMINALS)
    expect(ana.attachedTerminals.every((handle) => handle.startsWith('terminal-'))).toBe(true)
  })

  it('marks exactly one row self, resolved per listener', () => {
    const participantId = connectAna('conn-terminal')
    const forAna = buildTerminalPresenceRows({
      registry,
      hasEstablishedSubscription: () => true,
      resolveTerminalHandle,
      selfParticipantId: participantId
    })
    const forHost = buildTerminalPresenceRows({
      registry,
      hasEstablishedSubscription: () => true,
      resolveTerminalHandle,
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

describe('terminal presence stamp provenance', () => {
  let clock = 0
  let clocked: TerminalPresenceRegistry

  beforeEach(() => {
    clock = 1_000
    clocked = new TerminalPresenceRegistry({ now: () => clock })
  })

  it('writes an interactive stamp on the attachment and no grant row', () => {
    clocked.attach('pty-1', 'multiplex:conn-a:1', 'conn-a')
    clock = 2_000
    clocked.recordInteractiveInput('pty-1', 'multiplex:conn-a:1')

    expect(clocked.attachmentsOf('pty-1').get('multiplex:conn-a:1')).toEqual({
      connectionId: 'conn-a',
      lastInteractiveInputAt: 2_000
    })
    // Why: "site (d) never arms a hold" is a property of which map the stamp lands in, so the two
    // maps must be driven apart by the same clock or one shared field would pass both directions.
    expect(clocked.grantWritesOf('pty-1').size).toBe(0)
  })

  it('writes a grant stamp on the grant row and leaves the attachment unstamped', () => {
    clocked.attach('pty-1', 'multiplex:conn-a:1', 'conn-a')
    clock = 2_000
    clocked.recordGrantWrite('pty-1', ANA_DEVICE.deviceId)

    expect(clocked.grantWritesOf('pty-1').get(ANA_DEVICE.deviceId)).toBe(2_000)
    expect(clocked.attachmentsOf('pty-1').get('multiplex:conn-a:1')?.lastInteractiveInputAt).toBe(0)
  })

  it('never conjures an attachment for an unknown subscription key', () => {
    clocked.recordInteractiveInput('pty-1', 'multiplex:conn-a:1')
    expect(clocked.attachmentsOf('pty-1').size).toBe(0)
  })

  it('stamps the local human under the reserved key with no connection', () => {
    clock = 3_000
    clocked.recordHostInteractiveInput('pty-1')

    // Why: keeping the host in the interactive map is what lets it read as typing rather than writing.
    expect(clocked.attachmentsOf('pty-1').get(HOST_ATTACHMENT_KEY)).toEqual({
      connectionId: null,
      lastInteractiveInputAt: 3_000
    })
    expect(clocked.grantWritesOf('pty-1').size).toBe(0)
  })

  it('hands its own clock to every reader', () => {
    clock = 7_000
    // Why exposed at all: the stream emit evaluates the TTL against this, so a reader calling Date.now()
    // itself would compare an injected registry's stamps to wall time and read as never or always typing.
    expect(clocked.now()).toBe(7_000)
    expect(new TerminalPresenceRegistry({ now: () => 11 }).startedAt).toBe(11)
  })

  it('publishes one change per host keystroke', () => {
    const changed: string[] = []
    const stopWatching = clocked.onChange((ptyId) => changed.push(ptyId))

    clocked.recordHostInteractiveInput('pty-1')
    stopWatching()

    // Why pinned: creating the reserved key and stamping it are one keystroke, and publishing twice
    // sends every surface through its coalescer a second time for a change it already has.
    expect(changed).toEqual(['pty-1'])
  })

  it('preserves an existing host stamp when the reserved key is re-attached', () => {
    clock = 3_000
    clocked.recordHostInteractiveInput('pty-1')
    clock = 9_000
    clocked.attachHost('pty-1')

    expect(clocked.attachmentsOf('pty-1').get(HOST_ATTACHMENT_KEY)?.lastInteractiveInputAt).toBe(
      3_000
    )
  })

  it('stamps inbound traffic on the connection that carried it and nowhere else', () => {
    clocked.registerConnection({
      connectionId: 'conn-a',
      pairedDeviceId: ANA_DEVICE.deviceId,
      label: ANA_DEVICE.name,
      kind: ANA_DEVICE.scope
    })
    clock = 4_000
    clocked.stampInbound('conn-a')
    clocked.stampInbound('conn-already-closed')

    expect(clocked.getParticipantByConnection('conn-a')?.lastInboundAt).toBe(4_000)
    expect(clocked.getParticipantByConnection('conn-already-closed')).toBeNull()
  })
})

describe('OrcaRuntimeService PTY teardown', () => {
  it('releases the reserved host key and the grant writes when the PTY exits', () => {
    terminalPresenceRegistry.reset()
    terminalPresenceRegistry.recordHostInteractiveInput('pty-exit')
    terminalPresenceRegistry.recordGrantWrite('pty-exit', ANA_DEVICE.deviceId)
    expect(Array.from(terminalPresenceRegistry.attachmentsOf('pty-exit').keys())).toEqual([
      HOST_ATTACHMENT_KEY
    ])

    // Why: the reserved key belongs to no stream and no connection, so nothing but the PTY's own
    // teardown can ever drop it — one local keystroke would otherwise leak the entry for the process.
    new OrcaRuntimeService(null).onPtyExit('pty-exit', 0)

    expect(terminalPresenceRegistry.attachmentsOf('pty-exit').size).toBe(0)
    expect(terminalPresenceRegistry.grantWritesOf('pty-exit').size).toBe(0)
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
