// S10-21a C12 (design v3.2 §6.1 T3/T3b, T20). T3's own reasoning for "no lineage recorded, no
// rebind" from a forged hook row is structural, not behavioral: "the hook row never reaches
// `agent_launch_sessions` at all" (T20 restates the same fact — the hook channel still writes
// into `sleepingAgentSessionsByPaneKey` exactly as today, but that write is a DIFFERENT table
// from the one the restore sweep and the rebind actually read). This fence proves the structural
// half of that claim directly: `OrchestrationDb#recordLaunch` (db.ts:4873, delegating to
// `recordLaunch` in agent-launch-sessions.ts) — the ONLY function that inserts into
// `agent_launch_sessions` outside of the rebind's own `recordLaunchInTransaction` — is called
// from exactly one production module, `agent-launch-admission.ts`, and from nowhere reachable by
// hook ingestion (`src/main/agent-hooks/**`), the wire (`rpc/**`, `ipc/**` other than the
// admission module itself), `src/relay/**`, or `src/renderer/**`.
//
// This is a scoped structural fence, not a full simulation of server.ts's hook-authority
// corroboration machinery (`isCorroboratedAuthority`/`hydratedLaunchTokenHashByPaneKey`) driving
// a forged POST end to end — that machinery is ~3000 lines deep in agent-hooks/server.ts and a
// full behavioral T3/T3b (constructing a real forged hook payload, POSTing it through the real
// endpoint handler, and asserting BOTH that `sleepingAgentSessionsByPaneKey` still gets an entry
// AND that no launch row appears) needs a design-level read of that corroboration path this
// commit does not carry out (see the C12 RETURN for the escalation this file's own docblock
// stands in for). This fence proves the one fact T3/T20's own reasoning depends on: there is
// structurally no call from anywhere in the hook-ingestion/wire/relay/renderer surface into the
// one function that could write a forged hook's identity into the launch table.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const FORBIDDEN_ROOTS = [
  resolve(REPO_ROOT, 'src', 'main', 'agent-hooks'),
  resolve(REPO_ROOT, 'src', 'main', 'runtime', 'rpc'),
  resolve(REPO_ROOT, 'src', 'main', 'ipc'),
  resolve(REPO_ROOT, 'src', 'relay'),
  resolve(REPO_ROOT, 'src', 'renderer')
]
// `agent-launch-admission.ts` is the one production caller (errata/design §C); its own test files
// and this fence's own source necessarily name the call pattern they scan for.
const IPC_ROOT = resolve(REPO_ROOT, 'src', 'main', 'ipc')
const ALLOWED_FILES = new Set([join(IPC_ROOT, 'agent-launch-admission.ts')])

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(path)
    }
    if (!entry.isFile() || !(path.endsWith('.ts') || path.endsWith('.tsx'))) {
      return []
    }
    if (entry.name.includes('.test.')) {
      // Test fixtures legitimately seed launch rows directly against a real in-memory DB
      // (restore-sweep-test-fixtures.ts, server.test.ts) — not a production call path.
      return []
    }
    return [path]
  })
}

// Matches both the DB-wrapper call (`db.recordLaunch(` / `orchestrationDb.recordLaunch(`) and a
// direct call to the raw exported function (`recordLaunch(`), so a future refactor that imports
// the raw function instead of going through the OrchestrationDb wrapper is caught too.
const RECORD_LAUNCH_CALL_RE = /\brecordLaunch\s*\(/

type Offense = { file: string }

function findOffenses(): Offense[] {
  const offenses: Offense[] = []
  for (const root of FORBIDDEN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      if (ALLOWED_FILES.has(file)) {
        continue
      }
      const source = readFileSync(file, 'utf-8')
      if (RECORD_LAUNCH_CALL_RE.test(source)) {
        offenses.push({ file: file.slice(REPO_ROOT.length + 1) })
      }
    }
  }
  return offenses
}

describe('S10-21a C12, T3/T20 structural half: recordLaunch is unreachable from hook ingestion / wire / relay / renderer', () => {
  it('the guard scans a non-empty set of files (matcher sanity)', () => {
    const total = FORBIDDEN_ROOTS.reduce((n, root) => n + listSourceFiles(root).length, 0)
    expect(total).toBeGreaterThan(0)
  })

  it('agent-launch-admission.ts is the only production caller of recordLaunch under the scanned roots (matcher sanity — proves the pattern actually fires)', () => {
    const source = readFileSync(join(IPC_ROOT, 'agent-launch-admission.ts'), 'utf-8')
    expect(RECORD_LAUNCH_CALL_RE.test(source)).toBe(true)
  })

  it('no module under agent-hooks/**, rpc/**, ipc/** (other than agent-launch-admission.ts), relay/**, or renderer/** calls recordLaunch', () => {
    expect(findOffenses()).toEqual([])
  })
})
