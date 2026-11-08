import {
  loadIpcEventsHarness,
  type HarnessStoreState,
  type IpcEventsHarness,
  type IpcEventsHarnessOptions
} from './ipc-events-test-harness'

// Extends the base harness (kept in its own file so that one stays under the max-lines budget)
// with `window.api.session.onLiveAgentSessions`, the main-process push of live agent-session marks.
export type IpcEventsLiveSessionHarness = IpcEventsHarness & {
  /** Deliver a main-process push of the host's live agent-session marks. */
  pushLiveAgentSessions: (marks: unknown) => void
}

export async function loadIpcEventsHarnessWithLiveSessionPush(
  storeState: HarnessStoreState,
  options: IpcEventsHarnessOptions = {}
): Promise<IpcEventsLiveSessionHarness> {
  const harness = await loadIpcEventsHarness(storeState, options)
  let listener: ((marks: unknown) => void) | null = null
  const sessionApi: Record<string, unknown> = {
    onLiveAgentSessions: (callback: (marks: unknown) => void) => {
      listener = callback
      return () => {}
    }
  }
  // Same default as the base harness: every other `session` subscription is a no-op.
  ;(window.api as unknown as Record<string, unknown>).session = new Proxy(sessionApi, {
    get: (target, prop: string) => (prop in target ? target[prop] : () => () => {})
  })
  return {
    ...harness,
    pushLiveAgentSessions: (marks) => {
      if (typeof listener !== 'function') {
        throw new Error('Expected the live agent-session push listener to be registered')
      }
      listener(marks)
    }
  }
}
