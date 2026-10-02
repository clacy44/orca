// D-30a (T7): a normal quit must disconnect from the daemon, never shut it down. A shutdown would
// kill every chair on each deliberate quit, turning it into a prompted cold-start relaunch.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runQuitDaemonTeardown } from './quit-daemon-teardown'

describe('runQuitDaemonTeardown', () => {
  it('a normal quit disconnects and never shuts the daemon down', () => {
    const shutdown = vi.fn(() => 'shutdown')
    const disconnect = vi.fn(() => 'disconnect')
    expect(runQuitDaemonTeardown(false, { shutdown, disconnect })).toBe('disconnect')
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('only the dev-parent shutdown path shuts the daemon down', () => {
    const shutdown = vi.fn(() => 'shutdown')
    const disconnect = vi.fn(() => 'disconnect')
    expect(runQuitDaemonTeardown(true, { shutdown, disconnect })).toBe('shutdown')
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('main wires the quit through it with the real shutdown and disconnect, keyed by dev-parent shutdown', () => {
    const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
    expect(source).toMatch(
      /runQuitDaemonTeardown\(isDevParentShutdownRequested\(\), \{\s*shutdown: shutdownDaemon,\s*disconnect: disconnectDaemon\s*\}\)/
    )
    expect(source.match(/\bshutdownDaemon\(\)/g) ?? []).toHaveLength(0)
  })
})
