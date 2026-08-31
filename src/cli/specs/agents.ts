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
      'Idempotent: re-registering from the same terminal after a restart updates the same agent.'
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
    usage: 'orca agents show <name|id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id', 'name'],
    positionalArgs: ['name']
  },
  {
    path: ['agents', 'find'],
    summary: 'Find an agent from a plain-English description',
    usage: 'orca agents find "<plain English description>" [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'query', 'limit'],
    positionalArgs: ['query'],
    examples: ['orca agents find "the merge-restructure backend agent"']
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
      'orca agents ask <name> "<question>" [--options a,b,c] [--timeout-ms 600000] ' +
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
      'A timeout exits 0 with outcome:"timeout"; resume via orca agents wait, do not re-ask.'
    ]
  },
  {
    path: ['agents', 'reply'],
    summary: 'Reply to the latest message on a thread, or to one message by id',
    usage:
      'orca agents reply --thread <t> | --id <msg> --body "<text>" [--acknowledge-gate] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'thread', 'id', 'body', 'acknowledge-gate']
  },
  {
    path: ['agents', 'wait'],
    summary: 'Block until a thread gets a reply, a message, or a pact change',
    usage:
      'orca agents wait --thread <t> --for reply|message|pact [--timeout-ms] [--resume <token>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'thread', 'for', 'timeout-ms', 'resume'],
    notes: ['The resume token is stateless — safe to re-pass after a killed process restarts.']
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
