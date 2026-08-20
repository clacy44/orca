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
      'Rows are tagged with the environment (or local), runtimeId, reachability, terminal handle, title, and the agent derived from that title.'
    ],
    examples: ['orca environment roster --json', 'orca environment roster --timeout-ms 3000']
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
    summary: 'Remove one saved Orca runtime environment',
    usage: 'orca environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
