// Why (R105): proves the produced Windows entry (hook-settings.ts:138-153 — cmd.exe spawned
// directly, no conhost wrapper) actually delivers a piped stdin payload to the hook client end
// to end. Windows-only: the entry spawns Windows-native cmd.exe/curl.exe against the managed
// .cmd (hook-service.ts:60-90); on any other platform the produced entry is the POSIX shell form
// and this reproduction does not apply.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { ClaudeHookService } from './hook-service'
import { getWindowsManagedLifecycleHook } from './hook-settings'

describe.skipIf(process.platform !== 'win32')(
  'Windows cmd.exe exec-form hook: stdin delivery (R105)',
  () => {
    it('delivers a piped SessionStart payload to the hook listener via the produced command+args', async () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-exec-form-stdin-'))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      try {
        // Write the real managed .cmd the entry `call`s (hook-service.ts:60-90), the same way
        // production install() does.
        expect(new ClaudeHookService().install().state).toBe('installed')

        const scriptPath = join(tmpHome, '.orca', 'agent-hooks', 'claude-hook.cmd')
        const hook = getWindowsManagedLifecycleHook(scriptPath)

        const receivedPayload = await new Promise<string | undefined>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('timed out waiting for the hook POST'))
          }, 8000)

          const server = createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(chunk))
            req.on('end', () => {
              res.statusCode = 200
              res.end()
              clearTimeout(timer)
              const body = Buffer.concat(chunks).toString('utf-8')
              const payload = new URLSearchParams(body).get('payload') ?? undefined
              server.close()
              resolve(payload)
            })
          })

          server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo
            const child = spawn(hook.command, hook.args ?? [], {
              env: {
                ...process.env,
                ORCA_AGENT_HOOK_PORT: String(port),
                ORCA_AGENT_HOOK_TOKEN: 'test-token',
                ORCA_PANE_KEY: 'test-pane'
              },
              windowsHide: true
            })
            child.on('error', reject)
            child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart' }))
          })
        })

        expect(receivedPayload).toBeDefined()
        expect(JSON.parse(receivedPayload as string)).toMatchObject({
          hook_event_name: 'SessionStart'
        })
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }, 15000)
  }
)
