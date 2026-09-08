// S10-21a C6a/C6b (D-R107 fix item 6, D-R108 fix item ii; Ruling 34 Addendum 18/19): the
// runtime-layer wiring for the contested-lineage alarm's Layer-1 mismatch check — extracted
// from index.ts's subscribeProviderSessionChanges callback so the per-identity isolation and
// notice-shape logic have a direct fence (D-R108 fix item iii), independent of the hook server
// and full OrcaRuntimeService.
// [S10-21c B4, design §2 S3/S5] Async since B4 (the evaluator's conjunct (iii) reads the
// filesystem) and it now carries two more outcomes: `reconciled` (the pane corrected its own
// row) and `bootstrapped` (a registered pane with no row earned its first one), each with its
// own informational pane notice.
import type { AgentHookProviderSessionIdentity } from '../agent-hooks/server'
import type {
  LiveHookReportMismatchParams,
  LiveHookReportMismatchResult
} from '../runtime/orchestration/agent-lineage-mismatch'

/** [Ruling 34 Addendum 18] The notice's own clamp — 24h, distinct from admission's 1h default;
 * the audit row itself (agent-lineage-mismatch.ts) is unconditional. */
export const SESSION_IDENTITY_MISMATCH_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000

export type SessionIdentityMismatchAlarmDeps = {
  hostId: string
  launchGeneration: string
  /** [S10-21c B4] The wiring binds S4's `resolveResumeTranscript` INSIDE this closure (index.ts)
   * so the evaluator's conjunct (iii) has exactly one source and this module never grows a
   * filesystem dependency of its own. */
  evaluateLiveHookReportMismatch: (
    params: LiveHookReportMismatchParams
  ) => Promise<LiveHookReportMismatchResult>
  writeHostNoticeToPane: (
    paneKey: string,
    text: string,
    opts: { rateKey: string; windowMs: number }
  ) => void
}

type PaneNotice = { paneKey: string; text: string; rateKey: string }

/** [D-R107 fix item 6] T23's missing half: per identity, calls `evaluateLiveHookReportMismatch`
 * and raises `writeHostNoticeToPane` on `foreign_mismatch`/`unrecorded_launch`/`reconciled`/
 * `bootstrapped`/`bootstrap_refused`. [D-R108 fix item ii] Each identity is isolated in its own
 * try/catch — a throw for one malformed/edge-case identity (a DB hiccup, an unexpected shape, a
 * filesystem error from the transcript conjunct) must never abort the rest of the batch.
 * [S10-21c B4b, D-R152-b4 finding 6] Within ONE batch, identities are awaited in turn, never
 * `Promise.all` — but nothing serialises ACROSS batches (index.ts's subscription callback fires
 * this fire-and-forget, so a second hook event can start a second overlapping batch while the
 * first still awaits). That is exactly why every gating fact the evaluator relies on is re-read
 * in the same synchronous tick as the write it authorises, rather than resting on any claim of
 * cross-batch serialisation. */
export async function raiseSessionIdentityMismatchAlarms(
  deps: SessionIdentityMismatchAlarmDeps,
  sessions: readonly AgentHookProviderSessionIdentity[]
): Promise<void> {
  for (const identity of sessions) {
    try {
      const result = await deps.evaluateLiveHookReportMismatch({
        hostId: deps.hostId,
        paneKey: identity.paneKey,
        reportedSessionId: identity.sessionId,
        anchorCorroborated: identity.anchorCorroborated === true,
        anchorHostVerified: identity.anchorHostVerified === true,
        sessionStartSource: identity.sessionStartSource,
        launchGeneration: deps.launchGeneration,
        reportedAgentType: identity.agentType,
        // [S10-21c B-final F2, D-R159 finding 2] The host-owned counterpart `bootstrapRowFrom
        // LiveReport` cross-checks `reportedAgentType` against.
        reportedSource: identity.source,
        executionHostId: identity.executionHostId
      })
      const notice = noticeForResult(result, identity)
      if (notice) {
        deps.writeHostNoticeToPane(notice.paneKey, notice.text, {
          rateKey: notice.rateKey,
          windowMs: SESSION_IDENTITY_MISMATCH_NOTICE_WINDOW_MS
        })
      }
    } catch (err) {
      console.error('[S10-21a] raiseSessionIdentityMismatchAlarms failed for one identity', {
        paneKey: identity.paneKey,
        err
      })
    }
  }
}

/** The notice shapes, one per outcome that has one. `rateKey` is STATIC per outcome (never keyed
 * by launch generation): `checkAndBumpRate`'s opportunistic prune is scoped to the caller's own
 * verb, so a generation-keyed rate key would leave one permanently unprunable `agent_rate` row
 * per pane per restart. The 24h per-(pane, rateKey) clamp is the existing primitive the design
 * says to reuse, and a reconciliation is self-limiting anyway — once the row agrees, the pane
 * reports `match` and this path is never reached again. */
function noticeForResult(
  result: LiveHookReportMismatchResult,
  identity: AgentHookProviderSessionIdentity
): PaneNotice | undefined {
  if (result.kind === 'foreign_mismatch') {
    // [F2, D-R125] Notice goes to `attributedPaneKey` when set — the row's real owner when
    // the report was an uncorroborated claim on a different pane, never the unauthenticated
    // claimant — else falls back to the (already-authoritative) reporting pane, unchanged.
    return {
      paneKey: result.attributedPaneKey ?? identity.paneKey,
      text:
        `This pane's reported session id disagrees with the one Orca recorded at launch — ` +
        `treated as a foreign session, not a rotation.`,
      rateKey: 'session_identity_mismatch'
    }
  }
  if (result.kind === 'unrecorded_launch') {
    return {
      paneKey: identity.paneKey,
      text:
        `This pane's session id was never recorded by Orca (${result.reason}) — the reported ` +
        `id is not compared against anything.`,
      rateKey: 'session_identity_unrecorded_launch'
    }
  }
  if (result.kind === 'reconciled') {
    return {
      paneKey: identity.paneKey,
      text:
        `Orca updated this pane's recorded session to the one it is actually running ` +
        `(${result.row.session_id}), so a restart will resume this conversation.`,
      rateKey: 'session_identity_reconciled'
    }
  }
  if (result.kind === 'bootstrapped') {
    return {
      paneKey: identity.paneKey,
      text:
        `Orca had no launch record for this registered pane and has recorded the session it is ` +
        `running (${result.row.session_id}) — the pane is now restorable.`,
      rateKey: 'session_identity_bootstrapped'
    }
  }
  // [S10-21c B4b, D-R152-b4 finding 2] Was silent: the underlying audit already dedupes (fires
  // once per new fact), and this notice rides the SAME 24h rate clamp as every other outcome
  // here, so a persistently refused bootstrap is visible instead of only cheap to keep repeating.
  if (result.kind === 'bootstrap_refused') {
    return {
      paneKey: identity.paneKey,
      text:
        `Orca could not record this registered pane's running session (${result.reason}) — ` +
        `the pane will not be restorable until it does.`,
      rateKey: 'session_identity_bootstrap_refused'
    }
  }
  return undefined
}
