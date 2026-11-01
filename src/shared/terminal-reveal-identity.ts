export type TerminalRevealIdentity = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
}

export type TerminalTabCreateReply = {
  requestId: string
  tabId?: string
  title?: string
  identity?: TerminalRevealIdentity
  // Why: a materialize-only reveal that found the terminal already recorded by a tab in this
  // window changes nothing; main records a receipt instead of treating the missing identity as
  // a mismatch.
  skipped?: 'owned'
  error?: string
}

// Why: main tells "this reveal can never succeed this epoch" apart from "retry on the next
// call" by these reply errors; both sides import them so the strings cannot drift.
export const MATERIALIZE_ONLY_ERROR_AMBIGUOUS = 'terminal_materialize_ownership_ambiguous'
export const MATERIALIZE_ONLY_ERROR_TAB_CONFLICT = 'terminal_materialize_tab_conflict'
export const MATERIALIZE_ONLY_ERROR_UNKNOWN_WORKTREE = 'terminal_materialize_unknown_worktree'
