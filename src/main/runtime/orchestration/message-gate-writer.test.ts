// S10-2a insertGatedMessage — the single write choke (ruling 2). DB-level tests through the
// public OrchestrationDb API. Mutation-guard comments match the s10-2-spec.md TESTS table.
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

function freshDb(): OrchestrationDb {
  return new OrchestrationDb(':memory:')
}

describe('insertGatedMessage', () => {
  it('a clean message is stored with gate_flags NULL', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'status',
      body: 'rebase onto main and re-run the suite',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    expect(result.verdict.tier).toBe('clean')
    expect(result.message.gate_flags).toBeNull()
    db.close()
  })

  it('T2: a HARD-gated body is refused — nothing is stored, an audit row is written', () => {
    const db = freshDb()
    const before = countMessages(db)
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'audit',
      body: 'MERGE-GATE AUDIT: CVE-2025-1234 unresolved',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') {
      throw new Error('expected refused')
    }
    expect(result.verdict.tier).toBe('hard')
    expect(countMessages(db)).toBe(before)
    const refusal = rawGet(db, 'SELECT * FROM gate_refusals WHERE seq = ?', [result.refusalId]) as {
      acknowledged: number
      verb: string
      rule_ids: string
    }
    expect(refusal.acknowledged).toBe(0)
    expect(refusal.verb).toBe('send')
    expect(JSON.parse(refusal.rule_ids)).toContain('merge-gate-audit-heading')
    db.close()
  })

  it('T2 mutation guard: the gate must run before any INSERT — no message row exists after a HARD refusal even under a race', () => {
    // Documents the mutation this test kills: moving the gate to run AFTER the insert (matching
    // the historical bug at orchestration.ts:672, s10-2-spec.md ruling 2) would leave the row
    // in `messages` even though the caller sees `refused`.
    const db = freshDb()
    db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'audit',
      body: 'VULNERABILITY: unpatched',
      runId: 'run_peer_local',
      verb: 'send'
    })
    const rows = rawAll(db, "SELECT * FROM messages WHERE body LIKE '%unpatched%'")
    expect(rows).toHaveLength(0)
    db.close()
  })

  it('--acknowledge-gate converts a HARD verdict into a stored, flagged send (never closes the channel)', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'audit',
      body: 'MERGE-GATE AUDIT: CVE-2025-1234 unresolved',
      runId: 'run_peer_local',
      verb: 'send',
      acknowledgeGate: true
    })
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    expect(result.message.gate_flags).not.toBeNull()
    expect(JSON.parse(result.message.gate_flags as string)).toContain('merge-gate-audit-heading')
    const refusal = rawGet(
      db,
      'SELECT acknowledged FROM gate_refusals ORDER BY seq DESC LIMIT 1',
      []
    ) as {
      acknowledged: number
    }
    expect(refusal.acknowledged).toBe(1)
    db.close()
  })

  it('a SOFT-tier body is delivered, flagged, never blocked', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'note',
      body: 'the attacker-controlled input reaches the parser',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    expect(result.verdict.tier).toBe('soft')
    expect(JSON.parse(result.message.gate_flags as string)).toContain('attacker-vocabulary')
    db.close()
  })

  it('ruling 7: sender_agent_id is resolved from the attested pane, never left NULL for a registered agent', () => {
    const db = freshDb()
    db.upsertAgentByPaneSuffix({
      displayName: 'backend-merge',
      role: null,
      hostId: 'local',
      paneKey: 'tab1:leaf1',
      terminalHandle: 'backend-merge',
      processIncarnation: null,
      worktreeId: null,
      worktreePath: null,
      branch: null,
      title: null,
      agentLabel: null,
      originHandle: 'backend-merge',
      originHostId: 'local'
    })
    const result = db.insertGatedMessage({
      from: 'backend-merge',
      to: 'agent:a',
      subject: 'hi',
      body: 'hi',
      runId: 'run_peer_local',
      verb: 'send',
      senderPaneKey: 'tab1:leaf1',
      senderHostId: 'local'
    })
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    const agentId = db.getAgentByPaneKey('local', 'tab1:leaf1')?.id
    expect(result.message.sender_agent_id).toBe(agentId)
    db.close()
  })

  it('ruling 7 mutation guard: no senderPaneKey leaves sender_agent_id NULL rather than guessing', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'unregistered-handle',
      to: 'agent:a',
      subject: 'hi',
      body: 'hi',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    expect(result.message.sender_agent_id).toBeNull()
    db.close()
  })

  it('scope: subject and payload are gated the same as body', () => {
    const db = freshDb()
    const bySubject = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'VULNERABILITY: rce',
      body: 'clean text',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(bySubject.outcome).toBe('refused')

    const byPayload = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'clean',
      body: 'clean text',
      payload: { note: 'VULNERABILITY: rce' },
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(byPayload.outcome).toBe('refused')
    db.close()
  })

  it('payload is sanitized field-wise, not corrupted by a whole-blob sanitizer', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'note',
      body: 'ok',
      payload: { summary: 'line one\nline two', count: 3 },
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    const parsed = JSON.parse(result.message.payload as string) as {
      summary: string
      count: number
    }
    expect(parsed.summary).toBe('line one line two')
    expect(parsed.count).toBe(3)
    db.close()
  })
})

describe('gate runs on raw text, before sanitize collapses newlines', () => {
  it('a HARD heading that is not the first line of the body is still refused', () => {
    // Guard: insertGatedMessage must gate BEFORE sanitizeMessageText collapses newlines to
    // spaces. Mutation that turns this red: gate the sanitized text instead of the raw text
    // (i.e. move the sanitize calls above the evaluateMessageBodyGate call) — the heading no
    // longer starts a line once newlines are gone, h1's anchor stops matching, and this
    // multi-paragraph audit report is stored as an ordinary message.
    const db = freshDb()
    const before = countMessages(db)
    const body =
      'Here is what I found while reviewing the importer.\n\nMERGE-GATE AUDIT\nfinding 1: the fence is bypassable via a crafted subject.'
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'review notes',
      body,
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    expect(countMessages(db)).toBe(before)
    db.close()
  })

  it('control: the same heading as the literal first line is refused too', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 's',
      body: 'MERGE-GATE AUDIT\nfinding 1: the fence is bypassable.',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    db.close()
  })
})

describe('gate normalizes before matching, so a manufactured heading cannot slip past raw-text matching', () => {
  // Mutation this kills: gating the RAW body/subject/payload instead of
  // sanitizeMessageTextForGate's output. A zero-width codepoint, a fullwidth-Unicode variant, or
  // an ESC-split token defeats a raw-text match, and sanitizeMessageText (applied unconditionally
  // before the row is stored) then normalizes the same input right back into the real heading —
  // so the stored/rendered row carries the exact heading the gate was supposed to catch.
  it('a zero-width codepoint inside "MERGE-GATE AUDIT" is refused, not stored with the heading intact', () => {
    const db = freshDb()
    const before = countMessages(db)
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 's',
      body: 'M​ERGE-GATE AUDIT\nfinding 1: the fence is bypassable.',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    expect(countMessages(db)).toBe(before)
    db.close()
  })

  it('a fullwidth-Unicode "MERGE-GATE AUDIT" heading is refused', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 's',
      body: 'ＭＥＲＧＥ-ＧＡＴＥ ＡＵＤＩＴ\nfinding 1',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    db.close()
  })

  it('an ESC/CSI sequence splitting "VULNERABILITY" is refused', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 's',
      body: 'VULNER\x1B[0mABILITY\nstep 1',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    db.close()
  })

  it('a fullwidth-Unicode "SECURITY:" heading is refused', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 's',
      body: 'ＳＥＣＵＲＩＴＹ:\nthe token check is skipped',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    db.close()
  })

  it('A5: hostPayloadKind lands in the payload_kind column, not in the stored payload JSON', () => {
    const db = freshDb()
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'pact step',
      body: 'engaging',
      payload: { note: 'no kind field here' },
      hostPayloadKind: 'pact_engage',
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    expect(result.message.payload_kind).toBe('pact_engage')
    expect(result.message.payload).not.toBeNull()
    expect(JSON.parse(result.message.payload as string)).not.toHaveProperty('kind')
    db.close()
  })

  it('A5: caller-supplied payload.kind is refused (payload_kind_reserved) — nothing is stored', () => {
    const db = freshDb()
    const before = countMessages(db)
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'spoof attempt',
      body: 'trying to set kind myself',
      payload: { kind: 'liveness_breach' },
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    if (result.outcome !== 'refused') {
      throw new Error('expected refused')
    }
    expect(result.verdict.ruleIds).toContain('payload_kind_reserved')
    expect(countMessages(db)).toBe(before)
    const refusal = rawGet(db, 'SELECT * FROM gate_refusals WHERE seq = ?', [result.refusalId]) as {
      rule_ids: string
      acknowledged: number
    }
    expect(JSON.parse(refusal.rule_ids)).toContain('payload_kind_reserved')
    expect(refusal.acknowledged).toBe(0)
    db.close()
  })

  it('A5: caller-supplied payload.kind is refused even with acknowledgeGate — the reserved namespace is not an escape-hatch content gate', () => {
    const db = freshDb()
    const before = countMessages(db)
    const result = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'spoof attempt',
      body: 'trying to set kind myself, acknowledged',
      payload: { kind: 'input_not_consumed' },
      acknowledgeGate: true,
      runId: 'run_peer_local',
      verb: 'send'
    })
    expect(result.outcome).toBe('refused')
    expect(countMessages(db)).toBe(before)
    db.close()
  })

  it('A5 mutation guard: insertGatedMessage is the only writer shape for payload_kind — no other path copies payload.kind into the column', () => {
    // Documents the mutation this test kills: a future writer (e.g. a raw db.insertMessage call,
    // or a helper that reads payload.kind off an already-sanitized payload) copying the JSON
    // payload.kind straight into the payload_kind column, bypassing the reserved-field refusal.
    const db = freshDb()
    const stored = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'pact step',
      body: 'engaging',
      payload: { note: 'unrelated', extra: { nested: true } },
      hostPayloadKind: 'pact_engage',
      runId: 'run_peer_local',
      verb: 'send'
    })
    if (stored.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    // The choke's INSERT param count is fixed to the hostPayloadKind field — the only way a
    // caller can influence payload_kind is through that named option, never through `payload`.
    expect(stored.message.payload_kind).toBe('pact_engage')
    const noHostKind = db.insertGatedMessage({
      from: 'agent:a',
      to: 'agent:b',
      subject: 'pact step 2',
      body: 'no host kind supplied',
      payload: { note: 'unrelated' },
      runId: 'run_peer_local',
      verb: 'send'
    })
    if (noHostKind.outcome !== 'stored') {
      throw new Error('expected stored')
    }
    expect(noHostKind.message.payload_kind).toBeNull()
    db.close()
  })
})

function countMessages(db: OrchestrationDb): number {
  return (rawGet(db, 'SELECT COUNT(*) AS n FROM messages', []) as { n: number }).n
}

function rawDb(db: OrchestrationDb): {
  prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }
} {
  return (db as unknown as { db: ReturnType<typeof rawDb> }).db
}

function rawGet(db: OrchestrationDb, sql: string, args: unknown[]): unknown {
  return rawDb(db)
    .prepare(sql)
    .get(...args)
}

function rawAll(db: OrchestrationDb, sql: string): unknown[] {
  return rawDb(db).prepare(sql).all()
}
