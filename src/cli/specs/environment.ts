import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'add'],
    summary: 'Save a remote Orca runtime environment from a pairing code',
    usage: 'orca environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['orca environment add --name work-laptop --pairing-code orca://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved Orca runtime environments',
    usage: 'orca environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved Orca runtime environment',
    usage: 'orca environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'roster'],
    summary: 'List terminals across this runtime and every saved environment',
    usage: 'orca environment roster [--limit <n>] [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit', 'timeout-ms'],
    notes: [
      'Polls every runtime in parallel; an unreachable peer degrades to one row carrying its reason instead of failing the roster.',
      'Rows are tagged with the environment (or local), runtimeId, reachability, terminal handle, title, presence, and the agent derived from that title.',
      'Presence names everyone on that terminal — "<name> (typing)" for a live keystroke, "<name> (writing)" for a chat or scripted write, "(host)" on the row of the machine serving that terminal, "-" when nobody is there, and "presence?" when no presence answer arrived at all: a peer running an older runtime, or a row with no terminal to carry one.'
    ],
    examples: ['orca environment roster --json', 'orca environment roster --timeout-ms 3000']
  },
  {
    path: ['environment', 'set-endpoint'],
    summary: 'Override where a saved environment is reached (e.g. a tunnel address)',
    usage: 'orca environment set-endpoint --environment <selector> --url <ws-or-wss-url> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'url'],
    notes: [
      'Refuses a scheme other than ws:// or wss://.',
      'Probes the new address before saving it; an unreachable address is refused and nothing is written.',
      'Leaves the pairing credentials (device token, public key) untouched — only the address changes.'
    ],
    examples: [
      'orca environment set-endpoint --environment work-laptop --url wss://tunnel.example:8443'
    ]
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
    summary: 'Remove one saved Orca runtime environment',
    usage: 'orca environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'update'],
    summary: 'Re-pair an existing saved environment in place from a new pairing code',
    usage: 'orca environment update --environment <selector> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Preserves createdAt, bumps pairingRevision (which kills the old link binding, R15) and rewrites the endpoint from the offer.',
      'Produces no duplicate environment record, unlike `add --name <new>`.'
    ],
    examples: ['orca environment update --environment vps --pairing-code orca://pair?code=...']
  },
  {
    path: ['environment', 'link-status'],
    summary: 'Show link-binding health for one or every proven/attempted link',
    usage:
      'orca environment link-status [--link <deviceId>] [--environment <selector>] [--outbox] ' +
      '[--drain] [--wait] [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'link', 'environment', 'outbox', 'drain', 'wait', 'timeout-ms'],
    notes: [
      '--wait waits on the prover round-settled event, capped at LINK_BINDING_STATUS_WAIT_CAP_MS; a wait that expires is a report, never an error.',
      '--outbox shows the reply-relay queue for the link; --drain kicks every route with pending work and returns the pending count per route.',
      '--environment <selector> filters the table to links bound to that environment (server-side, by resolved environment id); ignored by --outbox/--drain, which already take --link.'
    ],
    examples: [
      'orca environment link-status --json',
      'orca environment link-status --link 9c1e… --outbox'
    ]
  },
  {
    path: ['environment', 'link-bind'],
    summary: 'Kick a link-binding round for one link or every link',
    usage:
      'orca environment link-bind (--link <deviceId> | --all) [--deep] ' +
      '[--accept-legacy --reason <text> [--lift]] [--yes] [--timeout-ms <ms>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'link',
      'all',
      'deep',
      'accept-legacy',
      'reason',
      'lift',
      'yes',
      'timeout-ms'
    ],
    notes: [
      'Kicks and returns immediately with {state:"running", link, attemptId} or {state:"noop", reason}; --deep requests a contest_search round.',
      '--accept-legacy is an audited, last-resort operator attestation; it requires --reason, expires after LINK_BINDING_LEGACY_ATTEST_TTL_MS, and silently lapses if the binding is later re-bound elsewhere.'
    ],
    examples: ['orca environment link-bind --all', 'orca environment link-bind --link 9c1e… --deep']
  },
  {
    path: ['environment', 'link-revoke'],
    summary: 'Revoke a link binding so no inbound message can silently re-bind it',
    usage: 'orca environment link-revoke --link <deviceId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'link'],
    notes: ['Sticky: `link-bind` on the same link is required to undo it.']
  },
  {
    path: ['environment', 'link-forget'],
    summary: "Drop a retired link's binding rows",
    usage: 'orca environment link-forget (--link <deviceId> | --all) [--yes] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'link', 'all', 'yes']
  },
  {
    path: ['environment', 'link-quarantine'],
    summary: 'Quarantine or lift quarantine on one link (routing and inbound mail both stop)',
    usage: 'orca environment link-quarantine --link <deviceId> [--lift] [--reason <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'link', 'lift', 'reason'],
    notes: ['The wire refusal carries the advisory so the peer operator learns it.']
  },
  {
    path: ['environment', 'link-exclude'],
    summary: 'Take a saved environment out of link-binding scans, or clear the exclusion',
    usage:
      'orca environment link-exclude --environment <selector> [--clear] [--reason <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'clear', 'reason'],
    notes: [
      'Use before re-pointing an environment mid re-pair to bracket the window (v6, lifecycle M9), then `--clear` to restore scanning.'
    ]
  }
]
