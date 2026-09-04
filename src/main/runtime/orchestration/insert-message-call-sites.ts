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
  // host-lifecycle — host-generated rows, never sender-controlled prose. Count 2:
  // failActiveDispatchOnExit's escalation, plus notifyOrphanedIdentityForPane's C2/F-19
  // (Ruling 33(a)) orphaned-identity wake — host-composed text, no peer/sender input.
  { file: 'main/runtime/orca-runtime.ts', count: 2, kind: 'host-lifecycle' },
  { file: 'main/runtime/orchestration/runtime-notification.ts', count: 1, kind: 'host-lifecycle' },
  {
    file: 'main/runtime/rpc/methods/orchestration-worker-topology.ts',
    count: 1,
    kind: 'host-lifecycle'
  },
  // pending-reroute — peer-supplied free text still bypassing the gate: the legacy
  // question/answer dispatcher plumbing (findLegacyQuestionsBySemanticIdentity's reconstruction
  // path, legacy answerQuestion-equivalent, and the mutation-executor replay path at
  // params.message) — out of S10-2b's enumerated scope (amendment A names point-to-point send,
  // broadcast, reply, federation relay import, and orchestration-legacy-lifecycle.ts sends
  // specifically; commitLegacyLifecycleOperation's own insert — the one backing
  // orchestration-legacy-lifecycle.ts — has moved onto insertGatedMessage). This remaining
  // legacy-question/mutation-replay plumbing is a separate, larger reroute left for a
  // follow-up slice.
  // orchestration.ts (send point-to-point, broadcast, reply) and
  // federation-control-message.ts (federation relay import) have moved onto
  // insertGatedMessage in S10-2b and are no longer on this list. Of db.ts's five remaining
  // sites, one is importFederatedRelayItem's 'runtime_notification' branch — host-lifecycle by
  // provenance (peer-host-attested relay kind, never dispatched-agent prose; its free-text
  // sibling branch is gated, and a refusal there is a committed disposition, not a throw);
  // the other four are the legacy-question/mutation-replay plumbing described above.
  { file: 'main/runtime/orchestration/db.ts', count: 5, kind: 'pending-reroute' }
]
