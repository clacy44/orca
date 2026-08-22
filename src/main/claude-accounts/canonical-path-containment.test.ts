import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalizePathForContainment,
  isCanonicalPathWithinRoot,
  isPathWithinRootForDenial
} from './canonical-path-containment'

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
