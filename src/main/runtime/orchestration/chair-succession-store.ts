// S10-22a WAVE 1 (b1-slice1-succession.md; D-R215 §Protocol steps 3/4/6/7): the on-disk
// succession store — one directory tree per chair under `<ORCA_HOME>/chairs/<chairName>/`,
// atomic (tmp + rename) writes, a legal-transition-only state machine, and an append-only
// retired-handles log.
//
// DEVIATION from the brief's bare function list (createSealed(), transition(id, next, patch),
// read(id), listActive(chair), appendRetiredHandle()): every function here takes `chair` as an
// explicit argument (not just `listActive`). The store's own root path
// (`<ORCA_HOME>/chairs/<chairName>/`) is a function of `chair`, so `read`/`transition` cannot
// locate a succession's directory from `id` alone without either threading `chair` through or
// scanning every chair directory for a matching id — threading it through is the same shape
// `listActive(chair)` already uses and avoids an O(chairs) directory scan on every read.
//
// LOCK PRIMITIVE: reuses the in-process pane-lock mutex the restore path already uses —
// `withPaneLock` in src/main/ipc/agent-launch-admission-lock.ts:14 ("In-process async mutex
// keyed `${hostId}\0${paneKey}` ... Chained-promise queue: each waiter registers its own slot
// before awaiting the prior one, so N waiters serialise in arrival order"). Keyed here as
// `succession:<chair>` — a fresh namespace in the same map, never colliding with a real
// `${hostId}\0${paneKey}` pane key. This fits the brief's "per-chair lock" requirement directly;
// the brief's fallback (a lock file with O_EXCL + pid + 120s staleness) is NOT used because the
// primitive above already exists in the lane. Contention resolves as FIFO serialization (a
// second `createSealed` call for the same chair waits for the first to finish), not as a
// rejection — different from the fallback's fail-fast shape; `chair-succession-store.test.ts`
// documents this.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withPaneLock } from '../../ipc/agent-launch-admission-lock'
import {
  chairLockKey,
  chairRoot,
  successionDir,
  successionsRoot,
  type ChairSuccessionStoreDeps
} from './chair-succession-paths'
import { readSuccessionMeta } from './chair-succession-meta-read'
import { ensureDirMode0700, writeAtomic } from './chair-succession-store-atomic-write'
import {
  SuccessionBadTransitionError,
  SuccessionInFlightError
} from './chair-succession-store-errors'
import type {
  CharterMode,
  IncumbentHandle,
  SuccessionMeta,
  SuccessionReason,
  SuccessionState,
  SuccessorHandle
} from './chair-succession-types'

// ChairSuccessionStoreDeps moved to chair-succession-paths.ts (leaf, breaks the store<->
// retired-handles import cycle) — re-exported below so existing importers don't churn.
export type { ChairSuccessionStoreDeps } from './chair-succession-paths'

export type CreateSealedInput = {
  reason: SuccessionReason
  checkpointText: string
  checkpointSha: string
  charterPath: string
  charterSha: string
  charterMode: CharterMode
  /** Required when `charterMode === 'embed'`. */
  charterText?: string
  resumeContextText: string
  incumbent: IncumbentHandle
  /** S10-22a residual R238: the delivery ids acked at seal time, carried onto `meta.ackedDeliveryIds`. */
  ackedDeliveryIds?: string[]
  /** G1 repair M1: pre-minted by the caller (before this write) so the size-checked render can
   * use the REAL id and never needs a second write. Defaults to a fresh id when omitted. */
  id?: string
  /** G1 repair L3: the Run id seal is bound to. */
  runId?: string
  /** G1 attempt-3 repair F3: see `SuccessionMeta.preSuccessionSessionId`. */
  preSuccessionSessionId?: string | null
}

// RetiredHandleEntry moved to chair-succession-paths.ts (leaf) — re-exported below so existing
// importers don't churn.
export type { RetiredHandleEntry } from './chair-succession-paths'

// Moved to chair-succession-store-errors.ts (line ratchet) — re-exported so existing importers
// don't churn.
export {
  SuccessionBadTransitionError,
  SuccessionInFlightError
} from './chair-succession-store-errors'

const LEGAL_TRANSITIONS: Record<SuccessionState, SuccessionState[]> = {
  sealed: ['launching', 'aborted'],
  launching: ['confirming', 'aborted'],
  confirming: ['confirmed', 'aborted'],
  confirmed: [],
  aborted: []
}

export { withPaneLock }

// chairLockKey / chairRoot / successionsRoot / retiredHandlesPath moved to
// chair-succession-paths.ts (leaf, breaks the store<->retired-handles import cycle) —
// re-exported below so existing importers don't churn.
export {
  chairLockKey,
  chairRoot,
  retiredHandlesPath,
  successionsRoot
} from './chair-succession-paths'

// ensureDirMode0700 / writeAtomic moved to chair-succession-store-atomic-write.ts (line ratchet)
// — re-exported below so existing importers don't churn.
export { ensureDirMode0700, writeAtomic } from './chair-succession-store-atomic-write'

export function generateSuccessionId(): string {
  return `succ_${randomBytes(6).toString('hex')}`
}

/** Writes a new `sealed` succession directory (0700), its checkpoint, charter reference (plus
 * embedded charter text when `charterMode === 'embed'`), rendered resume context, and meta.json —
 * all under the per-chair lock so two concurrent seals for one chair never interleave writes. */
export async function createSealed(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  input: CreateSealedInput
): Promise<SuccessionMeta> {
  if (input.charterMode === 'embed' && input.charterText === undefined) {
    throw new Error('createSealed: charterMode "embed" requires charterText')
  }
  return withPaneLock(chairLockKey(chair), async () => {
    // G1 repair M2: the SAME lock `transition()` uses — re-checks in-flight state here, not just
    // `sealSuccession`'s earlier unlocked `listActive` read, so a second concurrent seal for this
    // chair can never slip through the gap between that read and this write.
    let existingIds: string[]
    try {
      existingIds = await readdir(successionsRoot(deps, chair))
    } catch {
      existingIds = []
    }
    for (const existingId of existingIds) {
      const existing = await readSuccessionMeta(deps, chair, existingId)
      // G1 repair N5: `confirming` counts as in flight too — admitted here previously, letting a
      // second seal slip through while an accept is still finishing its takeover.
      if (
        existing &&
        (existing.state === 'sealed' ||
          existing.state === 'launching' ||
          existing.state === 'confirming')
      ) {
        throw new SuccessionInFlightError(existing.id, existing.state)
      }
    }
    const id = input.id ?? generateSuccessionId()
    await ensureDirMode0700(chairRoot(deps, chair))
    await mkdir(successionsRoot(deps, chair), { recursive: true })
    const dir = successionDir(deps, chair, id)
    await ensureDirMode0700(dir)

    await writeAtomic(join(dir, 'checkpoint.md'), input.checkpointText)
    await writeAtomic(
      join(dir, 'charter-ref.json'),
      JSON.stringify(
        { path: input.charterPath, sha256: input.charterSha, mode: input.charterMode },
        null,
        2
      )
    )
    if (input.charterMode === 'embed') {
      await writeAtomic(join(dir, 'charter.md'), input.charterText as string)
    }
    await writeAtomic(join(dir, 'resume-context.md'), input.resumeContextText)

    const now = new Date().toISOString()
    const meta: SuccessionMeta = {
      id,
      chair,
      state: 'sealed',
      createdAt: now,
      updatedAt: now,
      reason: input.reason,
      checkpointSha: input.checkpointSha,
      charterSha: input.charterSha,
      incumbent: input.incumbent,
      successor: {},
      ...(input.ackedDeliveryIds !== undefined ? { ackedDeliveryIds: input.ackedDeliveryIds } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.preSuccessionSessionId !== undefined
        ? { preSuccessionSessionId: input.preSuccessionSessionId }
        : {})
    }
    await writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    return meta
  })
}

/** WAVE 2 addition: overwrites `resume-context.md` atomically once the seal path's minted id is known. */
export async function writeResumeContext(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string,
  text: string
): Promise<void> {
  return writeAtomic(join(successionDir(deps, chair, id), 'resume-context.md'), text)
}

export type TransitionPatch = Partial<{
  successor: SuccessorHandle
  retiredHandle: string
  abortReason: string
  /** [G1-10z polish-recheck N3 repair] see `SuccessionMeta.landedAckIds`. */
  landedAckIds: string[]
}>

/** Applies a legal state transition, merging `patch` fields onto the record and bumping
 * `updatedAt`. Throws `SuccessionBadTransitionError` (code `succession_bad_transition`) for any
 * pair not in `LEGAL_TRANSITIONS` — including a transition on a succession that does not exist,
 * which surfaces as the same error rather than a separate not-found shape (there is no `sealed`
 * state to transition FROM when the record is missing). ASSUMES the caller already holds
 * `chairLockKey(chair)` — calling this from OUTSIDE that lock races every other writer; the
 * public, self-locking `transition()` below is what every caller outside this file and
 * `chair-succession-accept.ts`/`chair-succession-hold.ts` (B3's confirming/abort-tail dance,
 * which must read+write under ONE lock acquisition spanning more than this single write) should
 * use. */
export async function transitionLocked(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string,
  next: SuccessionState,
  patch: TransitionPatch = {}
): Promise<SuccessionMeta> {
  const current = await readSuccessionMeta(deps, chair, id)
  const from = current?.state
  const legal = from !== undefined && LEGAL_TRANSITIONS[from].includes(next)
  if (!current || !legal) {
    throw new SuccessionBadTransitionError((from ?? 'aborted') as SuccessionState, next)
  }
  const updated: SuccessionMeta = {
    ...current,
    ...patch,
    state: next,
    updatedAt: new Date().toISOString()
  }
  await writeAtomic(
    join(successionDir(deps, chair, id), 'meta.json'),
    JSON.stringify(updated, null, 2)
  )
  return updated
}

export async function transition(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string,
  next: SuccessionState,
  patch: TransitionPatch = {}
): Promise<SuccessionMeta> {
  return withPaneLock(chairLockKey(chair), () => transitionLocked(deps, chair, id, next, patch))
}

/** Read-only; no lock (a snapshot read racing a concurrent writer only ever sees a fully-written
 * meta.json, since every write is atomic tmp+rename). */
export async function read(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string
): Promise<SuccessionMeta | null> {
  return readSuccessionMeta(deps, chair, id)
}

// listActive moved to chair-succession-store-reads.ts, listRetiredHandles / appendRetiredHandle to
// chair-succession-retired-handles.ts (kept this file under the line ratchet) — re-exported below
// only so existing importers don't churn.
export { listActive } from './chair-succession-store-reads'
export { listRetiredHandles, appendRetiredHandle } from './chair-succession-retired-handles'
