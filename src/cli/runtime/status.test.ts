import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { RuntimeClient } from './client'

const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

// Why: legacy runtime metadata compatibility only applies to local Unix socket
// metadata; Windows uses named pipes and cannot run this fixture directly.
describe.skipIf(process.platform === 'win32')('CLI runtime status', () => {
  it('uses the legacy singular runtime transport when reporting status', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-status-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              runtimeId: 'runtime-legacy',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0
            },
            _meta: { runtimeId: 'runtime-legacy' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      getRuntimeMetadataPath(userDataPath),
      JSON.stringify({
        runtimeId: 'runtime-legacy',
        pid: process.pid,
        transport: { kind: 'unix', endpoint },
        authToken: 'token',
        startedAt: Date.now()
      })
    )

    const status = await new RuntimeClient(userDataPath).getCliStatus()

    expect(status.result.runtime).toMatchObject({
      reachable: true,
      runtimeId: 'runtime-legacy',
      state: 'ready'
    })
  })

  // INV-P-023: hostIntegrity on the wire maps to result.runtime.integrity; its absence
  // produces no `integrity` key at all (Windows-only field).
  it('maps a status.get hostIntegrity field to runtime.integrity, or omits it entirely', async () => {
    async function statusWith(hostIntegrity?: unknown) {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-status-integrity-'))
      const endpoint = join(userDataPath, 'runtime.sock')
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.once('data', (data) => {
          const request = JSON.parse(String(data).trim()) as { id: string }
          socket.write(
            `${JSON.stringify({
              id: request.id,
              ok: true,
              result: {
                runtimeId: 'runtime-legacy',
                rendererGraphEpoch: 1,
                graphStatus: 'ready',
                authoritativeWindowId: null,
                liveTabCount: 0,
                ...(hostIntegrity !== undefined ? { hostIntegrity } : {})
              },
              _meta: { runtimeId: 'runtime-legacy' }
            })}\n`
          )
        })
      })
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      writeFileSync(
        getRuntimeMetadataPath(userDataPath),
        JSON.stringify({
          runtimeId: 'runtime-legacy',
          pid: process.pid,
          transport: { kind: 'unix', endpoint },
          authToken: 'token',
          startedAt: Date.now()
        })
      )
      return new RuntimeClient(userDataPath).getCliStatus()
    }

    const withIntegrity = await statusWith({
      level: 'high',
      main: 'high',
      elevationAllowed: false,
      agentLaunch: 'refused',
      warning: 'refused'
    })
    expect(withIntegrity.result.runtime.integrity).toEqual({
      level: 'high',
      main: 'high',
      elevationAllowed: false,
      agentLaunch: 'refused',
      warning: 'refused'
    })

    const withoutIntegrity = await statusWith(undefined)
    expect('integrity' in withoutIntegrity.result.runtime).toBe(false)
  })
})
