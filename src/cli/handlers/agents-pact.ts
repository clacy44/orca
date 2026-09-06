// S10-3b: `orca agents pact|step|invite` — the lock-step pact CLI (agent-coordination-s10-3-pact-
// spec.md CLI §, lines 102-121 on the rev-7 line) plus A3's `invite` spelling for
// orchestration.threads.invite (one file, one manifest group, to stay under the max-lines
// ratchet without a second near-empty module — `.join` gets no CLI spelling per A3's own note:
// an invited caller already knows the thread id). Split out of agents.ts/agents-threads.ts, same
// precedent as agents-ask-reply.ts.
//
// Verb shapes follow the spec's CLI table exactly (not the looser paraphrase elsewhere): propose
// is `--with <name> --on <t>`, not a positional + `--propose`; `--resume` is a boolean on this
// noun (spec CLI §: "`pact --resume` is a boolean on the `pact` noun; `wait --resume <token>`
// takes a value on the `wait` noun — the spec table types them separately") and needs no
// BOOLEAN_FLAGS registration — `parseArgs`'s value/boolean heuristic already treats a flag
// followed by another `--flag` (or end of argv) as boolean, and every spec usage line puts
// `--resume` immediately before `--on`/`--json`/end, so this falls out for free.
import type { CommandHandler } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import {
  parseAgentSelector,
  refuseCrossHostPact,
  requireNonQuarantined,
  resolveAgentByNameOrId
} from './agents-shared'
import { LOCAL_FIND_HOST } from './agents-cross-host'
import { parsePactWithSelector, runPurgePeerLedger } from './agents-pact-federated'

type PactThread = {
  id: string
  pact_state: 'proposed' | 'engaged' | 'released' | null
  pact_proposer_agent_id: string | null
  pact_with_agent_id: string | null
  pact_turn_agent_id: string | null
  pact_steps_total: number | null
  pact_ordinal: number
  pact_paused_at: string | null
  pact_pause_reason: string | null
  pact_last_inbound_at: string | null
  // S10-21b B12b: the federated discriminator (§1.2) — non-null iff this pact is federated.
  // Read by `agents step`'s CLI-layer `--acknowledge-gate` refusal, before the step RPC.
  pact_peer_agent_id: string | null
}
type PactActionResult = { thread: PactThread; nextSteps: string[]; requested?: boolean }
type PactLedgerEntry = {
  ordinal: number
  kind: string
  actorAgentId: string | null
  actorDisplayName: string | null
  at: string
  summary: string | null
  summaryShaPrefix: string | null
  withheld: boolean
  purged: boolean
  reasonCode: string | null
}
type PactLedgerResult = {
  thread: PactThread
  entries: PactLedgerEntry[]
  omitted: { purged: number; withheld: number }
  // S10-21b B11 (design §3.3): the same three facts an expiring wait prints, durably visible
  // outside a wait too (lastInboundAt already rides on `thread.pact_last_inbound_at`).
  linkHealth: string | null
  peerState: string | null
  // S10-21b B12b (design §7): true only when THIS call's `--resync` actually minted a fresh
  // nonce (false when not asked, not federated, or coalesced against one already outstanding).
  resyncRequested: boolean
  nextSteps: string[]
}
type StepResult = {
  ordinal: number
  of: number | null
  turn: string
  messageId: string
  sequence: number
  gateFlags: string[] | null
  nextSteps: string[]
}
type InviteResult = {
  participant: { thread_id: string; agent_id: string | null; invite_state: string | null }
  nextSteps: string[]
}

function nextStepLines(nextSteps: readonly string[]): string {
  return nextSteps.map((step) => `Next: ${step}`).join('\n')
}

function stepsOf(total: number | null): string {
  return total === null ? 'open' : String(total)
}

function formatPactAction(
  r: PactActionResult,
  action: 'propose' | 'accept' | 'decline' | 'pause' | 'resume' | 'release',
  extra: { withDisplayName?: string; steps?: number; open?: boolean; reason?: string }
): string {
  let headline: string
  switch (action) {
    case 'propose':
      headline =
        `pact proposed with ${extra.withDisplayName} on ${r.thread.id} ` +
        `(${extra.open ? 'open-ended' : `${extra.steps ?? r.thread.pact_steps_total} steps`}).`
      break
    case 'accept':
      headline = 'pact engaged. Your turn is second.'
      break
    case 'decline':
      headline = 'pact declined.'
      break
    case 'pause':
      headline = `pact paused (reason: ${extra.reason ?? 'operator'}).`
      break
    case 'release':
      headline = 'pact released.'
      break
    case 'resume':
      headline = r.requested
        ? 'Requested: the other side paused this pact, so lifting it is theirs to confirm.'
        : 'pact resumed.'
      break
  }
  const steps = nextStepLines(r.nextSteps)
  return steps ? `${headline}\n${steps}` : headline
}

function formatPactShow(r: PactLedgerResult, threadId: string, resyncFlag: boolean): string {
  const t = r.thread
  if (!t.pact_state) {
    return (
      `No pact on thread ${threadId}.\n` + `Next: orca agents pact --with <name> --on ${threadId}`
    )
  }
  const proposer =
    r.entries.find((e) => e.kind === 'propose')?.actorDisplayName ?? t.pact_proposer_agent_id
  const withName =
    r.entries.find((e) => e.actorAgentId === t.pact_with_agent_id)?.actorDisplayName ??
    t.pact_with_agent_id
  const turnName =
    r.entries.find((e) => e.actorAgentId === t.pact_turn_agent_id)?.actorDisplayName ??
    t.pact_turn_agent_id
  const state = t.pact_paused_at
    ? `paused (${t.pact_pause_reason ?? 'unknown'})`
    : (t.pact_state as string)
  const turnSuffix = t.pact_state === 'released' ? '' : `, turn: ${turnName}`
  const header =
    `pact ${threadId}   ${proposer} <-> ${withName}    ${state}, ` +
    `${t.pact_ordinal}/${stepsOf(t.pact_steps_total)}${turnSuffix}`
  const rows = r.entries.map((e) => {
    const ord = e.kind === 'propose' ? '-' : String(e.ordinal)
    const when = e.at.slice(11, 16)
    let what: string
    if (e.purged) {
      what = `[summary purged - sha256 ${e.summaryShaPrefix}]`
    } else if (e.withheld) {
      what = `[withheld - author quarantined - sha256 ${e.summaryShaPrefix}]`
    } else if (e.kind === 'propose') {
      what = `${stepsOf(t.pact_steps_total)} steps`
    } else if (e.summary) {
      what = `"${e.summary}"`
    } else {
      what = e.reasonCode ? `(${e.reasonCode})` : ''
    }
    return `${ord}   ${when}  ${e.kind}  ${e.actorDisplayName ?? e.actorAgentId ?? '?'}  ${what}`.trimEnd()
  })
  const omissionLine =
    r.omitted.purged > 0 || r.omitted.withheld > 0
      ? `\n(${r.omitted.withheld} withheld, ${r.omitted.purged} purged)`
      : ''
  // S10-21b B11 (design §3.3): durably visible outside a wait too — same three facts an
  // expiring `wait` prints. Local (non-federated) pact: `linkHealth`/`peerState` are null.
  const factsLine =
    t.pact_last_inbound_at !== null || r.linkHealth !== null || r.peerState !== null
      ? `\nLast heard: ${t.pact_last_inbound_at ?? '(none)'}   ` +
        `Link: ${r.linkHealth ?? 'n/a'}   Peer: ${r.peerState ?? 'n/a'}`
      : ''
  // S10-21b B12b (design §7): only rendered when this invocation actually passed --resync — a
  // plain `--show` prints nothing about repair state.
  const resyncLine = resyncFlag
    ? r.resyncRequested
      ? '\nResync requested.'
      : '\nResync already in progress (or not applicable to a local pact).'
    : ''
  return (
    `${header}\n #   when      kind     who             what\n${rows.join('\n')}${omissionLine}${factsLine}${resyncLine}\n` +
    `Third-party check: orca agents pact --show ${threadId} --json`
  )
}

function formatStep(r: StepResult): string {
  return `step ${r.ordinal}/${stepsOf(r.of)} recorded. Turn passed.\n${nextStepLines(r.nextSteps)}`
}

function formatInvite(r: InviteResult, agentName: string): string {
  const steps = nextStepLines(r.nextSteps)
  return `Invited ${agentName} to thread ${r.participant.thread_id}.${steps ? `\n${steps}` : ''}`
}

export const AGENT_PACT_HANDLERS: Record<string, CommandHandler> = {
  'agents pact': async ({ flags, client, json }) => {
    const showId = getOptionalStringFlag(flags, 'show')
    if (showId) {
      const resyncFlag = flags.has('resync')
      const result = await client.call<PactLedgerResult>('orchestration.threads.pactLedger', {
        threadId: showId,
        resync: resyncFlag ? true : undefined
      })
      printResult(result, json, (r) => formatPactShow(r, showId, resyncFlag))
      return
    }

    // S10-21b B12b (design §7, §4.6(b)): `--purge-peer-ledger --link <id> [--force-released]` —
    // parse and pass through only (commit 14 implements the purge). A separate mode from the
    // propose/accept/.../release action set below, same as `--show`.
    if (flags.has('purge-peer-ledger')) {
      return runPurgePeerLedger(flags, client, json)
    }

    const onId = getOptionalStringFlag(flags, 'on')
    const withName = getOptionalStringFlag(flags, 'with')
    const isAccept = flags.has('accept')
    const isDecline = flags.has('decline')
    const isPause = flags.has('pause')
    const isResume = flags.has('resume')
    const isRelease = flags.has('release')
    const actionCount = [
      isAccept,
      isDecline,
      isPause,
      isResume,
      isRelease,
      Boolean(withName)
    ].filter(Boolean).length
    if (actionCount !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Pass exactly one of --with, --accept, --decline, --pause, --resume, --release ' +
          '(or --show <t> to read one).'
      )
    }
    if (!onId) {
      throw new RuntimeClientError('invalid_argument', 'Missing --on <thread>.')
    }

    const stepsFlag = getOptionalPositiveIntegerFlag(flags, 'steps')
    const open = flags.has('open')
    if (stepsFlag !== undefined && open) {
      throw new RuntimeClientError('invalid_argument', '--steps and --open are mutually exclusive.')
    }

    let withParam: string | undefined
    let withDisplayName: string | undefined
    let hostParam: string | undefined
    if (withName) {
      const selector = parsePactWithSelector(withName)
      if (selector.host === undefined) {
        const agent = requireNonQuarantined(await resolveAgentByNameOrId(client, withName))
        withParam = `agent:${agent.id}`
        withDisplayName = agent.displayName
      } else {
        // S10-21b B12b (design §7, "--with name@host"/"PactParams.host, unchanged from v2"):
        // the CLI-side host-local refusal (F-20/A1, refuseCrossHostPact) stays for
        // `invite --agent` below, but no longer applies to `pact --with` — this host resolves
        // and mirrors the peer server-side (same live-probe transport `agents ask --host`
        // already uses), so the raw, UNRESOLVED name travels with the host it names.
        withParam = selector.name
        withDisplayName = `${selector.name}@${selector.host}`
        hostParam = selector.host
      }
    }

    const reason = getOptionalStringFlag(flags, 'reason')
    const evidence = isRelease ? getOptionalStringFlag(flags, 'evidence') : undefined
    const result = await client.call<PactActionResult>('orchestration.threads.pact', {
      id: onId,
      with: withParam,
      host: hostParam,
      steps: stepsFlag,
      open: open ? true : undefined,
      accept: isAccept ? true : undefined,
      decline: isDecline ? true : undefined,
      pause: isPause ? true : undefined,
      resume: isResume ? true : undefined,
      release: isRelease ? true : undefined,
      reasonCode: reason,
      evidence
    })
    const action = withName
      ? 'propose'
      : isAccept
        ? 'accept'
        : isDecline
          ? 'decline'
          : isPause
            ? 'pause'
            : isResume
              ? 'resume'
              : 'release'
    printResult(result, json, (r) =>
      formatPactAction(r, action, { withDisplayName, steps: stepsFlag, open, reason })
    )
  },

  'agents step': async ({ flags, client, json }) => {
    const threadId = getRequiredStringFlag(flags, 'thread')
    const done = getRequiredStringFlag(flags, 'done')
    const acknowledgeGate = flags.has('acknowledge-gate')
    if (acknowledgeGate) {
      // S10-21b B12b (design §7, §2.6(a)): a federated step never accepts this flag — the
      // sender's gate can be acknowledged but the receiver's inbound apply passes no
      // `acknowledgeGate`, so an acknowledged HARD body is guaranteed `body_gate_refused` at
      // the peer. Refused here, before the step RPC (TESTS item 2: the RPC mock is never
      // called), by reading the pact's federated-ness off the ledger read (never mutating).
      const ledger = await client.call<{ thread: PactThread }>('orchestration.threads.pactLedger', {
        threadId
      })
      if (ledger.result.thread.pact_peer_agent_id !== null) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Refused: --acknowledge-gate is not honored on a federated pact step — the peer never ' +
            'sees it, so an acknowledged hard body is guaranteed to be refused there. Shorten or ' +
            'rephrase --done instead.'
        )
      }
    }
    const result = await client.call<StepResult>('orchestration.threads.step', {
      threadId,
      done,
      acknowledgeGate: acknowledgeGate ? true : undefined
    })
    printResult(result, json, formatStep)
  },

  'agents invite': async ({ flags, client, json }) => {
    const threadId = getRequiredStringFlag(flags, 'thread')
    const agentName = getRequiredStringFlag(flags, 'agent')
    // F-20/A1: same host-local refusal as `agents pact --with` above.
    const agentHost = parseAgentSelector(agentName).host
    if (agentHost !== LOCAL_FIND_HOST) {
      refuseCrossHostPact(agentName, agentHost)
    }
    const agent = await resolveAgentByNameOrId(client, agentName)
    const result = await client.call<InviteResult>('orchestration.threads.invite', {
      threadId,
      agentId: agent.id
    })
    printResult(result, json, (r) => formatInvite(r, agent.displayName))
  }
}
