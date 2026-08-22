import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCaptureSourceOutsideClaudeGrants } from './managed-capture-containment'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

describe('assertCaptureSourceOutsideClaudeGrants', () => {
  let userData = ''
  let elsewhere = ''

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-grants-root-'))
    elsewhere = mkdtempSync(join(tmpdir(), 'orca-grants-elsewhere-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })

  const grantsRoot = (): string => join(userData, 'claude-grants')

  it('refuses the grants root itself', () => {
    mkdirSync(grantsRoot(), { recursive: true })

    expect(() =>
      assertCaptureSourceOutsideClaudeGrants(grantsRoot(), 'claude-config-dir', grantsRoot())
    ).toThrow(/per-grant credential storage/)
  })

  it('refuses a lane directory under the grants root', () => {
    const lane = join(grantsRoot(), 'grant-a')
    mkdirSync(lane, { recursive: true })

    expect(() => assertCaptureSourceOutsideClaudeGrants(lane, 'codex-home', grantsRoot())).toThrow(
      /Codex home directory/
    )
  })

  it('refuses a symlink whose target is a lane directory', () => {
    const lane = join(grantsRoot(), 'grant-a')
    mkdirSync(lane, { recursive: true })
    const decoy = join(elsewhere, 'decoy')
    symlinkSync(lane, decoy)

    expect(() =>
      assertCaptureSourceOutsideClaudeGrants(decoy, 'claude-config-dir', grantsRoot())
    ).toThrow(/symbolic link|per-grant credential storage/)
  })

  it('allows a path that merely contains claude-grants as text', () => {
    const lookalike = join(elsewhere, 'claude-grants-archive')
    mkdirSync(lookalike, { recursive: true })

    expect(() =>
      assertCaptureSourceOutsideClaudeGrants(lookalike, 'claude-config-dir', grantsRoot())
    ).not.toThrow()
  })

  it('allows a sibling directory of the grants root', () => {
    const sibling = join(userData, 'claude-accounts')
    mkdirSync(sibling, { recursive: true })

    expect(() =>
      assertCaptureSourceOutsideClaudeGrants(sibling, 'claude-config-dir', grantsRoot())
    ).not.toThrow()
  })

  it('leaves a path that does not exist to the caller existence check', () => {
    expect(() =>
      assertCaptureSourceOutsideClaudeGrants(
        join(elsewhere, 'gone'),
        'claude-config-dir',
        grantsRoot()
      )
    ).not.toThrow()
  })
})
