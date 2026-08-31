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

function endpointBody(
  port: number,
  token: string,
  extra?: { paneKey?: string; terminalHandle?: string }
): string {
  return [
    `ORCA_AGENT_HOOK_PORT=${port}`,
    `ORCA_AGENT_HOOK_TOKEN=${token}`,
    'ORCA_AGENT_HOOK_ENV=production',
    'ORCA_AGENT_HOOK_VERSION=1',
    ...(extra?.paneKey ? [`ORCA_AGENT_HOOK_PANE_KEY=${extra.paneKey}`] : []),
    ...(extra?.terminalHandle ? [`ORCA_AGENT_HOOK_TERMINAL_HANDLE=${extra.terminalHandle}`] : []),
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

  it('reports no-endpoint-file when ORCA_AGENT_HOOK_ENDPOINT is unset', async () => {
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
      ok: false,
      reason: 'no-endpoint-file'
    })
  })

  it('reports no-endpoint-file when evidence has no launchToken (S10-6 R1 deviation)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, endpointBody(1, 'x'), 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath
    // Why: launchToken is the one field this module refuses to source from the endpoint file
    // (see the DEVIATION comment on attemptOrchestrationReattest) — without it in evidence,
    // there is no genuine per-pane secret to present, so reattest never even reaches the file.
    await expect(
      attemptOrchestrationReattest({ terminalHandle: 'term-1', paneKey: EVIDENCE.paneKey })
    ).resolves.toEqual({ ok: false, reason: 'no-endpoint-file' })
  })

  it('reports ok:true when the runtime accepts the reattest (204)', async () => {
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

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({ ok: true })
    expect(receivedToken).toBe('the-hook-token')
    // Why: launchToken is always evidence's own (env-sourced) value — see the DEVIATION comment;
    // the endpoint file's token only ever authenticates the request (the header above).
    expect(receivedBody).toEqual({
      paneKey: EVIDENCE.paneKey,
      terminalHandle: EVIDENCE.terminalHandle,
      launchToken: EVIDENCE.launchToken
    })
  })

  it("prefers evidence (the pane's own env) over the endpoint file paneKey/terminalHandle when both are present (S10-6 review correction)", async () => {
    // Why: the endpoint file is one shared, runtime-wide secret — identical for every pane's
    // spawn env — so a paneKey/terminalHandle recorded in it can only ever name ONE pane. If the
    // file's values won, a future writer that populates them would make every OTHER pane's
    // reattest resolve to that one pane's identity — a cross-pane identity swap. Evidence (this
    // pane's own process env) must always win when present.
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    let receivedBody: unknown
    const filePaneKey = 'tab-9:99999999-9999-4999-8999-999999999999'
    const port = await startReattestServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(204)
        res.end()
      })
    })
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(
      endpointPath,
      endpointBody(port, 'the-hook-token', { paneKey: filePaneKey, terminalHandle: 'term-file' }),
      'utf8'
    )
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({ ok: true })
    expect(receivedBody).toEqual({
      paneKey: EVIDENCE.paneKey,
      terminalHandle: EVIDENCE.terminalHandle,
      launchToken: EVIDENCE.launchToken
    })
  })

  it('falls back to the endpoint file paneKey/terminalHandle only when evidence lacks them (S10-6 R1)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    let receivedBody: unknown
    const filePaneKey = 'tab-9:99999999-9999-4999-8999-999999999999'
    const port = await startReattestServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(204)
        res.end()
      })
    })
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(
      endpointPath,
      endpointBody(port, 'the-hook-token', { paneKey: filePaneKey, terminalHandle: 'term-file' }),
      'utf8'
    )
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    // Why: evidence with no paneKey/terminalHandle of its own — the only case the file's values
    // may legitimately be used for.
    await expect(
      attemptOrchestrationReattest({ launchToken: EVIDENCE.launchToken })
    ).resolves.toEqual({ ok: true })
    expect(receivedBody).toEqual({
      paneKey: filePaneKey,
      terminalHandle: 'term-file',
      launchToken: EVIDENCE.launchToken
    })
  })

  it('reports stale-endpoint-token on a 403', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const port = await startReattestServer((_req, res) => {
      res.writeHead(403)
      res.end()
    })
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, endpointBody(port, 'the-hook-token'), 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
      ok: false,
      reason: 'stale-endpoint-token'
    })
  })

  it('reports ok:false with no reason on a 404 (older runtime with no /reattest route)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const port = await startReattestServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, endpointBody(port, 'the-hook-token'), 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({ ok: false })
  })

  it('reports no-endpoint-file when the endpoint file is malformed (missing fields)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, 'ORCA_AGENT_HOOK_PORT=1\n', 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
      ok: false,
      reason: 'no-endpoint-file'
    })
  })

  it('reports no-endpoint-file and never fetches when the port field is non-numeric (S10-5 review F2)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(
      endpointPath,
      [
        'ORCA_AGENT_HOOK_PORT=1234/hook/claude?x=',
        'ORCA_AGENT_HOOK_TOKEN=the-hook-token',
        'ORCA_AGENT_HOOK_ENV=production',
        'ORCA_AGENT_HOOK_VERSION=1',
        ''
      ].join('\n'),
      'utf8'
    )
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
      ok: false,
      reason: 'no-endpoint-file'
    })
  })

  it('reports no-endpoint-file when the endpoint file is oversized', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'endpoint.env')
    writeFileSync(endpointPath, `ORCA_AGENT_HOOK_PORT=${'1'.repeat(5_000)}\n`, 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
      ok: false,
      reason: 'no-endpoint-file'
    })
  })

  it.skipIf(process.platform === 'win32')(
    'reports no-endpoint-file when the endpoint path is a symlink (not followed)',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
      const realPath = join(dir, 'real-endpoint.env')
      writeFileSync(realPath, endpointBody(1, 'x'), 'utf8')
      const linkPath = join(dir, 'endpoint.env')
      symlinkSync(realPath, linkPath)
      process.env.ORCA_AGENT_HOOK_ENDPOINT = linkPath

      await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
        ok: false,
        reason: 'no-endpoint-file'
      })
    }
  )

  it('reports no-endpoint-file when the endpoint path has an unrecognized basename', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    const endpointPath = join(dir, 'not-an-endpoint-file.txt')
    writeFileSync(endpointPath, endpointBody(1, 'x'), 'utf8')
    process.env.ORCA_AGENT_HOOK_ENDPOINT = endpointPath

    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
      ok: false,
      reason: 'no-endpoint-file'
    })
  })

  it('reports no-endpoint-file when the endpoint file does not exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-reattest-'))
    process.env.ORCA_AGENT_HOOK_ENDPOINT = join(dir, 'endpoint.env')
    await expect(attemptOrchestrationReattest(EVIDENCE)).resolves.toEqual({
      ok: false,
      reason: 'no-endpoint-file'
    })
  })
})
