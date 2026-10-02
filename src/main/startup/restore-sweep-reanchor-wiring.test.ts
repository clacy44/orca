// D-30a: main's restore-sweep deps builder must wire the manifest-chair verdict and pass `internal`
// through, or no chair is ever prompted (or every relaunched pane is). Source pin, as quit-daemon-teardown.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function buildRestoreSweepDepsSource(): string {
  const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
  const start = source.indexOf('function buildRestoreSweepDeps(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n}\n', start))
}

describe('buildRestoreSweepDeps wiring (D-30a)', () => {
  it('wires isManifestChairPane to createIsManifestChairPane over the runtime orchestration db and host id', () => {
    expect(buildRestoreSweepDepsSource()).toMatch(
      /isManifestChairPane: createIsManifestChairPane\(\s*\(\) => runtimeService\.getOrchestrationDb\(\),\s*\(\) => runtimeService\.getOrchestrationCompatibilityHostId\(\)\s*\)/
    )
  })

  it('passes the in-process internal argument through to the runtime ensureAgentSession', () => {
    expect(buildRestoreSweepDepsSource()).toMatch(
      /ensureAgentSession: \(request, caller, internal\) =>\s*runtimeService\.ensureAgentSession\(request, caller, internal\)/
    )
  })
})
