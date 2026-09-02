import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--pairing-address <host>] [--pair-name <name>]… [--pairing-profile peer|full]… [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'pairing-address',
      'pair-name',
      'pairing-profile',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'Repeat --pair-name once per person: each occurrence prints its own pairing link bound to a separate revocable grant, so two people never share one identity. Without it a single unnamed link is printed, as before.',
      'S10-19 W-6: --pairing-profile is REQUIRED alongside each --pair-name, matched positionally (one per name), and refused beside --mobile-pairing (a federation-peer grant is runtime-scoped only). Without a spec entry the flag cannot be typed at all (ops MJ-1).',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing',
      'orca serve --pairing-address 100.64.1.20 --pair-name Ana --pairing-profile full --pair-name Ben --pairing-profile peer'
    ]
  }
]
