// S10-21b B12b (design §7): split out of agents-pact.ts per the max-lines ratchet — the CLI-flip
// additions that stand alone as pure parse/format logic: `--with name@host`'s stricter selector
// parse, and the (parse-and-pass-through-only, commit 14 implements the purge)
// `--purge-peer-ledger` verb.
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeClient } from '../runtime-client'

export type PactWithSelector = { name: string; host?: string }

// S10-21b B12b (design §7, "--with/PactParams.host, unchanged from v2"): `pact --with` is the
// ONE `name@host` selector this slice flips (`invite --agent` stays host-local, unchanged in
// agents-pact.ts). Deliberately its OWN, stricter parse than agents-shared.ts's
// parseAgentSelector: that helper silently downgrades a malformed selector (a bare leading/
// trailing `@`) to a LOCAL lookup — right for `show`/`ask`, but would misresolve a butchered
// `--with` as a bogus local display name instead of the typed refusal TESTS item 1 wants.
export function parsePactWithSelector(value: string): PactWithSelector {
  const at = value.lastIndexOf('@')
  if (at === -1) {
    return { name: value }
  }
  const name = value.slice(0, at)
  const host = value.slice(at + 1)
  if (name.length === 0 || host.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Malformed name@host selector: "${value}" — expected <name>@<host> with both parts present.`
    )
  }
  return { name, host }
}

function nextStepLines(nextSteps: readonly string[]): string {
  return nextSteps.map((step) => `Next: ${step}`).join('\n')
}

// S10-21b B12b (design §7, §4.6(b)): `orca agents pact --purge-peer-ledger --link <id>
// [--force-released]` — parse and pass through only (commit 14 implements the purge). This
// result shape is this commit's own contract for what that RPC returns, so the CLI has
// something concrete to render meanwhile.
export type PurgePeerLedgerResult = { purged: number; nextSteps: string[] }

function formatPurgePeerLedger(r: PurgePeerLedgerResult, linkId: string): string {
  const steps = nextStepLines(r.nextSteps)
  return `Purged ${r.purged} row(s) on link ${linkId}.${steps ? `\n${steps}` : ''}`
}

export async function runPurgePeerLedger(
  flags: Map<string, string | boolean>,
  client: RuntimeClient,
  json: boolean
): Promise<void> {
  const linkId = getOptionalStringFlag(flags, 'link')
  if (!linkId) {
    throw new RuntimeClientError('invalid_argument', 'Missing --link <id> for --purge-peer-ledger.')
  }
  const result = await client.call<PurgePeerLedgerResult>('orchestration.threads.purgePeerLedger', {
    linkId,
    forceReleased: flags.has('force-released') ? true : undefined
  })
  printResult(result, json, (r) => formatPurgePeerLedger(r, linkId))
}
