import { describe, expect, it } from 'vitest'
import {
  isAgentSessionOwnerBinding,
  type AgentSessionExecutionClaim,
  type AgentSessionOwnerBinding,
  type AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import { cloneAgentSessionOwnerBinding } from './claimed-agent-pty-owner-snapshot'

const claim: AgentSessionExecutionClaim = {
  digestVersion: 1,
  keyId: 'key',
  identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agent: 'codex'
}

const surface: AgentSessionSurfaceBinding = {
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '12345678-1234-4234-8234-123456789abc',
  terminalHandle: 'term_handle'
}

function owner(launchTokenHash?: string): AgentSessionOwnerBinding {
  return {
    claim,
    generation: 'gen-1',
    phase: 'live',
    ptyId: 'pty-1',
    surface,
    ...(launchTokenHash !== undefined ? { launchTokenHash } : {})
  }
}

// H2e (Ruling 32 Addendum 7/12): agent-session-host-authority.ts:205-206 accepts
// launchTokenHash only as a well-formed sha256 hex digest (64 lowercase hex chars) or absent
// entirely — never a malformed value that could masquerade as a hash.
describe('isAgentSessionOwnerBinding launchTokenHash clause', () => {
  const wellFormedHash = 'c'.repeat(64)

  it('accepts an owner carrying a 64-lowercase-hex launchTokenHash', () => {
    expect(isAgentSessionOwnerBinding(owner(wellFormedHash))).toBe(true)
  })

  it('rejects an owner whose launchTokenHash is malformed', () => {
    expect(isAgentSessionOwnerBinding(owner('C'.repeat(64)))).toBe(false) // uppercase
    expect(isAgentSessionOwnerBinding(owner('c'.repeat(63)))).toBe(false) // short
    expect(isAgentSessionOwnerBinding(owner('g'.repeat(64)))).toBe(false) // non-hex
  })

  it('the daemon adapter re-clone (cloneAgentSessionOwnerBinding) preserves launchTokenHash', () => {
    expect(cloneAgentSessionOwnerBinding(owner(wellFormedHash)).launchTokenHash).toBe(
      wellFormedHash
    )
  })
})
