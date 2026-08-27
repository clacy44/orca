import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrincipalLaneStatusSnapshot } from '../../../../shared/principal-lane-status-ipc'
import {
  getDelegationLeases,
  getPrincipalLaneStatus,
  getPrincipalLaneStatusSnapshot,
  resetPrincipalLaneStatusStoreForTest,
  setPrincipalLaneStatusSnapshot,
  startPrincipalLaneStatusSubscription
} from './principal-lane-status-store'

function snapshot(
  overrides: Partial<PrincipalLaneStatusSnapshot> = {}
): PrincipalLaneStatusSnapshot {
  return {
    lanes: [
      { principalId: 'prin-1', displayName: 'Ana', delegatedGrantId: 'dev-1', laneState: 'loaded' }
    ],
    delegationLeases: [
      {
        accountId: 'acct-1',
        accountUuid: null,
        hostId: 'host-1',
        principalId: 'prin-1',
        delegatedGrantId: 'dev-1',
        since: 1,
        expiresAt: null
      }
    ],
    delegableHosts: [],
    remoteHosts: [],
    ...overrides
  }
}

describe('principal lane status store', () => {
  beforeEach(() => {
    resetPrincipalLaneStatusStoreForTest()
  })
  afterEach(() => {
    resetPrincipalLaneStatusStoreForTest()
  })

  it('starts empty so a section with no lane host renders nothing', () => {
    expect(getPrincipalLaneStatusSnapshot()).toEqual({
      lanes: [],
      delegationLeases: [],
      delegableHosts: [],
      remoteHosts: []
    })
    expect(getPrincipalLaneStatus('prin-1')).toBeNull()
    expect(getDelegationLeases()).toEqual([])
  })

  it('exposes a provisioned lane and this desktop leases after a snapshot lands', () => {
    setPrincipalLaneStatusSnapshot(snapshot())
    expect(getPrincipalLaneStatus('prin-1')?.laneState).toBe('loaded')
    expect(getPrincipalLaneStatus('prin-absent')).toBeNull()
    expect(getDelegationLeases()).toHaveLength(1)
  })

  it('hydrates from get and keeps fresh through onChanged', async () => {
    const holder: { cb: ((next: PrincipalLaneStatusSnapshot) => void) | null } = { cb: null }
    const stop = startPrincipalLaneStatusSubscription({
      get: async () => snapshot(),
      onChanged: (callback) => {
        holder.cb = callback
        return () => {
          holder.cb = null
        }
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(getPrincipalLaneStatus('prin-1')?.laneState).toBe('loaded')

    holder.cb?.(
      snapshot({
        lanes: [
          { principalId: 'prin-1', displayName: 'Ana', delegatedGrantId: null, laneState: 'absent' }
        ]
      })
    )
    expect(getPrincipalLaneStatus('prin-1')?.laneState).toBe('absent')

    stop()
    expect(getPrincipalLaneStatusSnapshot()).toEqual({
      lanes: [],
      delegationLeases: [],
      delegableHosts: [],
      remoteHosts: []
    })
  })

  it('lets a republish that beats the initial read win', async () => {
    const holder: { cb: ((next: PrincipalLaneStatusSnapshot) => void) | null } = { cb: null }
    const gate = vi.fn()
    startPrincipalLaneStatusSubscription({
      get: async () => {
        gate()
        return snapshot({
          lanes: [
            {
              principalId: 'prin-1',
              displayName: 'Ana',
              delegatedGrantId: null,
              laneState: 'loaded'
            }
          ]
        })
      },
      onChanged: (callback) => {
        holder.cb = callback
        return () => {}
      }
    })
    // A newer push lands before the initial get resolves — it must not be overwritten by the stale read.
    holder.cb?.(
      snapshot({
        lanes: [
          {
            principalId: 'prin-1',
            displayName: 'Ana',
            delegatedGrantId: null,
            laneState: 'reauth-required'
          }
        ]
      })
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(getPrincipalLaneStatus('prin-1')?.laneState).toBe('reauth-required')
  })
})
