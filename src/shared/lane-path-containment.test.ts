import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalizePathForContainment,
  isCanonicalPathWithinRoot,
  isPathWithinRootForDenial
} from './lane-path-containment'

describe('isCanonicalPathWithinRoot', () => {
  it('accepts the root itself and a descendant', () => {
    expect(isCanonicalPathWithinRoot('/u/claude-lanes', '/u/claude-lanes', 'linux')).toBe(true)
    expect(isCanonicalPathWithinRoot('/u/claude-lanes', '/u/claude-lanes/p', 'linux')).toBe(true)
  })

  it('rejects a sibling that shares the root as a text prefix', () => {
    expect(isCanonicalPathWithinRoot('/u/claude-lanes', '/u/claude-lanes-archive', 'linux')).toBe(
      false
    )
  })

  // Negative control for the deny-direction fold: on APFS a case-only mismatch would otherwise
  // fail OPEN. Linux is the one place where the two paths are genuinely distinct files.
  // (Windows-shaped roots fold by path syntax inside isPathInsideOrEqual, on every platform.)
  it('folds case on darwin but not on linux', () => {
    expect(isCanonicalPathWithinRoot('/u/claude-lanes', '/u/Claude-Lanes/p', 'darwin')).toBe(true)
    expect(isCanonicalPathWithinRoot('/u/claude-lanes', '/u/Claude-Lanes/p', 'linux')).toBe(false)
  })
})

describe('isPathWithinRootForDenial', () => {
  let userData = ''
  let elsewhere = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-deny-root-'))
    elsewhere = mkdtempSync(join(tmpdir(), 'orca-deny-elsewhere-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  const lanesRoot = (): string => join(userData, 'claude-lanes')

  it('denies a lane path that does not exist yet', () => {
    expect(isPathWithinRootForDenial(lanesRoot(), join(lanesRoot(), 'principal-a'))).toBe(true)
  })

  it('denies a symlink whose target is a lane directory', () => {
    const lane = join(lanesRoot(), 'principal-a')
    mkdirSync(lane, { recursive: true })
    const decoy = join(elsewhere, 'decoy')
    symlinkSync(lane, decoy)

    expect(isPathWithinRootForDenial(lanesRoot(), decoy)).toBe(true)
  })

  it('denies a traversal that lands back inside the root', () => {
    expect(isPathWithinRootForDenial(lanesRoot(), join(elsewhere, '..', 'x'))).toBe(false)
    expect(
      isPathWithinRootForDenial(lanesRoot(), join(lanesRoot(), 'principal-a', '..', 'principal-b'))
    ).toBe(true)
  })

  it('allows unrelated values, including non-paths and empty strings', () => {
    expect(isPathWithinRootForDenial(lanesRoot(), elsewhere)).toBe(false)
    expect(isPathWithinRootForDenial(lanesRoot(), 'xterm-256color')).toBe(false)
    expect(isPathWithinRootForDenial(lanesRoot(), '')).toBe(false)
  })
})

describe('canonicalizePathForContainment', () => {
  it('reports a symlinked final component as its own kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-canon-'))
    try {
      const target = join(dir, 'target')
      mkdirSync(target)
      const link = join(dir, 'link')
      symlinkSync(target, link)

      expect(canonicalizePathForContainment(link)).toEqual({ kind: 'symlink' })
      expect(canonicalizePathForContainment(join(dir, 'missing'))).toEqual({ kind: 'unresolvable' })
      expect(canonicalizePathForContainment(target).kind).toBe('canonical')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// §2m(4) asks for a Windows-only control per containment site: the four Windows-specific
// escapes are 8.3 short names, drive-letter/segment case, junctions and the extended-length
// `\\?\` prefix, and only a real Windows host can exercise `realpathSync.native`'s handling
// of them. These SKIP on POSIX by construction — a Linux run proves nothing about them.
describe.runIf(process.platform === 'win32')('win32 containment', () => {
  let userData = ''
  let elsewhere = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-win-root-'))
    elsewhere = mkdtempSync(join(tmpdir(), 'orca-win-elsewhere-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  const lanesRoot = (): string => join(userData, 'claude-lanes')

  it('denies a lane path whose drive letter and segments are case-flipped', () => {
    const lane = join(lanesRoot(), 'principal-a')

    expect(isPathWithinRootForDenial(lanesRoot(), lane.toUpperCase())).toBe(true)
    expect(isPathWithinRootForDenial(lanesRoot(), lane.toLowerCase())).toBe(true)
  })

  it('denies a lane path wearing the extended-length prefix', () => {
    const lane = join(lanesRoot(), 'principal-a')

    expect(isPathWithinRootForDenial(lanesRoot(), `\\\\?\\${lane}`)).toBe(true)
  })

  // A junction needs no privilege on Windows, which makes it the cheap escape; Node reports
  // it as both a symlink and a directory, and the symlink branch must win.
  it('reports a junction as a symlink, not as its target directory', () => {
    const lane = join(lanesRoot(), 'principal-b')
    mkdirSync(lane, { recursive: true })
    const decoy = join(elsewhere, 'decoy')
    symlinkSync(lane, decoy, 'junction')

    expect(canonicalizePathForContainment(decoy)).toEqual({ kind: 'symlink' })
    expect(isPathWithinRootForDenial(lanesRoot(), decoy)).toBe(true)
  })

  it('resolves an 8.3 short name back to the long path it addresses', () => {
    const lane = join(lanesRoot(), 'principal-with-a-very-long-name')
    mkdirSync(lane, { recursive: true })
    const canonical = canonicalizePathForContainment(lane)

    expect(canonical.kind).toBe('canonical')
    expect(
      canonical.kind === 'canonical' && isCanonicalPathWithinRoot(lanesRoot(), canonical.path)
    ).toBe(true)
  })
})
