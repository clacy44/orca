import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCaptureSourceOutsideClaudeLanes } from './managed-capture-containment'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

describe('assertCaptureSourceOutsideClaudeLanes', () => {
  let userData = ''
  let elsewhere = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-lanes-root-'))
    elsewhere = mkdtempSync(join(tmpdir(), 'orca-lanes-elsewhere-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  const lanesRoot = (): string => join(userData, 'claude-lanes')

  it('refuses the lanes root itself', () => {
    mkdirSync(lanesRoot(), { recursive: true })

    expect(() =>
      assertCaptureSourceOutsideClaudeLanes(lanesRoot(), 'claude-config-dir', lanesRoot())
    ).toThrow(/per-principal credential lane storage/)
  })

  it('refuses a lane directory under the lanes root', () => {
    const lane = join(lanesRoot(), 'grant-a')
    mkdirSync(lane, { recursive: true })

    expect(() => assertCaptureSourceOutsideClaudeLanes(lane, 'codex-home', lanesRoot())).toThrow(
      /Codex home directory/
    )
  })

  it('refuses a symlink whose target is a lane directory', () => {
    const lane = join(lanesRoot(), 'grant-a')
    mkdirSync(lane, { recursive: true })
    const decoy = join(elsewhere, 'decoy')
    symlinkSync(lane, decoy)

    expect(() =>
      assertCaptureSourceOutsideClaudeLanes(decoy, 'claude-config-dir', lanesRoot())
    ).toThrow(/symbolic link|per-principal credential lane storage/)
  })

  it('allows a path that merely contains claude-lanes as text', () => {
    const lookalike = join(elsewhere, 'claude-lanes-archive')
    mkdirSync(lookalike, { recursive: true })

    expect(() =>
      assertCaptureSourceOutsideClaudeLanes(lookalike, 'claude-config-dir', lanesRoot())
    ).not.toThrow()
  })

  it('allows a sibling directory of the lanes root', () => {
    const sibling = join(userData, 'claude-accounts')
    mkdirSync(sibling, { recursive: true })

    expect(() =>
      assertCaptureSourceOutsideClaudeLanes(sibling, 'claude-config-dir', lanesRoot())
    ).not.toThrow()
  })

  it('leaves a path that does not exist to the caller existence check', () => {
    expect(() =>
      assertCaptureSourceOutsideClaudeLanes(
        join(elsewhere, 'gone'),
        'claude-config-dir',
        lanesRoot()
      )
    ).not.toThrow()
  })
})

// §2m(4)'s Windows-only control for the §2d capture refusal. SKIPS on POSIX: only a real
// Windows host exercises `realpathSync.native` and the junction/case behaviour it is here for.
describe.runIf(process.platform === 'win32')('win32 capture containment', () => {
  let userData = ''
  let elsewhere = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-win-capture-'))
    elsewhere = mkdtempSync(join(tmpdir(), 'orca-win-capture-elsewhere-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  const lanesRoot = (): string => join(userData, 'claude-lanes')

  it('refuses a case-flipped lane path', () => {
    const lane = join(lanesRoot(), 'principal-a')
    mkdirSync(lane, { recursive: true })

    expect(() =>
      assertCaptureSourceOutsideClaudeLanes(lane.toUpperCase(), 'claude-config-dir', lanesRoot())
    ).toThrow(/per-principal credential lane storage/)
  })

  it('refuses a junction rather than following it, for a Codex home too', () => {
    const lane = join(lanesRoot(), 'principal-b')
    mkdirSync(lane, { recursive: true })
    const decoy = join(elsewhere, 'decoy')
    symlinkSync(lane, decoy, 'junction')

    expect(() => assertCaptureSourceOutsideClaudeLanes(decoy, 'codex-home', lanesRoot())).toThrow(
      /symbolic link/
    )
  })
})
