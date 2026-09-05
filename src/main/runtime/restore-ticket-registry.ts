// Why: INV-P-021 (design v3.2 §2.2, §2.1d) — restore provenance must be minted only in-process,
// never carried on any wire. This registry is that mint/redeem point. Its module boundary (no
// import under src/main/runtime/rpc/**, src/main/ipc/**, src/relay/**, or src/renderer/**) is what
// makes "in-process only" a structural fact rather than a convention — see
// restore-ticket-registry-import-boundary.test.ts.
//
// Scope note (S10-21a C2): this file provides the branded id and the mint/redeem registry ONLY.
// The sweep that mints tickets from `agent_launch_sessions` rows is C7; the pane-key gate that
// requires a redeemed ticket before adopting a registered row's pane key is C3a. Neither is
// written here.
import { randomUUID } from 'node:crypto'

// Why 120s: design v3.2 §2.2 — long enough to cover the sweep's own mint-to-redeem window
// (createTerminal's synchronous adoption happens within the same startup pass), short enough that
// a ticket cannot outlive the restart it was minted for.
export const RESTORE_TICKET_TTL_MS = 120_000

// Why branded rather than a bare string: a caller (or a forged wire payload, were one ever
// accepted, which INV-P-021 forbids) must not be able to hand back an arbitrary string and have it
// treated as a ticket. Only `mint` below can produce a value of this type; `redeem` and `peek`
// reject anything else via the 'unknown' reason, per T (ids are unforgeable).
declare const RESTORE_TICKET_ID_BRAND: unique symbol
export type RestoreTicketId = string & { readonly [RESTORE_TICKET_ID_BRAND]: true }

// Why these fields only: the payload is exactly what the sweep (C7) needs to identify the row it
// minted the ticket from, and what the pane-key gate / rebind (C3a, C5) need to redeem it against
// the pane the ticket was minted for. Nothing wire-shaped (no providerSession, no raw hook data)
// is carried — see design v3.2 §2.2 "What changed from v2".
export type RestoreTicketPayload = {
  readonly predecessorPaneKey: string
  readonly sessionId: string
  readonly executionHostId: string
  readonly launchGeneration: string
  readonly launchSeq?: number
}

export type RestoreTicketMintArgs = RestoreTicketPayload

export type RestoreTicketRedeemResult =
  | { readonly ok: true; readonly payload: RestoreTicketPayload }
  | { readonly ok: false; readonly reason: 'unknown' | 'already_redeemed' | 'expired' }

type RestoreTicketEntry = {
  readonly payload: RestoreTicketPayload
  readonly mintedAt: number
  redeemedAt: number | null
}

export type RestoreTicketRegistryOptions = {
  // Why injectable: TTL and idempotence tests (T13, expiry-under-fake-timers) must drive the same
  // clock the registry stamps with, matching the codebase's existing clock-injection convention
  // (terminal-presence-registry.ts).
  now?: () => number
}

// Why in-memory Map only, no serialisation: a ticket that could be written to disk or sent over
// any channel would no longer be "minted only by the host's own restore module" (INV-P-021(b)) —
// it would be a value some other process or a future version of this one could replay. The registry
// is deliberately unable to export anything but the branded id (from mint) and the payload (from a
// successful redeem).
export class RestoreTicketRegistry {
  private readonly clock: () => number
  private readonly tickets = new Map<RestoreTicketId, RestoreTicketEntry>()

  constructor(options: RestoreTicketRegistryOptions = {}) {
    this.clock = options.now ?? ((): number => Date.now())
  }

  mint(args: RestoreTicketMintArgs): RestoreTicketId {
    this.sweepExpired()
    const id = randomUUID() as RestoreTicketId
    this.tickets.set(id, {
      payload: { ...args },
      mintedAt: this.clock(),
      redeemedAt: null
    })
    return id
  }

  // Why single-use: a ticket that could be redeemed twice could rebind two panes onto one
  // predecessor identity from a single mint. Redemption is idempotent in its FAILURE mode only —
  // a second redeem never re-returns the payload, it returns 'already_redeemed' (T13).
  redeem(id: RestoreTicketId): RestoreTicketRedeemResult {
    const entry = this.tickets.get(id)
    if (!entry) {
      return { ok: false, reason: 'unknown' }
    }
    if (entry.redeemedAt !== null) {
      return { ok: false, reason: 'already_redeemed' }
    }
    if (this.clock() - entry.mintedAt > RESTORE_TICKET_TTL_MS) {
      return { ok: false, reason: 'expired' }
    }
    entry.redeemedAt = this.clock()
    return { ok: true, payload: entry.payload }
  }

  // Why exposed: tests need to assert a ticket's state (minted, redeemed, expired) without
  // consuming it — peek never marks a ticket redeemed and never counts against single-use.
  peek(id: RestoreTicketId): RestoreTicketRedeemResult {
    const entry = this.tickets.get(id)
    if (!entry) {
      return { ok: false, reason: 'unknown' }
    }
    if (entry.redeemedAt !== null) {
      return { ok: false, reason: 'already_redeemed' }
    }
    if (this.clock() - entry.mintedAt > RESTORE_TICKET_TTL_MS) {
      return { ok: false, reason: 'expired' }
    }
    return { ok: true, payload: entry.payload }
  }

  // [S10-21a C8, errata 5(p) v2.1 §C.5, design v3.2 §2.8] Read-only mint-ordering check: true
  // while an unredeemed, unexpired ticket names `paneKey` as its predecessor — directory
  // derivation defers minting a placeholder for such a pane rather than racing the sweep's own
  // redeem. Never consumes (like `peek`), and needs no ticket id (unlike `peek`/`redeem`).
  hasLiveTicketForPane(paneKey: string): boolean {
    const now = this.clock()
    for (const entry of this.tickets.values()) {
      if (
        entry.redeemedAt === null &&
        now - entry.mintedAt <= RESTORE_TICKET_TTL_MS &&
        entry.payload.predecessorPaneKey === paneKey
      ) {
        return true
      }
    }
    return false
  }

  // Why opportunistic rather than a timer: this registry has no background interval (nothing here
  // should run when no sweep is minting), so expired/redeemed entries are dropped on the next mint
  // instead. Bounded by the sweep's own cadence (one sweep per startup), not by wall-clock idleness.
  private sweepExpired(): void {
    const now = this.clock()
    for (const [id, entry] of this.tickets) {
      if (entry.redeemedAt !== null || now - entry.mintedAt > RESTORE_TICKET_TTL_MS) {
        this.tickets.delete(id)
      }
    }
  }
}
