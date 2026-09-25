// S10-22a WAVE 1 (b1-slice1-succession.md; D-R215 §Protocol): shared types for chair succession
// — the checkpoint's section shape, the succession record's lifecycle state, its on-disk meta
// shape, and the resume-context renderer's pure input. Split out so chair-checkpoint.ts,
// chair-succession-store.ts and chair-resume-context.ts share one vocabulary without importing
// each other.

/** The eight `## ` sections a checkpoint carries, in the exact order D-R215 §2/§3 (A6) requires.
 * Each value is either the section's non-blank body text or the literal string `none`. */
export type CheckpointSections = {
  goal: string
  completed: string
  liveUnits: string
  blockers: string
  unsavedRulings: string
  queue: string
  todo: string
  gotchas: string
}

/** The order `chair-checkpoint.ts` and `chair-resume-context.ts` both walk — kept as one const so
 * neither file can drift from the other's section order. */
export const CHECKPOINT_SECTION_ORDER: readonly (keyof CheckpointSections)[] = [
  'goal',
  'completed',
  'liveUnits',
  'blockers',
  'unsavedRulings',
  'queue',
  'todo',
  'gotchas'
] as const

/** The exact `## ` heading title for each section, in `CHECKPOINT_SECTION_ORDER`. */
export const CHECKPOINT_SECTION_TITLES: Record<keyof CheckpointSections, string> = {
  goal: 'Goal',
  completed: 'Completed and verified work',
  liveUnits: 'Live units',
  blockers: 'Blockers',
  unsavedRulings: 'Unsaved rulings',
  queue: 'Queue',
  todo: 'Todo list',
  gotchas: 'Gotchas'
}

/** A succession record's lifecycle (D-R215 §Protocol steps 3/4/6/7). Transitions enforced by
 * `chair-succession-store.ts`'s `transition()`: sealed→launching→confirming→confirmed, and
 * sealed/launching/confirming→aborted; every other pair throws `succession_bad_transition`.
 * B3 repair: `confirming` is entered under the per-chair lock BEFORE the incumbent's pane is
 * closed, so `runAbortTail` (racing on the same lock) can tell "accept already committed to
 * closing the incumbent" apart from "still parked" and never double-close. */
export type SuccessionState = 'sealed' | 'launching' | 'confirming' | 'confirmed' | 'aborted'

export type SuccessionReason = 'batch_end' | 'context'

export type IncumbentHandle = {
  paneKey: string
  terminalHandle: string
  sessionId?: string
}

export type SuccessorHandle = {
  paneKey?: string
  sessionId?: string
  /** WAVE 2 addition (additive only): the successor pane's terminal handle — needed to
   * `closeTerminal` a launching-but-never-accepted successor on abort, and to register the
   * dead-pane takeover at confirm. Absent on records written before this field existed. */
  terminalHandle?: string
}

/** `<root>/successions/<id>/meta.json` — the succession record's durable state, written only
 * through `chair-succession-store.ts`'s atomic writer. */
export type SuccessionMeta = {
  id: string
  chair: string
  state: SuccessionState
  createdAt: string
  updatedAt: string
  reason: SuccessionReason
  checkpointSha: string
  charterSha: string
  incumbent: IncumbentHandle
  successor: SuccessorHandle
  retiredHandle?: string
  abortReason?: string
  /** S10-22a residual R238: the delivery ids acknowledged (`--ack`) at seal time, carried through
   * to `acceptSuccession`'s `obligations.ackedDeliveryIds` — additive, optional so existing
   * meta.json files without it still parse. */
  ackedDeliveryIds?: string[]
  /** G1 repair L3: the Run id seal bound to, persisted so accept can refuse
   * `succession_run_moved` if the incumbent no longer holds it by accept time — optional so
   * pre-repair meta.json files without it still parse. */
  runId?: string
  /** G1 attempt-3 repair F3: the manifest's `lastSessionId` (falling back to `conversationId`)
   * AT SEAL TIME — the startup tail's confirm-resolution only overwrites the manifest while it
   * still holds this exact value, so a session the successor (or a later restore) has already
   * moved on from is never regressed by a stranded record resolved at the next restart. Optional
   * so pre-repair meta.json files without it still parse (the startup tail then falls back to
   * always writing, its pre-repair shape). */
  preSuccessionSessionId?: string | null
}

/** Whether the resume context embeds the charter text or only references it (D-R215 amendment
 * A6b) — 'reference' is the default; 'embed' fires only when the lane has no charter on disk. */
export type CharterMode = 'reference' | 'embed'

export type ResumeContextRunBinding = {
  chair: string
  agentId: string
  runId: string
  generation: number
  handle: string
  lane: string
  worktree: string
}

export type ResumeContextObligations = {
  ackedDeliveryIds: string[]
  outstandingDeliveryIds: string[]
  retiredHandle: string | null
  pendingPeerQuestionThreadIds: string[]
  pactTurnsHeld: number
}

export type ResumeContextBoardWorktree = {
  path: string
  branch: string
  tip: string
}

export type ResumeContextBoardTask = {
  id: string
  title: string
  state: string
}

export type ResumeContextBoardSeat = {
  name: string
  pane: string
  state: string
}

export type ResumeContextBoard = {
  worktrees: ResumeContextBoardWorktree[]
  unfinishedTasks: ResumeContextBoardTask[]
  liveSeats: ResumeContextBoardSeat[]
}

export type ResumeContextCharter = {
  path: string
  sha256: string
  mode: CharterMode
  /** Required when `mode === 'embed'`; ignored otherwise. */
  text?: string
}

/** `renderResumeContext`'s whole input — a pure value, no I/O, so the renderer can be unit
 * tested without a store. */
export type ResumeContextInput = {
  successionId: string
  charter: ResumeContextCharter
  runBinding: ResumeContextRunBinding
  obligations: ResumeContextObligations
  board: ResumeContextBoard
  /** The already-validated checkpoint text (fenced verbatim in the `## Checkpoint` section). */
  checkpointText: string
  checkpointSha: string
}
