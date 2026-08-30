# S10-1 — Agent directory, resolver, durable peer delivery (implementation spec, rev 1 — 2026-08-30)

Synthesized from two Opus framings (affordance vs poison/abuse), each refuted by the other lens, then arbitrated (workflow wf_13975f89-34b). Tree of record `/home/ubuntu/orca-integration` @ `2de4f5894e`; designed on top of S10-0 (bugs 1–4, 6, 7 of `agent-coordination-s10-design.md` §1). Owner decisions on defaults: derived rows yes; `find` always hands back candidates; peer mailboxes become at-least-once via a generalized deliveries table. Poison containment (§6 of the S10 design) applies throughout; the remediation-framing gate applies to message bodies at `send`/`ask` (S10-2), never to `register`.



## SCHEMA

## ARBITRATION (which lens won, and why) — all line cites verified @ 2de4f5894e

| # | Blocker | Winner | Ruling |
|---|---|---|---|
|A1|`--terminal`/client `paneKey` = identity takeover; step 1 dead code|**ABUSE**|CONFIRMED: `CURRENT_AUTHORITY_PREFLIGHT_METHODS` is a closed 11-method set (rpc/orchestration-legacy-compatibility.ts:17-33), so a new method gets `authority === undefined`; and send's guard `authority.terminalHandle === from` with `from = params.from ?? 'unknown'` (rpc/methods/orchestration.ts:457-462) *confirms* a claimed handle, never *binds* one. Register takes identity **only** from `runtime.verifyOrchestrationCompatibilityCaller(evidence, {currentRuntimeLaunchSufficient:true})` (orca-runtime.ts:12982, launch-secret bound at :13004-13011, pane-exact fast path :13026-13039). No `--terminal`, no `paneKey` param, ever.|
|A2|`role` unbounded text into other agents' PTYs|**SPLIT**|AFFORDANCE wins *free text*: ABUSE's ~30-slug closed vocab cannot express the owner's literal example ("backend for the merge restructure"), and B5 shows it punishes exactly the security roles hardest to name. ABUSE wins *bounds*: 120 chars, single line, printable ASCII, one shared sanitizer at write **and** render. A field that structurally cannot hold a newline or a CSI cannot carry the payload A2 describes.|
|A3|`matched/queryTokens` ⇒ keyword stuffing scores 1.00|**ABUSE**|Fixed by denominator `max(\|Q\|, min(\|F\|,12))`. A 22-token stuffed role scores 0.25 — below threshold. Verified by fixture test S3.|
|A4|`agent:` mail lands on `run_legacy_local`; recipient's check throws|**NEITHER (chair)**|CONFIRMED end-to-end: send writes `runId: routing.run?.id` (rpc/methods/orchestration.ts:667) → undefined for two hand-started agents → `insertMessage` defaults `LEGACY_RUN_ID` (db.ts:2928, :286) → the bare-handle branch throws `legacy_read_only` (rpc/methods/orchestration.ts:1053-1060). Fix: sentinel run `run_peer_local` + a dedicated `agent:` check branch.|
|B1|Implicit ack can't tell "delivered" from "received"|**NEITHER (chair)**|Both lenses invented a protocol the tree already has: `deliveries` + replay-until-`--ack` (db.ts:387-402, mint :2807-2820, ack :2860-2882, ids frozen :2724-2726), and the one-shot CLI already carries the token across invocations via `--ack <delivery_id>` (specs/orchestration.ts:86-98). Generalize the table to mailboxes. Passes **both** BUG-5 tests; the delivered_at designs pass only the second.|
|B2|Stamping `delivered_at` in check kills the ambient wake-up|**ABUSE**|CONFIRMED: `delivered_at IS NULL` is the push watermark (db.ts:3584-3600 + its Why comment, restart repoint db.ts:3611 → orca-runtime.ts:33541), and the two-axis invariant is stated outright at orca-runtime.ts:2192-2194. **Nothing in S10-1 writes `delivered_at` from a read path.**|
|B3|`origin_pane_key NOT NULL` forecloses federation|**ABUSE**|`origin_kind` NOT NULL + nullable pane key.|
|B4/B5|Register-time content gate refuses rows / blocks security roles|**AFFORDANCE**|No semantic gate at register. §6's remediation gate stays where §6 put it — `send`/`ask` bodies, S10-2. Register **never** refuses for content; it sanitizes and stores.|
|—|Derived row naming|**SPLIT**|ABUSE is right that a pane title must never become a name (title is agent-controlled); AFFORDANCE is right that `pane-<hmac6>` fails the owner's test. Derive the name from **branch / worktree basename** (host-controlled path) + `getAgentLabel` + 4hex. Title is stored sanitized and scored, never promoted.|
|—|`getAgentLabel` source; `pty.ts:2489`|both agree|Use `src/shared/terminal-title-agent-type.ts:122` (the one the roster imports, environment-terminal-roster.ts:1, used :165) — **not** `agent-title-identity.ts:46`. Design §2.1 is wrong: `src/main/ipc/pty.ts:2489` writes `env.ORCA_TERMINAL_HANDLE`; `ORCA_PANE_KEY` is renderer-injected, so some panes lack it.|

## SCHEMA — v32, additive only

Bump `SCHEMA_VERSION` 31→32 (db.ts:309). Add each block to `createTables()` **and** verbatim under `if (current < 32) { … }` in `migrate()` beside the `current < 31` block (db.ts:1042), inside the existing `BEGIN IMMEDIATE` txn that bumps `user_version` only on success (db.ts:657, :1062). No `messages` rebuild; 0700/0600 hardening inherited (db.ts:311).

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                          -- generateId('agt') (db.ts:141); never caller-supplied
  display_name TEXT NOT NULL, role TEXT,        -- both sanitized at write (see CONTAINMENT)
  host_id TEXT NOT NULL DEFAULT 'local',
  pane_key TEXT, terminal_handle TEXT, process_incarnation TEXT,   -- handle+incarnation are CACHE
  worktree_id TEXT, worktree_path TEXT, branch TEXT, title TEXT, agent_label TEXT,
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('live','idle','gone')),
  derived INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0, quarantine_reason_code TEXT, quarantined_at TEXT,
  tombstoned_at TEXT,                                              -- reserved; every read filters it now
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('pane','paired_runtime','derived')),
  origin_pane_key TEXT, origin_handle TEXT, origin_host_id TEXT NOT NULL,
  origin_paired_device_id TEXT, origin_at TEXT NOT NULL DEFAULT (datetime('now')),
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name
  ON agents(host_id, display_name) WHERE tombstoned_at IS NULL;
-- suffix match, not equality: tabId changes when a pane moves tabs (precedent db.ts:100-108, :626-628)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_pane_suffix
  ON agents(host_id, substr(pane_key, instr(pane_key,':')+1))
  WHERE pane_key IS NOT NULL AND tombstoned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agents_state ON agents(state, quarantined) WHERE tombstoned_at IS NULL;

CREATE TABLE IF NOT EXISTS mailbox_deliveries (            -- BUG 5; mirrors deliveries (db.ts:387-402)
  id TEXT PRIMARY KEY, mailbox_handle TEXT NOT NULL, message_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'outstanding' CHECK(status IN ('outstanding','acknowledged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), acknowledged_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_deliveries_one_outstanding
  ON mailbox_deliveries(mailbox_handle) WHERE status = 'outstanding';

CREATE TABLE IF NOT EXISTS agent_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT, actor_pane_key TEXT, actor_host_id TEXT, verb TEXT NOT NULL,
  outcome TEXT NOT NULL, reason_code TEXT, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS agent_rate (subject_key TEXT NOT NULL, verb TEXT NOT NULL,
  window_start TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(subject_key, verb, window_start));

ALTER TABLE messages ADD COLUMN sender_agent_id TEXT;      -- author provenance for S10-3 purge/quarantine
```

Triggers (provenance immutable in the DB, not the handler):
`CREATE TRIGGER trg_agents_origin_immutable BEFORE UPDATE ON agents WHEN OLD.id<>NEW.id OR OLD.origin_kind<>NEW.origin_kind OR IFNULL(OLD.origin_pane_key,'')<>IFNULL(NEW.origin_pane_key,'') OR OLD.origin_host_id<>NEW.origin_host_id OR OLD.origin_at<>NEW.origin_at OR OLD.registered_at<>NEW.registered_at BEGIN SELECT RAISE(ABORT,'agent provenance is immutable'); END;`
plus `BEFORE UPDATE ON agent_audit` and `BEFORE DELETE ON agent_audit` → unconditional `RAISE(ABORT,…)`.

Sentinel run (resolves A4), seeded in the same `current < 32` block using the LEGACY_RUN_ID seeding precedent (db.ts:742):
`export const PEER_RUN_ID = 'run_peer_local'` beside db.ts:286; `INSERT OR IGNORE INTO runs (id, objective, legacy) VALUES ('run_peer_local','Peer agent mail (S10)',0)`. `orchestration.runUse` refuses `id === PEER_RUN_ID` with `invalid_argument` ("not a coordinator Run").

New `OrchestrationDb` methods (all filter `tombstoned_at IS NULL`): `upsertAgentByPaneSuffix`, `getAgentById`, `getAgentByName`, `listAgents`, `refreshAgentLiveness`, `setAgentQuarantine`, `getOrCreateMailboxDelivery`, `acknowledgeMailboxDelivery`, `writeAgentAudit`, `checkAndBumpRate`.


## RPCS

New module `src/main/runtime/rpc/methods/orchestration-agents.ts` exporting `ORCHESTRATION_AGENT_METHODS`, spread into `ORCHESTRATION_METHODS` (rpc/methods/orchestration.ts:421) the way `ORCHESTRATION_RUN_METHODS` is (:31); each built with `defineMethod` (rpc/core.ts:125). Adding methods needs no protocol bump (shared/protocol-version.ts:22-24). Declare `export const ORCHESTRATION_AGENT_DIRECTORY_RUNTIME_CAPABILITY = 'orchestration.agent-directory.v1' as const` beside shared/protocol-version.ts:32 so old peers degrade into the roster's existing capability-missing set (environment-terminal-roster.ts:6-11).

**Caller identity — one function, no alternatives.** Every `agents.*` method calls
`const authority = runtime.verifyOrchestrationCompatibilityCaller(request.orchestrationCompatibilityEvidence, { currentRuntimeLaunchSufficient: true })` (orca-runtime.ts:12982). Evidence is the env triple `ORCA_TERMINAL_HANDLE` + `ORCA_PANE_KEY` + `ORCA_AGENT_LAUNCH_TOKEN` the CLI already reads (shared/orchestration-compatibility-evidence.ts:47-62). `authority` yields `{paneKey, terminalHandle, processIncarnation, hostScope}` (orca-runtime.ts:2142-2148) — all four host-derived. **`register` refuses with `no_pane_identity` when `authority === null`.** There is no `--terminal`, no `paneKey` param, and no `params.from` fallback anywhere in this surface. (`orchestration.agents.*` is deliberately NOT added to `CURRENT_AUTHORITY_PREFLIGHT_METHODS`; it verifies directly, so it cannot inherit send's confirm-a-claim weakness.)

- **`orchestration.agents.register`** `{name, role?}` → `{agent, created, reMinted}`. Idempotent on the pane-key **suffix**: `SELECT … WHERE host_id=? AND substr(pane_key,instr(pane_key,':')+1)=?`. Hit → UPDATE (id, origin_*, registered_at preserved by trigger; name/role/handle/incarnation/title/worktree/last_seen rewritten; `derived`→0). Miss → INSERT `generateId('agt')`, `origin_kind='pane'`, `origin_pane_key=authority.paneKey`, `origin_handle=authority.terminalHandle`, `origin_host_id=runtime.getOrchestrationCompatibilityHostId() ?? 'local'`. Naturally idempotent, so no `mutation_receipts` round-trip (db.ts:403-415). Name collision with a different id: reclaim only if the holder is `state='gone' AND derived=1` (tombstone it: `tombstoned_at=now`, `pane_key=NULL`); else `name_taken` with a concrete alternative. **Never silently renames the caller.** Writes `agent_audit`.
- **`orchestration.agents.list`** `{state?, host?, includeDerived?=true, includeQuarantined?=false, limit?=100}` → `{agents[], liveCount, derivedCount, omitted:{quarantined,derived}}`. Refreshes derived rows from `runtime.listTerminals()` (orca-runtime.ts:16194; rows are `RuntimeTerminalSummary`, shared/runtime-types.ts:577-597) first, then prunes `derived=1 AND state='gone' AND last_seen_at < now-24h`.
- **`orchestration.agents.get`** `{id?, name?}` → `{agent, pushable}` or `not_found` + `nextSteps`. Full row only when `id === callerAgentId`; otherwise the `find` candidate shape.
- **`orchestration.agents.find`** `{query, limit?=5, includeDerived?=true}` → `{outcome, query, threshold:0.45, margin:0.15, candidates[], omitted, nextSteps[]}`. Deterministic, host-side, no model call. Returns no message content, ever (§6).
- **`orchestration.agents.quarantine`** `{name|id, lift?, reasonCode}` → `{agent}`. Refused unless the call is local and non-federated (`pairedDeviceId == null` and local `clientKind`, the same ctx fields send reads at rpc/methods/orchestration.ts:432-434) — **self-quarantine always allowed**. Splitting this from a future advisory `flag` (S10-3) is the point: a compromised agent must not be able to fence the reviewer about to catch it.

**Liveness is observed, never claimed** — `register` cannot set `state`. Computed at read time from the live graph and written back with `terminal_handle`/`process_incarnation`/`last_seen_at`. No timer, no background scan; S10-1 adds zero always-on work. `AgentStatus` is `'working'|'permission'|'idle'` (shared/agent-title-core.ts:12 — there is no `'busy'`):
`live` = pane resolves to a handle AND `leaf.lastAgentStatus ∈ {working,permission}` AND `lastAgentStatusObservedLive`; `idle` = same with `lastAgentStatus==='idle'` — the exact predicate ambient push gates on (orca-runtime.ts:33531-33533) and the only state with `pushable:true`; `gone` = `getTerminalHandleForPaneKey(pane_key)` → null (orca-runtime.ts:33193), or no live pane and `last_seen_at` older than 15 min. Cold restore (`lastAgentStatus` set, `observedLive===false`) reports `idle` with **`pushable:false`** — never `live` (precedent: the Why comment at orca-runtime.ts:33524-33530).

**BUG 5 — durability by reusing the Run protocol, not by overloading `delivered_at`.** New `db.getOrCreateMailboxDelivery({mailboxHandle, messageIds, limit:50})` and `db.acknowledgeMailboxDelivery(deliveryId)` are line-for-line ports of db.ts:2739-2830 / :2846-2882 with `run_id` → `mailbox_handle` and no `consumer_generation` (a re-minted agent keeps its id, so there is nothing to fence). Semantics: an outstanding delivery **replays the same frozen `message_ids`** until acked; ack sets `read=1` on exactly those ids. `--ack <delivery_id>` already exists on the CLI (specs/orchestration.ts:86-98), so the one-shot process is not the state — the agent is. **No read path calls `markAsDelivered`.**

**Dual behaviour (owner decision 3).** New optional `ackMode?: 'implicit'|'destructive'` on `orchestration.check`. The **new** `agent:<id>` mailbox is `implicit` (replay-until-ack) from day one — nothing exists to break. The **existing** `dispatch:` and bare-handle mailboxes (rpc/methods/orchestration.ts:1001, :1036, :1077) default to `destructive` for one release; next release the default flips to `implicit`; the release after, the param is deleted. The CLI sends `ackMode:'implicit'` whenever the negotiated runtime advertises `orchestration.agent-directory.v1`; `--legacy-destructive-read` forces the old path with a one-line stderr deprecation. `reply`'s `markAsRead([original.id])` (:1263) stays destructive — an explicit reply is an explicit ack. `--peek`/`--all` set neither bit.


## CLI

See the `cli` field above — namespace `orca agents register|list|find|show|quarantine`, specs in `src/cli/specs/agents.ts` (appended at specs/index.ts:22-40), handlers in `src/cli/handlers/agents.ts` registered as a new `agents` group in `handler-group-manifest.ts`, all rendered through `printResult` (format.ts:67) so `--json` is a raw RPC passthrough. No `--terminal` flag exists on any verb. Scoring pseudocode with `THRESHOLD = 0.45` / `MARGIN = 0.15` and the exact printed text for `resolved` / `ambiguous` / `no_match` are specified there.

**SLICE SPLIT — four Sonnet-sized commits, each independently testable.**

**S10-1a — schema + DB layer (no RPC, no CLI).** `SCHEMA_VERSION` 31→32; the `agents`, `mailbox_deliveries`, `agent_audit`, `agent_rate` DDL in both `createTables()` and `if (current < 32)`; the two provenance triggers; `ALTER TABLE messages ADD COLUMN sender_agent_id`; `PEER_RUN_ID` + its seeded `runs` row; `src/shared/directory-text.ts` (sanitizer) and `src/shared/agent-directory-scoring.ts` (pure, constants exported); the ten new `OrchestrationDb` methods, with `getOrCreateMailboxDelivery`/`acknowledgeMailboxDelivery` ported from db.ts:2739-2882. Tests: **M1-M4, S1-S3, S6, D2-D3**. Touches one file plus two new shared modules; no behaviour change ships.

**S10-1b — RPC surface.** `src/main/runtime/rpc/methods/orchestration-agents.ts` with `register`/`list`/`get`/`find`/`quarantine`, spread into `ORCHESTRATION_METHODS` (rpc/methods/orchestration.ts:421); attestation via `verifyOrchestrationCompatibilityCaller`; read-time liveness + re-mint writeback; derivation from `runtime.listTerminals()`; the capability constant in shared/protocol-version.ts; rate limits. Tests: **R1-R5, S4-S5, P4**. Depends on 1a only.

**S10-1c — CLI.** `src/cli/specs/agents.ts`, `src/cli/handlers/agents.ts`, the `agents` handler group, positional query via `rawArgs`, all printed text and `nextSteps`. Tests: **P1-P3**. Depends on 1b only; no runtime files touched.

**S10-1d — routing + durability.** The `agent:` branch in `resolveMailboxTerminalHandle` (orca-runtime.ts:33473); `agent:` resolution + `PEER_RUN_ID` + `senderAgentId` in `orchestration.send` (:658-670); the new `agent:` mailbox branch in `orchestration.check` before :1049; `ackMode` on check with `destructive` default for the two existing peer mailboxes (:1001, :1036, :1077); `--ack` wiring and the `--legacy-destructive-read` deprecation. Tests: **D1, D4-D6, T1-T6**. This is the only slice that edits `orca-runtime.ts` and the existing check handler — land it last, alone, so a revert is one commit.


## ROUTING

`agent:<id>` becomes a first-class address beside `run:` / `dispatch:` / bare handle. **The mailbox is always `agent:<id>` — never rewritten to a terminal handle.** Pane key is identity; handle is cache; the rewrite is one-way (`pane_key → terminal_handle`), never the reverse, and a supplied handle is a hint that gets verified, never a thing that writes `pane_key` or provenance.

**Send** (rpc/methods/orchestration.ts:425-670). Before the point-to-point `insertMessage` at :658: if `to.startsWith('agent:')`, resolve `db.getAgentById(id)`; miss → `agent_unknown` + `nextSteps:['orca agents find "…"','orca agents list']`; `quarantined=1` → `agent_quarantined` + `nextSteps:['orca agents show --id <id>']`. Then write `to:'agent:<id>'`, `senderAgentId` (from the already-computed `senderPaneKey`, :461), and **`runId: routing.run?.id ?? PEER_RUN_ID`** — the A4 fix. Without it the row defaults to `LEGACY_RUN_ID` (db.ts:2928) and the recipient's `check` throws `legacy_read_only` (:1053-1060).

**Ambient push** (BUG 6's peer half; A1 §19 generalized from `runs.coordinator_pane_key` to `agents.pane_key`). Add a third branch to `resolveMailboxTerminalHandle` (orca-runtime.ts:33473-33497), today `run:`/`dispatch:` only:
```ts
if (mailboxHandle.startsWith('agent:')) {
  const row = db.getAgentById(mailboxHandle.slice('agent:'.length))
  return row?.pane_key && !row.quarantined && !row.tombstoned_at
    ? this.getTerminalHandleForPaneKey(row.pane_key)   // private, same class (orca-runtime.ts:33193)
    : null
}
```
That is the entire change: `deliverPendingMessagesForHandle` (:33516-33533) already falls through to `resolveMailboxTerminalHandle` for any handle not in `this.handles`, and already gates the write on `lastAgentStatus === 'idle' && lastAgentStatusObservedLive` (:33531). `getUndeliveredUnreadMailboxHandles()` (db.ts:3611) returns `agent:` addresses unchanged, so `scheduleRestoredMessageRepoints` (:33541) repoints a peer's pane after an Orca restart with no further work — **the "survives a restart" half of the owner test, and it works only because nothing in S10-1 writes `delivered_at` from a read path (B2).**

**Check** — new branch in `orchestration.check`, placed **before** the bare-handle branch (rpc/methods/orchestration.ts:1049), taken only when the attested caller's pane resolves to a non-tombstoned agent row:
1. `address = 'agent:' + row.id`; refresh liveness, `terminal_handle`, `process_incarnation`, `last_seen_at` (the re-mint rewrite).
2. If `params.ack` names this mailbox's outstanding delivery → `acknowledgeMailboxDelivery` (sets `read=1` on its frozen ids) first.
3. Candidate ids = `db.getUnreadMessages(address)` ∪ `db.getUnreadMessages(callerHandle)` (db.ts:3525), **minus** rows with `run_id = LEGACY_RUN_ID`, which are reported as `legacyPending:n` and left untouched — preserving the fence's intent without ever throwing it at a peer.
4. `getOrCreateMailboxDelivery({mailboxHandle: address, messageIds, limit:50})` → `{deliveryId, messages, replayed, pendingBehind}`; an unacked prior batch replays identically (ids frozen at creation, db.ts:2724-2726).
5. Result adds `{mailbox, agentId, deliveryId, replayed, pendingBehind, legacyPending}`; the CLI prints `Ack when processed: orca orchestration check --ack <delivery_id>`.
`--peek`/`--all` mint no delivery and set neither bit.

**Liveness is observed, never claimed** — `register` cannot set `state`, so a spamming agent cannot rank itself live to the top of every `find`.

**Groups.** `@all`, `@idle`, `@worktree:`, `@claude` already exist (orchestration/groups.ts:58-90) — §6's "no broadcast" is not true in the tree today. S10-1 neither extends nor closes it: `agent:` is never a group-expansion target, and quarantined + tombstoned rows are subtracted from every expansion. Closing the group verbs is an open containment gap for S10-2.

**Federation.** v32 stores `host_id`/`origin_host_id` and reserves `name@host` (host = roster environment name, environment-terminal-roster.ts:3); the union query is S10-4. Uniqueness is per host; a bare name matching 2+ hosts is `ambiguous` and local never wins the tie implicitly. Foreign rows will be marked `foreign:true`; quarantine stays host-local — a remote host can neither fence nor un-fence an agent here.


## CONTAINMENT

1. **Attested identity only (A1).** Register derives pane, handle, incarnation and host from `runtime.verifyOrchestrationCompatibilityCaller(evidence, {currentRuntimeLaunchSufficient:true})` (orca-runtime.ts:12982), which binds a per-launch secret hash to a live PTY (:13004-13011) and, on the fast path, requires `claimedPaneKey === terminal.paneKey` (:13026-13039). No flag, no param and no `params.from` can name another pane. `orchestration.agents.*` is deliberately **not** added to `CURRENT_AUTHORITY_PREFLIGHT_METHODS` (orchestration-legacy-compatibility.ts:29-33) — it verifies directly, so it cannot inherit send's confirm-a-claim weakness at rpc/methods/orchestration.ts:457-462.
2. **No bodies on this surface, ever.** `agents.*` reads no `messages` body column. `find`/`list`/`show` return author-controlled bytes only as `display_name`, `role` and `title`, all bounded and sanitized; everything else is ids, enums, timestamps and numbers. A per-response field allowlist is unit-tested against the live schema so a new column cannot silently widen the API.
3. **One sanitizer, at write and again at render** — `src/shared/directory-text.ts` (pure, no I/O), reused by every renderer and by S10-2's pane push: NFKC → strip C0/C1, ESC, CSI/OSC, `\r`, `\n`, zero-width and bidi overrides → collapse spaces → truncate. Render-side application is the belt for derived rows and pre-migration titles.
4. **Bounds.** `display_name`: ASCII-only, `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`, no `--`, ≤32; reserved words rejected (`all, idle, everyone, here, run, dispatch, agent, worktree, system, orca, owner, coordinator`); `@` and `:` reserved for `name@host` / `agent:<id>`. ASCII-only removes homoglyph impersonation of a name like `merge-restructure-backend`. `role`: ≤120 chars, **single line**, printable ASCII + space — over-length is truncated with a warning, never refused. `title`: sanitized, ≤120, stored and scored, **never promoted to a name**.
5. **No semantic gate at register (B4/B5).** Register never refuses for content. §6's remediation-framing gate stays on `send`/`ask` bodies in S10-2: a 120-char single-line ASCII field structurally cannot carry the audit/vuln-shaped payload that gate exists to catch, and gating it would cost ~75% false positives on exactly the security roles ("triages exploit reports and bypass claims", "appsec reviewer for the auth path") that most need a free-text discriminator. Refusing a registration is the one outcome the design cannot afford — an absent row is unaddressable, and §5(i) already says a directory agents distrust is worse than none.
6. **Derived rows never launder agent-controlled text into identity.** `display_name = slug(branch basename || worktree dir basename) + '-' + slug(agent_label) + '-' + 4hex`; `agent_label = getAgentLabel(title)` from **shared/terminal-title-agent-type.ts:122** — the module the roster imports (environment-terminal-roster.ts:1, used :165), *not* the near-duplicate at shared/agent-title-identity.ts:46 that the design doc cites; using the wrong one makes `agents list` and `environment roster` disagree about the same terminal. Branch and worktree path are host-controlled (git forbids control characters in refs). Derived rows carry `role: null`, are rebuilt per live pane rather than accumulated, rank below registered rows (×0.85), and print with a leading `~`.
7. **Quarantine.** `quarantined=1` removes the row from `find` candidates but counts it in `omitted.quarantined` — nothing is silently missing. `list` still shows it with `[quarantined]`, no role, enum reason code only. Routing refuses `agent:<id>` in **both** directions with `agent_quarantined` + `nextSteps`. Only a local, non-federated caller may set or lift it (`pairedDeviceId == null` and local `clientKind`, the ctx fields send reads at rpc/methods/orchestration.ts:432-434); self-quarantine is always allowed. Splitting this from a future advisory `flag` (S10-3) is the point: a compromised agent may raise a signal but must not be able to fence the reviewer about to catch it. S10-1 ships the column, the read-path filter, the routing refusal and the verb; message-withholding is S10-3.
8. **Tombstones reserved, not precluded.** `tombstoned_at` ships in v32, every read path filters it from day one, and both unique indexes are partial on it — so an S10-3 purge frees a name without another migration. A tombstone nulls `role`, `title` and `worktree_path`, keeping provenance and the audit trail.
9. **Provenance immutable in the database, not the handler.** `origin_*` and `registered_at` are trigger-guarded; `agent_audit` refuses UPDATE and DELETE unconditionally. A caller reaching this DB by any other route still cannot rewrite who registered a row. Register, re-mint, quarantine and lift each write one audit row with actor pane key, host, verb, outcome and reason code.
10. **Rate limits** (`agent_rate`, fixed windows; refuse with `rate_limited` + `retryAfterMs`, never a partial result): `register` 10/h per pane key and 30/h per host; `find` 30/min per agent, 120/min per host; `list` 60/min; `quarantine` 10/day per host. Directory cap of 200 live non-derived rows per host → `directory_full` pointing at `orca agents list --state gone`.


## TESTS

Each test names the mutation it kills. Vitest, beside the existing `src/main/runtime/rpc/orchestration-*.test.ts` suites.

**M — migration.** M1 v31→v32 on a populated DB is idempotent; `createTables()+migrate()` twice is a no-op — *kills: DDL outside an `IF NOT EXISTS`/`current < 32` guard.* M2 a mid-migration throw leaves `user_version` at 31 and no `agents` table — *kills: DDL outside the `BEGIN IMMEDIATE` txn (db.ts:657).* M3 `messages` keeps its row count, `sequence` values and `PRAGMA table_info` order plus one new column — *kills: a table rebuild.* M4 `UPDATE agents SET origin_pane_key='x'` and `UPDATE`/`DELETE` on `agent_audit` all abort, in direct SQL — *kills: enforcing provenance in the handler.*

**R — identity (A1).** R1 register with no evidence → `no_pane_identity`, zero rows — *kills: a `params.from`/`getTerminalPaneKey` fallback.* R2 agent B, holding a valid launch token for its own pane, sends evidence naming A's `terminalHandle` → `verifyOrchestrationCompatibilityCaller` returns null → refused; A's row is byte-identical after — *kills: reinstating `--terminal`, a client `paneKey`, or send's confirm-a-claim guard.* R3 the CLI spec table contains no `terminal` flag under `agents *` — *kills: the flag creeping back.* R4 register twice from one pane → `created:true` then `reMinted:true`, same `id`, same `registered_at`, new `terminal_handle` — *kills: minting per terminal instead of per agent.* R5 register from the same agent after the pane moves tabs (tabId changes, leaf UUID stable) → same row — *kills: full-key equality instead of the suffix index.*

**S — scoring (A3).** S1 honest fixture: role "backend for the merge restructure", query "the merge-restructure backend agent" → `resolved`, confidence ≥0.9, `why` names the matched tokens. S2 two registered lookalikes → `ambiguous`, both candidates printed, nothing addressed; JSON `outcome:'ambiguous'` with the same `candidates` shape as `resolved` — *kills: auto-addressing (owner decision 2).* S3 **stuffed role of 22 topic tokens scores ≤0.30 and loses to the 3-token honest role on every one of 5 fixture queries** — *kills: reverting the denominator to `matched/|Q|`.* S4 an unregistered pane on branch `merge-restructure` running Claude scores ≥0.45 as `~merge-restructure-claude-<hex>` — *kills: `pane-<hmac>` naming, which fails the owner's four-terminal test.* S5 a pane whose title is a prompt-injection sentence never appears in any `displayName`; the sentence is sanitized wherever it is printed — *kills: promoting title to name, and render-side sanitizer removal.* S6 `THRESHOLD`/`MARGIN` are imported from one module by both the RPC and the tests — *kills: duplicated constants.*

**D — durability (BUG 5 / B1 / B2).** D1 **kill the client between the RPC response and the CLI exit, re-run `check` without `--ack` → the identical batch and the identical `deliveryId` come back** — *kills: any ack keyed on host-side state alone, incl. both lenses' `delivered_at`/next-read designs.* D2 `check` → `check --ack <id>` → second returns empty, `pendingBehind:0` — *kills: replay-forever.* D3 `check --ack <stale_id>` is a no-op returning `duplicate:true` — *kills: non-idempotent ack.* D4 **after any number of `check` calls, `messages.delivered_at` is still NULL and the row is still returned by `getUndeliveredUnreadMessages`** — *kills: `markAsDelivered` on a read path (B2), the defect in both lenses.* D5 push a message into an idle pane, then `check`: the row is pointed once and read once, neither surface hiding it from the other — *kills: collapsing the two axes (orca-runtime.ts:2192-2194).* D6 `--peek` and `--all` mint no delivery and set neither bit.

**T — routing (A4 / BUG 6).** T1 A sends to `agent:<B>` with no bound Run → the row's `run_id` is `run_peer_local`, and **B's `check` returns it instead of throwing `legacy_read_only`** — *kills: dropping the sentinel and letting `insertMessage` default to `LEGACY_RUN_ID` (db.ts:2928).* T2 a genuine legacy row in B's bare-handle mail is reported as `legacyPending:1` and left unread, still no throw — *kills: bypassing the fence's intent instead of preserving it.* T3 send to `agent:<B>`, force a graph reload so B's handle changes, confirm B's idle pane is still pointed and `terminal_handle` was rewritten from `pane_key` — *kills: caching the handle as identity.* T4 restart the runtime with unread peer mail → `scheduleRestoredMessageRepoints` repoints the pane — *kills: any read path that stamps `delivered_at` (the same mutation as D4, caught from the other end).* T5 send to a quarantined agent → `agent_quarantined` + nextSteps, nothing stored as deliverable; the quarantined row is absent from `find` candidates but counted in `omitted.quarantined` — *kills: silent omission.* T6 `runUse --id run_peer_local` → `invalid_argument`.

**P — parity.** P1 for all four verbs, `--json` and text describe the same node set over one fixture — *kills: the BUG 1 asymmetry (handlers/terminal.ts:62) reappearing.* P2 `HANDLER_COMMAND_KEYS` ≡ spec paths under `agents` (dispatch.ts:35-37). P3 every non-`resolved` outcome and every error carries a non-empty `nextSteps`. P4 the response field allowlist matches the schema snapshot — *kills: a new column leaking into `find` output.*


## RISKS

- A1 residual: panes not launched through the renderer paths that inject ORCA_PANE_KEY (pty-connection.ts:3408, launch-worktree-background-terminals.ts:59, adopt-agent-background-session-tab.ts:47, codex-detached-pane-restart.ts:158) cannot attest and therefore cannot register — they are derived-only. This is a deliberate trade of coverage for the removal of an identity-takeover primitive. If coverage proves too thin in practice, the fix is to widen ORCA_PANE_KEY injection at the launch sites, never to add a --terminal flag.
- Paired-runtime callers cannot register in S10-1 (no local pane to attest). The schema admits them (origin_kind='paired_runtime', nullable origin_pane_key, origin_paired_device_id), so S10-4 adds a code path rather than a migration — but until then the owner's desktop↔VPS topology has registered agents on one side only.
- Scoring constants (0.45 / 0.15 / cap 12 / derived 0.85) are fixture-tuned, not corpus-tuned. S4 sits near the threshold: a derived idle row for the right pane scores ≈0.48. If real titles or branch names are noisier than the fixtures, find will return no_match where the owner expects a hit. Mitigated by the single-module constants + failing-test tuning loop; watch this first after landing.
- ackMode dual behaviour means the two existing peer mailboxes stay destructive for one release, so BUG 5 is only fully fixed for the new agent:<id> surface on day one. The flip must actually be scheduled or the durability story stays a half-truth (design §5, decision 3).
- @all / @idle / @worktree: / @claude group expansion already exists (orchestration/groups.ts:58-90), so §6's 'no broadcast' is untrue in the tree and S10-1 does not make it true. It only excludes agent: from expansion and subtracts quarantined/tombstoned rows. Closing the group verbs is an open containment gap carried into S10-2.
- Register is voluntary; the directory is only as good as derivation for agents that never read the guide (§5(i)). Derived rows now score high enough to be found, which is the mitigation — but it also means find can return a plausible wrong answer, flagged derived:true and penalised ×0.85. S10-3's guide rewrite is what converts derived rows into registered ones; without it S10-1 under-delivers.
- role is free text with bounds and no semantic gate. That is the correct trade for a 120-char single-line ASCII field, but it does mean a determined agent can write a role that reads as an instruction. Bounds + the render-side sanitizer + the fact that role is never interpolated into a PTY payload for a derived row are the containment; if S10-2's content-bearing push starts carrying role into panes, that push must re-run the sanitizer and cap length independently.
- The check handler is already long and branch-dense; inserting a fourth mailbox branch before the bare-handle path (rpc/methods/orchestration.ts:1049) risks regressing the dispatch and legacy branches. Slice S10-1d isolates it deliberately, and T2 pins the legacy fence's intent, but this is the highest-regression-risk edit in the spec.
- mailbox_deliveries has no consumer_generation, so there is no fencing if an agent id is ever reused across genuinely different processes. Register preserves the id across re-mints by design, which is why this is safe today; any future verb that transfers an id to a different pane must add fencing first.
