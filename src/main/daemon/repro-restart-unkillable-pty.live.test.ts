// LIVE repro (Linux, real processes): a deliberate restart must never proceed while the old daemon
// PROCESS is still alive. Gated: runs only with ORCA_LIVE_REPRO=1 on Linux; otherwise skipped.
//   env ORCA_LIVE_REPRO=1 [ORCA_LIVE_REPRO_DAEMON_ENTRY=<built daemon-entry.js>] [ORCA_LIVE_REPRO_SCRATCH=<dir>] \
//     pnpm exec vitest run --config config/vitest.config.ts --maxWorkers=1 <this file>
// Needs a built entry (default out/main/daemon-entry.js). Windows pipe semantics are SIMULATED by a
// listen() preload; only the main-side invariant "predecessor is dead when step 3 returns" is proven.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROTOCOL_VERSION } from './types'
import { DaemonClient } from './client'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'

const { breadcrumbs } = vi.hoisted(() => ({
  breadcrumbs: [] as { name: string; data: Record<string, unknown> | undefined }[]
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/nonexistent-live-repro-userdata',
    getAppPath: () => '/nonexistent-live-repro-app',
    getVersion: () => '0.0.0-live-repro'
  }
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: (name: string, data?: Record<string, unknown>) => {
    breadcrumbs.push({ name, data })
  }
}))

const HERE = import.meta.dirname
const LIVE = process.env.ORCA_LIVE_REPRO === '1' && process.platform === 'linux'
const SWALLOW_WINDOW_MS = 20_000
const MARKER = 'ORCA_REPRO_UNKILLABLE=1'

// Swallows every real signal aimed at a marked PTY root (pid or process group) for SWALLOW_WINDOW_MS
// after the first attempt, like a ConPTY child that ignores kill for longer than the 8 s dispose wait.
const UNKILLABLE_PRELOAD = `
const { readFileSync } = require('node:fs')
const realKill = process.kill.bind(process)
let firstSwallowAt = 0
process.kill = function (pid, signal) {
  if (signal !== 0 && signal !== undefined) {
    try {
      const target = Math.abs(Number(pid))
      if (readFileSync('/proc/' + target + '/environ', 'latin1').split('\\0').includes('${MARKER}')) {
        firstSwallowAt ||= Date.now()
        if (Date.now() - firstSwallowAt < ${SWALLOW_WINDOW_MS}) {
          process.stderr.write('repro-swallowed-kill pid=' + pid + ' signal=' + String(signal) + '\\n')
          return true
        }
      }
    } catch {}
  }
  return realKill(pid, signal)
}
`

// Keeps the daemon process alive past its own shutdown (process.exit swallowed) so only the identity kill can end it.
const STUCK_EXIT_PRELOAD = `
const realExit = process.exit.bind(process)
const keepAlive = setInterval(() => {}, 1000)
process.exit = function () { process.stderr.write('repro-swallowed-exit\\n') }
setTimeout(() => { clearInterval(keepAlive); realExit(0) }, 60000).unref()
`

// Models a Windows named pipe still held by the predecessor: listen() fails while its pid is alive.
const REFUSE_BIND_PRELOAD = `
const net = require('node:net')
const realListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const predecessor = Number(process.env.ORCA_REPRO_PREDECESSOR_PID)
  let alive = false
  try { process.kill(predecessor, 0); alive = true } catch {}
  if (alive) {
    const where = typeof args[0] === 'string' ? args[0] : 'endpoint'
    const error = Object.assign(new Error('listen EADDRINUSE: address already in use ' + where), {
      code: 'EADDRINUSE', errno: -98, syscall: 'listen', address: where
    })
    process.stderr.write(String(error.message) + '\\n')
    process.nextTick(() => this.emit('error', error))
    return this
  }
  return realListen.apply(this, args)
}
`

// Why a file too: vitest hides console output of passing tests, and the GREEN evidence must be capturable.
function note(message: string): void {
  console.warn(message)
  if (process.env.ORCA_LIVE_REPRO_EVIDENCE) {
    appendFileSync(process.env.ORCA_LIVE_REPRO_EVIDENCE, `${message}\n`)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// Why: daemon-entry skips its main() when VITEST is set, so the daemon must not inherit it.
function hostEnvWithoutVitest(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST'))
  )
}

function electronBinary(): string {
  const root = resolve(HERE, '../../..')
  const rel = readFileSync(join(root, 'node_modules/electron/path.txt'), 'utf8').trim()
  return join(root, 'node_modules/electron/dist', rel)
}

function daemonEntry(): string {
  return (
    process.env.ORCA_LIVE_REPRO_DAEMON_ENTRY ?? resolve(HERE, '../../../out/main/daemon-entry.js')
  )
}

type Launched = { child: ChildProcess; pid: number; logPath: string; stderrPath: string }

describe.runIf(LIVE)('LIVE: restart step 3 vs a daemon whose PTY will not die', () => {
  const owned: number[] = []
  const scratches: string[] = []
  let scratch = ''

  afterAll(() => {
    for (const pid of owned) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    if (process.env.ORCA_LIVE_REPRO_KEEP !== '1') {
      for (const dir of scratches) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  function makeScratch(): string {
    // Why a short dir: the AF_UNIX socket path must fit sun_path; fall back to tmpdir when the base is too long.
    const base = process.env.ORCA_LIVE_REPRO_SCRATCH ?? tmpdir()
    const probe = join(base, 'l-XXXXXX', `daemon-v${PROTOCOL_VERSION}.sock`)
    const root = probe.length <= 104 ? base : tmpdir()
    return mkdtempSync(join(root, 'l-'))
  }

  function launchDaemon(
    label: string,
    runtimeDir: string,
    preloads: string[],
    extraEnv: Record<string, string> = {}
  ): Launched {
    const socketPath = getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION)
    const logPath = join(scratch, `${label}.daemon.log`)
    const stderrPath = join(scratch, `${label}.stderr.log`)
    writeFileSync(stderrPath, '')
    const stderrFd = openSync(stderrPath, 'a')
    const child = fork(
      daemonEntry(),
      [
        '--socket',
        socketPath,
        '--token',
        getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION),
        '--pid-record',
        getDaemonPidPath(runtimeDir, PROTOCOL_VERSION),
        '--launch-nonce',
        `live-repro-${label}`,
        '--entry-path',
        daemonEntry(),
        '--app-version',
        '0.0.0-live-repro',
        '--spawner-exec-path',
        electronBinary(),
        '--log-file',
        logPath
      ],
      {
        cwd: scratch,
        detached: true,
        stdio: ['ignore', 'ignore', stderrFd, 'ipc'],
        execPath: electronBinary(),
        // Why: the vitest worker's own execArgv must not leak into the daemon; the launcher passes only the heap flag.
        execArgv: ['--max-old-space-size=3072'],
        env: {
          ...hostEnvWithoutVitest(),
          ELECTRON_RUN_AS_NODE: '1',
          HOME: join(scratch, 'home'),
          ORCA_USER_DATA_PATH: join(scratch, 'userdata'),
          NODE_OPTIONS: preloads.map((preload) => `--require ${preload}`).join(' '),
          ...extraEnv
        }
      }
    )
    closeSync(stderrFd)
    expect(typeof child.pid).toBe('number')
    owned.push(child.pid as number)
    return { child, pid: child.pid as number, logPath, stderrPath }
  }

  function waitForOutcome(
    daemon: Launched,
    timeoutMs: number
  ): Promise<'ready' | `exit:${string}` | 'timeout'> {
    return new Promise((done) => {
      const timer = setTimeout(() => done('timeout'), timeoutMs)
      daemon.child.once('message', (message: { type?: string }) => {
        if (message?.type === 'ready') {
          clearTimeout(timer)
          done('ready')
        }
      })
      daemon.child.once('exit', (code, signal) => {
        clearTimeout(timer)
        done(`exit:${code ?? signal}`)
      })
    })
  }

  const readLog = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')

  async function runScenario(opts: { stuckExit: boolean }): Promise<{
    aliveAtReturn: boolean
    returnedAfterMs: number
    stages: unknown[]
    killedStage: Record<string, unknown> | undefined
    bOutcome: string
    stderrB: string
    cleanupOk: boolean
  }> {
    scratch = makeScratch()
    scratches.push(scratch)
    breadcrumbs.length = 0
    const runtimeDir = scratch
    mkdirSync(join(scratch, 'home'), { recursive: true })
    mkdirSync(join(scratch, 'userdata'), { recursive: true })
    const unkillable = join(scratch, 'unkillable.cjs')
    const refuseBind = join(scratch, 'refuse-bind.cjs')
    writeFileSync(unkillable, UNKILLABLE_PRELOAD)
    writeFileSync(refuseBind, REFUSE_BIND_PRELOAD)
    const stuckExit = join(scratch, 'stuck-exit.cjs')
    writeFileSync(stuckExit, STUCK_EXIT_PRELOAD)
    const socketPath = getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION)
    const tokenPath = getDaemonTokenPath(runtimeDir, PROTOCOL_VERSION)
    note(`[live-repro] entry=${daemonEntry()} socketPathLen=${socketPath.length}`)

    // 1. Daemon A with an unkillable marked PTY.
    const daemonA = launchDaemon(
      'A',
      runtimeDir,
      opts.stuckExit ? [unkillable, stuckExit] : [unkillable]
    )
    expect(await waitForOutcome(daemonA, 30_000)).toBe('ready')
    const client = new DaemonClient({ socketPath, tokenPath, protocolVersion: PROTOCOL_VERSION })
    await client.ensureConnected()
    await client.request('createOrAttach', {
      sessionId: 'live-repro-chair',
      cols: 80,
      rows: 24,
      command: '/bin/bash',
      env: { ORCA_REPRO_UNKILLABLE: '1' }
    })
    const sessions = await client.request<{ sessions: { sessionId: string; pid?: number }[] }>(
      'listSessions',
      undefined
    )
    const chairPid = readLog(daemonA.logPath).match(
      /"pid":(\d+)[^\n]*"event":"session-created"/
    )?.[1]
    if (chairPid) {
      owned.push(Number(chairPid))
    }
    client.disconnect()
    note(
      `[live-repro] A pid=${daemonA.pid} chairRootPid=${chairPid ?? '?'} sessions=${sessions.sessions.length}`
    )
    expect(isAlive(daemonA.pid)).toBe(true)

    // 2. The real step 3.
    const { cleanupDaemonForProtocol } = await import('./daemon-init')
    const startedAt = Date.now()
    const outcome = await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION).then(
      (value) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, error: error.message })
    )
    const returnedAfterMs = Date.now() - startedAt
    const aliveAtReturn = isAlive(daemonA.pid)
    note(
      `[live-repro] cleanup ${JSON.stringify(outcome)} returnedAfterMs=${returnedAfterMs} aliveAtReturn=${aliveAtReturn}`
    )
    const predecessorCrumbs = breadcrumbs.filter((b) => b.name === 'daemon_restart_predecessor')
    const stages = predecessorCrumbs.map((b) => b.data?.stage)
    note(`[live-repro] breadcrumbs=${JSON.stringify(stages)}`)

    // 3. Positive control: without it the injection did not take and the run is VOID, never a pass.
    const deadline = Date.now() + 30_000
    while (
      Date.now() < deadline &&
      !/shutdown-dispose-failed[^\n]*Timed out waiting for PTY process exit/.test(
        readLog(daemonA.logPath)
      )
    ) {
      await new Promise((r) => setTimeout(r, 200))
    }
    const logA = readLog(daemonA.logPath)
    const injectionLines = logA
      .split('\n')
      .filter((line) => /shutdown|dispose|session-created/.test(line))
    note(`[live-repro] A daemon.log (relevant):\n${injectionLines.join('\n')}`)
    if (!/shutdown-dispose-failed[^\n]*Timed out waiting for PTY process exit/.test(logA)) {
      throw new Error(
        'VOID RUN: daemon A never logged shutdown-dispose-failed "Timed out waiting for PTY process exit"; the unkillable-PTY injection did not take. This is not a pass.'
      )
    }

    // 4. Daemon B: refuses to bind while A lives (the Windows pipe rule, simulated).
    const daemonB = launchDaemon('B', runtimeDir, [refuseBind], {
      ORCA_REPRO_PREDECESSOR_PID: String(daemonA.pid)
    })
    const bOutcome = await waitForOutcome(daemonB, 30_000)
    const stderrB = readLog(daemonB.stderrPath)
      .split('\n')
      .filter((line) => /EADDRINUSE|Fatal|ready/.test(line))
      .slice(0, 3)
      .join('\n')
    note(`[live-repro] B outcome=${bOutcome} aliveAtReturn(A)=${aliveAtReturn}\n${stderrB}`)

    return {
      aliveAtReturn,
      returnedAfterMs,
      stages,
      killedStage: predecessorCrumbs.find((b) => b.data?.stage === 'killed')?.data,
      bOutcome,
      stderrB,
      cleanupOk: outcome.ok
    }
  }

  it('cleanupDaemonForProtocol returns only once the predecessor process is gone; the replacement then reaches ready', async () => {
    const result = await runScenario({ stuckExit: false })

    expect(result.cleanupOk).toBe(true)
    expect(
      result.aliveAtReturn,
      'cleanupDaemonForProtocol returned while the old daemon PROCESS was still alive'
    ).toBe(false)
    expect(
      result.bOutcome,
      `replacement daemon B did not reach ready; stderr: ${result.stderrB}`
    ).toBe('ready')
  }, 150_000)

  it('a predecessor that outlives the bound is killed by identity from the pre-captured record, then the replacement reaches ready', async () => {
    const result = await runScenario({ stuckExit: true })

    expect(result.cleanupOk).toBe(true)
    expect(result.stages).toEqual(['waiting', 'escalating', 'killed'])
    expect(result.killedStage).toMatchObject({ killed: true })
    expect(result.returnedAfterMs).toBeGreaterThan(20_000)
    expect(
      result.aliveAtReturn,
      'cleanupDaemonForProtocol returned while the old daemon PROCESS was still alive'
    ).toBe(false)
    expect(
      result.bOutcome,
      `replacement daemon B did not reach ready; stderr: ${result.stderrB}`
    ).toBe('ready')
  }, 150_000)
})
