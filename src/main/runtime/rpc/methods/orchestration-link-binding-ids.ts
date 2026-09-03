// Ruling 28(h) (C8a): the one enumeration of "every link id this host knows about" — shared by
// the local RPC surface's several verbs (split out for max-lines; also fixes protocol F9: the
// prior enumeration never scanned peer_link_scan_facts / peer_link_confirm_observations, so
// `linkForget` could silently delete an unrelated link's rows in those two tables, or never be
// able to name a link that lives only in one of them).
import type { RpcContext } from '../core'

export function collectLinkIds(runtime: RpcContext['runtime']): string[] {
  const db = runtime.getOrchestrationDb()
  const ids = new Set<string>()
  for (const row of db.listPeerLinkBindings()) {
    ids.add(row.linkDeviceId)
  }
  for (const row of db.listBindingAttempts()) {
    ids.add(row.linkDeviceId)
  }
  for (const row of db.listContainment()) {
    if (row.subjectKind === 'link') {
      ids.add(row.subjectId)
    }
  }
  for (const id of db.listScanFactLinkIds()) {
    ids.add(id)
  }
  for (const id of db.listConfirmObservationLinkIds()) {
    ids.add(id)
  }
  return [...ids]
}
