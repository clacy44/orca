import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import type { DeviceEntry } from '../../device-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ClientSessionTabSelectionStore } from '../../client-session-tab-selection'
import { terminalPresenceRegistry } from '../../terminal-presence-registry'
import {
  projectSessionTabsForClient,
  type SessionTabProjectionContext
} from './session-tab-device-selections'

const WORKTREE = 'wt-1'

// Why a whole registry row: the control is only real if the secret is present in the data the
// projection derives from, mapped exactly as runtime-rpc.ts's onReady consumer maps it.
const ANA_DEVICE: DeviceEntry = {
  deviceId: 'device-ana',
  name: 'Ana laptop',
  token: 'token-ana-secret',
  scope: 'runtime',
  pairedAt: 1,
  lastSeenAt: 2
}

function tab(id: string, title: string): RuntimeMobileSessionClientTab {
  return {
    type: 'file',
    id,
    title,
    filePath: `/repo/${title}`,
    relativePath: title,
    language: 'typescript',
    isDirty: false,
    isActive: false
  }
}

function snapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 3,
    activeGroupId: null,
    activeTabId: 'tab-a',
    activeTabType: 'file',
    tabs: [tab('tab-a', 'server.ts'), tab('tab-b', 'client.ts')]
  }
}

type Ctx = SessionTabProjectionContext & { store: ClientSessionTabSelectionStore }

function makeCtx(options: {
  established: Set<string>
  pairedDeviceId?: string
  store: ClientSessionTabSelectionStore
}): Ctx {
  const runtime = {
    getClientSessionTabSelections: (worktreeId: string) =>
      options.store.selectionsForWorktree(worktreeId),
    hasEstablishedSubscription: (connectionId: string) => options.established.has(connectionId)
  } as unknown as OrcaRuntimeService
  return {
    runtime,
    store: options.store,
    clientKind: 'runtime',
    clientCapabilities: undefined,
    ...(options.pairedDeviceId ? { pairedDeviceId: options.pairedDeviceId } : {})
  }
}

function selectTab(
  store: ClientSessionTabSelectionStore,
  pairedDeviceId: string,
  activeTabId: string
): void {
  store.activate(snapshot(), pairedDeviceId, activeTabId)
}

function connect(
  established: Set<string>,
  connectionId: string,
  pairedDeviceId: string,
  label: string,
  kind: 'runtime' | 'mobile' = 'runtime'
): string {
  established.add(connectionId)
  return terminalPresenceRegistry.registerConnection({
    connectionId,
    pairedDeviceId,
    label,
    kind
  }).participantId
}

describe('session.tabs device selections', () => {
  let established: Set<string>
  let store: ClientSessionTabSelectionStore

  beforeEach(() => {
    terminalPresenceRegistry.reset()
    established = new Set<string>()
    store = new ClientSessionTabSelectionStore()
  })

  afterEach(() => {
    terminalPresenceRegistry.reset()
  })

  // The negative control: a caller that never asked must get the pre-change payload, key and all.
  it('omits the key entirely without the param', () => {
    connect(established, 'conn-a', 'grant-a', 'Ana laptop')
    selectTab(store, 'grant-a', 'tab-b')
    const ctx = makeCtx({ established, store })

    const projected = projectSessionTabsForClient(snapshot(), ctx, false)

    expect(projected).toEqual(snapshot())
    expect('deviceSelections' in projected).toBe(false)
  })

  // Present-and-empty is the capability signal; "absent" must never be read as "nobody is here".
  it('emits an empty array when the param is set and nobody is published', () => {
    const ctx = makeCtx({ established, store })

    expect(projectSessionTabsForClient(snapshot(), ctx, true).deviceSelections).toEqual([])
  })

  it('joins each published grant to its presence row', () => {
    const anaId = connect(established, 'conn-a', 'grant-a', 'Ana laptop')
    const benId = connect(established, 'conn-b', 'grant-b', "Ben's phone", 'mobile')
    selectTab(store, 'grant-a', 'tab-a')
    selectTab(store, 'grant-b', 'tab-b')
    const ctx = makeCtx({ established, store, pairedDeviceId: 'grant-b' })

    const rows = projectSessionTabsForClient(snapshot(), ctx, true).deviceSelections ?? []

    expect(rows.toSorted((left, right) => left.label.localeCompare(right.label))).toEqual([
      {
        participantId: anaId,
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-a',
        activeTabType: 'file'
      },
      {
        participantId: benId,
        label: "Ben's phone",
        kind: 'mobile',
        self: true,
        activeTabId: 'tab-b',
        activeTabType: 'file'
      }
    ])
  })

  // Selections outlive the devices that made them (they are hydrated from disk), so joining on the
  // presence roster is what keeps W9 live-only in fact rather than only in the docstring.
  it('drops a selection whose grant holds no live subscription', () => {
    terminalPresenceRegistry.registerConnection({
      connectionId: 'conn-gone',
      pairedDeviceId: 'grant-gone',
      label: 'old phone',
      kind: 'mobile'
    })
    selectTab(store, 'grant-gone', 'tab-a')
    const ctx = makeCtx({ established, store })

    expect(projectSessionTabsForClient(snapshot(), ctx, true).deviceSelections).toEqual([])
  })

  it('drops a selection naming a tab that is gone', () => {
    connect(established, 'conn-a', 'grant-a', 'Ana laptop')
    store.activate(snapshot(), 'grant-a', 'tab-b')
    const ctx = makeCtx({ established, store })
    const withoutTabB: RuntimeMobileSessionTabsResult = {
      ...snapshot(),
      tabs: [tab('tab-a', 'server.ts')]
    }

    expect(projectSessionTabsForClient(withoutTabB, ctx, true).deviceSelections).toEqual([])
  })

  // §4.11(d): a disconnect/resubscribe cycle must not replay what the departed device had selected.
  it('never replays a departed device selection across a resubscribe', () => {
    connect(established, 'conn-a', 'grant-a', 'Ana laptop')
    connect(established, 'conn-b', 'grant-b', 'Ben laptop')
    selectTab(store, 'grant-a', 'tab-a')
    selectTab(store, 'grant-b', 'tab-b')
    const ctx = makeCtx({ established, store, pairedDeviceId: 'grant-b' })
    expect(projectSessionTabsForClient(snapshot(), ctx, true).deviceSelections).toHaveLength(2)

    established.delete('conn-a')
    terminalPresenceRegistry.releaseConnection('conn-a')

    const afterReconnect = projectSessionTabsForClient(snapshot(), ctx, true).deviceSelections ?? []
    expect(afterReconnect.map((row) => row.label)).toEqual(['Ben laptop'])
  })

  // §4.3, on W9: the grant id is threaded through TerminalPresenceGrantSelection one spread away from
  // the wire, so the payload is asserted against a fixture whose deviceId and token are both known.
  it('publishes neither the registry deviceId nor the device token', () => {
    connect(established, 'conn-a', ANA_DEVICE.deviceId, ANA_DEVICE.name)
    selectTab(store, ANA_DEVICE.deviceId, 'tab-a')
    const ctx = makeCtx({ established, store, pairedDeviceId: ANA_DEVICE.deviceId })

    const serialized = JSON.stringify(projectSessionTabsForClient(snapshot(), ctx, true))

    expect(serialized).toContain('deviceSelections')
    expect(serialized).not.toContain(ANA_DEVICE.deviceId)
    expect(serialized).not.toContain(ANA_DEVICE.token)
  })

  // §4.11(c): asserted on the serialized artifact, because that is what actually reaches disk.
  it('keeps deviceSelections out of the persisted artifact', () => {
    connect(established, 'conn-a', 'grant-a', 'Ana laptop')
    selectTab(store, 'grant-a', 'tab-a')
    const ctx = makeCtx({ established, store })
    projectSessionTabsForClient(snapshot(), ctx, true)

    const serialized = JSON.stringify(store.serialize())
    expect(serialized).not.toContain('deviceSelections')
    expect(serialized).not.toContain('participantId')
  })
})

// §4.11(a)/(b): the harness covers session.tabs nowhere, so the skew controls are hand-rolled frozen
// copies of the two consumers that exist today.
describe('session.tabs deviceSelections skew', () => {
  const withKey: RuntimeMobileSessionTabsResult = {
    ...snapshot(),
    deviceSelections: [
      {
        participantId: 'p-1',
        label: 'Ana laptop',
        kind: 'runtime',
        self: false,
        activeTabId: 'tab-b',
        activeTabType: 'file'
      }
    ]
  }

  // Frozen copy of the pre-change renderer reducer: it reads the keys that existed before W9 and
  // nothing else, so an unknown key must leave its state byte-identical.
  function frozenPreChangeReducer(payload: RuntimeMobileSessionTabsResult) {
    return {
      worktree: payload.worktree,
      publicationEpoch: payload.publicationEpoch,
      snapshotVersion: payload.snapshotVersion,
      activeGroupId: payload.activeGroupId,
      activeTabId: payload.activeTabId,
      activeTabType: payload.activeTabType,
      tabIds: payload.tabs.map((entry) => entry.id)
    }
  }

  // Frozen copy of mobile/src/transport/rpc-response-shape.ts (structural, ignores extra keys).
  function frozenMobileIsRpcResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
      return false
    }
    const response = value as { id?: unknown; ok?: unknown }
    return (
      typeof response.id === 'string' && response.ok === true && Object.hasOwn(response, 'result')
    )
  }

  it('leaves a pre-change renderer reducer state identical', () => {
    expect(frozenPreChangeReducer(withKey)).toEqual(frozenPreChangeReducer(snapshot()))
  })

  it('still parses through the pre-change mobile response guard', () => {
    expect(frozenMobileIsRpcResponse({ id: 'req-1', ok: true, result: withKey })).toBe(true)
  })
})
