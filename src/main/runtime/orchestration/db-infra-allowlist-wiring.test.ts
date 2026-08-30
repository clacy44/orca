// S10-2 GATE §, h3 (s10-2-spec.md:150): proves OrchestrationDb actually wires the on-disk
// allowlist into insertGatedMessage/purgeMessage/purgeThread — matchInfraLiterals
// (message-body-gate.ts) always receives [] unless something produces a value, and until this
// series nothing did.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { infraAllowlistPath, resetInfraAllowlistCacheForTests } from './infra-allowlist'
import { OrchestrationDb } from './db'

describe('OrchestrationDb wires the on-disk infra allowlist into the gate by default', () => {
  let tempDir: string | undefined
  let dbPath: string | undefined

  afterEach(() => {
    if (dbPath) {
      resetInfraAllowlistCacheForTests(dbPath)
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('h3 fires on insertGatedMessage without the caller passing infraAllowlist', () => {
    // Mutation this kills: OrchestrationDb never calling loadInfraAllowlist (or never passing it
    // through) — matchInfraLiterals then always receives [], h3 stays permanently inert, and
    // this HARD-blocks nothing.
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-infra-allowlist-'))
    dbPath = join(tempDir, 'orchestration.db')
    writeFileSync(infraAllowlistPath(dbPath), 'prod-db-07.internal\n')

    const db = new OrchestrationDb(dbPath)
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'ops',
      body: 'ssh into prod-db-07.internal now',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') {
      throw new Error('expected refused')
    }
    expect(result.verdict.ruleIds).toContain('infra-literal')
    db.close()
  })

  it('an explicit infraAllowlist param still overrides the loaded default', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-infra-allowlist-'))
    dbPath = join(tempDir, 'orchestration.db')
    writeFileSync(infraAllowlistPath(dbPath), 'prod-db-07.internal\n')

    const db = new OrchestrationDb(dbPath)
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'ops',
      body: 'ssh into prod-db-07.internal now',
      runId: 'run_peer_local',
      verb: 'send',
      infraAllowlist: []
    })
    expect(result.outcome).toBe('stored')
    db.close()
  })

  it('absent allowlist file leaves h3 inert, same as before this series', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-db-infra-allowlist-'))
    dbPath = join(tempDir, 'orchestration.db')

    const db = new OrchestrationDb(dbPath)
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'ops',
      body: 'ssh into prod-db-07.internal now',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('stored')
    db.close()
  })
})
