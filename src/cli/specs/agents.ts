import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// S10-1c: no --terminal flag exists anywhere on this surface (CONTAINMENT #1) — identity comes
// only from the attested launch evidence the CLI already threads into every RPC call.
export const AGENTS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agents', 'register'],
    summary: 'Register this terminal as a named, discoverable agent',
    usage: 'orca agents register --name <slug> [--role <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'role'],
    notes: [
      '--name is a lowercase ASCII slug, 3-32 chars (e.g. merge-restructure-backend).',
      'Idempotent: re-registering from the same terminal after a restart updates the same agent.',
      'If the terminal handle changed since last registration, unread mail still addressed to ' +
        'the old handle moves into this mailbox automatically (reported as repointedMessages).',
      'A session already running before this build was installed has no launch record yet, so ' +
        'it is not auto-restored on its first restart after the install — that one restart ' +
        'needs exactly one register, same as before this feature existed; every restart after ' +
        'that, for a session launched on this build, is automatic and needs no register at all.'
    ]
  },
  {
    path: ['agents', 'list'],
    summary: 'List agents in the directory',
    usage:
      'orca agents list [--state live|idle|gone] [--include-quarantined] [--no-derived] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'state', 'include-quarantined', 'no-derived', 'limit']
  },
  {
    path: ['agents', 'show'],
    summary: 'Show one agent by id or name',
    usage: 'orca agents show <name|id|name@host> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'name'],
    positionalArgs: ['name'],
    notes: [
      'A `name@host` positional (from `agents find --all-hosts`) resolves against that saved ' +
        'environment directly; `--id`/`--name` stay local-only.',
      '`sessionLaunchKnown` (shown only on your OWN agent, never on another row) reports ' +
        'whether this host currently holds a launch record for your pane — false means this ' +
        'pane will not be auto-restored on the next restart and needs one register then.'
    ]
  },
  {
    path: ['agents', 'find'],
    summary: 'Find an agent from a plain-English description',
    usage: 'orca agents find "<plain English description>" [--limit <n>] [--all-hosts] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit', 'all-hosts'],
    positionalArgs: ['query'],
    examples: [
      'orca agents find "the merge-restructure backend agent"',
      'orca agents find "the merge-restructure backend agent" --all-hosts'
    ],
    notes: [
      '--all-hosts unions the directory across every saved environment (bounded, live probes; ' +
        'a peer that does not answer in time is listed in `unreached`, never silently dropped ' +
        'nor allowed to veto a local resolution). A name matching 2+ hosts is `ambiguous` and ' +
        'candidates print as `name@host`.'
    ]
  },
  {
    path: ['agents', 'relink'],
    summary: 'Reset the relay cursors on a stale federated environment link (S10-4 ruling 5)',
    usage: 'orca agents relink --env <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'env'],
    notes: [
      'For a peer that was reimaged/reinstalled inside the same pairing (a new install needs ' +
        "`orca environment rm` + re-add instead): zeroes this host's import/ack cursors and " +
        'runtime epoch for every active dispatch federated to that environment, and bumps that ' +
        "dispatch's relink generation so `relay_seen` records the next contact's outcomes " +
        '(incl. refusals) fresh, never colliding with — or being silently dropped against — ' +
        "this link's pre-relink history under the same sequence number.",
      'A no-op returning an empty list when the environment has no active federated dispatch.'
    ]
  },
  {
    path: ['agents', 'quarantine'],
    destructive: true,
    summary: 'Quarantine (or lift quarantine on) an agent',
    usage: 'orca agents quarantine <name|id> --reason-code <code> [--lift] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'name', 'lift', 'reason-code'],
    positionalArgs: ['name'],
    notes: ['Local and non-federated only, except self-quarantine which is always allowed.']
  },
  {
    path: ['agents', 'retire'],
    destructive: true,
    summary:
      'Retire an agent and free its name for reclaim (the quarantine -> retire cleanup step)',
    usage: 'orca agents retire <name|id> [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'name', 'force'],
    positionalArgs: ['name'],
    notes: [
      'Local operator only, never a federated peer.',
      'Refuses a currently live, attested agent unless --force.',
      'Idempotent by --id: retiring an already-retired agent succeeds with outcome already_retired.',
      'Frees the display_name immediately for a new `orca agents register` to reclaim.'
    ]
  },
  {
    path: ['agents', 'threads'],
    summary: 'List durable threads you participate in',
    usage: 'orca agents threads [--state open|paused|closed|all] [--limit 25] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'state', 'limit'],
    notes: ['The first command after losing context: shows every thread you can resume.']
  },
  {
    path: ['agents', 'thread'],
    summary: 'Read a thread, start a new one, or leave one',
    usage:
      'orca agents thread --id <t> [--since <seq|ts>] [--json] | ' +
      'orca agents thread --new --with <name>[,<name>...] [--subject "<text>"] [--sensitive] [--json] | ' +
      'orca agents thread --id <t> --leave [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'since', 'new', 'with', 'subject', 'sensitive', 'leave'],
    notes: [
      '--since takes a message sequence (from a prior --since/resumeToken) or an ISO timestamp.',
      '--new mints its own thread id; do not pass --id with it.'
    ]
  },
  {
    path: ['agents', 'ask'],
    summary: 'Ask another agent a blocking question',
    usage:
      'orca agents ask <name|name@host> "<question>" [--options a,b,c] [--timeout-ms 600000] ' +
      '[--acknowledge-gate] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'name',
      'question',
      'options',
      'timeout-ms',
      'resume',
      'acknowledge-gate'
    ],
    positionalArgs: ['name', 'question'],
    examples: ['orca agents ask backend-merge "did db.ts land yet?"'],
    notes: [
      'No create, no join, no id needed — the first message to a new peer mints its own thread.',
      'A timeout exits 0 with outcome:"timeout"; resume via orca agents wait, do not re-ask.',
      'A `name@host` address sends the whole ask to that saved environment directly.'
    ]
  },
  {
    path: ['agents', 'reply'],
    summary: 'Reply to the latest message on a thread, or to one message by id',
    usage:
      'orca agents reply --thread <t> | --id <msg> --body "<text>" [--expect-host <name>] ' +
      '[--acknowledge-gate] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'thread', 'id', 'body', 'acknowledge-gate', 'expect-host']
  },
  {
    path: ['agents', 'wait'],
    summary: 'Block until a thread gets a reply, a message, a pact change, or a step',
    usage:
      'orca agents wait --thread <t> --for reply|message|pact|step [--timeout-ms <n>] ' +
      '[--resume <token>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'thread', 'for', 'timeout-ms', 'resume'],
    notes: [
      'The resume token is stateless — safe to re-pass after a killed process restarts.',
      "--for step blocks for the counterpart's next step on an engaged pact.",
      'A caller holding the turn in any engaged pact is refused every park (outcome: your_turn) — step first.'
    ]
  },
  {
    path: ['agents', 'pact'],
    summary: 'Propose, accept, decline, pause, resume, release, or show a lock-step pact',
    usage:
      'orca agents pact --with <name> --on <thread> [--steps <n>|--open] [--json] | ' +
      'orca agents pact --on <t> --accept|--decline [--reason <code>] [--json] | ' +
      'orca agents pact --pause --on <t> [--reason <code>] [--json] | ' +
      'orca agents pact --resume --on <t> [--json] | ' +
      'orca agents pact --release --on <t> [--reason <code>] [--json] | ' +
      'orca agents pact --show <t> [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'with',
      'on',
      'steps',
      'open',
      'accept',
      'decline',
      'pause',
      'resume',
      'release',
      'show',
      'reason'
    ],
    notes: [
      'Pacts are host-local — both parties must be on this host; coordinate across hosts with orca orchestration send / orca agents ask instead.',
      'One engaged pact per agent pair at a time — release or finish an existing one first.',
      '--steps and --open are mutually exclusive.',
      'Neither side may advance past a step until the other confirms — use for lock-step work, not ordinary coordination.'
    ]
  },
  {
    path: ['agents', 'step'],
    summary: 'Record your step on an engaged pact and pass the turn',
    usage: 'orca agents step --thread <t> --done "<what>" [--acknowledge-gate] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'thread', 'done', 'acknowledge-gate'],
    notes: ['Refused off-turn, and while the pact is paused.']
  },
  {
    path: ['agents', 'invite'],
    summary: 'Invite an agent to join a durable thread',
    usage: 'orca agents invite --thread <t> --agent <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'thread', 'agent'],
    notes: [
      'Host-local — the invited agent must be on this host; coordinate across hosts with orca orchestration send / orca agents ask instead.',
      'Needed to bring a third party into a sensitive thread before a pact can involve them.'
    ]
  },
  {
    path: ['agents', 'purge'],
    destructive: true,
    summary: 'Purge a message or every message on a thread (removes the body for every reader)',
    usage:
      'orca agents purge --message <id> | --thread <id> --reason "<text>" [--acknowledge-gate] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'message', 'thread', 'reason', 'acknowledge-gate'],
    notes: [
      'Never reaches copies already relayed to a federated peer.',
      'No --lift: an un-purge is a re-poison primitive.'
    ]
  },
  {
    path: ['agents', 'review'],
    summary: "Operator-only: review a quarantined agent's withheld messages",
    usage: 'orca agents review <name|id> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'limit'],
    positionalArgs: ['agent'],
    notes: ['Local, non-federated callers only. Never pushed into a pane, never --format-injected.']
  }
]
