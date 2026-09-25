import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError } from '../runtime/types'
import { CHAIRS_SUCCESSION_HANDLERS } from './chairs-succession'

function mockStdin(chunks: string[]): { restore: () => void } {
  const stdin = process.stdin
  const previousAsyncIterator = stdin[Symbol.asyncIterator]
  ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
    return undefined
  }
  return {
    restore: () => {
      ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = previousAsyncIterator
    }
  }
}

describe('chairs-succession handlers', () => {
  let dir: string
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-chairs-succession-'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    process.exitCode = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    logSpy.mockRestore()
    process.exitCode = 0
  })

  describe('chairs succeed', () => {
    it('hashes the checkpoint file and sends the RPC with a long client timeout', async () => {
      const checkpointPath = join(dir, 'checkpoint.md')
      writeFileSync(checkpointPath, 'schema: orca.chair-checkpoint/1\n')
      const expectedSha = createHash('sha256')
        .update(Buffer.from('schema: orca.chair-checkpoint/1\n'))
        .digest('hex')
      const call = vi.fn().mockResolvedValue({ result: { ok: true } })

      await CHAIRS_SUCCESSION_HANDLERS['chairs succeed']({
        flags: new Map<string, string | boolean>([
          ['checkpoint', checkpointPath],
          ['reason', 'batch_end']
        ]),
        client: { call },
        cwd: dir,
        json: false
      } as never)

      expect(call).toHaveBeenCalledWith(
        'orchestration.chairs.succeed',
        {
          checkpointPath,
          checkpointSha256: expectedSha,
          reason: 'batch_end',
          ack: undefined
        },
        { timeoutMs: 10 * 60 * 1000 }
      )
      expect(process.exitCode).toBe(0)
    })

    it('forwards repeated --ack ids', async () => {
      const checkpointPath = join(dir, 'checkpoint.md')
      writeFileSync(checkpointPath, 'x')
      const call = vi.fn().mockResolvedValue({ result: { ok: true } })

      await CHAIRS_SUCCESSION_HANDLERS['chairs succeed']({
        flags: new Map<string, string | boolean>([
          ['checkpoint', checkpointPath],
          ['reason', 'context'],
          ['ack', `msg_aaa${'\u0000'}msg_bbb`]
        ]),
        client: { call },
        cwd: dir,
        json: false
      } as never)

      expect(call).toHaveBeenCalledWith(
        'orchestration.chairs.succeed',
        expect.objectContaining({ ack: ['msg_aaa', 'msg_bbb'] }),
        expect.anything()
      )
    })

    it('rejects an invalid --reason before calling the runtime', async () => {
      const checkpointPath = join(dir, 'checkpoint.md')
      writeFileSync(checkpointPath, 'x')
      const call = vi.fn()

      await expect(
        CHAIRS_SUCCESSION_HANDLERS['chairs succeed']({
          flags: new Map<string, string | boolean>([
            ['checkpoint', checkpointPath],
            ['reason', 'bogus']
          ]),
          client: { call },
          cwd: dir,
          json: false
        } as never)
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    })

    it('rejects a missing checkpoint file before calling the runtime', async () => {
      const call = vi.fn()

      await expect(
        CHAIRS_SUCCESSION_HANDLERS['chairs succeed']({
          flags: new Map<string, string | boolean>([
            ['checkpoint', join(dir, 'missing.md')],
            ['reason', 'batch_end']
          ]),
          client: { call },
          cwd: dir,
          json: false
        } as never)
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    })

    it('prints the RESULT line and exits 1 on succession_aborted', async () => {
      const checkpointPath = join(dir, 'checkpoint.md')
      writeFileSync(checkpointPath, 'x')
      const call = vi.fn().mockResolvedValue({
        result: {
          ok: false,
          code: 'succession_aborted',
          successionId: 'succ_abc123',
          reason: 'model_pin'
        }
      })

      await CHAIRS_SUCCESSION_HANDLERS['chairs succeed']({
        flags: new Map<string, string | boolean>([
          ['checkpoint', checkpointPath],
          ['reason', 'batch_end']
        ]),
        client: { call },
        cwd: dir,
        json: false
      } as never)

      expect(logSpy).toHaveBeenCalledWith(
        'RESULT=succession_aborted id=succ_abc123 reason=model_pin'
      )
      expect(process.exitCode).toBe(1)
    })

    it('adds a next step for a refusal code the runtime sent none for', async () => {
      const checkpointPath = join(dir, 'checkpoint.md')
      writeFileSync(checkpointPath, 'x')
      const call = vi
        .fn()
        .mockRejectedValue(new RuntimeClientError('succession_charter_missing', 'no charter'))

      await expect(
        CHAIRS_SUCCESSION_HANDLERS['chairs succeed']({
          flags: new Map<string, string | boolean>([
            ['checkpoint', checkpointPath],
            ['reason', 'batch_end']
          ]),
          client: { call },
          cwd: dir,
          json: false
        } as never)
      ).rejects.toMatchObject({
        code: 'succession_charter_missing',
        data: {
          nextSteps: [
            "Set the chair's manifest `succession.charterPath` to an existing charter file, then retry."
          ]
        }
      })
    })

    it('does not overwrite next steps the runtime already sent', async () => {
      const checkpointPath = join(dir, 'checkpoint.md')
      writeFileSync(checkpointPath, 'x')
      const call = vi.fn().mockRejectedValue(
        new RuntimeClientError('checkpoint_schema', 'bad schema line', {
          line: 1,
          nextSteps: ['runtime-provided step']
        })
      )

      await expect(
        CHAIRS_SUCCESSION_HANDLERS['chairs succeed']({
          flags: new Map<string, string | boolean>([
            ['checkpoint', checkpointPath],
            ['reason', 'batch_end']
          ]),
          client: { call },
          cwd: dir,
          json: false
        } as never)
      ).rejects.toMatchObject({
        code: 'checkpoint_schema',
        data: { line: 1, nextSteps: ['runtime-provided step'] }
      })
    })
  })

  describe('chairs succession-accept', () => {
    it('sends the RPC by id and prints the ACCEPTED line', async () => {
      const call = vi.fn().mockResolvedValue({
        result: {
          successionId: 'succ_xyz',
          chair: 'chair-a',
          agentId: 'agent_1',
          runId: 'run_1',
          generation: 3,
          obligations: {
            ackedDeliveryIds: [],
            outstandingDeliveryIds: [],
            retiredHandle: null,
            pendingPeerQuestionThreadIds: [],
            pactTurnsHeld: 0
          }
        }
      })

      await CHAIRS_SUCCESSION_HANDLERS['chairs succession-accept']({
        flags: new Map<string, string | boolean>([['id', 'succ_xyz']]),
        client: { call },
        cwd: '/tmp',
        json: false
      } as never)

      expect(call).toHaveBeenCalledWith('orchestration.chairs.successionAccept', {
        successionId: 'succ_xyz'
      })
      expect(logSpy).toHaveBeenCalledWith(
        'ACCEPTED succ_xyz chair=chair-a agent=agent_1 run=run_1 generation=3'
      )
    })

    it('prints the resume context verbatim after a blank line when returned', async () => {
      const call = vi.fn().mockResolvedValue({
        result: {
          successionId: 'succ_xyz',
          chair: 'chair-a',
          agentId: 'agent_1',
          runId: 'run_1',
          generation: 1,
          resumeContext: '# SUCCESSION CONTEXT succ_xyz\nbody',
          obligations: {
            ackedDeliveryIds: [],
            outstandingDeliveryIds: [],
            retiredHandle: null,
            pendingPeerQuestionThreadIds: [],
            pactTurnsHeld: 0
          }
        }
      })

      await CHAIRS_SUCCESSION_HANDLERS['chairs succession-accept']({
        flags: new Map<string, string | boolean>([['id', 'succ_xyz']]),
        client: { call },
        cwd: '/tmp',
        json: false
      } as never)

      expect(logSpy).toHaveBeenCalledWith(
        'ACCEPTED succ_xyz chair=chair-a agent=agent_1 run=run_1 generation=1\n\n' +
          '# SUCCESSION CONTEXT succ_xyz\nbody'
      )
    })

    it('adds a next step for succession_expired when the runtime sent none', async () => {
      const call = vi
        .fn()
        .mockRejectedValue(new RuntimeClientError('succession_expired', 'expired'))

      await expect(
        CHAIRS_SUCCESSION_HANDLERS['chairs succession-accept']({
          flags: new Map<string, string | boolean>([['id', 'succ_xyz']]),
          client: { call },
          cwd: '/tmp',
          json: false
        } as never)
      ).rejects.toMatchObject({
        code: 'succession_expired',
        data: { nextSteps: [expect.stringContaining('acceptance window passed')] }
      })
    })

    // G1 repair N8: five refusals reachable after the wave-2 pass had no next-steps map entry —
    // the runtime sends none for any of them, so a caller previously saw a bare error code.
    // G1 attempt-3 repair F10: charter_invalid and runtime_busy had no map entry either.
    it.each([
      'succession_incumbent_exit_timeout',
      'succession_run_moved',
      'succession_unknown_ack',
      'succession_lane_unsupported',
      'resume_context_too_large',
      'charter_invalid',
      'runtime_busy'
    ])('adds a next step for %s when the runtime sent none', async (code) => {
      const call = vi.fn().mockRejectedValue(new RuntimeClientError(code, 'refused'))

      await expect(
        CHAIRS_SUCCESSION_HANDLERS['chairs succession-accept']({
          flags: new Map<string, string | boolean>([['id', 'succ_xyz']]),
          client: { call },
          cwd: '/tmp',
          json: false
        } as never)
      ).rejects.toMatchObject({
        code,
        data: { nextSteps: expect.arrayContaining([expect.any(String)]) }
      })
    })

    // G1 repair N7/N16: a post-takeover step can fail without failing the whole accept — the CLI
    // must still surface it, not stay silent about a chair that may need manual attention.
    it('prints a WARNINGS line when the runtime result carries warnings', async () => {
      const call = vi.fn().mockResolvedValue({
        result: {
          successionId: 'succ_xyz',
          chair: 'chair-a',
          agentId: 'agent_1',
          runId: 'run_1',
          generation: 3,
          warnings: ['manifestWriteFailed'],
          manifestWriteFailed: true,
          obligations: {
            ackedDeliveryIds: [],
            outstandingDeliveryIds: [],
            retiredHandle: null,
            pendingPeerQuestionThreadIds: [],
            pactTurnsHeld: 0
          }
        }
      })

      await CHAIRS_SUCCESSION_HANDLERS['chairs succession-accept']({
        flags: new Map<string, string | boolean>([['id', 'succ_xyz']]),
        client: { call },
        cwd: '/tmp',
        json: false
      } as never)

      expect(logSpy).toHaveBeenCalledWith(
        'ACCEPTED succ_xyz chair=chair-a agent=agent_1 run=run_1 generation=3\n' +
          'WARNINGS manifestWriteFailed\n' +
          // G1 attempt-3 repair F10: the WARNINGS line now names the next step for a recognised
          // warning, not just the bare identifier.
          "  - manifestWriteFailed: chairs.json's lastSessionId was not updated; a reboot's " +
          '`chairs restore` may resume the pre-succession session'
      )
    })
  })

  describe('chairs resume-context', () => {
    it('--json prints the raw result', async () => {
      const call = vi.fn().mockResolvedValue({ result: { ok: true, text: 'hi', served: false } })

      await CHAIRS_SUCCESSION_HANDLERS['chairs resume-context']({
        flags: new Map<string, string | boolean>(),
        client: { call },
        cwd: '/tmp',
        json: true
      } as never)

      expect(call).toHaveBeenCalledWith('orchestration.chairs.resumeContext', { hook: undefined })
      expect(logSpy).toHaveBeenCalledWith(
        JSON.stringify({ ok: true, text: 'hi', served: false }, null, 2)
      )
    })

    it('default/--markdown prints the text', async () => {
      const call = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, text: 'hello context', served: true } })

      await CHAIRS_SUCCESSION_HANDLERS['chairs resume-context']({
        flags: new Map<string, string | boolean>([['markdown', true]]),
        client: { call },
        cwd: '/tmp',
        json: false
      } as never)

      expect(logSpy).toHaveBeenCalledWith('hello context')
    })

    it('--hook with empty stdin passes hook:true, prints the text, and exits 0', async () => {
      const stdin = mockStdin([])
      const call = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, text: 'hook context', served: true } })

      try {
        await CHAIRS_SUCCESSION_HANDLERS['chairs resume-context']({
          flags: new Map<string, string | boolean>([['hook', true]]),
          client: { call },
          cwd: '/tmp',
          json: false
        } as never)
      } finally {
        stdin.restore()
      }

      expect(call).toHaveBeenCalledWith('orchestration.chairs.resumeContext', { hook: true })
      expect(logSpy).toHaveBeenCalledWith('hook context')
      expect(process.exitCode).toBe(0)
    })

    it('--hook with invalid stdin JSON does not throw', async () => {
      const stdin = mockStdin(['not json{'])
      const call = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, text: 'hook context', served: true } })

      try {
        await expect(
          CHAIRS_SUCCESSION_HANDLERS['chairs resume-context']({
            flags: new Map<string, string | boolean>([['hook', true]]),
            client: { call },
            cwd: '/tmp',
            json: false
          } as never)
        ).resolves.toBeUndefined()
      } finally {
        stdin.restore()
      }
      expect(process.exitCode).toBe(0)
    })

    it('--hook prints nothing and exits 0 on succession_none', async () => {
      const stdin = mockStdin([])
      const call = vi.fn().mockResolvedValue({ result: { ok: false, code: 'succession_none' } })

      try {
        await CHAIRS_SUCCESSION_HANDLERS['chairs resume-context']({
          flags: new Map<string, string | boolean>([['hook', true]]),
          client: { call },
          cwd: '/tmp',
          json: false
        } as never)
      } finally {
        stdin.restore()
      }

      expect(logSpy).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(0)
    })

    // [G1-10z B1 repair] Before this fix, an RPC refusal (no_pane_identity,
    // no_registered_identity, a transport error, etc.) inside the `--hook` branch was never
    // caught — the handler rejected, which a SessionStart hook must never do (a non-zero hook
    // can block/annotate Claude Code's whole session boot).
    it('--hook swallows an RPC refusal (e.g. no_registered_identity), prints nothing, resolves, and exits 0', async () => {
      const stdin = mockStdin([])
      const call = vi
        .fn()
        .mockRejectedValue(new RuntimeClientError('no_registered_identity', 'nope'))

      try {
        await expect(
          CHAIRS_SUCCESSION_HANDLERS['chairs resume-context']({
            flags: new Map<string, string | boolean>([['hook', true]]),
            client: { call },
            cwd: '/tmp',
            json: false
          } as never)
        ).resolves.toBeUndefined()
      } finally {
        stdin.restore()
      }

      expect(logSpy).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(0)
    })

    it('rejects passing more than one of --json/--markdown/--hook', async () => {
      const call = vi.fn()

      await expect(
        CHAIRS_SUCCESSION_HANDLERS['chairs resume-context']({
          flags: new Map<string, string | boolean>([['markdown', true]]),
          client: { call },
          cwd: '/tmp',
          json: true
        } as never)
      ).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    })
  })
})
