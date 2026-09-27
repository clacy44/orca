import { describe, expect, it, vi } from 'vitest'
import {
  parseWhoamiGroupsCsv,
  probeCurrentProcessIntegrity,
  runWhoami,
  ProcessIntegrityCache,
  startDaemonIntegrityReport,
  INCONCLUSIVE_RETRY_MS,
  WHOAMI_GROUPS_ARGS,
  WHOAMI_TIMEOUT_MS
} from './windows-integrity-level'
import type { IntegrityProbe } from './windows-integrity-level'

const CRLF_HIGH = '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""\r\n'
const MEDIUM_ROW = '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""\r\n'

describe('parseWhoamiGroupsCsv', () => {
  it('a: English High, CRLF', () => {
    expect(parseWhoamiGroupsCsv(CRLF_HIGH)).toEqual({ level: 'high', detail: 'S-1-16-12288' })
  })

  it('b: English Medium, BUILTIN\\Administrators deny-only', () => {
    const stdout = `"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n${MEDIUM_ROW}`
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('medium')
  })

  it('c: German localized High', () => {
    const stdout =
      '"Verbindliche Beschriftung\\Hohe Verbindlichkeitsstufe","Bezeichnung","S-1-16-12288",""\r\n'
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('high')
  })

  it('d: System 16384', () => {
    const stdout = '"Mandatory Label\\System Mandatory Level","Label","S-1-16-16384",""\r\n'
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('high')
  })

  it('e: Medium-Plus 8448', () => {
    const stdout = '"Mandatory Label\\Medium Plus Mandatory Level","Label","S-1-16-8448",""\r\n'
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('medium')
  })

  it('f: Low 4096', () => {
    const stdout = '"Mandatory Label\\Low Mandatory Level","Label","S-1-16-4096",""\r\n'
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('low')
  })

  it('g: Untrusted 0', () => {
    const stdout = '"Mandatory Label\\Untrusted Mandatory Level","Label","S-1-16-0",""\r\n'
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('low')
  })

  it('h: no label row', () => {
    const stdout =
      '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"\r\n'
    expect(parseWhoamiGroupsCsv(stdout)).toEqual({
      level: 'unknown',
      detail: 'no mandatory label in whoami output'
    })
  })

  it('i: empty string', () => {
    expect(parseWhoamiGroupsCsv('').level).toBe('unknown')
  })

  it('j: a group NAMED S-1-16-8192 plus the real High label -> ambiguous', () => {
    const stdout = `"S-1-16-8192","Group","S-1-5-21-111-222-333-1001",""\r\n${CRLF_HIGH}`
    expect(parseWhoamiGroupsCsv(stdout)).toEqual({
      level: 'unknown',
      detail: 'ambiguous mandatory labels (2)'
    })
  })

  it('k: SID text inside a longer field plus High -> high', () => {
    const stdout = `"x S-1-16-8192","Group","S-1-5-21-111-222-333-1002",""\r\n${CRLF_HIGH}`
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('high')
  })

  it('l: NUL-interleaved (UTF-16LE mis-decoded) High', () => {
    const stdout = CRLF_HIGH.split('')
      .map((c) => `${c}\u0000`)
      .join('')
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('high')
  })

  it('m: 11-digit RID -> unknown', () => {
    const stdout = '"Mandatory Label\\Something","Label","S-1-16-12345678901",""\r\n'
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('unknown')
  })

  it('n: header row present -> medium', () => {
    const stdout = `"Group Name","Type","SID","Attributes"\r\n${MEDIUM_ROW}`
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('medium')
  })

  it('o: ""-escaped quotes in a group name -> medium', () => {
    const stdout = `"Some ""Quoted"" Group","Group","S-1-5-21-1-2-3-1000",""\r\n${MEDIUM_ROW}`
    expect(parseWhoamiGroupsCsv(stdout).level).toBe('medium')
  })
})

describe('probeCurrentProcessIntegrity', () => {
  it('p: platform linux -> n/a, runWhoamiImpl not called', async () => {
    const spy = vi.fn()
    const result = await probeCurrentProcessIntegrity({ platform: 'linux', runWhoamiImpl: spy })
    expect(result).toEqual({ level: 'n/a', detail: 'platform linux' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('q: win32 with systemRoot builds the System32 path and parses stdout', async () => {
    const spy = vi.fn().mockResolvedValue(CRLF_HIGH)
    const result = await probeCurrentProcessIntegrity({
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runWhoamiImpl: spy
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('C:\\Windows\\System32\\whoami.exe')
    expect(result.level).toBe('high')
  })

  it('N5 (kills R8): an empty SystemRoot falls through to WINDIR, then C:\\Windows', async () => {
    const savedSystemRoot = process.env.SystemRoot
    const savedWindir = process.env.WINDIR
    try {
      process.env.SystemRoot = ''
      process.env.WINDIR = 'D:\\W'
      const spy1 = vi.fn().mockResolvedValue(CRLF_HIGH)
      await probeCurrentProcessIntegrity({ platform: 'win32', systemRoot: '', runWhoamiImpl: spy1 })
      expect(spy1).toHaveBeenCalledWith('D:\\W\\System32\\whoami.exe')

      process.env.WINDIR = ''
      const spy2 = vi.fn().mockResolvedValue(CRLF_HIGH)
      await probeCurrentProcessIntegrity({ platform: 'win32', systemRoot: '', runWhoamiImpl: spy2 })
      expect(spy2).toHaveBeenCalledWith('C:\\Windows\\System32\\whoami.exe')
    } finally {
      if (savedSystemRoot === undefined) {
        delete process.env.SystemRoot
      } else {
        process.env.SystemRoot = savedSystemRoot
      }
      if (savedWindir === undefined) {
        delete process.env.WINDIR
      } else {
        process.env.WINDIR = savedWindir
      }
    }
  })

  it('r: spy rejects with {code:ENOENT} -> unknown, detail contains ENOENT', async () => {
    const spy = vi.fn().mockRejectedValue({ code: 'ENOENT' })
    const result = await probeCurrentProcessIntegrity({
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      runWhoamiImpl: spy
    })
    expect(result.level).toBe('unknown')
    expect(result.detail).toContain('ENOENT')
  })

  it('s: spy throws synchronously -> unknown, probe does not reject', async () => {
    const spy = vi.fn(() => {
      throw new Error('boom')
    })
    await expect(
      probeCurrentProcessIntegrity({
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        runWhoamiImpl: spy
      })
    ).resolves.toEqual(expect.objectContaining({ level: 'unknown' }))
  })

  it('t: never-settling runner -> unknown after 6000ms', async () => {
    vi.useFakeTimers()
    try {
      const spy = vi.fn(() => new Promise<string>(() => {}))
      const promise = probeCurrentProcessIntegrity({
        platform: 'win32',
        systemRoot: 'C:\\Windows',
        runWhoamiImpl: spy
      })
      await vi.advanceTimersByTimeAsync(6000)
      const result = await promise
      expect(result).toEqual({ level: 'unknown', detail: 'whoami did not settle' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runWhoami', () => {
  it('u: passes fixed argv and options; a callback error rejects', async () => {
    const fakeExecFile = vi.fn(
      (_file: string, _args: string[], _options: unknown, cb: (...a: unknown[]) => void) => {
        cb(new Error('nope'))
      }
    )
    await expect(
      runWhoami('C:\\Windows\\System32\\whoami.exe', fakeExecFile as never)
    ).rejects.toThrow('nope')
    expect(fakeExecFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\whoami.exe',
      WHOAMI_GROUPS_ARGS,
      { encoding: 'utf8', windowsHide: true, timeout: WHOAMI_TIMEOUT_MS, maxBuffer: 1_048_576 },
      expect.any(Function)
    )
  })
})

describe('ProcessIntegrityCache', () => {
  it('v: a conclusive result -> probe called once across 3 resolve() calls', async () => {
    const probe = vi
      .fn()
      .mockResolvedValue({ level: 'medium', detail: 'x' } satisfies IntegrityProbe)
    const cache = new ProcessIntegrityCache(probe)
    await cache.resolve()
    await cache.resolve()
    await cache.resolve()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('w: two concurrent resolve() calls share one probe', async () => {
    const probe = vi.fn().mockResolvedValue({ level: 'high', detail: 'x' } satisfies IntegrityProbe)
    const cache = new ProcessIntegrityCache(probe)
    const [a, b] = await Promise.all([cache.resolve(), cache.resolve()])
    expect(a).toEqual(b)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('x: unknown not re-probed before 30s, re-probed at 30s, later conclusive is final', async () => {
    let time = 0
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ level: 'unknown', detail: 'first' } satisfies IntegrityProbe)
      .mockResolvedValueOnce({ level: 'medium', detail: 'second' } satisfies IntegrityProbe)
    const cache = new ProcessIntegrityCache(probe, () => time)

    expect(await cache.resolve()).toEqual({ level: 'unknown', detail: 'first' })
    time = 29_999
    expect(await cache.resolve()).toEqual({ level: 'unknown', detail: 'first' })
    expect(probe).toHaveBeenCalledTimes(1)
    time = 30_000
    expect(await cache.resolve()).toEqual({ level: 'medium', detail: 'second' })
    expect(probe).toHaveBeenCalledTimes(2)
    time = 999_999
    expect(await cache.resolve()).toEqual({ level: 'medium', detail: 'second' })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('y: peek() is null before the first settle', () => {
    const cache = new ProcessIntegrityCache(
      vi.fn().mockResolvedValue({ level: 'medium', detail: 'x' })
    )
    expect(cache.peek()).toBeNull()
  })

  it('z: onSettle fires once per actual probe', async () => {
    const onSettle = vi.fn()
    let time = 0
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ level: 'unknown', detail: 'first' } satisfies IntegrityProbe)
      .mockResolvedValueOnce({ level: 'medium', detail: 'second' } satisfies IntegrityProbe)
    const cache = new ProcessIntegrityCache(probe, () => time, onSettle)
    await cache.resolve()
    await Promise.all([cache.resolve(), cache.resolve()])
    time = 30_000
    await cache.resolve()
    expect(onSettle).toHaveBeenCalledTimes(2)
  })
})

describe('startDaemonIntegrityReport', () => {
  it('aa: current() undefined while pending, then the level after settle; logs on settle', async () => {
    let settle!: (probe: IntegrityProbe) => void
    const pending = new Promise<IntegrityProbe>((resolve) => {
      settle = resolve
    })
    const log = { log: vi.fn() }
    const report = startDaemonIntegrityReport(log, () => pending)
    expect(report.current()).toBeUndefined()
    settle({ level: 'high', detail: 'S-1-16-12288' })
    await pending
    await Promise.resolve()
    await Promise.resolve()
    expect(report.current()).toBe('high')
    expect(log.log).toHaveBeenCalledWith('integrity', { level: 'high', detail: 'S-1-16-12288' })
  })

  it('N4 (kills MX4): an unknown probe -> current() returns unknown, not undefined', async () => {
    const log = { log: vi.fn() }
    const report = startDaemonIntegrityReport(log, () =>
      Promise.resolve({ level: 'unknown', detail: 'still probing' })
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(report.current()).toBe('unknown')
  })

  it('ab: an n/a probe -> current() undefined and no log line', async () => {
    const log = { log: vi.fn() }
    const report = startDaemonIntegrityReport(log, () =>
      Promise.resolve({ level: 'n/a', detail: 'platform linux' })
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(report.current()).toBeUndefined()
    expect(log.log).not.toHaveBeenCalled()
  })

  it('T1: an unknown daemon probe retries on its own after 30 s and heals to the next conclusive result', async () => {
    vi.useFakeTimers()
    try {
      const probe = vi
        .fn()
        .mockResolvedValueOnce({ level: 'unknown', detail: 'first' } satisfies IntegrityProbe)
        .mockResolvedValueOnce({ level: 'medium', detail: 'second' } satisfies IntegrityProbe)
      const log = { log: vi.fn() }
      const report = startDaemonIntegrityReport(log, probe)
      await vi.advanceTimersByTimeAsync(0)
      expect(report.current()).toBe('unknown')
      expect(probe).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(INCONCLUSIVE_RETRY_MS)
      expect(probe).toHaveBeenCalledTimes(2)
      expect(report.current()).toBe('medium')
    } finally {
      vi.useRealTimers()
    }
  })

  it('T1b (kills the A1 mutant): the retry still probes when the timer fires before the clock says 30 s passed', async () => {
    vi.useFakeTimers()
    try {
      let time = 0
      const probe = vi
        .fn()
        .mockResolvedValueOnce({ level: 'unknown', detail: 'first' } satisfies IntegrityProbe)
        .mockResolvedValueOnce({ level: 'unknown', detail: 'second' } satisfies IntegrityProbe)
        .mockResolvedValueOnce({ level: 'medium', detail: 'third' } satisfies IntegrityProbe)
      const log = { log: vi.fn() }
      const report = startDaemonIntegrityReport(log, probe, () => time)
      await vi.advanceTimersByTimeAsync(0)
      expect(probe).toHaveBeenCalledTimes(1)
      const settledAt = time
      // the timer runs on the fake-timer clock, but the injected `now` lags behind: only
      // 29_940 ms have passed by its account when the timer callback fires.
      time = settledAt + 29_940
      await vi.advanceTimersByTimeAsync(INCONCLUSIVE_RETRY_MS)
      expect(probe).toHaveBeenCalledTimes(2)
      expect(report.current()).toBe('unknown')
      time += 29_940
      await vi.advanceTimersByTimeAsync(INCONCLUSIVE_RETRY_MS)
      expect(probe).toHaveBeenCalledTimes(3)
      expect(report.current()).toBe('medium')
      // the chain stops once conclusive: no further probe after medium
      await vi.advanceTimersByTimeAsync(INCONCLUSIVE_RETRY_MS * 2)
      expect(probe).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
