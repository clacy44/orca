// [S10-21c B6c, D-R155-b6b finding 1] Gates `index.ts`'s end-of-sweep desktop-materialize drain
// trigger on proof the renderer has already hydrated its tabs. Before this fix that trigger
// (index.ts ~3483) could fire BEFORE `hydrateWorkspaceSession` (App.tsx) replaces
// `tabsByWorktree` wholesale — a reveal handled in that window creates a tab hydration then
// discards, while the queue entry is already deleted and audited `revealed`: permanent silent
// loss, no retry (D-R155-b6b finding 1). App.tsx has FOUR call sites for the
// `app:recoverLegacyWorkerTerminalsForRendererStartup` IPC handler this flag is set from: :1134
// and :1146 on the normal path, both strictly after hydration (App.tsx :1027); :1236 and :1241
// inside the startup-error catch, reached only when hydration itself THREW and never ran — safe
// to mark there too, since that path never re-hydrates afterward (see the handler's own comment
// in index.ts), so there is no later wholesale replacement left to wipe a reveal. [S10-21c
// B-final, D-R157-b6c finding 2] So marking this flag on that handler's first invocation, on
// EITHER path, is a sound proxy for "the renderer has hydrated, or degraded-mode-mounted with
// nothing left to wipe" — and does not require threading any renderer-side signal back into main.
//
// Mirrors `restore-sweep-lock-release-guard.ts`'s split: a tiny mutable state object plus pure
// functions over it, so the decision is testable without Electron or `index.ts`'s own startup
// machinery (index.ts is never imported by a test — see that module's own wiring test, which
// reads it as source text instead).
export type DesktopMaterializeHydrationGateState = {
  rendererHydratedForMaterialize: boolean
}

export function createDesktopMaterializeHydrationGateState(): DesktopMaterializeHydrationGateState {
  return { rendererHydratedForMaterialize: false }
}

/** Call at the TOP of the renderer-startup IPC handler (index.ts ~893), before any `await` —
 * idempotent; only the first call changes anything. */
export function markRendererHydratedForMaterialize(
  state: DesktopMaterializeHydrationGateState
): void {
  state.rendererHydratedForMaterialize = true
}

/** True once the renderer-startup handler has run at least once. False means the renderer has
 * not hydrated yet: the end-of-sweep trigger (index.ts ~3483) must do nothing this call — the
 * renderer-startup handler drains instead when it arrives, and it cannot arrive before
 * hydration. */
export function shouldDrainAtEndOfSweep(state: DesktopMaterializeHydrationGateState): boolean {
  return state.rendererHydratedForMaterialize
}
