// H2c (F-6d, Ruling 32 Addendum 7) T7: createOrAttachClaimedAgentSession must pass the
// registry a launchTokenHash computed from the SAME env this create is about to spawn with
// (args.options.env), never the raw token, and never omit it when a token is present.
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createOrAttachClaimedAgentSession } from './terminal-host-agent-session-claim'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type { CreateOrAttachOptions, CreateOrAttachResult } from './terminal-host-create-contract'

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

function fakeOwners(ensure: ReturnType<typeof vi.fn>): ClaimedAgentPtyOwnerRegistry {
  return { ensure } as unknown as ClaimedAgentPtyOwnerRegistry
}

describe('createOrAttachClaimedAgentSession launch-token hash (Ruling 32 Addendum 7)', () => {
  it('passes the hash of options.env.ORCA_AGENT_LAUNCH_TOKEN to ensure()', async () => {
    const token = 'daemon-claim-token'
    const expectedHash = createHash('sha256').update(token).digest('hex')
    const ensure = vi.fn(async (args: { spawn: (r: { generation: string }) => unknown }) => {
      await args.spawn({ generation: 'gen-1' })
      return {
        disposition: 'created' as const,
        owner: { claim, generation: 'gen-1', phase: 'live' as const, ptyId: 'pty-1', surface }
      }
    })
    const options: CreateOrAttachOptions = {
      sessionId: 'pty-1',
      cols: 80,
      rows: 24,
      env: { ORCA_AGENT_LAUNCH_TOKEN: token },
      agentSessionEnsure: { claim, surface },
      streamClient: { onData: () => {}, onExit: () => {} }
    }

    await createOrAttachClaimedAgentSession({
      options,
      owners: fakeOwners(ensure),
      isLive: () => true,
      createOrAttach: async () => ({ id: 'pty-1' }) as unknown as CreateOrAttachResult
    })

    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({ claim, surface, launchTokenHash: expectedHash })
    )
  })

  it('omits launchTokenHash when the spawn env carries no token', async () => {
    const ensure = vi.fn(async (args: { spawn: (r: { generation: string }) => unknown }) => {
      await args.spawn({ generation: 'gen-1' })
      return {
        disposition: 'created' as const,
        owner: { claim, generation: 'gen-1', phase: 'live' as const, ptyId: 'pty-1', surface }
      }
    })
    const options: CreateOrAttachOptions = {
      sessionId: 'pty-1',
      cols: 80,
      rows: 24,
      env: { SOME_OTHER_VAR: 'x' },
      agentSessionEnsure: { claim, surface },
      streamClient: { onData: () => {}, onExit: () => {} }
    }

    await createOrAttachClaimedAgentSession({
      options,
      owners: fakeOwners(ensure),
      isLive: () => true,
      createOrAttach: async () => ({ id: 'pty-1' }) as unknown as CreateOrAttachResult
    })

    const passedArgs = ensure.mock.calls[0]?.[0] as { launchTokenHash?: string }
    expect(passedArgs.launchTokenHash).toBeUndefined()
  })
})
