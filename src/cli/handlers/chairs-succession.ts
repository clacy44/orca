import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { SUCCESSION_NEXT_STEPS, WARNING_GUIDANCE } from './chairs-succession-next-steps'

// Why this budget, not the `orchestration check --wait` mechanism itself: that mechanism
// (src/cli/runtime/client.ts:26-33 LONG_POLL_CLIENT_GRACE_MS, :193-204
// resolveMethodTimeoutMs) only extends the client-side socket timeout for
// `orchestration.check`/`terminal.wait` by name, and only from an inner `params.timeoutMs` the
// caller supplied — `orchestration.chairs.succeed` has neither: it is method-name-gated out and
// its RPC contract carries no timeout param (the hold is open-ended, minutes-scale, the
// incumbent's own pace). We instead follow `terminal wait`'s own explicit-options fallback for
// exactly this situation (src/cli/handlers/terminal.ts:120-132,
// DEFAULT_TERMINAL_WAIT_RPC_TIMEOUT_MS = 5 min) and pass a generous fixed client `timeoutMs`
// directly on the call, sized wider for a human-paced succession handshake.
const CHAIRS_SUCCEED_CLIENT_TIMEOUT_MS = 10 * 60 * 1000

const SUCCEED_REASON_VALUES = ['batch_end', 'context'] as const

type SucceedResult =
  | { ok: true }
  | { ok: false; code: 'succession_aborted'; successionId: string; reason: string }

type SuccessionAcceptObligations = {
  ackedDeliveryIds: string[]
  outstandingDeliveryIds: string[]
  retiredHandle: string | null
  pendingPeerQuestionThreadIds: string[]
  pactTurnsHeld: number
}

type SuccessionAcceptResult = {
  successionId: string
  chair: string
  agentId: string
  runId: string
  generation: number
  resumeContext?: string
  obligations: SuccessionAcceptObligations
  /** G1 repair N7: a post-takeover step failed but was audited and swallowed, not thrown. */
  warnings?: string[]
  /** G1 repair N16: the manifest write failed — a reboot's `chairs restore` will resume the
   * pre-succession session until this is fixed by hand. */
  manifestWriteFailed?: boolean
}

type ResumeContextResult =
  | { ok: true; text: string; served: boolean }
  | { ok: false; code: 'succession_none' }

async function withSuccessionNextSteps<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      const data = (error.data ?? undefined) as { nextSteps?: unknown } | undefined
      const hasNextSteps = Array.isArray(data?.nextSteps) && data.nextSteps.length > 0
      const nextSteps = SUCCESSION_NEXT_STEPS[error.code]
      if (!hasNextSteps && nextSteps) {
        throw new RuntimeClientError(error.code, error.message, { ...data, nextSteps })
      }
    }
    throw error
  }
}

function formatSucceedResult(result: SucceedResult): string {
  if (result.ok === false) {
    return `RESULT=succession_aborted id=${result.successionId} reason=${result.reason}`
  }
  // Why unreachable in practice: on confirm the runtime closes this pane before answering.
  return ''
}

function formatSuccessionAccept(result: SuccessionAcceptResult): string {
  const lines = [
    `ACCEPTED ${result.successionId} chair=${result.chair} agent=${result.agentId} ` +
      `run=${result.runId} generation=${result.generation}`
  ]
  // G1 repair N7/N16: a post-takeover step (bindRun, retired-handle append, the manifest write,
  // the confirm transition, the post-confirm purge) can fail without failing the whole accept —
  // print what to check by hand rather than staying silent about it.
  if (result.warnings && result.warnings.length > 0) {
    lines.push(`WARNINGS ${result.warnings.join(',')}`)
    for (const warning of result.warnings) {
      const guidance = WARNING_GUIDANCE[warning]
      if (guidance) {
        lines.push(`  - ${warning}: ${guidance}`)
      }
    }
  }
  if (result.resumeContext) {
    lines.push('', result.resumeContext)
  }
  return lines.join('\n')
}

// R250: bounded read, `stdin` param defaulting to `process.stdin` — the smallest seam for a
// PassThrough that never closes. A TTY stdin (no pipe/redirect) never closes on its own either,
// so it is skipped outright; otherwise the read races a 2 s timer and a timeout is treated as an
// empty payload (log nothing; the exit path below is unchanged either way).
const HOOK_STDIN_READ_TIMEOUT_MS = 2000

// Why only these two fields, nothing else forwarded: the SessionStart hook JSON's shape is
// Claude Code's, not ours, and the fixed RPC contract (`{successionId?, hook?: boolean}`) has no
// slot to carry the rest — reading further than `hook_event_name`/`source` would tie this file to
// a payload the runtime never sees.
// G1-10z2 B2: exported so tests can pass a stream (a PassThrough) through this parameter instead
// of only exercising the `process.stdin` default.
export async function readHookStdinAudit(
  stdin: NodeJS.ReadableStream = process.stdin
): Promise<{ hookEventName?: string; source?: string }> {
  if ((stdin as { isTTY?: boolean }).isTTY) {
    return {}
  }
  const chunks: Buffer[] = []
  const readAll = (async () => {
    for await (const chunk of stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
  })()
  const timedOut = Symbol('hook-stdin-timeout')
  // G1-10z2 B2: keep the timer handle and clear it once the race is over — an uncleared timer,
  // and the still-open stdin pipe below, both kept the process alive past the handler returning
  // (`orca chairs resume-context --hook` never calls `process.exit`).
  let timer: ReturnType<typeof setTimeout> | undefined
  const raced = await Promise.race([
    readAll.then(() => 'done' as const).catch(() => 'done' as const),
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), HOOK_STDIN_READ_TIMEOUT_MS)
    })
  ])
  clearTimeout(timer)
  if (raced === timedOut) {
    // G1-10z2 B2: destroy the stdin stream so a silent, never-closing pipe releases its handle
    // instead of keeping the process alive until the writer closes it (fallback to `unref` for a
    // stream with no `destroy`).
    const destroyable = stdin as { destroy?: () => void; unref?: () => void }
    if (typeof destroyable.destroy === 'function') {
      destroyable.destroy()
    } else {
      destroyable.unref?.()
    }
    return {}
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      return {
        hookEventName: typeof obj.hook_event_name === 'string' ? obj.hook_event_name : undefined,
        source: typeof obj.source === 'string' ? obj.source : undefined
      }
    }
  } catch {
    // Why: SessionStart hook input is advisory only here — never fail the hook on bad JSON.
  }
  return {}
}

export const CHAIRS_SUCCESSION_HANDLERS: Record<string, CommandHandler> = {
  'chairs succeed': async ({ flags, client, cwd, json }) => {
    const checkpointPath = resolve(cwd, getRequiredStringFlag(flags, 'checkpoint'))
    if (!existsSync(checkpointPath)) {
      throw new RuntimeClientError('invalid_argument', `No checkpoint file at ${checkpointPath}`)
    }
    const reason = getRequiredStringFlag(flags, 'reason')
    if (!SUCCEED_REASON_VALUES.includes(reason as (typeof SUCCEED_REASON_VALUES)[number])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid --reason '${reason}', expected one of: ${SUCCEED_REASON_VALUES.join(', ')}`
      )
    }
    const checkpointSha256 = createHash('sha256').update(readFileSync(checkpointPath)).digest('hex')
    const ack = getRepeatedStringFlag(flags, 'ack')
    const response = await withSuccessionNextSteps(
      client.call<SucceedResult>(
        'orchestration.chairs.succeed',
        {
          checkpointPath,
          checkpointSha256,
          reason,
          ack: ack.length > 0 ? ack : undefined
        },
        { timeoutMs: CHAIRS_SUCCEED_CLIENT_TIMEOUT_MS }
      )
    )
    printResult(response, json, formatSucceedResult)
    if (response.result.ok === false) {
      process.exitCode = 1
    }
  },

  'chairs succession-accept': async ({ flags, client, json }) => {
    const successionId = getRequiredStringFlag(flags, 'id')
    const response = await withSuccessionNextSteps(
      client.call<SuccessionAcceptResult>('orchestration.chairs.successionAccept', {
        successionId
      })
    )
    printResult(response, json, formatSuccessionAccept)
  },

  'chairs resume-context': async ({ flags, client, json, stdin }) => {
    const hook = flags.has('hook')
    const markdown = flags.has('markdown')
    if ([hook, json, markdown].filter(Boolean).length > 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose at most one of --json, --markdown, or --hook.'
      )
    }
    if (hook) {
      // Why unused beyond parsing: see readHookStdinAudit's comment — nothing here forwards
      // into the RPC call, which never leaves this file with more than `hook: true`.
      // G1-10z2 B2: forward ctx.stdin (undefined outside tests) so a PassThrough can be injected.
      await readHookStdinAudit(stdin)
      // [G1-10z B1 repair] `succession_none` (no record for this pane) resolves to `{ok: false}`
      // and is handled below — but an RPC REFUSAL (no_pane_identity, no_registered_identity, a
      // transport error, anything else) THROWS, and previously nothing here caught it: an
      // uncaught throw exits this process non-zero, which breaks Claude Code's SessionStart hook
      // contract (a non-zero hook can block/annotate the whole session boot) — a hook must never
      // fail loudly for a condition the caller (Claude Code, not the chair) cannot act on.
      try {
        const response = await client.call<ResumeContextResult>(
          'orchestration.chairs.resumeContext',
          { hook: true }
        )
        if (response.result.ok) {
          console.log(response.result.text)
        }
      } catch {
        // Swallowed deliberately — see comment above. Nothing printed, exit 0 either way.
      }
      return
    }
    // Why no `successionId` param: the CLI surface (`orca chairs resume-context
    // [--json|--markdown]`) names no id flag — the runtime resolves the record from the
    // caller's own pane.
    const response = await client.call<ResumeContextResult>('orchestration.chairs.resumeContext', {
      hook: undefined
    })
    if (json) {
      console.log(JSON.stringify(response.result, null, 2))
      return
    }
    if (response.result.ok) {
      console.log(response.result.text)
    } else {
      console.log('No succession context is pending for this pane.')
    }
  }
}
