// D6: Linux-runnable e2e of the Windows hook host's logic (via its TS mirror) against a real
// AgentHookServer, plus a Windows-only spawn of the exact produced entry. See
// windows-hook-host-mirror.ts and native/windows-hook-host/OrcaHookHost.cs.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import { getWindowsManagedLifecycleHook } from '../claude/hook-settings'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  buildWindowsHookHostFormBody,
  parseWindowsHookHostDescriptor,
  parseWindowsHookHostEndpointFile,
  readWindowsHookHostStdin,
  resolveWindowsHookHostContext,
  runWindowsHookHostOnce,
  WINDOWS_HOOK_HOST_DEFAULT_FIELDS
} from './windows-hook-host-mirror'

describe('parseWindowsHookHostEndpointFile', () => {
  it('parses `set K=V` CRLF lines and guards the port', () => {
    const contents = 'set ORCA_AGENT_HOOK_PORT=54123\r\nset ORCA_AGENT_HOOK_TOKEN=tok-1\r\n'
    expect(parseWindowsHookHostEndpointFile(contents)).toEqual({
      port: '54123',
      token: 'tok-1',
      env: '',
      version: ''
    })
  })

  it('rejects a malformed port', () => {
    const contents = 'set ORCA_AGENT_HOOK_PORT=1234/hook\r\nset ORCA_AGENT_HOOK_TOKEN=tok-1\r\n'
    expect(parseWindowsHookHostEndpointFile(contents)).toBeNull()
  })

  it('returns null when the token is missing', () => {
    expect(parseWindowsHookHostEndpointFile('set ORCA_AGENT_HOOK_PORT=8080\r\n')).toBeNull()
  })
})

describe('resolveWindowsHookHostContext', () => {
  it('prefers the endpoint file over process env and guards PANE_KEY', () => {
    const context = resolveWindowsHookHostContext({
      endpointFileContents:
        'set ORCA_AGENT_HOOK_PORT=9999\r\nset ORCA_AGENT_HOOK_TOKEN=file-tok\r\n',
      processEnv: {
        ORCA_AGENT_HOOK_PORT: '1',
        ORCA_AGENT_HOOK_TOKEN: 'env-tok',
        ORCA_PANE_KEY: 'pane-1'
      }
    })
    expect(context).toEqual({
      port: '9999',
      token: 'file-tok',
      env: '',
      version: '',
      paneKey: 'pane-1'
    })
  })

  it('exits (returns null) when ORCA_PANE_KEY is missing', () => {
    expect(
      resolveWindowsHookHostContext({
        endpointFileContents: null,
        processEnv: { ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_TOKEN: 't' }
      })
    ).toBeNull()
  })
})

describe('parseWindowsHookHostDescriptor', () => {
  it('falls open to the built-in default when unreadable', () => {
    expect(parseWindowsHookHostDescriptor(null)).toEqual({
      source: 'claude',
      pathname: '/hook/claude',
      fields: WINDOWS_HOOK_HOST_DEFAULT_FIELDS
    })
    expect(parseWindowsHookHostDescriptor('not json')).toEqual({
      source: 'claude',
      pathname: '/hook/claude',
      fields: WINDOWS_HOOK_HOST_DEFAULT_FIELDS
    })
  })

  it('parses a well-formed descriptor', () => {
    expect(
      parseWindowsHookHostDescriptor(
        JSON.stringify({
          source: 'claude',
          pathname: '/hook/claude',
          fields: ['paneKey', 'payload']
        })
      )
    ).toEqual({ source: 'claude', pathname: '/hook/claude', fields: ['paneKey', 'payload'] })
  })
})

describe('buildWindowsHookHostFormBody', () => {
  it('URL-encodes values in the declared field order', () => {
    expect(
      buildWindowsHookHostFormBody(['paneKey', 'payload'], { paneKey: 'a b', payload: '{"x":1}' })
    ).toBe('paneKey=a%20b&payload=%7B%22x%22%3A1%7D')
  })
})

describe('readWindowsHookHostStdin', () => {
  it('reads a piped stream to EOF', async () => {
    const stream = new PassThrough()
    stream.end('hello stdin')
    await expect(
      readWindowsHookHostStdin(stream, { deadlineMs: 2000, capBytes: 1_000_000 })
    ).resolves.toBe('hello stdin')
  })

  it('caps at capBytes rather than blocking', async () => {
    const stream = new PassThrough()
    stream.end('0123456789')
    const result = await readWindowsHookHostStdin(stream, { deadlineMs: 2000, capBytes: 5 })
    expect(result).toBe('01234')
  })

  it('resolves at the deadline if the stream never ends', async () => {
    const stream = new PassThrough()
    stream.write('partial')
    const result = await readWindowsHookHostStdin(stream, { deadlineMs: 20, capBytes: 1_000_000 })
    expect(result).toBe('partial')
    stream.end()
  })
})

describe('runWindowsHookHostOnce against a live AgentHookServer', () => {
  let server: AgentHookServer
  let tmpDir: string

  beforeEach(() => {
    server = new AgentHookServer()
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-hook-host-mirror-'))
  })

  afterEach(() => {
    server.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('ingests a SessionStart payload piped through the mirror via a temp endpoint file', async () => {
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

    // Why: a real on-disk file, not just an in-memory string — proves the file-read path too.
    const endpointFilePath = join(tmpDir, 'endpoint.cmd')
    writeFileSync(
      endpointFilePath,
      `set ORCA_AGENT_HOOK_PORT=${env.ORCA_AGENT_HOOK_PORT}\r\n` +
        `set ORCA_AGENT_HOOK_TOKEN=${env.ORCA_AGENT_HOOK_TOKEN}\r\n` +
        `set ORCA_AGENT_HOOK_ENV=${env.ORCA_AGENT_HOOK_ENV}\r\n` +
        `set ORCA_AGENT_HOOK_VERSION=${env.ORCA_AGENT_HOOK_VERSION}\r\n`
    )

    const stdin = new PassThrough()
    stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }))

    const outcome = await runWindowsHookHostOnce({
      stdin,
      endpointFileContents: readFileSync(endpointFilePath, 'utf-8'),
      descriptorJson: null,
      processEnv: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt-1',
        ORCA_AGENT_LAUNCH_TOKEN: undefined
      }
    })

    expect(outcome).toBe('sent')
    const snapshot = server.getStatusSnapshot()
    expect(snapshot.some((entry) => entry.paneKey === paneKey)).toBe(true)
  })

  it('exits without a POST when the pane-key guard fails', async () => {
    await server.start({ env: 'production' })
    const stdin = new PassThrough()
    stdin.end('{}')
    const outcome = await runWindowsHookHostOnce({
      stdin,
      endpointFileContents: null,
      descriptorJson: null,
      processEnv: {}
    })
    expect(outcome).toBe('guard-exit')
    expect(server.getStatusSnapshot()).toHaveLength(0)
  })
})

// Windows-only: spawns the exact entry getWindowsManagedLifecycleHook() produces (the real .exe,
// built by config/scripts/build-windows-hook-host.mjs) with a piped SessionStart payload.
// LIMIT: process CreationFlags (whether a console was allocated) is not observable from here —
// this only proves ingestion, exit code, and empty stdio, not the absence of a flash.
describe.skipIf(process.platform !== 'win32')('windows-only: the produced exe entry', () => {
  it('ingests a piped SessionStart payload with exit 0 and empty stdio', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const paneKey = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
      const hook = getWindowsManagedLifecycleHook(
        'C:\\Users\\test\\.orca\\agent-hooks\\claude-hook.cmd'
      )

      const stdout = execFileSync(hook.command, hook.args ?? [], {
        env: {
          ...process.env,
          ORCA_AGENT_HOOK_PORT: env.ORCA_AGENT_HOOK_PORT,
          ORCA_AGENT_HOOK_TOKEN: env.ORCA_AGENT_HOOK_TOKEN,
          ORCA_AGENT_HOOK_ENV: env.ORCA_AGENT_HOOK_ENV,
          ORCA_AGENT_HOOK_VERSION: env.ORCA_AGENT_HOOK_VERSION,
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1'
        },
        input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
        encoding: 'utf-8'
      })

      expect(stdout).toBe('')
      const snapshot = server.getStatusSnapshot()
      expect(snapshot.some((entry) => entry.paneKey === paneKey)).toBe(true)
    } finally {
      server.stop()
    }
  })
})
