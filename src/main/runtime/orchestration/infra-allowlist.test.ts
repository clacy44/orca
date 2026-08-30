// S10-2 GATE §, h3 (s10-2-spec.md:150). See infra-allowlist.ts's file comment.
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  infraAllowlistPath,
  loadInfraAllowlist,
  resetInfraAllowlistCacheForTests
} from './infra-allowlist'

describe('loadInfraAllowlist', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it(':memory: never touches disk and is always inert', () => {
    expect(loadInfraAllowlist(':memory:')).toEqual([])
  })

  it('an absent allowlist file is inert, not a startup failure', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-infra-allowlist-'))
    const dbPath = join(tempDir, 'orchestration.db')
    expect(() => loadInfraAllowlist(dbPath)).not.toThrow()
    expect(loadInfraAllowlist(dbPath)).toEqual([])
  })

  it('loads newline-delimited literals from beside the DB, dropping blank lines', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-infra-allowlist-'))
    const dbPath = join(tempDir, 'orchestration.db')
    writeFileSync(infraAllowlistPath(dbPath), 'prod-db-07.internal\n\nprod-db-08.internal\n')
    expect(loadInfraAllowlist(dbPath)).toEqual(['prod-db-07.internal', 'prod-db-08.internal'])
  })

  it('hardens the file to mode 0600 on load (POSIX only)', () => {
    if (process.platform === 'win32') {
      return
    }
    tempDir = mkdtempSync(join(tmpdir(), 'orca-infra-allowlist-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const path = infraAllowlistPath(dbPath)
    writeFileSync(path, 'prod-db-07.internal\n')
    chmodSync(path, 0o644)
    loadInfraAllowlist(dbPath)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('is read once per process and cached: a file written after the first load is not picked up', () => {
    // Mutation this kills: re-reading the file on every call instead of caching — the spec
    // requires "read once per process and cached" (s10-2-spec.md:150).
    tempDir = mkdtempSync(join(tmpdir(), 'orca-infra-allowlist-'))
    const dbPath = join(tempDir, 'orchestration.db')
    expect(loadInfraAllowlist(dbPath)).toEqual([])
    writeFileSync(infraAllowlistPath(dbPath), 'late-literal.internal\n')
    expect(loadInfraAllowlist(dbPath)).toEqual([])
    resetInfraAllowlistCacheForTests(dbPath)
    expect(loadInfraAllowlist(dbPath)).toEqual(['late-literal.internal'])
  })
})
