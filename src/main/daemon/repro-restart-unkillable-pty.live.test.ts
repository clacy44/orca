// LIVE repro (Linux, real processes): a deliberate restart must never proceed while the old daemon
// PROCESS is still alive. Gated: runs only with ORCA_LIVE_REPRO=1 on Linux; otherwise skipped.
//   env ORCA_LIVE_REPRO=1 [ORCA_LIVE_REPRO_DAEMON_ENTRY=<built daemon-entry.js>] [ORCA_LIVE_REPRO_SCRATCH=<dir>] \
//     pnpm exec vitest run --config config/vitest.config.ts --maxWorkers=1 <this file>
// Needs a built entry (default out/main/daemon-entry.js). Windows pipe semantics are SIMULATED by a
// listen() preload; only the main-side invariant "predecessor is dead when step 3 returns" is proven.
// The FX-3 phase drives the REAL runRestartDaemon/launcher/adapter against real daemons; only the
// pty.ts boundary (hold + session-loss handler wiring) is a harness built from the real pure modules.
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import type * as NodeChildProcess from 'node:child_process'
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
import { dirname, join, resolve } from 'node:path'
import { PROTOCOL_VERSION } from './types'
import { DaemonClient } from './client'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'

type LiveLaunch = { index: number; label: string; pid: number | undefined }
const { breadcrumbs, liveCtx } = vi.hoisted(() => ({
  breadcrumbs: [] as { name: string; data: Record<string, unknown> | undefined }[],
  liveCtx: {
    userData: '/nonexistent-live-repro-userdata',
    appPath: '/nonexistent-live-repro-app',
    // Set by the FX-3 phase: rewrites the launcher's own fork() options so the daemon runs under Electron-as-node.
    interceptFork: null as
      | null
      | ((index: number, opts: Record<string, unknown>) => Record<string, unknown>),
    launches: [] as LiveLaunch[],
    // The pty.ts boundary harness records what main would have told the window.
    notices: [] as { epoch: number; sessions: { id: string }[] }[],
    rendererExits: [] as string[],
    mainExits: [] as string[],
    audits: [] as string[][],
    handBacks: [] as string[][],
    incarnations: new Map<string, string>(),
    onNotice: null as null | ((ids: string[]) => void)
  }
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => liveCtx.userData,
    getAppPath: () => liveCtx.appPath,
    getVersion: () => '0.0.0-live-repro'
  }
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: (name: string, data?: Record<string, unknown>) => {
    breadcrumbs.push({ name, data })
  }
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return {
    ...actual,
    fork: ((entry: string, args: string[], opts: Record<string, unknown>) => {
      const index = liveCtx.launches.length
      const child = actual.fork(
        entry,
        args,
        (liveCtx.interceptFork ? liveCtx.interceptFork(index, opts) : opts) as never
      )
      if (liveCtx.interceptFork) {
        liveCtx.launches.push({
          index,
          label: ['A', 'B', 'C'][index] ?? `L${index}`,
          pid: child.pid
        })
      }
      return child
    }) as typeof actual.fork
  }
})
// The pty.ts boundary: the REAL restart hold and the REAL session-loss handler, wired the way pty.ts wires them.
vi.mock('../ipc/pty', async () => {
  const { createRestartExitHold } = await import('../ipc/pty-daemon-restart-hold')
  const { createDaemonSessionLossHandler } = await import('../ipc/pty-daemon-session-loss')
  type Held = { id: string; incarnationId?: string }
  type Provider = {
    onExit: (
      cb: (payload: { id: string; code: number; incarnationId?: string }) => void
    ) => () => void
    onSessionsLostToDaemonDeath?: (cb: (event: never) => void) => () => void
  }
  const hold = createRestartExitHold()
  let provider: Provider | null = null
  let unsubs: (() => void)[] = []
  const isCurrent = ({ id, incarnationId }: Held): boolean => {
    const current = liveCtx.incarnations.get(id)
    return !current || incarnationId === current
  }
  const handleLost = createDaemonSessionLossHandler({
    isCurrentPtyExit: isCurrent,
    isSpawnInFlight: () => false,
    notifyDaemonDiedFanout: (ids) => liveCtx.audits.push([...ids]),
    planRecovery: async (sessions) =>
      sessions.map(({ id }) => ({ id, paneKey: `tab:${id}`, peerOwned: false, reanchor: true })),
    applyProviderPtyExitState: ({ id }) => {
      liveCtx.mainExits.push(id)
      liveCtx.incarnations.delete(id)
    },
    sendExitToRenderer: ({ id }) => liveCtx.rendererExits.push(id),
    sendToRenderer: (payload) => {
      liveCtx.notices.push(payload)
      const ids = payload.sessions.map(({ id }) => id)
      // Why async: the renderer relaunches after its remount, never inside main's notice block.
      setTimeout(() => liveCtx.onNotice?.(ids), 0)
      return true
    },
    recordBreadcrumb: (name, data) => breadcrumbs.push({ name, data })
  })
  const unbind = (): void => {
    for (const unsub of unsubs) {
      unsub()
    }
    unsubs = []
  }
  const bind = (): void => {
    unbind()
    if (!provider) {
      return
    }
    unsubs.push(
      provider.onExit((payload) => {
        if (hold.captureIfHeld(payload)) {
          return
        }
        liveCtx.rendererExits.push(payload.id)
      })
    )
    const unsubLost = provider.onSessionsLostToDaemonDeath?.((event) => void handleLost(event))
    if (unsubLost) {
      unsubs.push(unsubLost)
    }
  }
  const release = async (
    options:
      | { mode: 'announce'; epoch: number }
      | { mode: 'exit' }
      | { mode: 'handback'; adopt: (held: Held[]) => Held[] }
  ): Promise<void> => {
    const released = hold.release()
    if (!released) {
      return
    }
    try {
      if (options.mode === 'announce') {
        await handleLost(
          { epoch: options.epoch, sessions: released.captured },
          {
            auditWritten: true,
            cause: 'manual_restart',
            exitUnnotified: true,
            excludeAfterPlan: released.isLateExit
          }
        )
        return
      }
      const exiting =
        options.mode === 'handback'
          ? options.adopt(released.captured.filter(isCurrent))
          : released.captured.filter(isCurrent)
      if (options.mode === 'handback') {
        liveCtx.handBacks.push(released.captured.map(({ id }) => id))
      }
      for (const { id } of exiting) {
        liveCtx.mainExits.push(id)
        liveCtx.incarnations.delete(id)
        liveCtx.rendererExits.push(id)
      }
    } finally {
      released.settle()
    }
  }
  return {
    getLocalPtyProvider: () => provider,
    setLocalPtyProvider: (next: Provider) => {
      provider = next
    },
    unbindLocalProviderListeners: unbind,
    rebindLocalProviderListeners: bind,
    beginRestartExitHold: (ids: Iterable<string>) => hold.begin(ids),
    releaseRestartExitHold: release,
    closeRestartSpawnFence: () => hold.closeFence(),
    awaitRestartSpawnDrain: async () => {}
  }
})

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

// Models a Windows named pipe still held by the predecessor: listen() fails while its pid is alive (always, when none is named).
const REFUSE_BIND_PRELOAD = `
const net = require('node:net')
const realListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  const raw = process.env.ORCA_REPRO_PREDECESSOR_PID
  let alive = !raw
  if (raw) { try { process.kill(Number(raw), 0); alive = true } catch {} }
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

  function makeScratch(subdir = ''): string {
    // Why a short dir: the AF_UNIX socket path must fit sun_path; fall back to tmpdir when the base is too long.
    const base = process.env.ORCA_LIVE_REPRO_SCRATCH ?? tmpdir()
    const probe = join(base, 'l-XXXXXX', subdir, `daemon-v${PROTOCOL_VERSION}.sock`)
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

  it('FX-3: a restart that fails after step 3 hands the held agent back; once a healthy daemon is confirmed it is announced once, not exited', async () => {
    scratch = makeScratch('daemon')
    scratches.push(scratch)
    breadcrumbs.length = 0
    Object.assign(liveCtx, {
      notices: [],
      rendererExits: [],
      mainExits: [],
      audits: [],
      handBacks: []
    })
    liveCtx.launches.length = 0
    liveCtx.incarnations.clear()
    liveCtx.userData = scratch
    liveCtx.appPath = dirname(daemonEntry())
    mkdirSync(join(scratch, 'home'), { recursive: true })
    const unkillable = join(scratch, 'unkillable.cjs')
    const refuseBind = join(scratch, 'refuse-bind.cjs')
    writeFileSync(unkillable, UNKILLABLE_PRELOAD)
    writeFileSync(refuseBind, REFUSE_BIND_PRELOAD)
    const preloadFor = (index: number): string =>
      index === 0 ? `--require ${unkillable}` : index === 1 ? `--require ${refuseBind}` : ''
    // Launch A runs the unkillable PTY, launch B (step 4) fails once with EADDRINUSE, later launches are healthy.
    const predecessorAliveAtFork: Record<number, boolean> = {}
    liveCtx.interceptFork = (index, opts) => {
      const first = liveCtx.launches[0]?.pid
      predecessorAliveAtFork[index] = first !== undefined && isAlive(first)
      return {
        ...opts,
        execPath: electronBinary(),
        execArgv: ['--max-old-space-size=3072'],
        env: {
          ...Object.fromEntries(
            Object.entries(opts.env as Record<string, string>).filter(
              ([key]) => !key.startsWith('VITEST')
            )
          ),
          HOME: join(scratch, 'home'),
          NODE_OPTIONS: preloadFor(index)
        }
      }
    }
    const daemonLogPath = join(scratch, 'logs', 'daemon.log')
    const {
      getDaemonProvider,
      restartDaemon,
      setDaemonDiedFanoutHandler,
      shutdownDaemon,
      initDaemonPtyProvider
    } = await import('./daemon-init')
    setDaemonDiedFanoutHandler((ids) => liveCtx.audits.push([...ids]))
    const spawnChair = async (): Promise<string | undefined> => {
      const provider = getDaemonProvider() as unknown as {
        spawn: (opts: Record<string, unknown>) => Promise<{ id: string; incarnationId?: string }>
      }
      const result = await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: scratch,
        sessionId: 'live-repro-chair',
        env: { SHELL: '/bin/bash', ORCA_REPRO_UNKILLABLE: '1' }
      })
      if (result.incarnationId) {
        liveCtx.incarnations.set(result.id, result.incarnationId)
      }
      return result.incarnationId
    }
    let relaunches = 0
    liveCtx.onNotice = (ids) => {
      relaunches += ids.length
      void spawnChair().catch((error) => note(`[live-repro] relaunch failed: ${String(error)}`))
    }

    try {
      await initDaemonPtyProvider()
      const first = await spawnChair()
      note(`[live-repro] FX-3: A pid=${liveCtx.launches[0]?.pid} chair incarnation=${first}`)
      expect(isAlive(liveCtx.launches[0]?.pid ?? -1)).toBe(true)

      const restart = await restartDaemon().then(
        () => ({ ok: true as const, message: '' }),
        (error: Error) => ({ ok: false as const, message: error.message })
      )
      const logLines = (): { pid: number; event: string; ts: string }[] =>
        readLog(daemonLogPath)
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as { pid: number; event: string; ts: string })
      const pidA = liveCtx.launches[0]?.pid
      const deadline = Date.now() + 60_000
      while (
        Date.now() < deadline &&
        liveCtx.notices.length === 0 &&
        liveCtx.rendererExits.length === 0
      ) {
        await new Promise((r) => setTimeout(r, 200))
      }
      await new Promise((r) => setTimeout(r, 1_500))
      const lines = logLines()
      const pidC = liveCtx.launches[2]?.pid
      note(
        `[live-repro] FX-3: restart ${JSON.stringify(restart).slice(0, 220)}\n` +
          `launches=${JSON.stringify(liveCtx.launches)} predecessorAliveAtFork=${JSON.stringify(predecessorAliveAtFork)}\n` +
          `notices=${JSON.stringify(liveCtx.notices)} rendererExits=${JSON.stringify(liveCtx.rendererExits)} handBacks=${JSON.stringify(liveCtx.handBacks)}\n` +
          `audits=${JSON.stringify(liveCtx.audits)} relaunches=${relaunches}\n` +
          `predecessor stages=${JSON.stringify(breadcrumbs.filter((b) => b.name === 'daemon_restart_predecessor').map((b) => b.data?.stage))}\n` +
          `daemon_sessions_lost=${JSON.stringify(breadcrumbs.filter((b) => b.name === 'daemon_sessions_lost').map((b) => b.data))}\n` +
          `daemon.log (relevant):\n${lines
            .filter((l) =>
              /shutdown|dispose|startup|session-created|daemon-log-closed/.test(l.event)
            )
            .map((l) => JSON.stringify(l))
            .join('\n')}`
      )

      // Positive controls: without both injections the run is VOID, never a pass.
      if (!lines.some((l) => l.pid === pidA && l.event === 'shutdown-dispose-failed')) {
        throw new Error(
          'VOID RUN: daemon A never logged shutdown-dispose-failed; the unkillable-PTY injection did not take.'
        )
      }
      if (!/EADDRINUSE/.test(restart.message)) {
        throw new Error(
          `VOID RUN: the injected first replacement failure (EADDRINUSE) did not surface; restart said: ${restart.message}`
        )
      }

      expect(restart.ok).toBe(false)
      // The replacement launched only after the predecessor was gone (FX-1 gate), and the healthy one started later still.
      expect(predecessorAliveAtFork[1]).toBe(false)
      const aExit = lines.find((l) => l.pid === pidA && l.event === 'daemon-log-closed')?.ts
      const cStart = lines.find((l) => l.pid === pidC && l.event === 'startup')?.ts
      expect(aExit, 'daemon A closed its log').toBeDefined()
      expect(cStart, 'a healthy replacement daemon started after the failed restart').toBeDefined()
      expect(Date.parse(cStart as string)).toBeGreaterThanOrEqual(Date.parse(aExit as string))
      // The held agent is announced once (a notice), never exited, and its death is audited once.
      expect(liveCtx.rendererExits, 'the held pane was exited instead of announced').toEqual([])
      expect(liveCtx.notices).toHaveLength(1)
      expect(liveCtx.notices[0]?.sessions.map(({ id }) => id)).toEqual(['live-repro-chair'])
      expect(liveCtx.audits).toEqual([['live-repro-chair']])
      expect(breadcrumbs.filter((b) => b.name === 'daemon_sessions_lost')).toHaveLength(1)
      // One relaunch, served by the healthy daemon.
      await new Promise((r) => setTimeout(r, 2_000))
      expect(relaunches).toBe(1)
      const provider = getDaemonProvider() as unknown as {
        listProcesses: () => Promise<{ id: string }[]>
      }
      expect((await provider.listProcesses()).map(({ id }) => id)).toContain('live-repro-chair')
    } finally {
      liveCtx.interceptFork = null
      liveCtx.onNotice = null
      setDaemonDiedFanoutHandler(null)
      await shutdownDaemon().catch((error) => note(`[live-repro] shutdownDaemon: ${String(error)}`))
      for (const launch of liveCtx.launches) {
        if (launch.pid) {
          owned.push(launch.pid)
        }
      }
      for (const line of readLog(daemonLogPath).split('\n')) {
        const match = line.match(/"pid":(\d+)[^\n]*"event":"session-created"/)
        if (match) {
          owned.push(Number(match[1]))
        }
      }
    }
  }, 240_000)
})
