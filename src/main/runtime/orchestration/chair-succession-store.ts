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
import { randomUUID } from 'node:crypto'
import { mkdir, chmod, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withPaneLock } from '../../ipc/agent-launch-admission-lock'
import type {
  CharterMode,
  IncumbentHandle,
  SuccessionMeta,
  SuccessionReason,
  SuccessionState,
  SuccessorHandle
} from './chair-succession-types'

export type ChairSuccessionStoreDeps = {
  orcaHome: string
}

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
}

export type RetiredHandleEntry = {
  handle: string
  succession: string
  at: string
}

export class SuccessionBadTransitionError extends Error {
  readonly code = 'succession_bad_transition' as const
  constructor(from: SuccessionState, to: SuccessionState) {
    super(`succession_bad_transition: ${from} -> ${to} is not a legal transition`)
    this.name = 'SuccessionBadTransitionError'
  }
}

const LEGAL_TRANSITIONS: Record<SuccessionState, SuccessionState[]> = {
  sealed: ['launching', 'aborted'],
  launching: ['confirmed', 'aborted'],
  confirmed: [],
  aborted: []
}

function lockKey(chair: string): string {
  return `succession:${chair}`
}

function chairRoot(deps: ChairSuccessionStoreDeps, chair: string): string {
  return join(deps.orcaHome, 'chairs', chair)
}

function successionsRoot(deps: ChairSuccessionStoreDeps, chair: string): string {
  return join(chairRoot(deps, chair), 'successions')
}

function successionDir(deps: ChairSuccessionStoreDeps, chair: string, id: string): string {
  return join(successionsRoot(deps, chair), id)
}

function retiredHandlesPath(deps: ChairSuccessionStoreDeps, chair: string): string {
  return join(chairRoot(deps, chair), 'retired-handles.json')
}

/** Creates `dir` (and any missing parents) then forces its own mode to 0700 — `mkdir`'s
 * `recursive` option only reliably applies `mode` to the final path segment across Node
 * versions/umasks, so this `chmod`s explicitly rather than trusting that. */
async function ensureDirMode0700(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o700)
}

/** Atomic write: unique tmp name in the same directory, write, rename over the target, and clean
 * up the tmp file if anything before the rename throws — never leaves a partial target and never
 * leaves a stray tmp file behind on failure. */
async function writeAtomic(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readMeta(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string
): Promise<SuccessionMeta | null> {
  try {
    const raw = await readFile(join(successionDir(deps, chair, id), 'meta.json'), 'utf8')
    return JSON.parse(raw) as SuccessionMeta
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

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
  return withPaneLock(lockKey(chair), async () => {
    const id = generateSuccessionId()
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
      ...(input.ackedDeliveryIds !== undefined ? { ackedDeliveryIds: input.ackedDeliveryIds } : {})
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
}>

/** Applies a legal state transition, merging `patch` fields onto the record and bumping
 * `updatedAt`. Throws `SuccessionBadTransitionError` (code `succession_bad_transition`) for any
 * pair not in `LEGAL_TRANSITIONS` — including a transition on a succession that does not exist,
 * which surfaces as the same error rather than a separate not-found shape (there is no `sealed`
 * state to transition FROM when the record is missing). */
export async function transition(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string,
  next: SuccessionState,
  patch: TransitionPatch = {}
): Promise<SuccessionMeta> {
  return withPaneLock(lockKey(chair), async () => {
    const current = await readMeta(deps, chair, id)
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
  })
}

/** Read-only; no lock (a snapshot read racing a concurrent writer only ever sees a fully-written
 * meta.json, since every write is atomic tmp+rename). */
export async function read(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  id: string
): Promise<SuccessionMeta | null> {
  return readMeta(deps, chair, id)
}

/** All successions for `chair` currently in `sealed` or `launching` state. Read-only, no lock. */
export async function listActive(
  deps: ChairSuccessionStoreDeps,
  chair: string
): Promise<SuccessionMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(successionsRoot(deps, chair))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const active: SuccessionMeta[] = []
  for (const id of entries) {
    const meta = await readMeta(deps, chair, id)
    if (meta && (meta.state === 'sealed' || meta.state === 'launching')) {
      active.push(meta)
    }
  }
  return active
}

/** WAVE 2 addition (additive only): read-only snapshot of `retired-handles.json`, append order. */
export async function listRetiredHandles(
  deps: ChairSuccessionStoreDeps,
  chair: string
): Promise<RetiredHandleEntry[]> {
  try {
    return JSON.parse(
      await readFile(retiredHandlesPath(deps, chair), 'utf8')
    ) as RetiredHandleEntry[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/** Appends one entry to `retired-handles.json` (created on first append) under the per-chair
 * lock — append-only, never rewrites or drops a prior entry. */
export async function appendRetiredHandle(
  deps: ChairSuccessionStoreDeps,
  chair: string,
  entry: RetiredHandleEntry
): Promise<void> {
  return withPaneLock(lockKey(chair), async () => {
    await ensureDirMode0700(chairRoot(deps, chair))
    const path = retiredHandlesPath(deps, chair)
    let existing: RetiredHandleEntry[] = []
    try {
      existing = JSON.parse(await readFile(path, 'utf8')) as RetiredHandleEntry[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await writeAtomic(path, JSON.stringify([...existing, entry], null, 2))
  })
}
