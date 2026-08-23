import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PrincipalRegistry,
  type PrincipalGrantRow,
  type PrincipalGrantSource
} from './principal-registry'
import type { DeviceRegistry } from './device-registry'
import { authorizeHostConsent } from './principal-consent-authority'
import { PRINCIPAL_AUDIT_MAX_ROWS, PRINCIPAL_REGISTRY_FILENAME } from './principal-registry-store'
import { reconcileOrphanPrincipalLanes } from '../claude-accounts/principal-lane-orphan-reconciliation'
import {
  deprovisionPrincipalLane,
  provisionPrincipalLane
} from '../claude-accounts/principal-credential-lane'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const RUNTIME_AUTH_TOKEN = 'a'.repeat(48)

// Why type-only: the registry takes the device registry as its grant source, and nothing else in
// this slice wires the two together yet — this keeps the shapes from drifting apart in the meantime.
type Assert<T extends true> = T
export type DeviceRegistryIsAGrantSource = Assert<
  DeviceRegistry extends PrincipalGrantSource ? true : false
>

class FakeGrants {
  private rows: PrincipalGrantRow[] = []
  loadSucceeded = true

  add(row: Partial<PrincipalGrantRow> & { deviceId: string }): PrincipalGrantRow {
    const full: PrincipalGrantRow = {
      name: 'Ana',
      token: `token-${row.deviceId}`,
      pairedAt: 1_000,
      lastSeenAt: 0,
      // Why present: `pendingExpiresAt` is the mint discriminator a bind requires (§2a). Its VALUE
      // is not a bind precondition — a scanned pairing keeps a long-past deadline and still binds.
      pendingExpiresAt: Date.now() + 60_000,
      ...row
    }
    this.rows = [...this.rows.filter((entry) => entry.deviceId !== full.deviceId), full]
    return full
  }

  remove(deviceId: string): void {
    this.rows = this.rows.filter((entry) => entry.deviceId !== deviceId)
  }

  getDevice(deviceId: string): PrincipalGrantRow | null {
    return this.rows.find((entry) => entry.deviceId === deviceId) ?? null
  }

  listDevices(): readonly PrincipalGrantRow[] {
    return this.rows
  }
}

describe('PrincipalRegistry', () => {
  let userData = ''
  let grants: FakeGrants

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-principals-'))
    grants = new FakeGrants()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  const consent = authorizeHostConsent({})

  const registry = (): PrincipalRegistry =>
    new PrincipalRegistry(userData, grants, { runtimeAuthToken: RUNTIME_AUTH_TOKEN })

  describe('consent authority', () => {
    it('refuses a consent write from an identified socket', () => {
      expect(() => authorizeHostConsent({ clientKind: 'mobile' })).toThrow(
        /decisions made at the host machine/
      )
      expect(() => authorizeHostConsent({ clientKind: 'runtime' })).toThrow(
        /decisions made at the host machine/
      )
    })

    it('admits the local socket', () => {
      expect(authorizeHostConsent({}).source).toBe('local-socket')
    })
  })

  describe('binding', () => {
    it('binds a minted per-person grant and resolves it back', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'device-a' })

      store.bindGrant(consent, 'device-a', person.principalId)

      expect(store.principalOf('device-a')).toBe(person.principalId)
      expect(store.boundDeviceIds(person.principalId)).toEqual(['device-a'])
    })

    it('refuses a coalesced grant that carries no pendingExpiresAt', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'coalesced', pendingExpiresAt: undefined })

      expect(() => store.bindGrant(consent, 'coalesced', person.principalId)).toThrow(
        /shared invite link/
      )
      expect(store.principalOf('coalesced')).toBeNull()
    })

    it('binds a scanned pairing whose invite deadline is long past', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      // The shape every real pairing has on disk: the invite was consumed (`lastSeenAt > 0`) and
      // its 24h deadline went by. Only un-scanned rows expire, and `DeviceRegistry.load` prunes
      // those — so refusing on the deadline here would make every paired device unbindable.
      grants.add({
        deviceId: 'paired-desktop',
        lastSeenAt: Date.now() - 60_000,
        pendingExpiresAt: Date.now() - 25 * 60 * 60 * 1000
      })

      store.bindGrant(consent, 'paired-desktop', person.principalId)

      expect(store.principalOf('paired-desktop')).toBe(person.principalId)
      store.designatePusher(consent, person.principalId, 'paired-desktop')
      expect(() => store.assertLaneProvisionable(person.principalId)).not.toThrow()
    })

    it('refuses binding onto an already-bound row and re-binds as unbind-then-bind', () => {
      const store = registry()
      const ana = store.createPrincipal(consent, 'Ana')
      const bo = store.createPrincipal(consent, 'Bo')
      grants.add({ deviceId: 'device-a' })
      store.bindGrant(consent, 'device-a', ana.principalId)

      expect(() => store.bindGrant(consent, 'device-a', bo.principalId)).toThrow(
        /already bound to a person/
      )

      store.rebindGrant(consent, 'device-a', bo.principalId)
      expect(store.principalOf('device-a')).toBe(bo.principalId)
    })

    it('leaves the binding and the designation untouched when a re-bind is refused', () => {
      const store = registry()
      const ana = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'desktop' })
      store.bindGrant(consent, 'desktop', ana.principalId)
      store.designatePusher(consent, ana.principalId, 'desktop')

      expect(() =>
        store.rebindGrant(consent, 'desktop', '00000000-0000-4000-8000-000000000000')
      ).toThrow(/no record of that person/)

      expect(store.principalOf('desktop')).toBe(ana.principalId)
      expect(store.delegatedGrantIdOf(ana.principalId)).toBe('desktop')
      expect(store.boundDeviceIds(ana.principalId)).toEqual(['desktop'])
      expect(() => store.assertLaneProvisionable(ana.principalId)).not.toThrow()
      expect(store.listAudit().map((row) => row.action)).toEqual([
        'create-principal',
        'bind',
        'designate'
      ])
    })

    it('never resolves a principal by the free-form pairing name', () => {
      const store = registry()
      const ana = store.createPrincipal(consent, 'Ana')
      store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'device-a', name: 'Ana' })
      grants.add({ deviceId: 'device-b', name: 'Ana' })
      store.bindGrant(consent, 'device-a', ana.principalId)

      // Two rows both named "Ana" are two unrelated grants: the second stays unbound.
      expect(store.principalOf('device-b')).toBeNull()
      expect(store.listPrincipals()).toHaveLength(2)
    })

    it('stops counting a revoked grant immediately', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'device-a' })
      store.bindGrant(consent, 'device-a', person.principalId)

      grants.remove('device-a')

      expect(store.principalOf('device-a')).toBeNull()
      expect(store.boundPrincipalIds()).toEqual([])
    })

    it('writes an audit row per consent write', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'device-a' })
      store.bindGrant(consent, 'device-a', person.principalId)
      store.unbindGrant(consent, 'device-a')

      expect(store.listAudit().map((row) => row.action)).toEqual([
        'create-principal',
        'bind',
        'unbind'
      ])
      expect(store.listAudit().at(1)).toMatchObject({ direction: 'bind', deviceId: 'device-a' })
      expect(store.listAudit().at(2)).toMatchObject({ direction: 'unbind' })
    })

    it('caps the in-memory audit trail at the bound the store writes', () => {
      const store = registry()
      for (let index = 0; index <= PRINCIPAL_AUDIT_MAX_ROWS; index += 1) {
        store.createPrincipal(consent, `Ana ${index}`)
      }

      expect(store.listAudit()).toHaveLength(PRINCIPAL_AUDIT_MAX_ROWS)
      expect(registry().listAudit()).toHaveLength(PRINCIPAL_AUDIT_MAX_ROWS)
      expect(store.listAudit().at(-1)?.principalId).toBe(store.listPrincipals().at(-1)?.principalId)
    })

    it('refuses a display name that is over-long or carries control characters', () => {
      const store = registry()

      expect(() => store.createPrincipal(consent, 'x'.repeat(65))).toThrow(/printable characters/)
      expect(() => store.createPrincipal(consent, 'Ana')).toThrow(/printable characters/)
    })
  })

  describe('designation', () => {
    const bound = (store: PrincipalRegistry): { principalId: string } => {
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'desktop' })
      grants.add({ deviceId: 'phone' })
      store.bindGrant(consent, 'desktop', person.principalId)
      store.bindGrant(consent, 'phone', person.principalId)
      return person
    }

    it('designates any bound grant, including one that has never connected', () => {
      const store = registry()
      const person = bound(store)

      store.designatePusher(consent, person.principalId, 'desktop')

      expect(store.delegatedGrantIdOf(person.principalId)).toBe('desktop')
      expect(grants.getDevice('desktop')?.lastSeenAt).toBe(0)
      expect(() => store.assertLaneProvisionable(person.principalId)).not.toThrow()
    })

    it('refuses to designate a grant bound to nobody', () => {
      const store = registry()
      const person = bound(store)
      grants.add({ deviceId: 'stranger' })

      expect(() => store.designatePusher(consent, person.principalId, 'stranger')).toThrow(
        /already bound to this person/
      )
    })

    it('re-designates at any time and audits it with no direction', () => {
      const store = registry()
      const person = bound(store)
      store.designatePusher(consent, person.principalId, 'desktop')

      store.designatePusher(consent, person.principalId, 'phone')

      expect(store.delegatedGrantIdOf(person.principalId)).toBe('phone')
      const designations = store.listAudit().filter((row) => row.action === 'designate')
      expect(designations).toHaveLength(2)
      expect(designations.at(-1)).toMatchObject({ designatedGrantId: 'phone' })
      expect(designations.at(-1)?.direction).toBeUndefined()
    })

    it('clears the designation when the designated grant is unbound', () => {
      const store = registry()
      const person = bound(store)
      store.designatePusher(consent, person.principalId, 'desktop')

      store.unbindGrant(consent, 'desktop')

      expect(store.delegatedGrantIdOf(person.principalId)).toBeNull()
      expect(store.listAudit().at(-1)).toMatchObject({
        action: 'designate',
        designatedGrantId: null
      })
      expect(() => store.assertLaneProvisionable(person.principalId)).toThrow(
        /No grant has been designated/
      )
    })

    it('drops a designation whose grant was revoked rather than serving it stale', () => {
      const store = registry()
      const person = bound(store)
      store.designatePusher(consent, person.principalId, 'desktop')

      grants.remove('desktop')

      expect(store.delegatedGrantIdOf(person.principalId)).toBeNull()
      expect(() => store.assertLaneProvisionable(person.principalId)).toThrow(
        /No grant has been designated/
      )
    })

    it('survives a runtime restart', () => {
      const person = (() => {
        const store = registry()
        const created = bound(store)
        store.designatePusher(consent, created.principalId, 'desktop')
        return created
      })()

      const reloaded = registry()

      expect(reloaded.delegatedGrantIdOf(person.principalId)).toBe('desktop')
      expect(reloaded.principalOf('phone')).toBe(person.principalId)
    })
  })

  describe('provisioning refusals', () => {
    it('refuses a principal with no bound grant', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')

      expect(() => store.assertLaneProvisionable(person.principalId)).toThrow(
        /No device is bound to this person/
      )
    })

    it('refuses a principal with bound grants but no designated pusher', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'desktop' })
      store.bindGrant(consent, 'desktop', person.principalId)

      expect(() => store.assertLaneProvisionable(person.principalId)).toThrow(
        /No grant has been designated/
      )
    })

    it('refuses an unknown principal', () => {
      const store = registry()

      expect(() => store.assertLaneProvisionable('00000000-0000-4000-8000-000000000000')).toThrow(
        /no record of that person/
      )
    })
  })

  describe('federated link binding', () => {
    const fingerprintOf = (value: string): string =>
      createHash('sha256').update(value).digest('hex')

    it('binds a fingerprint matching exactly one paired grant and reads its principal', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      const grant = grants.add({ deviceId: 'home-peer', token: 'peer-token' })
      store.bindGrant(consent, grant.deviceId, person.principalId)

      store.bindFederatedLink(consent, fingerprintOf('peer-token'))

      expect(store.linkPrincipalOf(fingerprintOf('peer-token'))).toBe(person.principalId)
      expect(store.listAudit().at(-1)).toMatchObject({
        action: 'link-bind',
        deviceId: 'home-peer'
      })
    })

    it('refuses the runtime auth token and the authenticated-transport fallback by name', () => {
      const store = registry()
      grants.add({ deviceId: 'home-peer', token: 'peer-token' })

      expect(() => store.bindFederatedLink(consent, fingerprintOf(RUNTIME_AUTH_TOKEN))).toThrow(
        /local Orca connection/
      )
      expect(() =>
        store.bindFederatedLink(consent, fingerprintOf('authenticated_transport'))
      ).toThrow(/no per-link credential/)
      expect(store.linkPrincipalOf(fingerprintOf(RUNTIME_AUTH_TOKEN))).toBeNull()
    })

    it('refuses a fingerprint matching zero or two grants', () => {
      const store = registry()
      grants.add({ deviceId: 'one', token: 'shared-token' })
      grants.add({ deviceId: 'two', token: 'shared-token' })

      expect(() => store.bindFederatedLink(consent, fingerprintOf('nothing'))).toThrow(
        /no paired grant/
      )
      expect(() => store.bindFederatedLink(consent, fingerprintOf('shared-token'))).toThrow(
        /more than one paired grant/
      )
    })

    it('falls back to unbound after the grant is re-paired', () => {
      const store = registry()
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId: 'home-peer', token: 'peer-token' })
      store.bindGrant(consent, 'home-peer', person.principalId)
      store.bindFederatedLink(consent, fingerprintOf('peer-token'))

      grants.add({ deviceId: 'home-peer', token: 'rotated-token' })

      expect(store.linkPrincipalOf(fingerprintOf('peer-token'))).toBeNull()
    })
  })

  describe('orphan lane reconciliation', () => {
    const lanesRoot = (): string => join(userData, 'claude-lanes')

    const provisionFor = (store: PrincipalRegistry, deviceId: string): string => {
      const person = store.createPrincipal(consent, 'Ana')
      grants.add({ deviceId })
      store.bindGrant(consent, deviceId, person.principalId)
      store.designatePusher(consent, person.principalId, deviceId)
      store.assertLaneProvisionable(person.principalId)
      provisionPrincipalLane(person.principalId, { lanesRoot: lanesRoot(), platform: 'linux' })
      return person.principalId
    }

    it('deletes only the lane whose principal lost its last grant', () => {
      const store = registry()
      const kept = provisionFor(store, 'desktop')
      const orphaned = provisionFor(store, 'retired')
      grants.remove('retired')

      const result = reconcileOrphanPrincipalLanes({
        boundPrincipalIds: store.boundPrincipalIds(),
        registryLoadSucceeded: store.loadSucceeded,
        lanesRoot: lanesRoot()
      })

      expect(result.deletedPrincipalIds).toEqual([orphaned])
      expect(store.boundPrincipalIds()).toEqual([kept])
    })

    it('deletes nothing when the device registry load threw', () => {
      const store = registry()
      const kept = provisionFor(store, 'desktop')
      grants.loadSucceeded = false

      const result = reconcileOrphanPrincipalLanes({
        boundPrincipalIds: [],
        registryLoadSucceeded: store.loadSucceeded,
        lanesRoot: lanesRoot()
      })

      expect(result.skipped).toBe('registry-load-failed')
      expect(deprovisionPrincipalLane(kept, { lanesRoot: lanesRoot() })).toBe(true)
    })

    it('deletes nothing when its own persisted state failed to parse', () => {
      const store = registry()
      provisionFor(store, 'desktop')
      writeFileSync(join(userData, PRINCIPAL_REGISTRY_FILENAME), '{not json')

      const reloaded = registry()

      expect(reloaded.loadSucceeded).toBe(false)
      expect(
        reconcileOrphanPrincipalLanes({
          boundPrincipalIds: reloaded.boundPrincipalIds(),
          registryLoadSucceeded: reloaded.loadSucceeded,
          lanesRoot: lanesRoot()
        }).skipped
      ).toBe('registry-load-failed')
    })
  })
})
