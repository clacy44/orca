/**
 * Spawn/kill lifecycle for a `claude` CLI child process — extracted from
 * service.ts's `runClaudeCommand` (AGENTS.md: ratcheted files take delegating
 * calls only; logic lives in new, concretely-named modules). Owns spawn config
 * resolution (WSL / win32 / posix), process-group teardown on posix, taskkill on
 * win32, the win32 "auth login" close-vs-exit special case, and cleanup — NOT
 * output accumulation, truncation, or content-based decisions (e.g. detecting an
 * auth-denied message in the output), which stay with the caller and reach this
 * module only as a `kill(rejectionError)` call.
 *
 * `onStdoutChunk`/`onStderrChunk` fire with each raw chunk as it arrives, before
 * any accumulation — the live-stream feed a chunk-driven parser (the login URL,
 * the paste-code prompt; see lane-login-url-parser.ts) must be fed from, never
 * from a caller's own truncated buffer.
 */
import { spawn } from 'node:child_process'
import { resolveClaudeCommand } from '../codex-cli/command'
import { buildWindowsCommandInvocation } from './windows-command-invocation'

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export type ClaudeCliChildProcessConfigDir = {
  windowsPath: string
  linuxPath: string | null
  wslDistro: string | null
}

export type ClaudeCliChildProcessOptions = {
  signal?: AbortSignal
  keepStdinOpen?: boolean
  onStdoutChunk?: (chunk: string) => void
  onStderrChunk?: (chunk: string) => void
  timeoutMessage?: string
  cancelMessage?: string
}

export type ClaudeCliChildProcessHandle = {
  /** Writes to the child's stdin. No-op unless `keepStdinOpen` was set and the
   * process is still alive — callers must not assume the write landed. */
  writeStdin(data: string): void
  /** Idempotent: terminates the process group (posix) / process tree (win32
   * taskkill via `/pid /t /f`). `rejectionError`, when given, becomes the
   * `result` promise's rejection — lets a caller watching its own accumulated
   * output attribute the kill to a specific cause (e.g. a denial message). */
  kill(rejectionError?: Error): void
}

export type ClaudeCliChildProcessSpawn = {
  handle: ClaudeCliChildProcessHandle
  /** Resolves with the exit code on ANY completed run, including a non-zero
   * exit — callers decide what counts as failure from their own accumulated
   * output. Rejects only on timeout, abort, an explicit `kill(error)`, or a
   * native spawn/stream error. */
  result: Promise<{ code: number | null }>
}

export function spawnClaudeCliChildProcess(
  args: string[],
  configDir: ClaudeCliChildProcessConfigDir,
  timeoutMs: number,
  options: ClaudeCliChildProcessOptions = {}
): ClaudeCliChildProcessSpawn {
  let resolveResult!: (value: { code: number | null }) => void
  let rejectResult!: (error: Error) => void
  const result = new Promise<{ code: number | null }>((res, rej) => {
    resolveResult = res
    rejectResult = rej
  })

  const spawnConfig =
    configDir.linuxPath && configDir.wslDistro
      ? {
          command: 'wsl.exe',
          args: [
            '-d',
            configDir.wslDistro,
            '--',
            'bash',
            '-lc',
            `export CLAUDE_CONFIG_DIR=${shellQuote(configDir.linuxPath)}; exec claude ${args.map(shellQuote).join(' ')}`
          ],
          env: process.env,
          shell: false,
          windowsVerbatimArguments: false
        }
      : process.platform === 'win32'
        ? {
            ...buildWindowsCommandInvocation(resolveClaudeCommand(), args),
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir.windowsPath },
            shell: false
          }
        : {
            command: resolveClaudeCommand(),
            args,
            env: { ...process.env, CLAUDE_CONFIG_DIR: configDir.windowsPath },
            shell: false,
            windowsVerbatimArguments: false
          }
  const child = spawn(spawnConfig.command, spawnConfig.args, {
    // Why: Claude's browser auth can bind its callback lifetime to stdin.
    // Keeping stdin open prevents hidden managed-login runs from tearing down
    // the local callback server before the browser returns.
    stdio: [options.keepStdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: spawnConfig.shell,
    windowsVerbatimArguments: spawnConfig.windowsVerbatimArguments,
    env: spawnConfig.env,
    // Why: Claude auth can leave browser/login descendants alive after denial.
    // A process group lets cancellation terminate the whole POSIX login tree.
    detached: process.platform !== 'win32'
  })
  const handle: ClaudeCliChildProcessHandle = {
    writeStdin: (data) => {
      child.stdin?.write(data)
    },
    kill: (rejectionError) =>
      killChild(() =>
        settle(() => rejectResult(rejectionError ?? new Error('Claude command was terminated.')))
      )
  }
  const stdout = child.stdout
  const stderr = child.stderr
  if (!stdout || !stderr) {
    if (options.keepStdinOpen) {
      child.stdin?.destroy()
    }
    child.kill()
    rejectResult(new Error('Claude command failed to open output streams.'))
    return { handle, result }
  }
  const completesOnExit =
    process.platform === 'win32' &&
    configDir.linuxPath === null &&
    configDir.wslDistro === null &&
    args[0] === 'auth' &&
    args[1] === 'login'
  const completionEvent = completesOnExit ? 'exit' : 'close'

  let settled = false
  const onStdoutData = (chunk: Buffer): void => options.onStdoutChunk?.(chunk.toString())
  const onStderrData = (chunk: Buffer): void => options.onStderrChunk?.(chunk.toString())
  let timeout: ReturnType<typeof setTimeout> | null = null
  const cleanupListeners = (): void => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    stdout.off('data', onStdoutData)
    stderr.off('data', onStderrData)
    child.off('error', onError)
    child.off(completionEvent, onDone)
    options.signal?.removeEventListener('abort', onAbort)
    if (options.keepStdinOpen) {
      child.stdin?.destroy()
    }
    if (completesOnExit) {
      stdout.destroy()
      stderr.destroy()
    }
  }
  const settle = (callback: () => void): void => {
    if (settled) {
      return
    }
    settled = true
    cleanupListeners()
    callback()
  }
  let terminationPending = false
  function killChild(afterKill: () => void): void {
    if (terminationPending || settled) {
      return
    }
    terminationPending = true
    if (process.platform === 'win32' && child.pid) {
      const taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      let taskkillFinished = false
      const finishTaskkill = (succeeded: boolean): void => {
        if (taskkillFinished) {
          return
        }
        taskkillFinished = true
        clearTimeout(taskkillTimeout)
        if (!succeeded) {
          child.kill()
        }
        afterKill()
      }
      const taskkillTimeout = setTimeout(() => {
        taskkill.kill()
        finishTaskkill(false)
      }, WINDOWS_TASKKILL_TIMEOUT_MS)
      taskkill.once('error', () => finishTaskkill(false))
      taskkill.once('close', (code) => finishTaskkill(code === 0))
      return
    }
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid)
        afterKill()
        return
      } catch {
        // Fall back to the direct child if the process group is unavailable.
      }
    }
    child.kill()
    afterKill()
  }
  timeout = setTimeout(() => {
    killChild(() =>
      settle(() =>
        rejectResult(new Error(options.timeoutMessage ?? 'Claude sign-in took too long to finish.'))
      )
    )
  }, timeoutMs)

  const onAbort = (): void => {
    killChild(() =>
      settle(() =>
        rejectResult(new Error(options.cancelMessage ?? 'Claude sign-in was cancelled.'))
      )
    )
  }
  const onError = (error: Error): void => {
    if (terminationPending) {
      return
    }
    settle(() => rejectResult(error))
  }
  const onDone = (code: number | null): void => {
    if (terminationPending) {
      return
    }
    settle(() => resolveResult({ code }))
  }

  stdout.on('data', onStdoutData)
  stderr.on('data', onStderrData)
  child.on('error', onError)
  // Native Windows browsers can inherit these pipes and indefinitely delay close.
  child.on(completionEvent, onDone)

  if (options.signal?.aborted) {
    onAbort()
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true })
  }

  return { handle, result }
}
