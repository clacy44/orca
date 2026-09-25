import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

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

// Why this map, not raw RPC refusals: `format.ts`'s `formatCliError` already renders any
// `nextSteps` the runtime attaches to `error.data` (src/cli/format.ts:87-90,134-138) — this map
// only fills the gap for succession/checkpoint refusal codes where the runtime sends none, the
// same pattern `computer-use-error-recovery.ts` uses for `computer` command codes (cited at
// src/cli/format.ts:94).
const SUCCESSION_NEXT_STEPS: Record<string, string[]> = {
  succession_not_a_chair: [
    'Run this from a chair pane; only a Run-bound chair may call `orca chairs succeed`.'
  ],
  succession_no_run: [
    'Bind a Run first (`orca orchestration run-use --id <run>` or create one), then retry.'
  ],
  succession_legacy_run: [
    'This Run predates succession support; finish it without succession, or migrate the Run before retrying.'
  ],
  succession_active_dispatch: [
    'Wait for the outstanding dispatch to settle, or release it, before retrying `orca chairs succeed`.'
  ],
  succession_in_flight: [
    'A succession for this chair is already sealed or launching; run `orca chairs resume-context` on the successor, or wait for it to resolve, before starting another.'
  ],
  succession_charter_missing: [
    "Set the chair's manifest `succession.charterPath` to an existing charter file, then retry."
  ],
  succession_unacked_delivery: [
    'Acknowledge the listed delivery ids (pass each with `--ack <id>`), then retry.'
  ],
  checkpoint_schema: [
    "Make the checkpoint's first non-empty line read exactly `schema: orca.chair-checkpoint/1`."
  ],
  checkpoint_sections: [
    'Fix the checkpoint to have exactly the eight required `## ` headings, in order, with exact titles.'
  ],
  checkpoint_empty_section: ['Fill in the empty section, or write the literal `none`, then retry.'],
  checkpoint_fence_line: [
    'Remove the code-fence delimiter (```` ``` ```` or `~~~`) from the checkpoint body.'
  ],
  checkpoint_tag_line: ['Remove the line that looks like a system tag from the checkpoint body.'],
  checkpoint_too_large: [
    'Shorten the checkpoint: each section must fit 8 KiB and the whole file 32 KiB.'
  ],
  checkpoint_secret_shape: ['Remove the credential-shaped text from the checkpoint, then retry.'],
  checkpoint_unsupported_claim: [
    'Cite the approving message id (`msg_` + 12 hex) for any claimed owner approval, or remove the claim.'
  ],
  succession_unknown: [
    'Check the succession id; it may already have resolved or expired. Use the id your launch context named.'
  ],
  succession_wrong_pane: [
    'Run `orca chairs succession-accept` from the successor pane the succession named, not this one.'
  ],
  succession_not_launching: [
    'This succession is not awaiting acceptance (already confirmed or aborted); nothing to accept.'
  ],
  succession_expired: [
    'The acceptance window passed and the succession was aborted; ask the incumbent chair to run `orca chairs succeed` again.'
  ],
  succession_takeover_failed: [
    'Both panes may be down: run `orca chairs restore` twice, ten seconds apart, then retry from the restored chair.'
  ],
  // G1 repair round (attempt 2), N8: five refusals reachable after the wave-2 pass with no map
  // entry — the runtime sent no `nextSteps` for any of them, so a caller saw a bare error code.
  succession_incumbent_exit_timeout: [
    'stand down: this pane is not the chair — do not send or receive chair traffic from it',
    'ask the incumbent (or a human) to check whether the old pane is actually dead',
    'once confirmed dead, a fresh `orca chairs succeed` from the incumbent (if reachable) or manual recovery can retry'
  ],
  succession_run_moved: [
    'The incumbent no longer holds the Run this succession was sealed for; ask the incumbent to re-run `orca chairs succeed` against its CURRENT Run.'
  ],
  succession_unknown_ack: [
    '--ack named an id with no outstanding delivery; drop it (or fix the typo) and retry.'
  ],
  succession_lane_unsupported: [
    'Chair succession (slice 1) only supports the host default lane; move this pane off its named credential lane before retrying.'
  ],
  resume_context_too_large: [
    'Shorten the checkpoint or the board state so the rendered resume context fits the size cap, then retry.'
  ]
}

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
  }
  if (result.resumeContext) {
    lines.push('', result.resumeContext)
  }
  return lines.join('\n')
}

// Why only these two fields, nothing else forwarded: the SessionStart hook JSON's shape is
// Claude Code's, not ours, and the fixed RPC contract (`{successionId?, hook?: boolean}`) has no
// slot to carry the rest — reading further than `hook_event_name`/`source` would tie this file to
// a payload the runtime never sees.
async function readHookStdinAudit(): Promise<{ hookEventName?: string; source?: string }> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
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

  'chairs resume-context': async ({ flags, client, json }) => {
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
      await readHookStdinAudit()
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
