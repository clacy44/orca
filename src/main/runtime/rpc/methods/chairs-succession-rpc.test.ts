// S10-22a G1 repair round — RPC-level tests for the chair succession surface, Q7:
// - B1: successionAccept / resumeContext must attest by PANE ALONE — a freshly-spawned successor
//   pane has no `agents` row yet, so a REGISTERED-identity requirement would make the whole
//   protocol unreachable from the very pane it exists to serve.
// - B5: `--id` is validated against `^succ_[0-9a-f]{12}$` at this boundary, before it can ever
//   reach a `path.join`.
// - B2: `orchestration.chairs.succeed` is a long-poll — clone of runtime-rpc.test.ts's F-15
//   `orchestration.wait` keepalive test (:5515), same shape, this method instead.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { readRuntimeMetadata } from '../../runtime-metadata'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { CHAIRS_SUCCESSION_METHODS } from './chairs-succession'
import { createSealed, listActive, transition } from '../../orchestration/chair-succession-store'
import { getHoldRecord, holdSealRequest } from '../../orchestration/chair-succession-hold'
import type { RpcContext } from '../core'
import type * as NodeOs from 'node:os'

function withContract(request: Record<string, unknown>): Record<string, unknown> {
  return { ...request, orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
}

// G1 repair B2 test isolation: `os.homedir` is un-spyable under Vitest's ESM module namespace
// (Object.defineProperty on a frozen namespace) — `vi.mock` + `vi.hoisted` is the supported
// substitute, keyed off a mutable ref this file alone controls. FILE-LOCAL (Vitest isolates
// `vi.mock` per test file): never touches the real `~/.orca`, never affects any other suite.
const fakeHomeRef = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: (): string => fakeHomeRef.current }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function methodByName(name: string) {
  const method = CHAIRS_SUCCESSION_METHODS.find((m) => m.name === name)
  if (!method) {
    throw new Error(`no such method: ${name}`)
  }
  return method
}

describe('S10-22a G1 repair: chairs-succession RPC boundary', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  const PANE = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const HANDLE = 'term_successor'

  function attestPane(paneKey: string, terminalHandle: string): void {
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((evidence) =>
      evidence?.paneKey === paneKey && evidence.terminalHandle === terminalHandle
        ? ({
            hostScope: { kind: 'local', hostId: 'local' },
            paneKey,
            terminalHandle,
            processIncarnation: 'proc-1',
            launchTokenHash: 'hash-1'
          } as never)
        : null
    )
  }

  function ctxFor(paneKey: string, terminalHandle: string): RpcContext {
    return {
      runtime: runtime as never,
      orchestrationCompatibilityEvidence: { paneKey, terminalHandle, launchToken: 'lt' } as never
    } as RpcContext
  }

  // G1 repair B1: before the fix, this threw `no_registered_identity` (resolveCallerAgent
  // requires an `agents` row) — the exact pane the whole protocol depends on being able to call
  // this method never has one yet. After the fix it reaches `acceptSuccession`'s OWN logic
  // (no live hold for this id → `succession_unknown`), proving identity resolution no longer
  // gates on registration.
  it('successionAccept from an UNREGISTERED but attested pane never throws no_registered_identity', async () => {
    attestPane(PANE, HANDLE)
    const method = methodByName('orchestration.chairs.successionAccept')
    await expect(
      method.handler({ successionId: 'succ_ae82f3cbf9c6' }, ctxFor(PANE, HANDLE))
    ).rejects.toMatchObject({ code: 'succession_unknown' })
  })

  it('resumeContext --hook from an UNREGISTERED but attested pane never throws, returns succession_none', async () => {
    attestPane(PANE, HANDLE)
    const method = methodByName('orchestration.chairs.resumeContext')
    const result = await method.handler({ hook: true }, ctxFor(PANE, HANDLE))
    expect(result).toEqual({ ok: false, code: 'succession_none' })
  })

  it('both methods refuse an entirely unattested caller with no_pane_identity', async () => {
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockReturnValue(null)
    const accept = methodByName('orchestration.chairs.successionAccept')
    await expect(
      accept.handler({ successionId: 'succ_ae82f3cbf9c6' }, ctxFor(PANE, HANDLE))
    ).rejects.toMatchObject({ code: 'no_pane_identity' })
    const resume = methodByName('orchestration.chairs.resumeContext')
    await expect(resume.handler({ hook: true }, ctxFor(PANE, HANDLE))).rejects.toMatchObject({
      code: 'no_pane_identity'
    })
  })

  // G1 repair B5: shaped exactly as `generateSuccessionId()`'s own output, so nothing legitimate
  // is ever refused — but a path-traversal-shaped id never reaches a `path.join`.
  it.each(['../../etc/passwd', 'succ_short', `succ_${'g'.repeat(12)}`, ''])(
    'successionAccept refuses a malformed id %s with invalid_argument, before touching the store',
    async (badId) => {
      attestPane(PANE, HANDLE)
      const method = methodByName('orchestration.chairs.successionAccept')
      await expect(
        method.handler({ successionId: badId }, ctxFor(PANE, HANDLE))
      ).rejects.toMatchObject({ code: 'invalid_argument' })
    }
  )

  it('resumeContext by id refuses a malformed id with invalid_argument', async () => {
    attestPane(PANE, HANDLE)
    const method = methodByName('orchestration.chairs.resumeContext')
    await expect(
      method.handler({ successionId: '../../etc/passwd' }, ctxFor(PANE, HANDLE))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

// G1 repair B2: `orchestration.chairs.succeed` must be classified as a long-poll (keepalive +
// abort signal) — clone of runtime-rpc.test.ts's F-15 `orchestration.wait` test at :5515, same
// shape, against the real socket server. `os.homedir` is mocked FILE-LOCALLY (this suite only)
// to a throwaway mkdtemp root — `defaultOrcaHome()`/`defaultChairsManifestPath()` both derive
// from it, so this never touches the real `~/.orca`.
describe('S10-22a G1 repair B2: orchestration.chairs.succeed keepalive', () => {
  let fakeHome: string

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'orca-succession-rpc-home-'))
    fakeHomeRef.current = fakeHome
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(fakeHome, { recursive: true, force: true })
  })

  it('emits keepalive frames while orchestration.chairs.succeed blocks on the hold', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-succession-'))
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    const paneKey = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const terminalHandle = 'term_incumbent'
    const evidence = { terminalHandle, paneKey, launchToken: 'lt-a' }
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((ev) =>
      ev?.terminalHandle === terminalHandle && ev.paneKey === paneKey
        ? ({
            hostScope: { kind: 'local', hostId: 'local' },
            paneKey,
            terminalHandle,
            processIncarnation: 'proc-a',
            launchTokenHash: 'hash-a'
          } as never)
        : null
    )
    // Never resolves — isolates this test to the SEAL's own 150s hold, not launch's outcome.
    vi.spyOn(runtime, 'createAgentSession').mockReturnValue(new Promise(() => {}))

    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, keepaliveIntervalMs: 50 })
    await server.start()

    const checkpointPath = join(fakeHome, 'checkpoint.md')
    const checkpoint = [
      'schema: orca.chair-checkpoint/1',
      '## Goal',
      'ship it',
      '## Completed and verified work',
      'none',
      '## Live units',
      'none',
      '## Blockers',
      'none',
      '## Unsaved rulings',
      'none',
      '## Queue',
      'none',
      '## Todo list',
      'none',
      '## Gotchas',
      'none',
      ''
    ].join('\n')
    await writeFile(checkpointPath, checkpoint)
    const charterPath = join(fakeHome, 'CHARTER.md')
    await writeFile(charterPath, 'the charter\n')
    const manifestPath = join(fakeHome, '.orca', 'chairs.json')
    await mkdir(join(fakeHome, '.orca'), { recursive: true })
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        chairs: [
          {
            name: 'chair-keepalive',
            worktree: 'id:wt-1',
            agent: 'claude',
            conversationId: 'sess-orig',
            succession: { enabled: true, charterPath }
          }
        ]
      })
    )

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const endpoint = metadata!.transports[0]!.endpoint
      const authToken = metadata!.authToken

      const registered = (await sendRequest(endpoint, {
        id: 'req_register',
        authToken,
        method: 'orchestration.agents.register',
        params: { name: 'chair-keepalive', role: 'chair' },
        orchestrationCompatibilityEvidence: evidence
      })) as { result?: { agent: { id: string } } }
      expect(registered.result?.agent.id).toBeDefined()

      db.createRun({
        objective: 'ship it',
        coordinatorHandle: terminalHandle,
        coordinatorPaneKey: paneKey
      })

      const checkpointSha256 = createHash('sha256').update(checkpoint).digest('hex')
      const session = openFramedSession(endpoint, {
        id: 'req_succeed',
        authToken,
        method: 'orchestration.chairs.succeed',
        params: { checkpointPath, checkpointSha256, reason: 'batch_end' },
        orchestrationCompatibilityEvidence: evidence
      })

      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(session.frames.filter((f) => f._keepalive === true).length).toBeGreaterThanOrEqual(3)
      // The hold is registered under the succession's own id — grab it (still `sealed` at this
      // point, the hold parked on `createAgentSession`'s never-resolving promise) so the wait
      // below can watch that same id's hold entry.
      const [sealedMeta] = await listActive(
        { orcaHome: join(fakeHome, '.orca') },
        'chair-keepalive'
      )
      // Why destroy rather than await: `succeed` parks for up to 150s in production; destroying
      // the socket fires the abort signal, releasing the hold's `runAbortTail` immediately so
      // this test does not hang.
      session.socket.destroy()
      await session.done.catch(() => undefined)
      // The abort tail (fs-backed transitionLocked + a sync writeAgentAudit against `db`) keeps
      // running server-side after the socket closes — close `db` before it finishes and its
      // `writeAgentAudit` throws "database is not open" as an unhandled rejection. `getHoldRecord`
      // returns undefined only once `settleHold` has run, which is strictly after the tail's
      // `writeAgentAudit` call (same synchronous continuation, see chair-succession-hold.ts) — so
      // polling it to `undefined` is a safe barrier for the tail having fully finished.
      if (sealedMeta) {
        await waitForCondition(() => getHoldRecord(sealedMeta.id) === undefined)
      }
    } finally {
      db.close()
      await server.stop()
      // H12 (G1-10z attempt-4): this held an `orca-runtime.json` with a (now-dead) auth token —
      // never removed, leaking one mkdtemp directory per run of this test.
      await rm(userDataPath, { recursive: true, force: true })
    }
  }, 15_000)
})

// G1 repair N9: `orchestration.chairs.successionAccept`'s worst case (a chair-lock wait, the
// bounded incumbent exit wait, a manifest-lock wait behind a restore) can exceed the 30s socket
// idle bound the same way `succeed` above can — clone of the B2 keepalive test, this method.
describe('S10-22a G1 repair N9: orchestration.chairs.successionAccept keepalive', () => {
  let fakeHome: string

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'orca-succession-rpc-accept-home-'))
    fakeHomeRef.current = fakeHome
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(fakeHome, { recursive: true, force: true })
  })

  it('emits keepalive frames while orchestration.chairs.successionAccept blocks on the incumbent exit wait', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-accept-'))
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    const incumbentPaneKey = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const incumbentHandle = 'term_incumbent'
    const successorPaneKey = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const successorHandle = 'term_successor'
    const evidence = {
      terminalHandle: successorHandle,
      paneKey: successorPaneKey,
      launchToken: 'lt-b'
    }
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((ev) =>
      ev?.terminalHandle === successorHandle && ev.paneKey === successorPaneKey
        ? ({
            hostScope: { kind: 'local', hostId: 'local' },
            paneKey: successorPaneKey,
            terminalHandle: successorHandle,
            processIncarnation: 'proc-b',
            launchTokenHash: 'hash-b'
          } as never)
        : null
    )
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
    // Real (not instant) delay so the transport-level keepalive timer has time to fire — the
    // point of this test is the classifier/keepalive wiring, not the takeover's own outcome.
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(
      async () =>
        await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                handle: incumbentHandle,
                condition: 'exit',
                satisfied: true,
                status: 'exited',
                exitCode: 0
              }),
            250
          )
        )
    )

    // `defaultOrcaHome()` (the RPC handler's own `depsFor`) resolves to `homedir()/.orca` — the
    // mocked `homedir()` here returns `fakeHome`, so the store must be seeded under
    // `fakeHome/.orca`, not `fakeHome` itself, or the handler's own `read()`/`transition()` calls
    // see nothing on disk.
    const orcaHome = join(fakeHome, '.orca')
    await mkdir(join(orcaHome, 'chairs'), { recursive: true })
    const storeDeps = { orcaHome }
    const meta = await createSealed(storeDeps, 'chair-accept-keepalive', {
      reason: 'batch_end',
      checkpointText: 'x',
      checkpointSha: 'x',
      charterPath: '/c',
      charterSha: 'c',
      charterMode: 'reference' as const,
      resumeContextText: 'rc',
      incumbent: { paneKey: incumbentPaneKey, terminalHandle: incumbentHandle }
    })
    const launching = await transition(storeDeps, 'chair-accept-keepalive', meta.id, 'launching', {
      successor: { paneKey: successorPaneKey, terminalHandle: successorHandle }
    })
    const deps = { db, runtime, orcaHome, manifestPath: join(orcaHome, 'chairs.json') }
    void holdSealRequest(deps, 'local', launching, undefined) // the accept below needs a live hold

    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, keepaliveIntervalMs: 50 })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const endpoint = metadata!.transports[0]!.endpoint
      const authToken = metadata!.authToken

      const session = openFramedSession(endpoint, {
        id: 'req_accept',
        authToken,
        method: 'orchestration.chairs.successionAccept',
        params: { successionId: meta.id },
        orchestrationCompatibilityEvidence: evidence
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const keepalives = session.frames.filter((f) => f._keepalive === true)
      expect(keepalives.length).toBeGreaterThanOrEqual(3)
      // The server leaves the socket open after writing the terminal frame (short RPCs expect
      // the client to close it) — destroy from the client side so `session.done` resolves.
      session.socket.destroy()
      await session.done.catch(() => undefined)
    } finally {
      db.close()
      await server.stop()
      // H12 (G1-10z attempt-4): see the B2 keepalive test's identical cleanup above.
      await rm(userDataPath, { recursive: true, force: true })
    }
  }, 15_000)
})

// Q7: "hold registered before launch through the real handler with a launch that resolves" +
// "a successful accept through the RPC handler" — both through the REAL socket-level RPC
// handlers (not direct function calls), with `createAgentSession` actually resolving (unlike the
// B2 keepalive test above, which never lets it resolve).
describe('S10-22a G1 repair round 2 Q7: succeed -> real launch -> successionAccept end to end', () => {
  let fakeHome: string

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'orca-succession-rpc-e2e-home-'))
    fakeHomeRef.current = fakeHome
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(fakeHome, { recursive: true, force: true })
  })

  it('a real succeed -> resolving launch -> successionAccept round trip ends ACCEPTED', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-e2e-'))
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    const incumbentPaneKey = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const incumbentHandle = 'term_incumbent'
    const successorPaneKey = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const successorHandle = 'term_successor'
    const incumbentEvidence = {
      terminalHandle: incumbentHandle,
      paneKey: incumbentPaneKey,
      launchToken: 'lt-a'
    }
    const successorEvidence = {
      terminalHandle: successorHandle,
      paneKey: successorPaneKey,
      launchToken: 'lt-b'
    }
    vi.spyOn(runtime, 'verifyOrchestrationCompatibilityCaller').mockImplementation((ev) => {
      if (ev?.terminalHandle === incumbentHandle && ev.paneKey === incumbentPaneKey) {
        return {
          hostScope: { kind: 'local', hostId: 'local' },
          paneKey: incumbentPaneKey,
          terminalHandle: incumbentHandle,
          processIncarnation: 'proc-a',
          launchTokenHash: 'hash-a'
        } as never
      }
      if (ev?.terminalHandle === successorHandle && ev.paneKey === successorPaneKey) {
        return {
          hostScope: { kind: 'local', hostId: 'local' },
          paneKey: successorPaneKey,
          terminalHandle: successorHandle,
          processIncarnation: 'proc-b',
          launchTokenHash: 'hash-b'
        } as never
      }
      return null
    })
    // The launch RESOLVES — unlike the B2 keepalive test, which deliberately never lets it.
    vi.spyOn(runtime, 'createAgentSession').mockResolvedValue({
      terminal: { paneKey: successorPaneKey, handle: successorHandle }
    } as never)
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({} as never)
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: incumbentHandle,
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 0
    } as never)

    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, keepaliveIntervalMs: 50 })
    await server.start()

    const checkpointPath = join(fakeHome, 'checkpoint.md')
    const checkpoint = [
      'schema: orca.chair-checkpoint/1',
      '## Goal',
      'ship it',
      '## Completed and verified work',
      'none',
      '## Live units',
      'none',
      '## Blockers',
      'none',
      '## Unsaved rulings',
      'none',
      '## Queue',
      'none',
      '## Todo list',
      'none',
      '## Gotchas',
      'none',
      ''
    ].join('\n')
    await writeFile(checkpointPath, checkpoint)
    const charterPath = join(fakeHome, 'CHARTER.md')
    await writeFile(charterPath, 'the charter\n')
    const manifestPath = join(fakeHome, '.orca', 'chairs.json')
    await mkdir(join(fakeHome, '.orca'), { recursive: true })
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        chairs: [
          {
            name: 'chair-e2e',
            worktree: 'id:wt-1',
            agent: 'claude',
            conversationId: 'sess-orig',
            succession: { enabled: true, charterPath }
          }
        ]
      })
    )

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const endpoint = metadata!.transports[0]!.endpoint
      const authToken = metadata!.authToken

      const registered = (await sendRequest(endpoint, {
        id: 'req_register',
        authToken,
        method: 'orchestration.agents.register',
        params: { name: 'chair-e2e', role: 'chair' },
        orchestrationCompatibilityEvidence: incumbentEvidence
      })) as { result?: { agent: { id: string } } }
      expect(registered.result?.agent.id).toBeDefined()

      db.createRun({
        objective: 'ship it',
        coordinatorHandle: incumbentHandle,
        coordinatorPaneKey: incumbentPaneKey
      })

      const checkpointSha256 = createHash('sha256').update(checkpoint).digest('hex')
      const succeedSession = openFramedSession(endpoint, {
        id: 'req_succeed',
        authToken,
        method: 'orchestration.chairs.succeed',
        params: { checkpointPath, checkpointSha256, reason: 'batch_end' },
        orchestrationCompatibilityEvidence: incumbentEvidence
      })

      // Give the real handler's launch (createAgentSession resolving) time to land the record in
      // `launching` and register the successor onto the hold — proves the ordering (chair review
      // fix #1: hold registered BEFORE launch) survives end to end with a launch that actually
      // resolves, not one the test forces to hang forever.
      await new Promise((resolve) => setTimeout(resolve, 200))
      const active = await listActive({ orcaHome: join(fakeHome, '.orca') }, 'chair-e2e')
      expect(active).toHaveLength(1)
      expect(active[0]!.state).toBe('launching')
      const successionId = active[0]!.id

      const acceptResponse = (await sendRequest(endpoint, {
        id: 'req_accept',
        authToken,
        method: 'orchestration.chairs.successionAccept',
        params: { successionId },
        orchestrationCompatibilityEvidence: successorEvidence
      })) as { result?: { chair?: string; agentId?: string }; error?: { code: string } }
      expect(acceptResponse.error).toBeUndefined()
      expect(acceptResponse.result?.chair).toBe('chair-e2e')
      expect(acceptResponse.result?.agentId).toBeDefined()

      // The incumbent's held `succeed` call is released once accept settles the hold — poll for
      // its terminal frame (the server leaves the socket open after writing it; short RPCs expect
      // the client to close, same as the B2 keepalive test above).
      const deadline = Date.now() + 5_000
      let succeedTerminal: Record<string, unknown> | undefined
      while (!succeedTerminal && Date.now() < deadline) {
        succeedTerminal = succeedSession.frames.find(
          (f) => f.id === 'req_succeed' && f._keepalive !== true
        )
        if (!succeedTerminal) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      expect(succeedTerminal).toMatchObject({ ok: true, result: { ok: true, confirmed: true } })
      succeedSession.socket.destroy()
      await succeedSession.done.catch(() => undefined)
    } finally {
      db.close()
      await server.stop()
      // H12 (G1-10z attempt-4): see the B2 keepalive test's identical cleanup above.
      await rm(userDataPath, { recursive: true, force: true })
    }
  }, 15_000)
})

// G1 repair test-hygiene: bounded poll for the abort tail's post-response work (fs write + a
// sync `db.writeAgentAudit`) to finish before the test's own `db.close()` runs — otherwise that
// write throws "database is not open" as an unhandled rejection after the test has passed.
async function waitForCondition(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error('waitForCondition: timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function sendRequest(
  endpoint: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const message = buffer.slice(0, newlineIndex)
      socket.end()
      resolve(JSON.parse(message) as Record<string, unknown>)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(withContract(request))}\n`)
    })
  })
}

type FramedSession = {
  socket: ReturnType<typeof createConnection>
  frames: Record<string, unknown>[]
  done: Promise<void>
}

function openFramedSession(endpoint: string, request: Record<string, unknown>): FramedSession {
  const frames: Record<string, unknown>[] = []
  const socket = createConnection(endpoint)
  let buffer = ''
  socket.setEncoding('utf8')
  const done = new Promise<void>((resolve, reject) => {
    socket.once('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolve()
        return
      }
      reject(err)
    })
    socket.on('close', () => resolve())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (raw) {
          frames.push(JSON.parse(raw) as Record<string, unknown>)
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(withContract(request))}\n`)
    })
  })
  return { socket, frames, done }
}
