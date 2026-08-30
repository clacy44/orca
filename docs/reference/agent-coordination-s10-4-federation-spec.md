# S10-4 — Federation: cross-host directory, threads, wake-ups, propagation (implementation spec, rev 1 — 2026-08-30)

Tree of record **[base]** `/home/ubuntu/orca-integration` @ `2de4f5894e` (`SCHEMA_VERSION = 31`, db.ts:309); every cite is [base] and re-verified. Binding: S10 design §2 and §6; S10-1 (`agents` v33, A1 attested identity, B2 never write `delivered_at` from a read path, `display_name` unique per host); S10-2 (threads v34, `insertGatedMessage` choke, sensitive latch, purge/quarantine, receipts). Synthesized from two Opus framings (affordance vs trust/poison), each refuted by the other, then arbitrated by the chair.

**Version: v36, and read `SCHEMA_VERSION` at land time.** S10-2 takes 34; the S10-3 pact spec already claims 35 (`s10-3-pact-spec:17-19`). S10-4 is **36**, or the next free number if the chain re-cuts. Writing a version twice leaves `user_version` claiming a schema the DB does not have — S10-2's own correction, restated.

**Hard dependency.** `sanitizeMessageText`, `insertGatedMessage`, `threads`, `message-body-gate.ts` do **not** exist in [base] (`grep -rl` returns nothing). They are S10-2a deliverables. S10-4 does not land before S10-2a; every cite to them below is a cite to that spec, not to code.

**The owner's failure, mechanically.** Two Windows desktops and one VPS that cannot address each other by role. The desktop read *terminal titles* through `environment roster`, because that is the only cross-host view that exists (`environment-terminal-roster.ts:165` derives `agent` from a title via `getAgentLabel`, imported at `:1` from `shared/terminal-title-agent-type`). It prompt-injected a pane, so the reply had no route home. It sent mail that woke nothing, because `resolveMailboxTerminalHandle` resolves `run:` and `dispatch:` only (`orca-runtime.ts:33473-33497`). Then `dispatch --inject` refused: `runtime.isTerminalRunningAgent(to)` is a **local** call (`orca-runtime.ts:33299`), so a handle on a saved environment can never be detected — *"no recognized agent detected"* (`rpc/methods/orchestration.ts:1459-1466`). Every one is an addressing failure. **The transport is already built** (`callOrchestrationWorkerServer`, `orca-runtime.ts:4959`; durable queue + pump, db.ts:527-541 / `orca-runtime.ts:5068`, `:5080`; remote-side local push on receipt, `rpc/methods/orchestration-federation-relay.ts:198-205`). S10-4 adds a lane and an address, not a protocol.

## ARBITRATION (which lens won, and why) — every cite re-verified in [base]

| # | Blocker | Winner | Ruling |
|---|---|---|---|
|1|AFF relays `messages.sequence` and makes it the shared thread cursor|**TRUST**|CONFIRMED: `sequence INTEGER PRIMARY KEY AUTOINCREMENT` (db.ts:377) — a relayed sequence lets a peer choose a local rowid. New `messages.thread_sequence`, assigned locally per thread; the wire field is `threadSequence` and is never written to `sequence`. `--since` (S10-2 T9) names the new column.|
|2|No relayed identity field is bound to the authenticated peer|**TRUST**, chair-corrected|CONFIRMED: `parseFederatedControlMessage` accepts any `from` string unsanitized (federation-control-message.ts:31-49); only `priority` is coerced. Receiver **overwrites** every `*_runtime_id`/host field from the lane. **Correction:** `authenticatedCallerFingerprint` falls back to the literal `'authenticated_transport'` when no token is present (orchestration-mutation-executor.ts:128-133), so it alone merges every tokenless caller into one identity. A link binds to `fingerprintOrchestrationPeer(publicKeyB64)` (environment-transport.ts:24) **and** refuses the fallback constant.|
|3|AFF gates outbound only; the inbound path is ungated today|**TRUST**|CONFIRMED and worse: `importFederatedRelayItem` calls raw `this.insertMessage` (db.ts:5522) and its conflict compare checks only `run_id`/`to_handle`/`type` (db.ts:5525-5531) — strictly weaker than `importFederatedControlMessage`'s full-field compare (federation-control-message.ts:63-78). Inbound goes through the S10-2 choke with the full compare; pointer text is built only from locally-held rows.|
|4|Register paired callers into `agents` with `origin_kind='paired_runtime'`|**TRUST**|Mirrored rows live in a separate `remote_agents` table; `agents` gains `CHECK(origin_kind IN ('pane','derived'))`. This **corrects** S10-1 RISKS (`s10-1-spec:180`): one forgotten `WHERE origin_kind <> 'paired_runtime'` on `find`/`agent:` routing/`resolveMailboxTerminalHandle`/`idx_agents_name` is a foreign row woken as local or squatting a local name. An extra additive table, paid gladly. AFF's `agents.host_runtime_id` is dropped.|
|5|AFF §7 remote push vs TRUST's unconsented-pane-write objection|**AFF, gated**|The core principle is right and is the whole slice: **the sender never touches the remote pane; the remote runtime pushes into its own pane on relay receipt** — exactly what `orchestration-federation-relay.ts:198-205` already does for a dispatch. No agent detection, no handle crossing a host boundary. TRUST's H4 is upheld as a fence, not a veto: a peer may wake only a local agent that participates in a thread on the lane, plus a per-link inbound rate limit.|
|6|TRUST refuses a HARD inbound with strict contiguity and no cursor rule|**AFF (F2)**|Sharpest hole in either draft. `item.sequence !== cursor + 1` throws (federation-sync.ts:95-98). A refusal that does not advance the cursor kills the link permanently at item N. **A refusal advances the cursor and writes `relay_seen(outcome='refused')` in the same transaction.**|
|7|Receiver re-runs h3 (local infra allowlist) on import; the only unblock verb is on the headless VPS|**AFF (F3), chair ruling**|**h3 does not run on the import path.** h3 exists to stop *this host's* infra literals from leaving the box; running it inbound inverts its purpose and wedges the dominant desktop→VPS traffic (VPS remediation text naming VPS paths). Inbound HARD = h1 + h2 only. `--acknowledge-gate` still never crosses (TRUST): the sender's remedy for a secret-shaped value or an audit heading is to rewrite, which is the correct remedy for exactly those two.|
|8|TRUST refuses `sequence_rewind` on a peer reinstall, with no resync|**AFF (F5)**|The tree already tolerates this: `federation-sync.ts:141-143` zeroes the acked cursor when `remote_runtime_epoch` changes. Keep it; `relay_seen` survives the epoch so a replayed id is still caught. Refuse a rewind **within** an epoch only, and ship `orca agents relink --env <e>` as the named reconciliation verb.|
|9|TRUST's `containment_pending` freezes a thread with no release; re-keys the relay quota as per-minute|**AFF (F4)**|`--abandon-pending-containment` clears the per-thread `containment_pending`, not only the link row. And the correction: db.ts:5211-5218 is a **standing-backlog cap** (count ≥ 256 or bytes > 1 MiB *unacked*), not a rate — an unreachable link accretes until it trips and then all relay on that link fails. Per-link **rates** are new and separate.|
|10|AFF trusts peer-asserted `confidence`; TRUST reads a 30s directory mirror|**SPLIT**|AFF wins freshness — the premise of the slice is that discovery failed, and a 30s mirror is staler than today's live bounded probe (`environment-terminal-roster.ts:71-86`, `:112-122`, 10s timeout `:4`). TRUST wins trust — foreign rows are **re-scored locally** with the shared S10-1 module, capped in rows and bytes per host, and a foreign single winner never emits `resolved` on a peer-supplied score.|
|11|`resolved` requires every host to answer|**TRUST's L11 (AFF concedes)**|A silent peer must not veto local resolution. `resolved` is allowed among answered hosts **with** `unreached[]` and `hostsAnswered: n/m` printed. A partial union that reads as a clean answer is the same lie as `Sent` on an undelivered message (design §1 BUG 3).|
|12|Scope honesty: one usable edge, Dispatch exempt, version gate, `--inject` still refuses|**AFF (F1/F8/F9/F10)**|All four are true and all four are **printed, not buried**: two NATed desktops cannot pair at all (`endpoints` min 1, runtime-environments.ts:34), so the owner's fleet has one usable edge today; Dispatch federation stays unchanged and purge cannot recall what crossed it; a peer lacking the capability gets no agent relay; and `dispatch --inject` to a foreign agent still refuses (orchestration.ts:1459-1466) — say so with the workaround.|
|13|Purge/quarantine/withhold propagation authority|**TRUST (H5/H6), scoped**|A relayed tombstone applies **only** to rows whose `origin_link_id` = the lane and whose thread the lane peer owns; never to local-origin rows; one audit row each. Withheld ids intersect with lane-origin rows, the rest refused and counted. `remote_quarantined` and `local_quarantined` are independent columns — a relayed lift clears only the first.|

## SCHEMA — v36, additive only

DDL verbatim in `createTables()` **and** under `if (current < 36)` beside the prior block, inside the existing `BEGIN IMMEDIATE` txn that bumps `user_version` only on success (db.ts:657, :1062). Ids from `generateId` (db.ts:141), never caller-supplied. 0700/0600 store inherited (db.ts:311).

```sql
CREATE TABLE IF NOT EXISTS agent_links (          -- explicit, audited, revocable. Pairing != a link.
  link_id TEXT PRIMARY KEY,                      -- generateId('lnk')
  environment_id TEXT NOT NULL UNIQUE,           -- receiver-local KnownRuntimeEnvironment.id
  env_name TEXT NOT NULL,                        -- asker-local alias; provenance for printing only
  peer_fingerprint TEXT NOT NULL,                -- fingerprintOrchestrationPeer(publicKeyB64), environment-transport.ts:24
  peer_runtime_id TEXT,                          -- learned once, then pinned; drift => link_peer_changed
  remote_runtime_epoch TEXT,                     -- same semantics as db.ts:488
  out_sequence INTEGER NOT NULL DEFAULT 0, in_imported_sequence INTEGER NOT NULL DEFAULT 0,
  in_acked_sequence INTEGER NOT NULL DEFAULT 0,
  capability_directory INTEGER NOT NULL DEFAULT 0, capability_threads INTEGER NOT NULL DEFAULT 0,
  capability_containment INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, last_contact_at TEXT, last_error_code TEXT,
  containment_state TEXT NOT NULL DEFAULT 'ok' CHECK(containment_state IN ('ok','unreachable','abandoned')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS remote_agents (       -- mirrored claims. NEVER a row in `agents`.
  link_id TEXT NOT NULL, remote_agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT, state TEXT, derived INTEGER NOT NULL DEFAULT 0,
  remote_quarantined INTEGER NOT NULL DEFAULT 0,   -- asserted by the origin host
  local_quarantined INTEGER NOT NULL DEFAULT 0,    -- this host's own defensive act; a remote lift never clears it
  quarantine_reason_code TEXT, last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(link_id, remote_agent_id));

CREATE TABLE IF NOT EXISTS agent_relay_items (   -- shape of federation_relay_items (db.ts:527-541), re-keyed off link_id
  link_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('out','in')),
  sequence INTEGER NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, byte_count INTEGER NOT NULL, thread_id TEXT, acked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(link_id, direction, sequence), UNIQUE(link_id, direction, item_id));
CREATE INDEX IF NOT EXISTS idx_agent_relay_pending
  ON agent_relay_items(link_id, direction, acked_at, sequence);

CREATE TABLE IF NOT EXISTS relay_seen (          -- the one genuinely new mechanism (see RELAY §idempotency)
  link_id TEXT NOT NULL, item_id TEXT NOT NULL, content_sha256 TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('imported','refused','purged','duplicate')),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(link_id, item_id));

CREATE TABLE IF NOT EXISTS message_receipts (    -- ids + enums + times. NEVER a body.
  message_id TEXT NOT NULL, recipient_key TEXT NOT NULL, link_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','relayed','pointed','read')),
  claimed INTEGER NOT NULL DEFAULT 0,            -- 1 = asserted by a peer, not observed here
  at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(message_id, recipient_key));
CREATE TRIGGER trg_receipt_monotone BEFORE UPDATE ON message_receipts
  WHEN (CASE NEW.state WHEN 'queued' THEN 0 WHEN 'relayed' THEN 1 WHEN 'pointed' THEN 2 ELSE 3 END)
     < (CASE OLD.state WHEN 'queued' THEN 0 WHEN 'relayed' THEN 1 WHEN 'pointed' THEN 2 ELSE 3 END)
  BEGIN SELECT RAISE(ABORT,'receipt states never regress'); END;

ALTER TABLE messages ADD COLUMN thread_sequence INTEGER;   -- ruling 1; NEVER messages.sequence
ALTER TABLE messages ADD COLUMN origin_link_id TEXT;       -- NULL = local-origin; set from the lane, never the payload
ALTER TABLE messages ADD COLUMN sender_remote_agent_id TEXT; -- imported rows NEVER write sender_agent_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_thread_sequence
  ON messages(thread_id, thread_sequence) WHERE thread_sequence IS NOT NULL;
ALTER TABLE threads ADD COLUMN owner_link_id TEXT;         -- NULL = owned here; else the lane that owns sequencing
ALTER TABLE threads ADD COLUMN containment_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thread_participants ADD COLUMN link_id TEXT;   -- NULL = local participant
ALTER TABLE thread_participants ADD COLUMN remote_agent_id TEXT;
ALTER TABLE thread_participants ADD COLUMN env_name_at_join TEXT;  -- provenance only, never an address
ALTER TABLE agents ADD CHECK(origin_kind IN ('pane','derived'));   -- ruling 4; table rebuild NOT permitted, see below
```

The `agents` CHECK cannot be added by `ALTER` in SQLite and a `messages`/`agents` rebuild is forbidden (S10-1 test M3). Ship it as `trg_agents_no_foreign_origin` `BEFORE INSERT OR UPDATE ON agents WHEN NEW.origin_kind NOT IN ('pane','derived') → RAISE(ABORT,'foreign agents live in remote_agents')`. Plus `trg_remote_lift_scope` `BEFORE UPDATE ON remote_agents WHEN OLD.local_quarantined=1 AND NEW.local_quarantined=0 AND NEW.remote_quarantined<>OLD.remote_quarantined → RAISE(ABORT,'a remote lift cannot clear a local quarantine')` — written so a legitimate local lift (`remote_quarantined` unchanged) still passes, which the trust draft's version did not.

`environment add --name local|<name containing : or @>` is refused: `local` is the reserved self-name (`environment-terminal-roster.ts:3`) and `@`/`:` are reserved by S10-1 CONTAINMENT §4.

New `OrchestrationDb` methods: `createAgentLink`, `getLinkByFingerprint`, `getLinkByEnvironment`, `listAgentLinks`, `setLinkContainmentState`, `upsertRemoteAgent`, `listRemoteAgents`, `setRemoteQuarantine`, `enqueueAgentRelay`, `listPendingAgentRelay`, `acknowledgeAgentRelay`, `importAgentRelayItem`, `recordRelaySeen`, `nextThreadSequence`, `upsertMessageReceipt`.

## RELAY — what crosses, what never does, and what happens when it fails

**Relayed**, all through an extended `encodeFederatedControlMessage` shape (federation-control-message.ts:7-15):
1. **Message rows** — `{itemId, threadId, threadSequence, subject, body, type, priority, sentAt, gateFlags, fromRemoteAgentId, fromDisplayName, toAgentId}`.
2. **Thread rows** — `{id, subject, origin, state, ownerClaim, participants:[{remoteAgentId,name}], lastThreadSequence, pact}`. Subjects only.
3. **Receipts** — `{itemId, messageId, recipientKey, state, at}`.
4. **Containment items** — `tombstone`, `quarantine`, `withhold`, `withhold-lift`, `rejected`.

**Never relayed:** `messages.payload` (dropped from the peer encode entirely — a blob crossing hosts is the one thing purge cannot recall); any HARD-gated body (the gate runs **before** `encodeFederatedControlMessage`, orchestration.ts:628-632 and :1230-1234 in [base], `:640`/`:1252` in the S10-2 tree — outbound bytes cannot be recalled); sensitive-thread bodies **and subjects**; `pane_key`, `terminal_handle`, `process_incarnation`, launch tokens, endpoints, device tokens (host-local cache, useless to a peer, and precisely the identity-takeover primitive S10-1 A1 removed); `purge --reason` free text (an enum `reasonCode` only — shipping the text makes purge a message channel); `agent_audit`, `gate_refusals`, `agent_rate`.

**Origin binding is receiver-computed (ruling 2).** On every inbound call: `link = db.getLinkByFingerprint(fingerprint)` where the fingerprint comes from the authenticated socket and is refused when it equals the `'authenticated_transport'` fallback (`unauthenticated_lane`). Every `*_runtime_id`/host field in the payload is **compared and discarded**: a mismatch is `origin_host_mismatch` + audit; the stored value and every printed host tag come from `link.env_name`. A payload naming this host's runtime id, or a third host, is refused.

**Idempotency and replay.** PK `(link_id, direction, sequence)` + UNIQUE `(link_id, direction, item_id)`. An id may be re-sent only byte-identically — the full-field compare of `importFederatedControlMessage` (federation-control-message.ts:63-78), **not** `importFederatedRelayItem`'s three-field compare (db.ts:5525-5531). A changed body under a reused id is a poison-rewrite primitive: `request_mismatch`, never last-write-wins. `relay_seen` is load-bearing because after an ack and a purge the row is gone and the same id would re-import clean: a replayed acked/purged/refused id → `duplicate_or_purged`, no insert, one audit row. Retention ≥ 30 days, evicted by `orca agents relay-gc` and on link delete (RISK 6).

**Contiguity and the head-of-line rule (ruling 6).** Contiguity is enforced exactly as `federation-sync.ts:95-98` does. **A refusal — gate HARD, `origin_host_mismatch`, `not_a_participant`, quota — advances `in_imported_sequence` and writes `relay_seen(outcome='refused')` in the same transaction**, and enqueues a `rejected` item back carrying `{itemId, ruleIds, verdict}` — rule ids only, never matched text, because a refusal that quotes the literal republishes it into the sender's transcript. Without this rule one false-positive HARD silences the link forever.

**Gates (ruling 7).** Outbound: the full S10-2 tier set at `db.insertGatedMessage` and again before the peer encode. Inbound: the receiver re-runs **h1 (audit/vuln heading shape) and h2 (secret-shaped value) only**. **h3, the local 0600 infra allowlist, does not run on import** — it exists to stop this host's literals from leaving, and running it inbound both inverts its purpose and wedges the dominant traffic (remediation text naming the receiver's own paths). SOFT flags union; soft never blocks on either side (~75% measured false positives, S10-2). `--acknowledge-gate` does not cross: it relays as a `gate_flags` entry the receiver records and ignores.

**Failure modes.** Backoff is the existing doubling curve 1s→60s (`federation-sync-health.ts:3-4`); past `FEDERATION_RELAY_UNREACHABLE_MIN_OUTAGE_MS` (`:9`, two max intervals) the link flips `containment_state='unreachable'` and posts the existing runtime notice (`federation-relay-health.ts:18-48`). **Quota correction (ruling 9):** db.ts:5211-5218 is a standing-backlog cap on *unacked* items (count ≥ 256 or bytes > 1 MiB), not a rate; `agent_relay_items` reuses that shape with the same 64 KiB per item (db.ts:5148-5153), so an unreachable link accretes until it trips and then all relay on that link fails — stated in RISKS, surfaced in `orca agents links`. Per-link **rates** are separate and new: inbound directory serve 30/min, inbound import 120 items/min and 1 MiB/min, outbound directory probe 1/10s, all through S10-1's `agent_rate` with `subject_key = 'link:'+link_id` so a noisy peer exhausts only its own budget. Exceeding any → `rate_limited` + `retryAfterMs`, never a partial result.

**Epoch (ruling 8).** Keep the tree's tolerance: on `remote_runtime_epoch` change the acked cursor zeroes (federation-sync.ts:141-143) and replay is automatic and ordered. A rewind **within** an epoch is `sequence_rewind`. `orca agents relink --env <e>` is the named recovery for a reimaged peer: new `link_id`, `relay_seen` preserved under the old link for 30 days, threads re-pointed by `owner_link_id`.

## RPCS

New module `src/main/runtime/rpc/methods/orchestration-federated-agents.ts`, spread into `ORCHESTRATION_METHODS` (orchestration.ts:421) as `ORCHESTRATION_RUN_METHODS` is (:31); each built with `defineMethod` (rpc/core.ts:125). Adding methods needs no protocol bump. Declare `ORCHESTRATION_FEDERATED_AGENTS_RUNTIME_CAPABILITY = 'orchestration.federated-agents.v1'` beside protocol-version.ts:32-38.

- `orchestration.federatedAgents.serve {query?, limit?}` → `{runtimeId, agents:[{remoteAgentId, name, role, state, derived}], capped}`. Answers **only about agents on this host**, from `agents` where `origin_kind IN ('pane','derived')` and not quarantined. No thread data, no bodies, ever. Row cap 200, byte cap 64 KiB, both counted in `capped`, never silently truncated.
- `orchestration.federatedAgents.deliver {items[], sequenceFrom}` → `{acknowledgedThrough, results[]}`. The import path: link lookup → origin binding → inbound gate → `db.insertGatedMessage` → `nextThreadSequence` → `notifyMessageArrived('agent:'+localAgentId, type)`. Returns per-item `imported|refused|duplicate` with rule ids on a refusal.
- `orchestration.federatedAgents.pull {afterSequence}` / `.ack {through}` — mirror `orchestration.federationPull` / `.federationAck` (orchestration-federation-relay.ts:60-100) for the inbound half.
- `orchestration.federatedAgents.link {environmentId}` / `.unlink {linkId, abandonPendingContainment?}` / `.links {}` — the explicit consent step. **Pairing does not enroll a host in agent federation**; pairing already grants terminal-drive rights, but not consent to a relationship whose contents are typed into this host's panes.
- `orchestration.federatedAgents.relayReview {linkId, list?|allow itemId}` — local, non-federated caller only (`pairedDeviceId == null` and local `clientKind`, the ctx fields send reads at orchestration.ts:432-434). Admits one held inbound item.
- Extended: `orchestration.agents.find`/`.list` gain `allHosts?`, `host?`, `timeoutMs?`; `orchestration.threads.*` gain remote participants (§CONTAINMENT).

Every method resolves the local caller through `runtime.verifyOrchestrationCompatibilityCaller(evidence, {currentRuntimeLaunchSufficient:true})` (orca-runtime.ts:12982) — S10-1 A1, binding. `serve`/`deliver`/`pull`/`ack` additionally resolve the **lane** by fingerprint and are refused without one.

## CLI

`orca agents link --env <selector>` → `Linked Private VPS (runtime rt_9a…, capabilities: directory, threads, containment). Foreign agents now appear in: orca agents list --all-hosts`
`orca agents links` → per link: `Private VPS  ok  last contact 3s ago  queued 0  directory+threads+containment` / `desktop  UNREACHABLE 4m  queued 12 (backlog cap 256)  relink: orca agents relink --env desktop`
`orca agents list --all-hosts [--host <env>] [--timeout-ms 10000] [--json]` and `orca agents find --all-hosts "<plain english>"`.

The union generalizes `collectEnvironmentTerminalRoster` (`environment-terminal-roster.ts:71-86`) into `collectDirectoryUnion(probes)` — same never-reject `Promise.all` (`:78`), same per-probe timeout with `timer.unref` (`:112-122`), same tri-state `ok|unreachable|capability-missing` (`:14`, `:124-127`). Probes call `federatedAgents.serve`; a peer without the capability answers `method_not_found` and lands in the existing `capability-missing` bucket (`:6-12`) rather than failing the union. **Scoring is re-run locally** on returned fields with the one shared module (S10-1 `shared/agent-directory-scoring.ts`, `THRESHOLD 0.45` / `MARGIN 0.15`, pinned by S10-1 test S6) times a link-freshness multiplier; a peer-supplied `confidence` is ignored (ruling 10). Outcomes are S10-1's three, unchanged: `resolved` / `ambiguous` (never auto-addresses — owner decision 2) / `no_match`.

Honesty line, printed on every union result with a non-empty `unreached` (ruling 11):
`2 of 3 hosts answered; desktop did not (no response within 10000ms) — this answer may be incomplete.`
Old host: `Private VPS: no agent directory (older Orca) — 4 terminals visible by title only, not addressable. Update that host, or reach it with orca dispatch.`
Ambiguity across hosts: `2 candidates: merge-restructure-backend@local, merge-restructure-backend@Private VPS. Pick one: orca agents ask merge-restructure-backend@Private-VPS "…"`
Per-candidate JSON: `{agentId, name, host, foreign, role, state, pushable, derived, confidence, why, address}` where `address` is the copy-pasteable `agent:<id>@<env>`. **No message content, ever** (§6).

`orca agents ask|send|reply|threads|thread|wait` take `name@env` and `agent:<id>@<env>` wherever they take a local name today. A send to a foreign agent prints `queued` and then, on the pump's ack, `relayed`; it prints `pointed` only when the peer's receipt arrives. `orca agents purge` prints one line per host:
`local: purged · Private VPS: relayed (acked 0.3s) · desktop: PENDING — unreachable 4m; the copy on desktop stays readable there until it reconnects.`
`orca dispatch --inject` to a foreign agent still refuses (orchestration.ts:1459-1466); the CLI now says why and what to do: `dispatch --inject is local-only: a foreign agent has no pane on this host. Use orca agents ask <name>@<env> to reach it, or orca dispatch worker-start over Dispatch federation to assign it work.`

## WAKE — the piece the owner lacks

**The sender never touches the remote pane. The remote runtime pushes into its own pane on relay receipt.** That is why this works where `dispatch --inject` cannot.

1. Sender resolves `agent:<id>@<env>` → `link_id`; `enqueueAgentRelay`; writes `message_receipts(state='queued', claimed=0)`; returns immediately. CLI prints `queued`.
2. The pump — armed by `ensureOrchestrationFederationRelay` (`orca-runtime.ts:5068`) and rearmed at boot by `resumeOrchestrationFederationRelayAfterRestart` (`:5080`, called from `main/index.ts`) — calls `federatedAgents.deliver` via `callOrchestrationWorkerServer(environmentId, …)` (`:4959`, resolver `:4949`), the same transport `syncFederatedDispatch` uses (federation-sync.ts:77, :148, :179).
3. The remote runtime does what `orchestration-federation-relay.ts:198-205` already does for a dispatch: import through the S10-2 choke `db.insertGatedMessage` (**never** raw `insertMessage`, db.ts:5522), resolve `toAgentId` in its **own** `agents` table, assign `thread_sequence` locally, then call `runtime.notifyMessageArrived('agent:'+toAgentId, type)` (`orca-runtime.ts:33574`). Returns `acknowledgedThrough` → sender records `relayed`.
4. Local push on the remote host: `notifyMessageArrived` → `queueMicrotask` → `deliverPendingMessagesForHandle('agent:<id>')` (`:33516`, `:33608`) → the S10-1d `agent:` branch of `resolveMailboxTerminalHandle` (`:33473`) → `getTerminalHandleForPaneKey` (`:33193`) → the S10-2 bounded pointer, typed only under `leaf.lastAgentStatus === 'idle' && leaf.lastAgentStatusObservedLive` (`:33532`).
5. **The pointer names the sender's host, and every byte of it is built from locally-held rows** (ruling 3): local agent id, local thread id, the lane's `env_name`, and the subject only after `sanitizeMessageText` + hard truncation. `[from: fable@desktop] "lock-step: schema freeze" thread:thr_9fk2` / `Answer: orca agents reply --thread thr_9fk2 --body "…"`. Without the host tag a cross-host wake is indistinguishable from a local one and the reply routes into the wrong lane.
6. Not idle → nothing is typed, the row stays undelivered, and `getUndeliveredUnreadMailboxHandles` (db.ts:3611 — note it filters `delivery_contract = 'current_delivery'`, so imported rows must carry that contract) plus `scheduleRestoredMessageRepoints` (`orca-runtime.ts:33540-33549`) repoint it later, **including across a restart of the remote runtime**. This works only because no read path writes `delivered_at` (S10-1 B2).
7. A receipt returns on the inbound lane: `pointed` when the remote typed it, `read` when the recipient acked. Both arrive with `claimed=1` — a peer can lie, and the CLI says so: `relayed · peer reports pointed 0.4s ago`. Until a receipt arrives the sender prints `relayed`, never `pointed`.
8. `orca agents wait --thread <t>` is unchanged: a cross-host reply arrives as an ordinary local message on the waiter's own runtime and `notifyMessageArrived`'s reservation logic (`:33589-33608`) hands it to the parked waiter instead of pushing the pane (S10-2 §WAIT/ASK).

## TRUST BOUNDARY

**What the transport proves is one bit:** this socket is the runtime whose public key was saved — `pairedDeviceId` + `clientKind === 'runtime'` (orchestration-remote-run-mailbox.ts:39-48), keyed to `fingerprintOrchestrationPeer(publicKeyB64)` (environment-transport.ts:24). Which agent, which pane, which role, which incarnation: all peer self-report, unverifiable here, forever.

**What a linked runtime may assert:** exactly one class of claim — the agents that exist on itself, `{remoteAgentId, displayName, role, state, derived}`, in its own namespace. Never anything about agents on this host or a third host. Never a pane, handle, incarnation, token, or a local `agents.id`.

**Invariants.** A mirrored row is never `pushable`, never a dispatch assignee, never has a `pane_key`, and can never be the attested caller of anything — attestation comes only from `verifyOrchestrationCompatibilityCaller` (orca-runtime.ts:12982), which is pane-bound and local. An imported message never writes `messages.sender_agent_id` (S10-2's local-author column); it writes `origin_link_id` + `sender_remote_agent_id`. A local id on an imported row *is* the impersonation primitive.

**Namespacing.** `getOrchestrationCompatibilityHostId()` returns the literal `'local'` (orca-runtime.ts:12960-12962), so **every host in the fleet calls itself `local`** and S10-1's `agents.host_id` is not a global namespace and cannot be made one by asking peers nicely. Addresses are therefore receiver-relative: `<env>` is this host's own `KnownRuntimeEnvironment` name. The desktop calls the VPS `Private VPS`; the VPS calls the desktop `desktop`; both are correct and neither is portable. Foreign display names re-run `sanitizeMessageText` at render, print host-tagged, never bare, and `@`/`:` are already rejected in local names (S10-1 CONTAINMENT §4) — so a peer cannot make its row read as your `merge-restructure-backend`. A bare name matching a local and a foreign row resolves to **neither**: `ambiguous`, both fully-qualified addresses printed, nothing addressed. Local never wins a tie implicitly.

## CONTAINMENT

**Threads.** `thread_participants` keeps `participant_key`; a foreign participant carries `link_id` + `remote_agent_id`. `threads.owner_link_id` names the sequence authority: a foreign post is relayed to the owner, given its `thread_sequence` there, then fanned back; each participating host keeps a replica of the rows it is party to and `threads.origin` gains `'federated'`. The owner refuses `not_a_participant`, `thread_closed`, `thread_paused` on the relayed post exactly as S10-2 §RPCS does locally. A host may only propose participants it can itself address; invites to a third host relay through the owner. **A peer may wake only agents that participate in a thread on its own lane** (ruling 5) — otherwise `not_a_participant`, refused, cursor advanced, one audit row.

**Sensitive threads never cross, at either end.** `threads.create --sensitive --with <foreign>` refuses `sensitive_thread_local_only` at creation; `threads.invite` of a foreign agent onto a sensitive thread refuses; and because `sensitive` is a one-way latch (S10-2 `trg_threads_provenance_immutable`), a thread that **already** has a foreign participant cannot become sensitive — `sensitive_requires_local_only`, naming the participant that blocks it. The bodies have already crossed; a latch cannot recall them, and the right answer is a new thread. Fan-out threads (`origin='fanout'`) never federate.

**Purge (ruling 13).** Local purge first (S10-2 shape), then one `tombstone` item per link that carried a copy: `{v:1, kind:'tombstone', itemIds[], threadId?, purgedAtIso, reasonCode}` — enum only, never the free-text reason. Accepted only on the lane whose fingerprint matches, and applied **only** to rows with `origin_link_id = link_id` on a thread with `owner_link_id = link_id`; every other named id is refused and counted. Never to local-origin rows — `trg_messages_purge_final` makes the result unrecallable, so an unfenced travelling purge is denial of evidence, not privacy. One audit row per applied purge. **One hop, no transitive forwarding:** A→B→C does not carry A's purge to C, and `purge` prints that limit when a participant lives on an unlinked host. Ids with no local copy write `relay_seen(outcome='purged')` so a message arriving later under that id is refused `purged_upstream` — closing the race where a purge overtakes its own message.

**Quarantine and withhold.** `quarantine X@A` on A relays `{remoteAgentId, state, reasonCode}`; B sets `remote_agents.remote_quarantined`, withholds X's past and queued messages **in SQL on every read path** (S10-2's rule: never in the formatter), and refuses outbound to `agent:X@A` with `agent_quarantined`. B refuses a relayed quarantine naming an agent on B or a third host: `quarantine_scope_violation`, audited. A relayed *lift* clears `remote_quarantined` only; `local_quarantined` is this host's own act and the poisoner's host cannot un-fence itself (trigger `trg_remote_lift_scope`). Withhold notices intersect with lane-origin rows; the rest are refused and counted.

**Containment failure and the release verb (ruling 9).** An unacked tombstone leaves the thread `containment_pending=1` and refuses new outbound relay for that thread on that link (`containment_pending_no_relay`) — do not add to a pile you cannot clean. `orca agents unlink --abandon-pending-containment` and `orca environment rm` refuse while any tombstone is unacked unless the flag is given; the flag names each copy left live, writes an audit row, sets `containment_state='abandoned'`, **and clears `containment_pending` on every affected thread**. On reconnect, replay is automatic, ordered and contiguous, so a tombstone can never be skipped past by a later message.

**Bounded, and said out loud (ruling 12).** Dispatch federation is unchanged and already moves arbitrary bodies host-to-host (orchestration.ts:628-632; live-verified round-tripping a token verbatim, `federation-live-test-findings.md`). Purge does not reach it. `orca agents purge` prints: `Dispatch-federated copies are not recalled by this purge.` A link lacking `orchestration.containment.v1` gets no agent relay at all — during any version skew the fleet has no new capability and the roster degrades to the title-only rows that caused the original failure. That is a deliberate security choice and is printed as the cost it is.

## TESTS (acceptance, each with the mutation it must fail on)

| # | Assertion | Mutation that must turn it red |
|---|---|---|
|F1|An imported message never writes `messages.sequence`; two hosts posting concurrently to one thread produce contiguous `thread_sequence` and no rowid collision|Write the wire `sequence` into `messages.sequence` (db.ts:377) ⇒ a peer picks a local rowid|
|F2|A payload claiming a `fromRuntimeId` that is not the lane peer (and one claiming the local runtime id) is refused `origin_host_mismatch`; the printed host tag comes from the link row|Read the host tag from the payload ⇒ `[from: fable@desktop]` is peer-controlled|
|F3|A caller presenting no auth token is refused `unauthenticated_lane`|Key the link on `authenticatedCallerFingerprint` alone ⇒ the `'authenticated_transport'` fallback (mutation-executor.ts:128-133) merges every tokenless caller|
|F4|An inbound HARD (h1/h2) body is absent from `messages` and from every replay; **item N+1 still imports**, and `relay_seen(outcome='refused')` exists|Refuse without advancing `in_imported_sequence` ⇒ contiguity (federation-sync.ts:95-98) kills the link at N|
|F5|A body naming the receiver's own infra literals imports cleanly; the same body sent *outbound from* that host is HARD-blocked|Run h3 on the import path ⇒ the dominant desktop→VPS traffic wedges|
|F6|**Owner scenario A:** desktop sends to `agent:<id>@Private VPS`; the VPS types a 3-line host-tagged pointer into an idle pane; the desktop shows `queued → relayed → peer reports pointed`|Have the sender resolve a remote pane ⇒ `dispatch --inject`'s local-only refusal (orchestration.ts:1459-1466) reappears|
|F7|**Owner scenario B:** kill and restart the VPS runtime with unread federated mail → `scheduleRestoredMessageRepoints` repoints the pane; `delivered_at` is still NULL on every path|Stamp `delivered_at` on any read path ⇒ S10-1 B2, the push watermark is consumed|
|F8|A peer returning `state:'read'` instantly is stored `claimed=1` and printed as a peer claim, never as an observation|Store peer receipts indistinguishably ⇒ the sender is told the pane was written when it was not|
|F9|A peer returning `confidence:1.0` on every row never produces `resolved`; foreign rows are re-scored locally and row/byte caps are enforced|Sort on the peer's `confidence` ⇒ one hostile peer collapses S10 owner decision 2|
|F10|`find --all-hosts` with one dead peer returns `resolved` among answered hosts **and** prints `2 of 3 hosts answered…`|Require every host to answer ⇒ a silent peer vetoes local resolution|
|F11|A relayed tombstone naming a local-origin id, or an id on a thread the lane does not own, is refused and counted; only lane-origin rows are blanked|Apply a tombstone by id alone ⇒ any peer permanently blanks arbitrary local bodies|
|F12|A relayed quarantine naming an agent on this host or a third host → `quarantine_scope_violation`; a relayed lift does not clear `local_quarantined`; a purely local lift succeeds|Clear both columns on a relayed lift ⇒ the poisoner un-fences itself (and a too-broad trigger blocks the local lift)|
|F13|`sensitive` on a thread with a foreign participant is refused at create, at invite, and at latch|Refuse only at create ⇒ the latch reads as retroactive protection for rows already on a peer|
|F14|Re-sending an acked-then-purged item id → `duplicate_or_purged`, no insert; a byte-different body under a reused id → `request_mismatch`|Drop `relay_seen`, or keep `importFederatedRelayItem`'s three-field compare (db.ts:5525-5531) ⇒ a purged id re-imports clean|
|F15|`unlink --abandon-pending-containment` clears `containment_pending` on every affected thread and names each live remote copy|Clear only the link row ⇒ a reimaged peer freezes that thread's outbound relay forever|
|F16|Migration on a v35 fixture is idempotent; `agents` and `messages` keep row count, `sequence` values and `PRAGMA table_info` order plus the new columns; `INSERT INTO agents … origin_kind='paired_runtime'` aborts|Rebuild either table (S10-1 M3), or add the `agents` CHECK by rebuild ⇒ rowids and the AUTOINCREMENT counter move|

## COMMIT SERIES (3 Sonnet series, hard dependency chain)

**S10-4a — schema + DB layer (no RPC, no CLI).** `SCHEMA_VERSION` → 36 (read it first); the five tables, three triggers and seven ALTERs in `createTables()` **and** `if (current < 36)`; the fifteen `OrchestrationDb` methods, with `enqueueAgentRelay`/`listPendingAgentRelay`/`acknowledgeAgentRelay`/`importAgentRelayItem` ported from db.ts:5138-5300 / :5325 / :5339 / :5467 re-keyed off `link_id`, and `importAgentRelayItem` using the **full-field** compare (federation-control-message.ts:63-78), not db.ts:5525-5531; `relay_seen`; `nextThreadSequence`. Tests F1, F14, F16. No behaviour change ships.

**S10-4b — lane, gates, wake.** `orchestration-federated-agents.ts` (`serve`/`deliver`/`pull`/`ack`/`link`/`unlink`/`links`/`relayReview`); origin binding and the fingerprint-fallback refusal; the inbound gate with h3 excluded; the refusal-advances-cursor transaction; the pump and its boot rearm beside `ensureOrchestrationFederationRelay` (`orca-runtime.ts:5068`, `:5080`); receipts with `claimed`; the capability constant. Tests F2-F8, F11, F12, F14. Depends on 4a only.

**S10-4c — union, CLI, containment surface.** `collectDirectoryUnion` generalized from `environment-terminal-roster.ts:71-86`; local re-scoring and caps; `agents list|find --all-hosts`; `link`/`links`/`relink`/`unlink`/`relay-review`/`relay-gc`; `name@env` accepted by `ask|send|reply|threads|thread|wait`; every printed sentence in §CLI including the unreached line, the old-host line, the `--inject` redirect and the per-host purge line; tombstone/quarantine/withhold propagation and `--abandon-pending-containment`. Tests F9, F10, F13, F15, plus the `--json`/text same-node-set fixture and the non-empty-`nextSteps` sweep.

## RISKS

1. **One usable edge (F1).** A link needs the receiver inbound-reachable and a saved environment on each side (runtime-environments.ts:23-36, `endpoints` min 1 at :34). Two NATed Windows desktops have no transport to each other at all, and desktop-2↔VPS needs a second reverse tunnel that does not exist. The owner's three-host fleet gets **desktop-1↔VPS only** on day one. `orca agents links` must say so rather than implying a mesh.
2. **The wake is only as good as the remote pane's idleness.** Everything past step 3 of §WAKE depends on the S10-1d `agent:` branch and S10-0b's bounded pointer existing on the *remote* host. Against a peer at S10-2 but not S10-1d, delivery is durable and the wake is silent — the receipt says `relayed`, never `pointed`, which is honest but is not what the owner asked for.
3. **Backlog cap, not a rate.** An unreachable link accretes unacked items to 256 / 1 MiB (db.ts:5211-5218) and then *all* relay on that link fails, not just the pending thread — purging one message can escalate to a link-wide outage. Surfaced in `orca agents links`; the fix if it bites is eviction of oldest non-containment items, not a bigger cap.
4. **Containment is one hop and Dispatch federation is exempt.** Purge is not fleet-wide and this spec does not claim it is. The exempt path is also the faster, already-working, version-tolerant one, so agents will route around the contained channel unless S10-3's guide rewrite makes the agent surface cheaper.
5. **Every address is host-relative and there is no fleet-wide alias.** Same-role names across hosts are the normal case, so most bare names go `ambiguous` and each host types a different fully-qualified string for the same agent. `@` is reserved in `display_name` (S10-1 §4), so no alias is possible without another migration. In a git doc, one agent has one name everywhere — that remains the docs bus's residual advantage.
6. **`relay_seen` grows unbounded without the GC verb.** At the 120 items/min ceiling a link accrues millions of rows over the 30-day retention. `relay-gc` is specified but is a manual verb; if it is not run the table is the largest thing in the store.
7. **`agents` cannot take a real CHECK constraint without a rebuild**, which S10-1 M3 forbids, so ruling 4's fence is a trigger. A future migration that rebuilds `agents` must re-create it or the `paired_runtime` reservation silently reopens.
8. **Two of the three S10-4 preconditions are unmerged.** S10-2 (the choke, the sanitizer, `threads`) and S10-3 (v35) are both spec, not schema. If either re-cuts, v36 and every `current < 36` assumption move with it. Land the chain in order; do not design around a fourth numbering.
