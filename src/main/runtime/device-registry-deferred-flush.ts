// Split out of device-registry.ts to stay under the max-lines ratchet: a tiny debounce timer with
// no DeviceRegistry-specific knowledge, reused as-is for the lastSeen coalescing flush.
export class DeferredFlushTimer {
  private handle: NodeJS.Timeout | null = null

  constructor(
    private readonly delayMs: number,
    private readonly onFire: () => void
  ) {}

  get pending(): boolean {
    return this.handle !== null
  }

  /**
   * No-op while already pending — one flush covers every scheduling call in between.
   * `onFire` is responsible for clearing pending state itself (typically via `cancel()`) —
   * the handle stays set across the fire so `pending` reads true from inside the callback,
   * exactly as a caller would expect a "still due" flush to report.
   */
  schedule(): void {
    if (this.handle) {
      return
    }
    this.handle = setTimeout(() => this.onFire(), this.delayMs)
    // Why: bookkeeping must never hold the process open.
    this.handle.unref?.()
  }

  cancel(): void {
    if (this.handle) {
      clearTimeout(this.handle)
      this.handle = null
    }
  }
}
