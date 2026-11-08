import { useAppStore } from '@/store'

// Why: the host's live agent-session marks are otherwise hydrated only at startup, so a pty born
// later (a restored chair, a background worker) looks absent and a resume pass could open a second
// tab for its conversation. Main pushes a fresh set after such a pty appears; the push replaces
// the marks the same way the startup hydration does.
export function subscribeLiveAgentSessionPush(): () => void {
  const unsubscribe = window.api.session?.onLiveAgentSessions?.((marks) => {
    if (Array.isArray(marks)) {
      useAppStore.getState().setLiveAgentSessions(marks)
    }
  })
  return unsubscribe ?? (() => {})
}
