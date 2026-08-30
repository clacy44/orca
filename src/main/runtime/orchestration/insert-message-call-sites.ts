// S10-2a RISKS #3 (s10-2-spec.md:225): `db.insertGatedMessage` (message-gate-writer.ts) is the
// single write choke for peer-facing content (ruling 2, GATE §). `db.insertMessage` is meant to
// become private to host-generated lifecycle rows — but S10-2a lands "no handler edits" (that
// rerouting is S10-2b, s10-2-spec.md:119), so as of THIS series `insertMessage` still has real
// peer-facing callers. Naming every one of them here, with an exact count each, is what stops an
// over-broad exemption from silently re-opening the gate: a caller added anywhere else, or a new
// call site added inside an already-listed file, fails
// `insert-message-call-site-audit.test.ts` at CI instead of slipping through unreviewed.
//
// `kind` is the honest classification, not an aspiration:
//   - 'host-lifecycle': the row is host-generated (a runtime notification, an escalation on an
//     unexpected exit, a worker/dispatch setup-status line) — never sender-controlled prose, so
//     routing it through the content gate is moot. These are the entries the S10-2 ruling
//     actually means by "host-lifecycle exemption list".
//   - 'pending-reroute': the row carries peer-supplied free text (a legacy lifecycle op's
//     message body, a dispatch's question/answer body, an imported federated message) that
//     bypasses the gate today and must move onto `insertGatedMessage` in S10-2b. Listed here
//     rather than silently grandfathered, so that reroute is a visible diff against this file.
export type InsertMessageCallSiteKind = 'host-lifecycle' | 'pending-reroute'

export type InsertMessageCallSite = {
  /** Path relative to `src/`, forward-slash separated. */
  file: string
  /** Number of call sites in the file, kept exact so a new call site added
   * inside an already-listed file still requires a conscious update here, not just a new file
   * entry. */
  count: number
  kind: InsertMessageCallSiteKind
}

export const INSERT_MESSAGE_CALL_SITES: readonly InsertMessageCallSite[] = [
  // host-lifecycle — host-generated rows, never sender-controlled prose
  { file: 'main/runtime/orca-runtime.ts', count: 1, kind: 'host-lifecycle' },
  { file: 'main/runtime/orchestration/runtime-notification.ts', count: 1, kind: 'host-lifecycle' },
  {
    file: 'main/runtime/rpc/methods/orchestration-worker-topology.ts',
    count: 1,
    kind: 'host-lifecycle'
  },
  // pending-reroute — peer-supplied free text (legacy lifecycle ops, dispatch question/answer
  // bodies, federated relay import); S10-2b moves these onto insertGatedMessage
  { file: 'main/runtime/orchestration/db.ts', count: 6, kind: 'pending-reroute' },
  {
    file: 'main/runtime/orchestration/federation-control-message.ts',
    count: 1,
    kind: 'pending-reroute'
  },
  { file: 'main/runtime/rpc/methods/orchestration.ts', count: 3, kind: 'pending-reroute' }
]
