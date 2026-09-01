// S10-10 review F9 (optional, out-of-scope flag): serializeStatusFile's second loop
// (server.ts's `for (const [paneKey, payload] of this.state.lastStatusByPaneKey)`) used to write
// authorityCommitments from a pane's last-status entry regardless of corroboration — so an
// uncorroborated status-only pane could still land an authorityCommitment on disk, which the NEXT
// generation hydrates into a bona-fide `hydratedAuthorityCommitment` (undermining the S10-6 gate's
// disk story). This proves the gate now applies to that loop too, without weakening it anywhere else.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const LEAF = '11111111-1111-4111-8111-111111111111'

describe('S10-10/F9: last-status entries only become authorityCommitments when corroborated', () => {
  let server: AgentHookServer | null = null
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-f9-status-corroboration-'))
  })

  afterEach(() => {
    server?.stop()
    server = null
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('an uncorroborated hook POST records status but never an authorityCommitment on disk', async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    // Deliberately no paneLaunchAuthorityVerifier wired — matches a fresh boot with no runtime
    // corroboration source, and no prior hydrated/persisted commitment exists for this pane.
    const env = server.buildPtyEnv()
    const pane = makePaneKey('tab-f9-uncorroborated', LEAF)

    const res = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN!
      },
      body: JSON.stringify({
        paneKey: pane,
        tabId: 'tab-f9-uncorroborated',
        worktreeId: 'wt-f9',
        launchToken: 'never-corroborated-token',
        env: 'production',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }
      })
    })
    expect(res.status).toBe(204)

    server.flushStatusPersistSync()
    const onDisk = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    // Status is still recorded (observation-only, fills the void) …
    expect(onDisk.entries[pane]).toBeDefined()
    // … but F9: no corroboration source exists, so no authorityCommitment may land on disk.
    expect(onDisk.authorityCommitments[pane]).toBeUndefined()
  })

  it('a corroborated hook POST (live-pty verifier says yes) still persists its authorityCommitment', async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const pane = makePaneKey('tab-f9-corroborated', LEAF)
    const launchToken = 'genuinely-corroborated-token'
    server.setPaneLaunchAuthorityVerifier((candidatePaneKey) => candidatePaneKey === pane)
    const env = server.buildPtyEnv()

    const res = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN!
      },
      body: JSON.stringify({
        paneKey: pane,
        tabId: 'tab-f9-corroborated',
        worktreeId: 'wt-f9',
        launchToken,
        env: 'production',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' }
      })
    })
    expect(res.status).toBe(204)

    server.flushStatusPersistSync()
    const onDisk = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    expect(onDisk.authorityCommitments[pane]).toBeDefined()
  })

  // S10-10 closeout (F9 second door): the ENTRY hash is authority-bearing at hydrate — an
  // uncorroborated pane's serialized entry must carry NO launchTokenHash, or one restart later
  // it is promoted into hydratedLaunchTokenHashByPaneKey + a commitment, bypassing the
  // commitments-loop gate entirely.
  it('an uncorroborated entry serializes WITHOUT its launchTokenHash, so hydrate cannot promote it', async () => {
    server = new AgentHookServer()
    // No verifier wired and no prior commitment: everything is uncorroborated.
    await server.start({ env: 'production', userDataPath })
    const env = server.buildPtyEnv()
    const pane = makePaneKey('tab-f9-entry-hash', LEAF)

    const res = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN!
      },
      body: JSON.stringify({
        paneKey: pane,
        tabId: 'tab-f9-entry-hash',
        worktreeId: 'wt-f9',
        launchToken: 'self-chosen-ghost-token',
        env: 'production',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'ghost' }
      })
    })
    expect(res.status).toBe(204)

    server.flushStatusPersistSync()
    const onDisk = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    // The status entry lands (observation-only) — but with NO authority-bearing hash, so the
    // next generation's hydrate has nothing to promote (mutation guard: dropping the
    // entryHashCorroborated gate in serializeStatusFile turns this red).
    expect(onDisk.entries[pane]).toBeDefined()
    expect(onDisk.entries[pane].launchTokenHash).toBeUndefined()
    expect(onDisk.authorityCommitments?.[pane]).toBeUndefined()
  })
})
