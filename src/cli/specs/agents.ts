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
  }
]
