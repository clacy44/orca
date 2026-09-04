// S10-21a C6a/C6b (D-R107 fix item 6, D-R108 fix item ii; Ruling 34 Addendum 18/19): the
// runtime-layer wiring for the contested-lineage alarm's Layer-1 mismatch check — extracted
// from index.ts's subscribeProviderSessionChanges callback so the per-identity isolation and
// notice-shape logic have a direct fence (D-R108 fix item iii), independent of the hook server
// and full OrcaRuntimeService.
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
  evaluateLiveHookReportMismatch: (
    params: LiveHookReportMismatchParams
  ) => LiveHookReportMismatchResult
  writeHostNoticeToPane: (
    paneKey: string,
    text: string,
    opts: { rateKey: string; windowMs: number }
  ) => void
}

/** [D-R107 fix item 6] T23's missing half: per identity, calls `evaluateLiveHookReportMismatch`
 * and raises `writeHostNoticeToPane` on `foreign_mismatch`/`unrecorded_launch`. [D-R108 fix
 * item ii] Each identity is isolated in its own try/catch — a throw for one malformed/edge-case
 * identity (a DB hiccup, an unexpected shape) must never abort the rest of the batch. */
export function raiseSessionIdentityMismatchAlarms(
  deps: SessionIdentityMismatchAlarmDeps,
  sessions: readonly AgentHookProviderSessionIdentity[]
): void {
  for (const identity of sessions) {
    try {
      const result = deps.evaluateLiveHookReportMismatch({
        hostId: deps.hostId,
        paneKey: identity.paneKey,
        reportedSessionId: identity.sessionId,
        anchorCorroborated: identity.anchorCorroborated === true,
        sessionStartSource: identity.sessionStartSource,
        launchGeneration: deps.launchGeneration
      })
      if (result.kind === 'foreign_mismatch') {
        deps.writeHostNoticeToPane(
          identity.paneKey,
          `This pane's reported session id disagrees with the one Orca recorded at launch — ` +
            `treated as a foreign session, not a rotation.`,
          {
            rateKey: 'session_identity_mismatch',
            windowMs: SESSION_IDENTITY_MISMATCH_NOTICE_WINDOW_MS
          }
        )
      } else if (result.kind === 'unrecorded_launch') {
        deps.writeHostNoticeToPane(
          identity.paneKey,
          `This pane's session id was never recorded by Orca (${result.reason}) — the reported ` +
            `id is not compared against anything.`,
          {
            rateKey: 'session_identity_unrecorded_launch',
            windowMs: SESSION_IDENTITY_MISMATCH_NOTICE_WINDOW_MS
          }
        )
      }
    } catch (err) {
      console.error('[S10-21a] raiseSessionIdentityMismatchAlarms failed for one identity', {
        paneKey: identity.paneKey,
        err
      })
    }
  }
}
