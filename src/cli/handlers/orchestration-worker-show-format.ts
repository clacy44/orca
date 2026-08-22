import { RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS } from '../../shared/runtime-types'

export type OrchestrationWorkerShowResult = {
  dispatch: { id: string; task_id: string; status: string }
  worker: {
    state: string
    stage: string
    agent_terminal_handle: string | null
    inputEvidence?: { submittedAt: string; blockedReason?: string }
  }
  // Why loose: the federated branch relays the peer's projection verbatim, so only the fields
  // this formatter reads can be relied on.
  terminal?: { lastOutputAt?: number | null } | null
  observation?: {
    status: string
    exactWorker: boolean
    agentStatus?: string
    blockedSince?: string
  }
  lastHeartbeatAt?: string
  heartbeatAgeMs?: number
  dispatchMailbox?: { unread: number; deliverable: boolean }
  workerMail?: { pending: number; deliverable: boolean }
  sync?: {
    lastSyncAt: string | null
    lastError: string | null
    consecutiveFailures: number
  } | null
}

// Why whitelisted: the federated branch relays the peer's projection verbatim, so an unknown
// verdict would render on the home as though the home computed it, and any newline in it would
// forge an extra line in the coordinator's terminal.
const RENDERABLE_AGENT_STATUSES = ['working', 'permission', 'idle']
const RENDERABLE_BLOCKED_REASONS: readonly string[] = RUNTIME_TERMINAL_WAIT_BLOCKED_REASONS
const RENDERABLE_TERMINAL_STATUSES = [
  'unattached',
  'missing',
  'identity_changed',
  'running',
  'exited'
]

export function formatOrchestrationWorkerShow(value: OrchestrationWorkerShowResult): string {
  const lines = [
    `${value.dispatch.id} task=${value.dispatch.task_id} [${value.worker.state}] stage=${value.worker.stage}`
  ]
  const terminal = formatWorkerTerminalLine(value)
  if (terminal) {
    lines.push(terminal)
  }
  lines.push(formatWorkerLivenessLine(value))
  const input = formatWorkerInputEvidenceLine(value)
  if (input) {
    lines.push(input)
  }
  const mail = formatWorkerMailLine(value)
  if (mail) {
    lines.push(mail)
  }
  if (value.sync) {
    const sync = `sync: lastSyncAt=${value.sync.lastSyncAt ?? 'never'} consecutiveFailures=${value.sync.consecutiveFailures}`
    lines.push(value.sync.lastError ? `${sync} lastError=${value.sync.lastError}` : sync)
  }
  return lines.join('\n')
}

export function formatHeartbeatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

function formatWorkerTerminalLine(value: OrchestrationWorkerShowResult): string | null {
  // Why exact only: a non-exact observation describes some other process, so its terminal
  // timestamps would be a report about the wrong worker.
  if (!value.observation?.exactWorker) {
    return null
  }
  const lastOutputAt = Number(value.terminal?.lastOutputAt)
  const parts = [
    `terminal: status=${renderPeerToken(value.observation.status, RENDERABLE_TERMINAL_STATUSES)}`,
    `lastOutputAt=${Number.isFinite(lastOutputAt) && lastOutputAt > 0 ? new Date(lastOutputAt).toISOString() : 'never'}`,
    // Why unknown on absence: an older host or peer simply does not compute the verdict, and
    // guessing one here is how a healthy worker gets reported stuck.
    `agent=${renderPeerToken(value.observation.agentStatus, RENDERABLE_AGENT_STATUSES)}`
  ]
  const blockedSince = Date.parse(value.observation.blockedSince ?? '')
  if (Number.isFinite(blockedSince)) {
    parts.push(`blockedSince=${new Date(blockedSince).toISOString()}`)
  }
  return parts.join(' ')
}

// Why silent unless a gate was seen: `ready` plus nothing here is the ordinary case, and printing
// a line that says only "we looked and saw nothing" on every healthy worker is how the one line
// that matters stops being read.
function formatWorkerInputEvidenceLine(value: OrchestrationWorkerShowResult): string | null {
  const evidence = value.worker.inputEvidence
  if (!evidence || !RENDERABLE_BLOCKED_REASONS.includes(evidence.blockedReason ?? '')) {
    return null
  }
  return (
    `input: submittedAt=${evidence.submittedAt} blockedReason=${evidence.blockedReason} — ` +
    'a gate was already on screen when the dispatch prompt was written'
  )
}

function renderPeerToken(value: string | undefined, allowed: string[]): string {
  return value !== undefined && allowed.includes(value) ? value : 'unknown'
}

function formatWorkerLivenessLine(value: OrchestrationWorkerShowResult): string {
  if (!value.lastHeartbeatAt) {
    return 'liveness: lastHeartbeat=never'
  }
  const age =
    value.heartbeatAgeMs === undefined ? 'unknown' : formatHeartbeatAge(value.heartbeatAgeMs)
  return `liveness: lastHeartbeat=${value.lastHeartbeatAt} age=${age}`
}

function formatWorkerMailLine(value: OrchestrationWorkerShowResult): string | null {
  // Why two shapes: the local count is unread mailbox rows, the federated one is relay-queue
  // depth — different questions, so they keep different words.
  const mail = value.dispatchMailbox
    ? { label: 'unread', count: value.dispatchMailbox.unread, ...value.dispatchMailbox }
    : value.workerMail
      ? { label: 'pending', count: value.workerMail.pending, ...value.workerMail }
      : null
  // Why silent at zero: a healthy result must stay terse or coordinators stop reading it.
  if (!mail || mail.count === 0) {
    return null
  }
  const line = `mail: ${mail.label}=${mail.count} deliverable=${mail.deliverable}`
  return mail.deliverable
    ? line
    : `${line} — STRANDED: this mail is queued for a Dispatch whose worker no longer reads it`
}
