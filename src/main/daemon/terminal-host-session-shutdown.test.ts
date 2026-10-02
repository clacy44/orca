import { afterEach, describe, expect, it, vi } from 'vitest'
import { killWithDescendantSweep } from '../pty-descendant-termination'
import type { Session } from './session'
import { shutdownTerminalHostSessions } from './terminal-host-session-shutdown'

type FakeSession = Session & {
  forceKillAndDisposeSubprocess: ReturnType<typeof vi.fn>
  disposeSubprocess: ReturnType<typeof vi.fn>
  waitForExitAndDisposeSubprocess: ReturnType<typeof vi.fn>
}

function fakeSession(pid: number, alive: boolean): FakeSession {
  const session = {
    pid,
    isAlive: alive,
    detachAllClients: vi.fn(),
    forceKillAndDisposeSubprocess: vi.fn(async () => {
      session.isAlive = false
    }),
    disposeSubprocess: vi.fn(),
    waitForExitAndDisposeSubprocess: vi.fn(async () => {
      session.isAlive = false
    })
  }
  return session as unknown as FakeSession
}

describe('shutdownTerminalHostSessions: win32 descendant sweep before the root force-kill (FX-4a)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sweeps the live root pid, with an ownsRoot gate, BEFORE force-killing the root', async () => {
    const session = fakeSession(50564, true)
    const sweep = vi.fn(async (_pid: number, _killRoot: () => void, _deps?: unknown) => {})

    await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
      platform: 'win32',
      sweep
    })

    expect(sweep).toHaveBeenCalledTimes(1)
    expect(sweep.mock.calls[0]?.[0]).toBe(50564)
    const deps = sweep.mock.calls[0]?.[2] as { ownsRoot: () => boolean }
    expect(deps.ownsRoot()).toBe(false)
    expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(
      session.forceKillAndDisposeSubprocess.mock.invocationCallOrder[0]
    )
    expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
  })

  it('the ownsRoot gate holds while the session still owns a live root', async () => {
    const session = fakeSession(50564, true)
    let ownedDuringSweep: boolean | undefined
    const sweep = vi.fn(async (_pid: number, _killRoot: () => void, deps?: unknown) => {
      ownedDuringSweep = (deps as { ownsRoot: () => boolean }).ownsRoot()
    })

    await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
      platform: 'win32',
      sweep
    })

    expect(ownedDuringSweep).toBe(true)
  })

  it('does not sweep a dead session (its pid may be recycled) and logs the skip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = fakeSession(50564, false)
    const sweep = vi.fn(async () => {})

    await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
      platform: 'win32',
      sweep
    })

    expect(sweep).not.toHaveBeenCalled()
    expect(session.disposeSubprocess).toHaveBeenCalledTimes(1)
    expect(session.forceKillAndDisposeSubprocess).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reason=root_not_alive'))
  })

  it.each(['linux', 'darwin'] as const)('does not sweep on %s', async (platform) => {
    const session = fakeSession(50564, true)
    const sweep = vi.fn(async () => {})

    await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, { platform, sweep })

    expect(sweep).not.toHaveBeenCalled()
    expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
  })

  it('never tree-kills a root whose ownership probe says foreign, still force-kills it, and logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = fakeSession(50564, true)
    const killWindowsTree = vi.fn(async () => {})

    await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
      platform: 'win32',
      verifyTreeKillTarget: async () => 'foreign',
      sweep: (pid, killRoot, deps) =>
        killWithDescendantSweep(pid, killRoot, { ...deps, platform: 'win32', killWindowsTree })
    })

    expect(killWindowsTree).not.toHaveBeenCalled()
    expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reason=root_foreign'))
  })

  it('tree-kills an owned root through the real sweep before the root force-kill', async () => {
    const session = fakeSession(50564, true)
    const killWindowsTree = vi.fn(async () => {})

    await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
      platform: 'win32',
      verifyTreeKillTarget: async () => 'own',
      sweep: (pid, killRoot, deps) =>
        killWithDescendantSweep(pid, killRoot, { ...deps, platform: 'win32', killWindowsTree })
    })

    expect(killWindowsTree).toHaveBeenCalledWith(50564)
    expect(killWindowsTree.mock.invocationCallOrder[0]).toBeLessThan(
      session.forceKillAndDisposeSubprocess.mock.invocationCallOrder[0]
    )
  })

  it('a failing sweep is logged and never blocks the root force-kill', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = fakeSession(50564, true)

    await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
      platform: 'win32',
      sweep: async () => {
        throw new Error('taskkill exploded')
      }
    })

    expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reason=sweep_failed'))
  })

  describe('F5: no second PID-based kill after the tree kill took the root', () => {
    const own = {
      platform: 'win32',
      verifyTreeKillTarget: async (): Promise<'own'> => 'own'
    } as const
    const taskkill = (exitCode: number | null) => vi.fn(async () => ({ exitCode }))

    it('(i) taskkill exit 0 goes straight to the dispose wait, with no PID force-kill, and logs the branch', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = fakeSession(50564, true)

      await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
        ...own,
        killWindowsTree: taskkill(0)
      })

      expect(session.forceKillAndDisposeSubprocess).not.toHaveBeenCalled()
      expect(session.waitForExitAndDisposeSubprocess).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('branch=await_exit'))
    })

    it.each([
      ['a non-zero taskkill exit', 128],
      ['a taskkill that never ran to an exit', null]
    ])('(ii) %s keeps the PID force-kill and logs the branch', async (_name, exitCode) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = fakeSession(50564, true)

      await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
        ...own,
        killWindowsTree: taskkill(exitCode)
      })

      expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
      expect(session.waitForExitAndDisposeSubprocess).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('branch=force_kill'))
    })

    it('a throwing taskkill keeps the PID force-kill', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = fakeSession(50564, true)

      await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
        ...own,
        killWindowsTree: async () => {
          throw new Error('boom')
        }
      })

      expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
    })

    it('a foreign root never runs taskkill and keeps the PID force-kill', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const session = fakeSession(50564, true)
      const killWindowsTree = taskkill(0)

      await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
        platform: 'win32',
        verifyTreeKillTarget: async (): Promise<'foreign'> => 'foreign',
        killWindowsTree
      })

      expect(killWindowsTree).not.toHaveBeenCalled()
      expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
    })

    it('a custom sweep that reports nothing keeps the PID force-kill', async () => {
      const session = fakeSession(50564, true)

      await shutdownTerminalHostSessions(new Map([['s1', session]]), undefined, {
        platform: 'win32',
        sweep: async () => {}
      })

      expect(session.forceKillAndDisposeSubprocess).toHaveBeenCalledTimes(1)
    })
  })
})
