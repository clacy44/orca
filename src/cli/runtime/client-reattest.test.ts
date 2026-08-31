// S10-5: the RuntimeClient single choke — a no_pane_identity refusal from an orchestration.*
// call triggers exactly one reattest + one retry, using the endpoint file the runtime already
// wrote and env-sourced identity. Mirrors client-timeout-policy.test.ts's unix-socket harness.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createUnixServer, type Server, type Socket } from 'node:net'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeClient } from './client'

const unixServers = new Set<Server>()
const httpServers = new Set<HttpServer>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...unixServers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  unixServers.clear()
  await Promise.all(
    [...httpServers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  httpServers.clear()
  delete process.env.ORCA_AGENT_HOOK_ENDPOINT
  delete process.env.ORCA_TERMINAL_HANDLE
  delete process.env.ORCA_PANE_KEY
  delete process.env.ORCA_AGENT_LAUNCH_TOKEN
})

function noPaneIdentityFailure(id: string): string {
  return `${JSON.stringify({
    id,
    ok: false,
    error: {
      code: 'no_pane_identity',
      message: 'This requires an attested, registered caller identity.',
      data: {
        nextSteps: [
          're-run the command — the CLI re-attests this pane automatically after a runtime restart'
        ]
      }
    }
  })}\n`
}

function success(id: string, result: unknown): string {
  return `${JSON.stringify({ id, ok: true, result, _meta: { runtimeId: 'runtime-1' } })}\n`
}

describe.skipIf(process.platform === 'win32')('RuntimeClient reattest choke', () => {
  it('reattests once and retries once on no_pane_identity, then succeeds', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-reattest-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let callCount = 0
    const unixServer = createUnixServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        callCount += 1
        if (callCount === 1) {
          socket.write(noPaneIdentityFailure(request.id))
          return
        }
        socket.write(success(request.id, { agentId: 'agent-1' }))
      })
    })
    unixServers.add(unixServer)
    await new Promise<void>((resolve) => unixServer.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    let reattestCalls = 0
    const httpServer = createHttpServer((req, res) => {
      reattestCalls += 1
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(204)
        res.end()
      })
    })
    httpServers.add(httpServer)
    const port: number = await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const endpointPath = join(userDataPath, 'endpoint.env')
    writeFileSync(
      endpointPath,
      [
        `ORCA_AGENT_HOOK_PORT=${port}`,
        'ORCA_AGENT_HOOK_TOKEN=hook-token',
        'ORCA_AGENT_HOOK_ENV=production',
        'ORCA_AGENT_HOOK_VERSION=1',
        ''
      ].join('\n'),
      'utf8'
    )
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath
    process.env.ORCA_TERMINAL_HANDLE = 'term-1'
    process.env.ORCA_PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-secret'

    const client = new RuntimeClient(userDataPath, 2_000)
    const response = await client.call<{ agentId: string }>('orchestration.agents.register', {
      name: 'foo'
    })

    expect(response.result).toEqual({ agentId: 'agent-1' })
    expect(callCount).toBe(2)
    expect(reattestCalls).toBe(1)
  })

  it('surfaces the original refusal, unretried, when reattest itself fails (404)', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-reattest-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    let callCount = 0
    const unixServer = createUnixServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        callCount += 1
        socket.write(noPaneIdentityFailure(request.id))
      })
    })
    unixServers.add(unixServer)
    await new Promise<void>((resolve) => unixServer.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const httpServer = createHttpServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    httpServers.add(httpServer)
    const port: number = await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const endpointPath = join(userDataPath, 'endpoint.env')
    writeFileSync(
      endpointPath,
      [
        `ORCA_AGENT_HOOK_PORT=${port}`,
        'ORCA_AGENT_HOOK_TOKEN=hook-token',
        'ORCA_AGENT_HOOK_ENV=production',
        'ORCA_AGENT_HOOK_VERSION=1',
        ''
      ].join('\n'),
      'utf8'
    )
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath
    process.env.ORCA_TERMINAL_HANDLE = 'term-1'
    process.env.ORCA_PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-secret'

    const client = new RuntimeClient(userDataPath, 2_000)

    await expect(
      client.call('orchestration.agents.register', { name: 'foo' })
    ).rejects.toMatchObject({
      code: 'no_pane_identity',
      data: {
        nextSteps: [
          're-run the command — the CLI re-attests this pane automatically after a runtime restart'
        ]
      }
    })
    // Why: no loops, no second retry — one original call, no successful retry.
    expect(callCount).toBe(1)
  })
})

// S10-6 (R4): the CLI must swap the server's canned "re-run the command" nextStep for an
// accurate one once it already knows reattest couldn't help — using a REAL AgentHookServer for
// the reattest leg. The HTTP status codes stubbed below (403, 204) are exactly what a real
// AgentHookServer returns for a stale token and a disposition-not-'accept' refusal respectively
// — see src/main/agent-hooks/server.test.ts and orchestration-compatibility-reattest.test.ts
// (main/runtime) for those gates proven against the real server; this file stays scoped to
// src/cli's own tsconfig project boundary (server.ts is deliberately not on tsconfig.cli.json's
// allowlist — it would pull in most of src/main).
describe.skipIf(process.platform === 'win32')('RuntimeClient reattest S10-6 (R4) nextStep', () => {
  async function startAlwaysRefusingRpcServer(
    userDataPath: string
  ): Promise<{ callCount: () => number }> {
    const endpoint = join(userDataPath, 'runtime.sock')
    let callCount = 0
    const unixServer = createUnixServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        callCount += 1
        socket.write(noPaneIdentityFailure(request.id))
      })
    })
    unixServers.add(unixServer)
    await new Promise<void>((resolve) => unixServer.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )
    return { callCount: () => callCount }
  }

  function setEvidenceEnv(): void {
    process.env.ORCA_TERMINAL_HANDLE = 'term-1'
    process.env.ORCA_PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-secret'
  }

  it('reason: no-endpoint-file — ORCA_AGENT_HOOK_ENDPOINT unset', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-reattest-r4-'))
    await startAlwaysRefusingRpcServer(userDataPath)
    setEvidenceEnv()
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT

    const client = new RuntimeClient(userDataPath, 2_000)
    await expect(
      client.call('orchestration.agents.register', { name: 'foo' })
    ).rejects.toMatchObject({
      code: 'no_pane_identity',
      data: {
        nextSteps: [
          'this pane cannot re-attest (reason: no-endpoint-file); relaunch this agent in a fresh Orca pane (claude --resume keeps its context)'
        ]
      }
    })
  })

  async function startStubReattestServer(userDataPath: string, status: number): Promise<void> {
    const httpServer = createHttpServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(status)
        res.end()
      })
    })
    httpServers.add(httpServer)
    const port: number = await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    const endpointPath = join(userDataPath, 'endpoint.env')
    writeFileSync(
      endpointPath,
      [
        `ORCA_AGENT_HOOK_PORT=${port}`,
        'ORCA_AGENT_HOOK_TOKEN=hook-token',
        'ORCA_AGENT_HOOK_ENV=production',
        'ORCA_AGENT_HOOK_VERSION=1',
        ''
      ].join('\n'),
      'utf8'
    )
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath
  }

  it('reason: stale-endpoint-token — the server answers /reattest with a real 403', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-reattest-r4-'))
    await startAlwaysRefusingRpcServer(userDataPath)
    setEvidenceEnv()
    // Why 403: AgentHookServer's request handler checks X-Orca-Agent-Hook-Token before routing
    // to handleReattestRequest at all (server.ts:2142) — a token mismatch always 403s regardless
    // of route, so this stub reproduces that gate precisely without standing up the real server.
    await startStubReattestServer(userDataPath, 403)

    const client = new RuntimeClient(userDataPath, 2_000)
    await expect(
      client.call('orchestration.agents.register', { name: 'foo' })
    ).rejects.toMatchObject({
      code: 'no_pane_identity',
      data: {
        nextSteps: [
          'this pane cannot re-attest (reason: stale-endpoint-token); relaunch this agent in a fresh Orca pane (claude --resume keeps its context)'
        ]
      }
    })
  })

  it('reason: pane-not-admitted — the retry after a "successful" 204 still refuses', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-reattest-r4-'))
    const rpc = await startAlwaysRefusingRpcServer(userDataPath)
    setEvidenceEnv()
    // Why 204: handleReattestRequest returns this same status for a genuine success and for a
    // disposition-not-'accept' pane (server.ts:2826) — deliberately, so a caller can't use the
    // status to enumerate which paneKeys are open. This stub reproduces that exact status; the
    // rpc stub above always refuses no_pane_identity on the retry too, which is what actually
    // happens when the pane was never admitted (see the DEVIATION comment on
    // handleReattestRequest for why the runtime can't attest a pane like this).
    await startStubReattestServer(userDataPath, 204)

    const client = new RuntimeClient(userDataPath, 2_000)
    await expect(
      client.call('orchestration.agents.register', { name: 'foo' })
    ).rejects.toMatchObject({
      code: 'no_pane_identity',
      data: {
        nextSteps: [
          'this pane cannot re-attest (reason: pane-not-admitted); relaunch this agent in a fresh Orca pane (claude --resume keeps its context)'
        ]
      }
    })
    // Why: the retry DID happen (reattest looked like a success) — two RPC calls, not one.
    expect(rpc.callCount()).toBe(2)
  })
})
