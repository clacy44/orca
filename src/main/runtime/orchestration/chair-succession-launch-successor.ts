// S10-22a WAVE 2 (D-R215 §Protocol step 4): split out of chair-succession-hold.ts (line ratchet)
// — launches the successor and records it onto the sealed record and the live hold.
import { randomBytes } from 'node:crypto'
import {
  chairLockKey,
  read,
  transition,
  transitionLocked,
  withPaneLock,
  type ChairSuccessionStoreDeps
} from './chair-succession-store'
import type { SuccessionMeta } from './chair-succession-types'
import type { ManifestEntryWithSuccession } from './chair-succession-manifest-entry'
import type { ChairSuccessionDeps } from './chair-succession-execute'
import { setHoldSuccessor, settleHold } from './chair-succession-hold'

function storeDepsFor(deps: ChairSuccessionDeps): ChairSuccessionStoreDeps {
  return { orcaHome: deps.orcaHome }
}

/** D-R215 §Protocol step 4. `createAgentSession` (orca-runtime.ts:28469 — the primitive
 * `requestChairRestore`'s own `ensureAgentSession` call sits beside, cited in chair-restore.ts)
 * spawns a NEW background tab, first prompt exactly `orca chairs succession-accept <id>`, launch
 * prefs from the manifest. Recording the successor pane/handle/session and transitioning
 * sealed → launching happen in the SAME store write (wave 1's `LEGAL_TRANSITIONS` has no legal
 * launching → launching patch, so there is no earlier point to record a partial successor). A
 * spawn failure aborts immediately (`settleHold`) rather than waiting out the 150 s hold.
 *
 * G1 repair M8: `model`/`effort` fall back to the INCUMBENT's own last-recorded launch prefs
 * (`pref_model`/`pref_effort`) when the manifest entry sets neither — "manifest else the row"
 * (D-R215 §Protocol step 4). Slice 1 never passes a lane (A9); `sealSuccession` now refuses to
 * seal an incumbent that is not already on the host default lane, so the successor always lands
 * on the same (default) lane it would have landed on anyway. */
export async function launchSuccessor(
  deps: ChairSuccessionDeps,
  hostId: string,
  entry: ManifestEntryWithSuccession,
  meta: SuccessionMeta
): Promise<void> {
  // Tracks the pane createAgentSession minted, once it exists — every catch below closes it
  // rather than leaving it orphaned (N1 REPAIR item 2).
  let createdTerminalHandle: string | undefined
  try {
    const incumbentLaunch = deps.db.newestLaunchForPane(hostId, meta.incumbent.paneKey)
    const model = entry.model ?? incumbentLaunch?.pref_model ?? undefined
    const effort = entry.effort ?? incumbentLaunch?.pref_effort ?? undefined
    const clientOperationId = `${Date.now()}-${randomBytes(16).toString('hex')}`
    const created = await deps.runtime.createAgentSession({
      clientOperationId,
      worktree: entry.worktree,
      agent: 'claude',
      prompt: `orca chairs succession-accept ${meta.id}`,
      promptDelivery: 'auto-submit',
      ...(entry.launchArgs ? { appendAgentArgs: entry.launchArgs.join(' ') } : {}),
      ...(model || effort
        ? {
            launchPreferences: {
              ...(model ? { model } : {}),
              ...(effort ? { effort } : {})
            }
          }
        : {}),
      presentation: 'background'
    })
    const paneKey = created.terminal.paneKey
    const terminalHandle = created.terminal.handle
    createdTerminalHandle = terminalHandle
    if (!paneKey) {
      throw new Error('succession_launch_no_pane_key')
    }
    const sessionId = deps.db.newestLaunchForPane(hostId, paneKey)?.session_id

    // N1 REPAIR item 2: re-read under the chair lock — the abort tail may have moved this
    // record to `aborted` (sealed→aborted) while createAgentSession was in flight. Only
    // transition to `launching` if it is still `sealed`; otherwise close the pane just created
    // instead, under the SAME lock the abort tail itself holds while it acts.
    const landed = await withPaneLock(chairLockKey(meta.chair), async () => {
      const current = await read(storeDepsFor(deps), meta.chair, meta.id)
      if (!current || current.state !== 'sealed') {
        return false
      }
      await transitionLocked(storeDepsFor(deps), meta.chair, meta.id, 'launching', {
        successor: { paneKey, terminalHandle, sessionId }
      })
      return true
    })

    if (!landed) {
      if (terminalHandle) {
        try {
          await deps.runtime.closeTerminal(terminalHandle)
        } catch {
          // best-effort — the pane may already be gone.
        }
      }
      return
    }

    // The successor pane is now the record's own — mirror it onto the hold so accept can read it
    // without a disk re-read (B5).
    setHoldSuccessor(meta.id, { paneKey, terminalHandle })
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: paneKey,
      actorHostId: hostId,
      verb: 'succession_launch',
      outcome: 'launched',
      reasonCode: `succession=${meta.id}`.slice(0, 200)
    })
  } catch (err) {
    if (createdTerminalHandle) {
      try {
        await deps.runtime.closeTerminal(createdTerminalHandle)
      } catch {
        // best-effort — the pane may already be gone.
      }
    }
    const reason = `launch_failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 200)
    try {
      await transition(storeDepsFor(deps), meta.chair, meta.id, 'aborted', { abortReason: reason })
    } catch {
      // Already terminal — e.g. the abort tail beat this catch to `aborted`. Nothing more to do.
    }
    deps.db.writeAgentAudit({
      agentId: null,
      actorPaneKey: meta.incumbent.paneKey,
      actorHostId: hostId,
      verb: 'succession_abort',
      outcome: 'aborted',
      reasonCode: reason
    })
    settleHold(meta.id, { ok: false, code: 'succession_aborted', successionId: meta.id, reason })
  }
}
