/**
 * Spawns one lane login's `claude auth login` child and wires the live stdout stream through the
 * URL/prompt parsers (S9-L1 A1 split out of `lane-login-session.ts` for the 300-line ratchet).
 *
 * Mutates the caller's session fields directly rather than emitting events, because the fields
 * ARE the state `submitCode`/`cancelStateTransition` read — an event layer here would just be a
 * second copy of that state to keep in sync.
 */
import {
  spawnClaudeCliChildProcess,
  type ClaudeCliChildProcessHandle
} from './claude-cli-child-process'
import {
  createAuthorizeUrlAccumulator,
  createPasteCodePromptWatcher
} from './lane-login-url-parser'

/** The subset of a login session's mutable fields this module writes to, live, per chunk. */
export type LaneLoginChildSink = {
  authDir: string
  promptWasShowing: boolean
  pasteReady: boolean
  promptEdgeCount: number
  pasteReadyWaiters: (() => void)[]
  promptEdgeWaiters: (() => void)[]
}

export type LaneLoginChildSpawn = {
  handle: ClaudeCliChildProcessHandle
  result: Promise<{ code: number | null }>
  /** Resolves with the first relayable authorization URL, or rejects with a refusal — never
   * hangs, even if the child exits or errors before printing one (§2b). */
  urlPromise: Promise<string>
}

export function spawnLaneLoginChild(
  sink: LaneLoginChildSink,
  timeoutMs: number
): LaneLoginChildSpawn {
  const urlAccumulator = createAuthorizeUrlAccumulator()
  const promptWatcher = createPasteCodePromptWatcher()
  let urlSettled = false
  let resolveUrl!: (url: string) => void
  let rejectUrl!: (error: unknown) => void
  const urlPromise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveUrl = resolvePromise
    rejectUrl = rejectPromise
  })

  const { handle, result } = spawnClaudeCliChildProcess(
    ['auth', 'login', '--claudeai'],
    { windowsPath: sink.authDir, linuxPath: null, wslDistro: null },
    timeoutMs,
    {
      keepStdinOpen: true,
      // Fed from the LIVE chunk stream, never an accumulated/truncated buffer (§A3).
      onStdoutChunk: (chunk) => {
        if (!urlSettled) {
          try {
            const url = urlAccumulator.feed(chunk)
            if (url) {
              urlSettled = true
              resolveUrl(url)
            }
          } catch (error) {
            urlSettled = true
            rejectUrl(error)
          }
        }
        const promptNow = promptWatcher.feed(chunk)
        if (promptNow && !sink.promptWasShowing) {
          sink.promptWasShowing = true
          sink.promptEdgeCount += 1
          if (!sink.pasteReady) {
            sink.pasteReady = true
          }
          // The paste prompt IS the CLI's own "I have finished printing the URL" signal (§2b): a
          // child that reaches it without ever completing a URL candidate (prints only the paste
          // prompt, or a still-unterminated fragment) must decide NOW, not park the caller for the
          // full login timeout waiting for a candidate that will never arrive.
          if (!urlSettled) {
            urlSettled = true
            try {
              resolveUrl(urlAccumulator.finish())
            } catch (error) {
              rejectUrl(error)
            }
          }
          flush(sink.pasteReadyWaiters)
          flush(sink.promptEdgeWaiters)
        } else if (!promptNow) {
          sink.promptWasShowing = false
        }
      }
    }
  )
  // A child that exits (or errors) before ever printing a relayable URL must not leave the
  // caller hanging — `finish()` treats whatever is left in the buffer as final, resolving or
  // refusing accordingly.
  void result.then(
    () => {
      if (!urlSettled) {
        urlSettled = true
        try {
          resolveUrl(urlAccumulator.finish())
        } catch (error) {
          rejectUrl(error)
        }
      }
    },
    (error) => {
      if (!urlSettled) {
        urlSettled = true
        rejectUrl(error)
      }
    }
  )
  return { handle, result, urlPromise }
}

function flush(waiters: (() => void)[]): void {
  const toFlush = waiters.splice(0)
  for (const waiter of toFlush) {
    waiter()
  }
}
