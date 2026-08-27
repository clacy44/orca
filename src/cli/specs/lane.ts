import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: per-person Claude credential lanes are set up by the human at the host machine (S9 §2a).
// On a headless serve box that human has only a shell, so these verbs drive the same host-only
// consent RPCs the desktop AccountsPane drives — over the local socket, refused to any remote
// caller. `--environment` / `--pairing-code` are rejected, not ignored: this runs on the host.
const DEVICE_NOTE =
  '--device accepts a device id, a unique id prefix, or the pairing label; an ambiguous prefix is refused with its candidates.'
const PERSON_NOTE = '--person accepts a person id or their exact display name.'

export const LANE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['lane', 'persons'],
    summary: 'List the people who can own a per-person Claude credential lane',
    usage: 'orca lane persons [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca lane persons']
  },
  {
    path: ['lane', 'create-person'],
    summary: 'Create a person who can own a credential lane',
    usage: 'orca lane create-person --name <name> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['orca lane create-person --name "Ana Ng"']
  },
  {
    path: ['lane', 'invite'],
    summary: 'Mint a per-person pairing invite for someone to redeem on their own machine',
    usage:
      'orca lane invite --person <idOrName> [--scope runtime|mobile] [--ttl <hours>] [--address <host>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person', 'scope', 'ttl', 'address'],
    notes: [
      PERSON_NOTE,
      '--scope defaults to runtime — the only scope admitted on the lane push/pull/clear/status RPCs.',
      '--ttl is in hours, 1..24, and can only shorten the 24h default.',
      '--address advertises the endpoint the invited machine will dial; it defaults to the address this serve was started with.'
    ],
    examples: [
      'orca lane invite --person "Ana Ng"',
      'orca lane invite --person "Ana Ng" --scope runtime --ttl 4 --address example.com'
    ]
  },
  {
    path: ['lane', 'bind'],
    summary: 'Bind a paired device to a person',
    usage: 'orca lane bind --device <idOrPrefixOrLabel> --person <idOrName> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device', 'person'],
    notes: [DEVICE_NOTE, PERSON_NOTE],
    examples: ['orca lane bind --device ana-phone --person "Ana Ng"']
  },
  {
    path: ['lane', 'unbind'],
    summary: 'Unbind a device from its person',
    usage: 'orca lane unbind --device <idOrPrefixOrLabel> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device'],
    notes: [DEVICE_NOTE],
    examples: ['orca lane unbind --device ana-phone']
  },
  {
    path: ['lane', 'rebind'],
    summary: 'Rebind a device to a person (unbind, then bind — drops the designation)',
    usage: 'orca lane rebind --device <idOrPrefixOrLabel> --person <idOrName> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device', 'person'],
    notes: [
      DEVICE_NOTE,
      PERSON_NOTE,
      'Rebinding clears the pusher designation; re-designate before provisioning.'
    ],
    examples: ['orca lane rebind --device ana-phone --person "Ana Ng"']
  },
  {
    path: ['lane', 'designate'],
    summary: "Designate which of a person's bound devices pushes their Claude account",
    usage: 'orca lane designate --person <idOrName> --device <idOrPrefixOrLabel> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person', 'device'],
    notes: [PERSON_NOTE, DEVICE_NOTE],
    examples: ['orca lane designate --person "Ana Ng" --device ana-phone']
  },
  {
    path: ['lane', 'provision'],
    summary: "Create a person's credential lane (requires a bound, designated device)",
    usage: 'orca lane provision --person <idOrName> [--accept-unverified-platform] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person', 'accept-unverified-platform'],
    notes: [
      PERSON_NOTE,
      '--accept-unverified-platform provisions on a platform whose credential-containment probe has not run yet (S9 §5/§6), and records the acceptance in `orca lane audit`.'
    ],
    examples: [
      'orca lane provision --person "Ana Ng"',
      'orca lane provision --person "Ana Ng" --accept-unverified-platform'
    ]
  },
  {
    path: ['lane', 'deprovision'],
    summary: "Wipe and remove a person's credential lane",
    usage: 'orca lane deprovision --person <idOrName> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person'],
    notes: [PERSON_NOTE],
    examples: ['orca lane deprovision --person "Ana Ng"']
  },
  {
    path: ['lane', 'bind-link'],
    summary: 'Bind a federated home-peer link to the person its grant belongs to',
    usage: 'orca lane bind-link --link <fingerprint> [--person <idOrName>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'link', 'person'],
    notes: [
      'The person a link runs as is derived from the grant the fingerprint resolves to.',
      '--person is an optional assertion: if it disagrees with that grant, the bind is refused.'
    ],
    examples: ['orca lane bind-link --link 0f1e2d3c...']
  },
  {
    path: ['lane', 'status'],
    summary: 'Show lane residency, device bindings, and pusher designations',
    usage: 'orca lane status [--person <idOrName>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person'],
    notes: [PERSON_NOTE, 'Omit --person to see every person and every paired device.'],
    examples: ['orca lane status', 'orca lane status --person "Ana Ng" --json']
  },
  {
    path: ['lane', 'audit'],
    summary: 'Show the host-only lane consent audit trail',
    usage: 'orca lane audit [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca lane audit --json']
  }
]
