import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

// S10-21d b4 (design-r105-r112 ITEM 2 D1): no --pane/--terminal flag exists anywhere on this
// surface (CONTAINMENT #1, src/cli/specs/agents.ts:4-5) — the runtime chooses every pane.
export const CHAIRS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['chairs', 'restore'],
    summary: 'Restore every chair listed in a manifest: open its pane, resume its conversation',
    usage: 'orca chairs restore [--manifest <path>] [--only <name,...>] [--dry-run] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'manifest', 'only', 'dry-run'],
    notes: [
      'Default manifest: ~/.orca/chairs.json.',
      'Idempotent: a chair already live on its recorded pane is skipped, not relaunched.',
      '--dry-run prints the plan (skip_live/rebind/launch/refuse per chair, plus any cross-host ' +
        'entries) without opening or touching anything.',
      'A conversation id already live on a DIFFERENT pane is refused loudly, naming the pane — ' +
        'fork it manually instead of running restore again.'
    ]
  },
  {
    path: ['chairs', 'status'],
    summary: 'Show the restore plan for a manifest without acting on it',
    usage: 'orca chairs status [--manifest <path>] [--only <name,...>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'manifest', 'only']
  },
  {
    path: ['chairs', 'export'],
    summary: 'Write a manifest from the current agent directory',
    usage: 'orca chairs export [--manifest <path>] [--force] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'manifest', 'force'],
    notes: ['Refuses to overwrite any existing file at the target path unless --force is passed.']
  }
]
