export type PtyDisposable = {
  dispose: () => void
}

export type HiddenPty = {
  kill: (signal?: string) => void
  destroy?: () => void
  /** Read by the close-wipe fence, which resolves on the child's exit rather than on the signal. */
  onExit?: (listener: () => void) => PtyDisposable | undefined | void
}

const activeHiddenRateLimitPtys = new Set<HiddenPty>()

export function registerHiddenRateLimitPty(term: HiddenPty): PtyDisposable {
  activeHiddenRateLimitPtys.add(term)
  return {
    dispose: () => {
      activeHiddenRateLimitPtys.delete(term)
    }
  }
}

export function getActiveHiddenRateLimitPtyCount(): number {
  return activeHiddenRateLimitPtys.size
}

export function cleanupHiddenRateLimitPty(
  term: HiddenPty,
  disposables: PtyDisposable[],
  options: { kill: boolean }
): void {
  for (const disposable of disposables.splice(0)) {
    disposable.dispose()
  }

  if (options.kill) {
    try {
      term.kill()
    } catch {
      /* already exited */
    }

    // Why: node-pty WindowsTerminal.destroy() calls kill() again, which can
    // close the same ConPTY handle twice after an intentional termination.
    if (process.platform === 'win32') {
      return
    }
  }

  // Why: node-pty destroy releases the master PTY fd; on POSIX, neutralize
  // the post-close SIGHUP hook after exit/kill to avoid pid reuse.
  if (process.platform !== 'win32') {
    term.kill = () => {}
  }
  try {
    term.destroy?.()
  } catch {
    /* already torn down */
  }
}
