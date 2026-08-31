import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { attemptOrchestrationReattest } from './orchestration-compatibility-reattest'

const EVIDENCE = {
  terminalHandle: 'term-1',
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  launchToken: 'launch-secret'
}

function endpointBody(port: number, token: string): string {
  return [
    `ORCA_AGENT_HOOK_PORT=${port}`,
    `ORCA_AGENT_HOOK_TOKEN=${token}`,
    'ORCA_AGENT_HOOK_ENV=production',
    'ORCA_AGENT_HOOK_VERSION=1',
    ''
  ].join('\n')
}

describe('attemptOrchestrationReattest', () => {
  let dir: string
  let servers: Server[] = []

  afterEach(async () => {
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    servers = []
  })

  function startReattestServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void
  ): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer(handler)
      servers.push(server)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }

  it('returns false when ORCA_AGENT_HOOK_ENDPOINT is unset', async () => {
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toBe(false)
  })

  it('returns false when evidence is missing a required field', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, endpointBody(1, 'x'), 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath
    await expect(
      attemptOrchestrationReattest({ terminalHandle: 'term-1', paneKey: EVIDENCE.paneKey })
    ).resolves.toBe(false)
  })

  it('returns true when the runtime accepts the reattest (204)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    let receivedBody: unknown
    let receivedToken: string | undefined
    const port = await startReattestServer((req, res) => {
      receivedToken = req.headers['x-orca-agent-hook-token'] as string | undefined
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(204)
        res.end()
      })
    })
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, endpointBody(port, 'the-hook-token'), 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toBe(true)
    expect(receivedToken).toBe('the-hook-token')
    expect(receivedBody).toEqual({
      paneKey: EVIDENCE.paneKey,
      terminalHandle: EVIDENCE.terminalHandle,
      launchToken: EVIDENCE.launchToken
    })
  })

  it('returns false on a 404 (older runtime with no /reattest route)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const port = await startReattestServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, endpointBody(port, 'the-hook-token'), 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toBe(false)
  })

  it('returns false when the endpoint file is malformed (missing fields)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, 'ORCA_AGENT_HOOK_PORT=1\n', 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toBe(false)
  })

  it('returns false when the endpoint file is oversized', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, `ORCA_AGENT_HOOK_PORT=${'1'.repeat(5_000)}\n`, 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'returns false when the endpoint path is a symlink (not followed)',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
      const realPath = join(dir, 'real-endpoint.env')
      writeFileSync(realPath, endpointBody(1, 'x'), 'utf8')
      const linkPath = join(dir, 'endpoint.env')
      symlinkSync(realPath, linkPath)
      process.env.ORCA_AGENT_HOOK_ENDPOINT = linkPath

      await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toBe(false)
    }
  )

  it('returns false when the endpoint file does not exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    process.env.ORCA_AGENT_HOOK_ENDPOINT = join(dir, 'endpoint.env')
    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toBe(false)
  })
})
