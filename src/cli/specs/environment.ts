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
  }
]
