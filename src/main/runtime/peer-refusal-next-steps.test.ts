// Review Q4 (2026-09-02): nextStepsForRefusedMethod must never echo the raw, peer-supplied
// method string — the ingress bounds it only as a non-empty string (no length cap, no
// charset), and this text is rendered back to the peer's own CLI.
import { describe, expect, it } from 'vitest'
import { nextStepsForRefusedMethod } from './peer-refusal-next-steps'

// Built from a code-point range rather than a literal escape, so the source file carries no
// raw control bytes of its own.
// eslint-disable-next-line no-control-regex
const CONTROL_BYTE_RE = new RegExp('[\\x00-\\x1f\\x7f]')

describe('Review Q4: nextStepsForRefusedMethod never echoes the raw method string', () => {
  it('a 10 KB method name containing control bytes is never echoed anywhere in nextSteps', () => {
    const hostile = `files.${'x'.repeat(10_000)}${String.fromCharCode(0x1b, 0x00, 0x07)}`
    const steps = nextStepsForRefusedMethod(hostile)
    for (const step of steps) {
      expect(step).not.toContain(hostile)
      expect(step).not.toContain('x'.repeat(100))
      expect(step.length).toBeLessThan(500)
      expect(CONTROL_BYTE_RE.test(step)).toBe(false)
    }
  })

  it('the host-mutating-prefix arm names the class of alternative without echoing the method', () => {
    const steps = nextStepsForRefusedMethod('files.write')
    expect(steps.join(' ')).not.toContain('files.write')
  })

  it('the default arm and the other closed-vocabulary arms carry no method interpolation at all', () => {
    for (const method of ['orchestration.workerStart', 'terminal.send', 'some.unknown.method']) {
      const steps = nextStepsForRefusedMethod(method)
      expect(steps.join(' ')).not.toContain(method)
    }
  })
})
