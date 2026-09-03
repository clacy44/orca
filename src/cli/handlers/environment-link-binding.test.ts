// S10-16 C7, test 61 + the spec-completeness test PART 7 requires: link-bind returns without
// waiting on the server round; link-status --wait/--timeout-ms thread through as a call option;
// --drain is in the grammar (L11.1); every flag PART 7's runbook quotes is in `allowedFlags`.
import { describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_LINK_BINDING_HANDLERS } from './environment-link-binding'
import { ENVIRONMENT_COMMAND_SPECS } from '../specs/environment'
import { BOOLEAN_FLAGS } from '../args'
import type { HandlerContext } from '../dispatch'

function specFor(name: string) {
  const spec = ENVIRONMENT_COMMAND_SPECS.find((s) => s.path.join(' ') === name)
  if (!spec) {
    throw new Error(`No spec for ${name}`)
  }
  return spec
}

function ctxWith(
  flags: Record<string, string | boolean>,
  call: ReturnType<typeof vi.fn>
): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    client: { call } as unknown as HandlerContext['client'],
    cwd: '/tmp',
    json: true
  }
}

describe('environment link-binding CLI handlers', () => {
  it('link-bind returns immediately (no local wait loop) for --link', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'local',
      ok: true,
      result: { state: 'running', link: 'lnk_1', attemptId: 'lnk_1:1' },
      _meta: { runtimeId: 'local' }
    })
    const start = Date.now()
    await ENVIRONMENT_LINK_BINDING_HANDLERS['environment link-bind'](
      ctxWith({ link: 'lnk_1' }, call)
    )
    expect(Date.now() - start).toBeLessThan(1000)
    expect(call).toHaveBeenCalledWith(
      'orchestration.linkBind',
      expect.objectContaining({ link: 'lnk_1', all: false })
    )
  })

  it('link-bind refuses --accept-legacy without --yes', async () => {
    const call = vi.fn()
    await expect(
      ENVIRONMENT_LINK_BINDING_HANDLERS['environment link-bind'](
        ctxWith({ link: 'lnk_1', 'accept-legacy': true, reason: 'r' }, call)
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('link-status --wait raises the client call timeout rather than clamping locally', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'local',
      ok: true,
      result: { links: [] },
      _meta: { runtimeId: 'local' }
    })
    await ENVIRONMENT_LINK_BINDING_HANDLERS['environment link-status'](
      ctxWith({ wait: true, 'timeout-ms': '200000' }, call)
    )
    // R22.1: the server holds the ONE cap (LINK_BINDING_STATUS_WAIT_CAP_MS); the CLI raises its
    // own socket timeout to give that wait room rather than imposing a second, contradictory cap.
    expect(call).toHaveBeenCalledWith(
      'orchestration.linkBindings',
      expect.objectContaining({ link: undefined }),
      { timeoutMs: 200000 }
    )
  })

  // Ruling 28(g): --drain wakes the pump (runtime.replyOutbox.kick) and reports the PRE-drain
  // queued count labelled `kicked` — never a number implying the drain already completed. The
  // C7 shape (`{drained: {...}}`, printed as "pending") is replaced.
  it('link-status --drain kicks every route with pending work and reports it honestly as "kicked"', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'local',
      ok: true,
      result: { kicked: { lnk_1: 0 } },
      _meta: { runtimeId: 'local' }
    })
    await ENVIRONMENT_LINK_BINDING_HANDLERS['environment link-status'](
      ctxWith({ drain: true }, call)
    )
    expect(call).toHaveBeenCalledWith('orchestration.replyOutbox', { link: undefined, drain: true })
  })

  it('--drain is in the BOOLEAN_FLAGS grammar (L11.1)', () => {
    expect(BOOLEAN_FLAGS.has('drain')).toBe(true)
  })

  // PART 7's runbook quotes these exact flags; a flag absent from `allowedFlags` is a hard
  // refusal at `cli/args.ts:319-325` before any handler runs.
  it.each([
    [
      'environment link-status',
      ['link', 'environment', 'outbox', 'drain', 'wait', 'timeout-ms', 'json']
    ],
    [
      'environment link-bind',
      ['link', 'all', 'deep', 'accept-legacy', 'reason', 'lift', 'yes', 'timeout-ms', 'json']
    ],
    ['environment link-revoke', ['link', 'json']],
    ['environment link-forget', ['link', 'all', 'yes', 'json']],
    ['environment link-quarantine', ['link', 'lift', 'reason', 'json']],
    ['environment link-exclude', ['environment', 'clear', 'reason', 'json']],
    ['environment update', ['environment', 'pairing-code', 'json']]
  ])('%s allows every flag PART 7 quotes', (name, flags) => {
    const spec = specFor(name)
    for (const flag of flags) {
      expect(spec.allowedFlags).toContain(flag)
    }
  })
})
