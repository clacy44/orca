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
      'orca lane invite --person <idOrName> --profile peer|full [--scope runtime|mobile] [--ttl <hours>] [--address <host>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person', 'scope', 'profile', 'ttl', 'address'],
    notes: [
      PERSON_NOTE,
      '--profile is REQUIRED, no default (Ruling 20(d)): "full" for ordinary runtime access, "peer" for a least-privilege federation-dispatch-only grant. --scope mobile --profile peer is refused.',
      '--scope defaults to runtime — the only scope admitted on the lane push/pull/clear/status RPCs.',
      '--ttl is in hours, 1..24, and can only shorten the 24h default.',
      '--address advertises the endpoint the invited machine will dial; it defaults to the address this serve was started with.'
    ],
    examples: [
      'orca lane invite --person "Ana Ng" --profile full',
      'orca lane invite --person "Ana Ng" --profile peer --scope runtime',
      'orca lane invite --person "Ana Ng" --profile full --scope runtime --ttl 4 --address example.com'
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
    path: ['lane', 'login'],
    summary: 'Sign a lane into a Claude account (host-inline, S9-L1 §modules E)',
    usage:
      'orca lane login --person <idOrName> --email <e> [--code <c>] [--json]\n       orca lane login --cancel --person <idOrName>',
    allowedFlags: [...GLOBAL_FLAGS, 'person', 'email', 'code', 'cancel'],
    notes: [
      PERSON_NOTE,
      '--email is required: it is the account this login must land in, checked after the CLI reports back in — a mismatch or an unverifiable report discards the login and signs in nothing.',
      '--code answers the paste-code prompt non-interactively (for scripts); omit it to be prompted on this terminal.',
      "--cancel ends the lane's in-flight host-inline login (started by this verb, on this or another shell) rather than starting a new one; it cannot cancel a login a paired device started.",
      'Runs inline, exactly like `orca account add` — the authorization URL and the paste prompt appear on this terminal, and the code never touches a log line.',
      'A paired device and this verb share ONE per-lane login lock: whichever starts first wins, and the other is refused until it finishes, is cancelled, or times out.'
    ],
    examples: [
      'orca lane login --person "Ana Ng" --email ana@example.com',
      'orca lane login --person "Ana Ng" --email ana@example.com --code 123456',
      'orca lane login --cancel --person "Ana Ng"'
    ]
  },
  {
    path: ['lane', 'logout'],
    summary: 'Sign a lane out of every Claude account it holds',
    usage: 'orca lane logout --person <idOrName> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person'],
    notes: [
      PERSON_NOTE,
      'Wipes the active credential, every captured login this lane has ever signed into, and the account index. Refuses `logout_incomplete` rather than reporting a sweep that did not finish.'
    ],
    examples: ['orca lane logout --person "Ana Ng"']
  },
  {
    path: ['lane', 'accounts'],
    summary: "List a lane's captured Claude logins",
    usage: 'orca lane accounts --person <idOrName> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person'],
    notes: [PERSON_NOTE, 'Up to eight logins per lane; the active one is marked.'],
    examples: ['orca lane accounts --person "Ana Ng"']
  },
  {
    path: ['lane', 'use'],
    summary: "Switch a lane's active Claude account to one it already holds",
    usage: 'orca lane use --person <idOrName> --account <idOrEmail> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person', 'account'],
    notes: [
      PERSON_NOTE,
      '--account accepts a laneAccountId or an exact email from `orca lane accounts`.'
    ],
    examples: ['orca lane use --person "Ana Ng" --account ana@example.com']
  },
  {
    path: ['lane', 'wipe'],
    summary:
      "Force-release a lane's latched wipe-pending mark without waiting on the confirm-dead budget",
    usage: 'orca lane wipe --person <idOrName> --force [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'person', 'force'],
    notes: [
      PERSON_NOTE,
      "--force is required: this ends a latch a wipe left in place because it could not confirm the lane's credential was gone, and a credential may still be at rest until the next logout, revoke, or deprovision sweeps it.",
      'Refuses if the lane was not latched wipe-pending — there is nothing to release.'
    ],
    examples: ['orca lane wipe --person "Ana Ng" --force']
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
