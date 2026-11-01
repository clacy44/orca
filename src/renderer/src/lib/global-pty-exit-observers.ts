// Leaf module: the PTY dispatcher cannot import the store (the store's slices import terminal
// modules back), so store-side consumers register here and the dispatcher only notifies.
const observers = new Set<(ptyId: string) => void>()

export function registerGlobalPtyExitObserver(observer: (ptyId: string) => void): () => void {
  observers.add(observer)
  return () => {
    observers.delete(observer)
  }
}

export function notifyGlobalPtyExitObservers(ptyId: string): void {
  for (const observer of observers) {
    try {
      observer(ptyId)
    } catch (error) {
      console.error('[pty] exit observer failed:', error)
    }
  }
}
