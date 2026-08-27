import { describe, expect, it } from 'vitest'
import { parseOwnerRepo, resolveUpdateFeed } from './update-feed-resolution'

describe('resolveUpdateFeed', () => {
  it('checks upstream when package.json repository is stablyai/orca and no override is set', () => {
    const result = resolveUpdateFeed({
      packageRepository: 'github:stablyai/orca',
      env: {}
    })
    expect(result).toEqual({
      mode: 'upstream',
      owner: 'stablyai',
      repo: 'orca',
      reason: 'package-repository-upstream'
    })
  })

  it('never checks upstream for a fork build with no override (red case this guard exists to fix)', () => {
    const result = resolveUpdateFeed({
      packageRepository: 'github:clacy44/orca',
      env: {}
    })
    expect(result.mode).toBe('off')
    expect(result).toMatchObject({
      mode: 'off',
      message: 'Updates are managed manually for this build.',
      reason: 'package-repository-fork'
    })
  })

  it('never checks upstream when package.json has no repository field at all', () => {
    const result = resolveUpdateFeed({ packageRepository: undefined, env: {} })
    expect(result).toEqual({
      mode: 'off',
      message: 'Updates are managed manually for this build.',
      reason: 'package-repository-unset'
    })
  })

  it('ORCA_UPDATE_FEED=upstream forces the upstream feed even on a fork build', () => {
    const result = resolveUpdateFeed({
      packageRepository: 'github:clacy44/orca',
      env: { ORCA_UPDATE_FEED: 'upstream' }
    })
    expect(result).toEqual({
      mode: 'upstream',
      owner: 'stablyai',
      repo: 'orca',
      reason: 'env-override-upstream'
    })
  })

  it('ORCA_UPDATE_FEED=off suppresses checks even on the upstream build', () => {
    const result = resolveUpdateFeed({
      packageRepository: 'github:stablyai/orca',
      env: { ORCA_UPDATE_FEED: 'off' }
    })
    expect(result).toEqual({
      mode: 'off',
      message: 'Updates are managed manually for this build.',
      reason: 'env-override-off'
    })
  })

  it('ORCA_UPDATE_FEED=fork points at the fork repo parsed from package.json', () => {
    const result = resolveUpdateFeed({
      packageRepository: 'github:clacy44/orca',
      env: { ORCA_UPDATE_FEED: 'fork' }
    })
    expect(result).toEqual({
      mode: 'fork',
      owner: 'clacy44',
      repo: 'orca',
      reason: 'env-override-fork'
    })
  })

  it('ORCA_UPDATE_FEED=fork falls back to clacy44/orca when repository is unparseable', () => {
    const result = resolveUpdateFeed({
      packageRepository: undefined,
      env: { ORCA_UPDATE_FEED: 'fork' }
    })
    expect(result).toEqual({
      mode: 'fork',
      owner: 'clacy44',
      repo: 'orca',
      reason: 'env-override-fork'
    })
  })

  it('ignores an unrecognized ORCA_UPDATE_FEED value and falls through to package.json inference', () => {
    const result = resolveUpdateFeed({
      packageRepository: 'github:stablyai/orca',
      env: { ORCA_UPDATE_FEED: 'bogus' }
    })
    expect(result.mode).toBe('upstream')
  })
})

describe('parseOwnerRepo', () => {
  it('parses a plain "owner/repo" style shorthand string', () => {
    expect(parseOwnerRepo('github:stablyai/orca')).toEqual({ owner: 'stablyai', repo: 'orca' })
  })

  it('parses an https git URL with a .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/clacy44/orca.git')).toEqual({
      owner: 'clacy44',
      repo: 'orca'
    })
  })

  it('parses an npm-style repository object', () => {
    expect(parseOwnerRepo({ type: 'git', url: 'git+https://github.com/clacy44/orca.git' })).toEqual(
      { owner: 'clacy44', repo: 'orca' }
    )
  })

  it('returns null for garbage input', () => {
    expect(parseOwnerRepo(undefined)).toBeNull()
    expect(parseOwnerRepo(null)).toBeNull()
    expect(parseOwnerRepo(42)).toBeNull()
    expect(parseOwnerRepo('not a repo url')).toBeNull()
  })
})
