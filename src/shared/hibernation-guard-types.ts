// Why: R316 — the host-computed verdict the renderer's agent-sleep planner consumes. Panes the
// host protects (registered or chair) never sleep; a pane sleeps only on a positive 'idle'
// background-work verdict. 'unknown' and absent both refuse (fail closed).
export type BackgroundWorkVerdict = 'idle' | 'busy' | 'unknown'

export type HibernationGuardSnapshot = {
  protectedPaneKeys: string[]
  backgroundWork: Record<string, BackgroundWorkVerdict>
}

export const HIBERNATION_GUARD_MAX_PANE_KEYS = 512

export function isBackgroundWorkVerdict(value: unknown): value is BackgroundWorkVerdict {
  return value === 'idle' || value === 'busy' || value === 'unknown'
}
