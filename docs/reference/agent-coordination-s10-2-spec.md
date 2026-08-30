# S10-2 — Durable threads, delivery, ask/reply/wait, purge/quarantine, post-time gate (implementation spec, rev 1 — 2026-08-30)

Trees: **[base]** `/home/ubuntu/orca-integration` @ `2de4f5894e` (v31) · **[s10a]** `/home/ubuntu/orca-s10a` on `feat/s10-0a`, HEAD `068b7f5c07` (v32, S10-0b) **with S10-1 staged-but-uncommitted in the working tree** (v33: `agents`, `mailbox_deliveries`, `agent_audit`, `agent_rate`, `messages.sender_agent_id`, `PEER_RUN_ID`). All line cites below are the **[s10a] working tree** unless marked. Binding inputs: S10 design §2.3 and §6; S10-1 ARBITRATION rulings A1 (identity only via the runtime's verified caller), B2 (never write `delivered_at` from a read path), A2/B4 (one shared sanitizer at write **and** render; no semantic gate at register — the §6 gate lands here).

**Version, settled by the tree, not by either lens.** Both lens drafts opened on an unresolved "v32 collision". It is resolved: S10-0b took **32** (`SCHEMA_VERSION = 32` at HEAD), S10-1 took **33** (db.ts:467, migrate `if (current < 33)` db.ts:1224-1240). **S10-2 is v34.** The task brief's "additive, v33" is superseded — writing v33 twice would leave `user_version` claiming a schema the DB does not have.

## ARBITRATION (which lens won, and why) — every cite re-verified in [s10a]

| # | Blocker / major | Winner | Ruling |
|---|---|---|---|
|1|AFFORDANCE keeps `orca orchestration thread\|sent` "as-is", voiding every gate `threads.get` adds|**ABUSE**|CONFIRMED: `orchestration.thread` (orchestration-thread.ts:14-25) takes `{id, since}`, calls `db.getThreadMessages` (db.ts:3968 — deliberately recipient-unfiltered, comment :3965-3967) and returns full `MessageRow[]` incl. `body` and `payload`. No caller verification, no membership, no sensitive check. `orchestration.inbox --thread-id` hits the identical path (orchestration.ts:1301). Thread ids are not secrets — printed into panes at formatter.ts:124-125, and for question threads `thread_id === message_id` (db.ts:4020). Both verbs are hardened here (§RPCS), not left alone.|
|2|Gate bolted onto 3–4 handler call sites; ≥13 insert paths bypass it — including the federated branch **inside** the gated handlers|**NEITHER (chair)**|CONFIRMED and worse than either lens stated: `orchestration.send` returns from its federated relay branch at orchestration.ts:654-663, **before** the point-to-point `db.insertMessage` at :672; `orchestration.reply` returns at :1270-1277 before its insert at :1281. A gate "immediately before insertMessage" is dead code on both. `insertMessage` (db.ts:3146) has 9 further callers (db.ts:3301, :3450, :3667, :4006, :4086, :5790; orchestration.ts:672, :776, :1281) plus 5 `enqueueFederationRelay` sites (orchestration.ts:516, :636, :1201, :1248, :1816). Ruling: **one choke, `db.insertGatedMessage`**, plus the relay encode path; `insertMessage` becomes private to host-generated lifecycle rows on a named exemption list.|
|3|`reply` takes its sender from `params.from`, checks no participation; `question_threads` has no recipient column ⇒ forged answers unblock a peer `ask`|**AFFORDANCE**|CONFIRMED: orchestration.ts:1281-1287 inserts `from: params.from ?? original.to_handle` with no `verifyOrchestrationCompatibilityCaller`. `question_threads` (db.ts:937-950) stores `asker_handle` only — structurally cannot verify who was asked — and the peer branch drops `requireCurrentConsumer` (db.ts:4057), the only fence the coordinator path has. v34 adds `to_agent_id` + `answered_by_agent_id` and binds the answerer to the attested caller.|
|4|`subject`/`body`/`payload` sanitized nowhere; the pane pointer prints raw `messages.subject`, so "never more than 3 lines" is false|**AFFORDANCE**|CONFIRMED: `truncatePointerSubject` (formatter.ts:116-121) **slices**, it does not sanitize; `formatMessagePointerLine` (:123-126) renders `msg.subject` verbatim; `insertMessage` (db.ts:3168-3186) applies no normalization, no newline collapse, no length cap. `formatMessageBanner` prints `msg.body` (:80-82) and `[Payload: …]` (:84-86) raw. S10-2 owns `sanitizeMessageText` at write **and** render (S10-1 ruling A2 generalized), and treats `payload` as sender-controlled: gated, and never rendered on the peer surface.|
|5|§6 "purgeable" foreclosed — AFFORDANCE ships `omitted:{purged:n}` with no per-message tombstone to derive it from|**ABUSE**|CONFIRMED: v33 adds only `messages.sender_agent_id`; nothing else. Purge must land **in this slice**, not S10-3, or the field reports 0 forever and §6's "nothing is silently missing" inverts. Bodies live in three stores — `messages.body` (db.ts:524), `question_threads.answer_body` (db.ts:945) and relay payloads (`encodeFederatedControlMessage`, orchestration.ts:640, :1252) — so purge is transactional across the first two and explicitly bounded on the third.|
|6|Hard gate tier has no escape hatch, and the refusal's own suggested rewrite is refused by the same rule|**AFFORDANCE**|Upheld, with the source consulted: the docs-bus design blocks on **a heading matching** `MERGE-GATE AUDIT\|SECURITY\s*\(?\s*(HIGH\|CRITICAL)\|VULNERABILITY` — a structural cue, not a bare noun anywhere in the text. ABUSE's port dropped the structural anchor, which is what makes `merge gate FAIL: CVE-2025-1234, fix is a version bump` unsendable. Ported rules keep the anchor (§GATE), and `--acknowledge-gate` stores the body flagged + audited rather than closing the channel.|
|7|`sender_agent_id` has no writer — quarantine withholding and purge-by-author match zero rows|**ABUSE**|CONFIRMED and load-bearing: the column exists (db.ts:540, ALTER db.ts:1225-1227) and `insertMessage`'s INSERT column list (db.ts:3168-3171) omits it. Every row is NULL. S10-2 owns populating it from the attested pane via `idx_agents_pane_suffix`; without that, half of S10-2 reads as shipped and does nothing.|
|8|A `thread_participants` refusal un-ships the BUG-4 replay that just landed; no population path for legacy threads|**SPLIT**|AFFORDANCE wins the backfill (v34 populates from `messages`); ABUSE wins that a hard refusal is wrong for pre-v34 traffic and for the derived-only agents S10-1 accepted as unable to attest. Ruling: non-participants **degrade** to the recipient-filtered `getThreadMessagesFor` (db.ts:3946) rather than being refused — except `sensitive=1`, which refuses.|
|9|Purge `--reason` is ungated, immutable, author-controlled text rendered where the body was — a clean gate bypass|**ABUSE**|Upheld. The reason runs the **same gate**, not just the sanitizer. The reason-rewrite `RAISE(ABORT)` is dropped (an operator must be able to correct a reason); the un-purge ABORT stays, since that is the actual re-poison primitive.|
|10|Blanking `answer_body` breaks `answerQuestion` idempotency ⇒ at-least-once retry becomes `answer_conflict`|**ABUSE**|CONFIRMED at db.ts:4071-4077: dedup compares `question.answer_body !== params.body`. Purge sets `answer_purged_at` and stores `answer_body_sha256` **before** blanking; dedup compares the hash when purged (§PURGE).|
|11|Backfilling `thread_participants` from `from_handle`/`to_handle` invents N-way threads|**NEITHER (chair)**|`orchestration.broadcast` mints one `thread_${Date.now()}` for N recipients (orchestration.ts:774), so a naive backfill turns a fan-out into a group conversation nobody joined, and §6 forbids exactly that. Backfill marks such threads `state='closed', origin='fanout'`; they replay, they do not accept posts.|
|12|Cursor resolution: `--since` is a timestamp truncated to 1 second|**AFFORDANCE**|CONFIRMED: `normalizeThreadSinceTimestamp` (thread-replay-since-filter.ts:9-14) slices to 19 chars, so two messages in one second are unresumable. Note the fix is half-built already — `getThreadMessagesFor` (db.ts:3946) **already takes `afterSequence`**. Generalize it; keep the timestamp form accepted and mapped.|

## SCHEMA — v34, additive only

`SCHEMA_VERSION = 34`. DDL verbatim in `createTables()` **and** under `if (current < 34)` beside db.ts:1224, inside the existing `BEGIN IMMEDIATE` txn that bumps `user_version` only on success (db.ts:1244-1245). Ids from `generateId` (db.ts:197), never caller-supplied. 0700/0600 store inherited (`hardenOrchestrationDatabaseFiles`, db.ts:469).

```sql
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,                        -- generateId('thr')
  subject TEXT NOT NULL,                      -- sanitizeMessageText, <=120, single line
  created_by_agent_id TEXT,                   -- agents.id (v33); NULL for backfilled threads
  origin TEXT NOT NULL DEFAULT 'peer' CHECK(origin IN ('peer','question','fanout','legacy')),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','paused','closed')),
  sensitive INTEGER NOT NULL DEFAULT 0,       -- one-way 0 -> 1 latch (trigger)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT, last_message_id TEXT,
  last_message_sequence INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
  pact_with_agent_id TEXT,
  pact_state TEXT CHECK(pact_state IS NULL OR pact_state IN ('proposed','engaged','released')),
  pact_turn_agent_id TEXT, pact_at TEXT,
  purged_at TEXT, purge_reason TEXT, purged_by_agent_id TEXT);
CREATE INDEX IF NOT EXISTS idx_threads_recent ON threads(state, last_message_at) WHERE purged_at IS NULL;

CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id TEXT NOT NULL,
  participant_key TEXT NOT NULL,              -- agents.id when known, else the raw handle
  agent_id TEXT, handle TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')), left_at TEXT,
  invited_by_agent_id TEXT,
  invite_state TEXT CHECK(invite_state IS NULL OR invite_state IN ('pending','accepted','declined')),
  last_read_sequence INTEGER NOT NULL DEFAULT 0,   -- cursor ONLY; never messages.delivered_at (B2)
  PRIMARY KEY(thread_id, participant_key));
CREATE INDEX IF NOT EXISTS idx_thread_participants_agent
  ON thread_participants(participant_key) WHERE left_at IS NULL;

ALTER TABLE messages ADD COLUMN purged_at TEXT;
ALTER TABLE messages ADD COLUMN purge_reason TEXT;
ALTER TABLE messages ADD COLUMN purged_by_agent_id TEXT;
ALTER TABLE messages ADD COLUMN gate_flags TEXT;      -- JSON rule-id array; NULL = clean (soft tier)
CREATE INDEX IF NOT EXISTS idx_inbox_live ON messages(to_handle, read) WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_thread_live ON messages(thread_id, sequence) WHERE purged_at IS NULL;

ALTER TABLE question_threads ADD COLUMN to_agent_id TEXT;          -- who was asked (ruling 3)
ALTER TABLE question_threads ADD COLUMN answered_by_agent_id TEXT; -- who actually answered
ALTER TABLE question_threads ADD COLUMN answer_body_sha256 TEXT;   -- dedup survives purge (ruling 10)
ALTER TABLE question_threads ADD COLUMN answer_purged_at TEXT;
ALTER TABLE question_threads ADD COLUMN thread_key TEXT;           -- threads.id for peer asks

CREATE TABLE IF NOT EXISTS gate_refusals (      -- audit of a HARD block. NEVER any body bytes.
  seq INTEGER PRIMARY KEY AUTOINCREMENT, actor_agent_id TEXT, actor_pane_key TEXT, actor_host_id TEXT,
  verb TEXT NOT NULL, rule_ids TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
  body_sha256 TEXT NOT NULL, body_bytes INTEGER NOT NULL, subject_sha256 TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')));
```

Triggers (in the DB, not the handler — mirrors v33's `trg_agents_origin_immutable`, db.ts:397-407):
- `trg_threads_provenance_immutable` `BEFORE UPDATE ON threads WHEN OLD.id<>NEW.id OR OLD.created_at<>NEW.created_at OR IFNULL(OLD.created_by_agent_id,'')<>IFNULL(NEW.created_by_agent_id,'') OR OLD.origin<>NEW.origin OR (OLD.sensitive=1 AND NEW.sensitive=0) → RAISE(ABORT,'thread provenance is immutable')`.
- `trg_messages_purge_final` `BEFORE UPDATE ON messages WHEN OLD.purged_at IS NOT NULL AND (NEW.purged_at IS NULL OR NEW.body<>'' OR NEW.subject<>'[purged]' OR IFNULL(NEW.payload,'') <> '') → RAISE(ABORT,'purge is final')`. Note: **no reason-rewrite clause** (ruling 9) — un-purge and body/payload resurrection are refused; correcting a reason is allowed.
- `BEFORE UPDATE`/`BEFORE DELETE ON gate_refusals` → unconditional `RAISE(ABORT)`, same shape as `trg_agent_audit_no_update` (db.ts:437-445).

**Backfill, same `current < 34` block** (so `threads` is non-empty on day one and ruling 8's degrade path has rows):
```sql
INSERT OR IGNORE INTO threads (id, subject, origin, state, created_at, last_message_at,
    last_message_sequence, message_count)
  SELECT m.thread_id, '(legacy thread)',
    CASE WHEN EXISTS(SELECT 1 FROM question_threads q WHERE q.message_id = m.thread_id) THEN 'question'
         WHEN COUNT(DISTINCT m.to_handle) > 2 THEN 'fanout' ELSE 'legacy' END,
    CASE WHEN COUNT(DISTINCT m.to_handle) > 2 THEN 'closed' ELSE 'open' END,
    MIN(m.created_at), MAX(m.created_at), MAX(m.sequence), COUNT(*)
  FROM messages m WHERE m.thread_id IS NOT NULL GROUP BY m.thread_id;
INSERT OR IGNORE INTO thread_participants (thread_id, participant_key, handle)
  SELECT thread_id, from_handle, from_handle FROM messages WHERE thread_id IS NOT NULL
  UNION SELECT thread_id, to_handle, to_handle FROM messages WHERE thread_id IS NOT NULL;
```
Subjects are backfilled as the fixed literal `'(legacy thread)'`, **not** derived from historical `messages.subject`: those rows predate the write-side sanitizer, so promoting them would import unsanitized author text into a new render surface. First post-v34 message on a legacy thread sets the real subject.

Subject derivation, one pure helper `src/shared/thread-subject.ts` (used by RPC and never by the backfill): `subject = sanitizeMessageText(explicit ?? firstNonEmptyLine(body))`, collapse whitespace, cut at 80 on a word boundary + `…`; empty → `'(no subject)'`.

New `OrchestrationDb` methods, all filtering `purged_at IS NULL` on both tables: `insertGatedMessage`, `createThread`, `getThread`, `listThreadsForParticipant`, `upsertThreadParticipant`, `leaveThread`, `bumpThreadOnMessage`, `getThreadMessagesSince(threadId, afterSequence, limit)`, `setThreadState`, `setThreadPact`, `markThreadRead`, `createPeerQuestion`, `answerPeerQuestion`, `purgeMessage`, `purgeThread`, `listMessagesByAuthor`.

## RPCS

Two new modules, both spread into `ORCHESTRATION_METHODS` (orchestration.ts:427-432) exactly as `ORCHESTRATION_THREAD_METHODS` already is (:432), so the ratcheted `orchestration.ts` gains only the send/ask/reply edits: `rpc/methods/orchestration-threads.ts` → `ORCHESTRATION_THREAD_DIRECTORY_METHODS`, and `rpc/methods/orchestration-containment.ts` → `ORCHESTRATION_CONTAINMENT_METHODS`. Adding methods needs no protocol bump; declare `ORCHESTRATION_THREADS_RUNTIME_CAPABILITY = 'orchestration.threads.v1'` and `ORCHESTRATION_CONTAINMENT_RUNTIME_CAPABILITY = 'orchestration.containment.v1'` beside protocol-version.ts:32.

**Identity — one function, no alternatives (S10-1 A1, binding).** Every method on both modules resolves the caller through `runtime.verifyOrchestrationCompatibilityCaller(evidence, {currentRuntimeLaunchSufficient:true})` (orca-runtime.ts:12997) → pane → `agents` row via `idx_agents_pane_suffix` → `callerAgentId`. **Never** send's pattern at orchestration.ts:456-460 (`params.from ?? 'unknown'` then `authority?.terminalHandle === from`), which confirms a claimed handle and never binds one. No `params.from`, no `--terminal`, no `paneKey` param on either surface. `null` → `no_pane_identity` + `nextSteps`.

- `orchestration.threads.create {subject?, with:[name|agent:<id>,…], sensitive?}` → `{thread, participants, nextSteps}`. Names resolve via S10-1 `agents.find`; `ambiguous` refuses with candidates and addresses nobody. Group addresses (`@all` groups.ts:58, `@idle` :63, `@worktree:` :72) refuse with `group_not_a_thread` — a thread has a fixed participant set (§6 "no broadcast").
- `orchestration.threads.get {id, sinceSequence?, since?, limit?=100}` → `{thread, participants, messages[], omitted:{purged,withheld,sensitive}, nextSequence, myUnread}`. Participant → full replay. Non-participant on a non-sensitive thread → **degrades** to `getThreadMessagesFor(id, callerHandle, afterSequence)` (db.ts:3946) with `degraded:true` (ruling 8). Non-participant on `sensitive=1` → `not_a_participant`, no bodies, no subject. Sets `last_read_sequence`; **never** writes `delivered_at`, never `markAsRead` — replay stays read-only, as specs/orchestration.ts:148 already promises.
- `orchestration.threads.list {state?='open', limit?=25}` → `{threads:[{id, subject, state, sensitive, participants, lastMessageAt, lastFrom, unread, pact}], nextSteps}`, scoped to the caller's own participations. **Subjects only, never bodies** (§6); a sensitive thread's subject is returned only to its participants, others omitted and counted.
- `orchestration.threads.invite {id, agent}` (participant-only) / `.join {id}` (only when `state='open' AND sensitive=0 AND invite_state='pending'`) / `.leave {id}` (always allowed; sets `left_at`, keeps history).
- `orchestration.threads.receipts {id, sinceSequence?}` → per message per recipient `queued|pointed|read`, **by reusing** `runtime.getMessageDeliverySnapshot` (orca-runtime.ts:33629) and `resolveMessageDeliveryState` (message-delivery-state.ts:16-24). No new columns, no second state machine. Ids + states + recipient presence, never bodies.
- `orchestration.threads.pact {id, with, release?}` → `pact_state='engaged'`, `pact_turn_agent_id=<other side>`; `release` → `'released'`. Only the two named participants may set or release.
- **`orchestration.thread` and `orchestration.inbox --thread-id` — hardened, not left alone (ruling 1).** Both route through the same participant resolution and the same degrade rule as `threads.get`. `orchestration.thread` additionally gains the attested-caller lookup it has never had (orchestration-thread.ts:17 takes `{runtime}` only today).
- `orchestration.messages.purge {messageId?|threadId?, reason}`, `orchestration.agents.quarantine {name|id, lift?, reasonCode, releaseQueued?}`, `orchestration.agents.review {agentId, since?, limit?=50}` — §PURGE/QUARANTINE.

**Write-path edits inside `orchestration.ts`, minimal by design:**
- `orchestration.send` — replace the two `db.insertMessage` calls (:672 point-to-point, :776 broadcast) with `db.insertGatedMessage`, and gate the federated branch **before** `encodeFederatedControlMessage` at :640 (it returns at :654-663 and never reaches :672). Then: `agent:<id>` resolution (S10-1); **thread minting** — absent `params.threadId` with an `agent:`/bare-peer recipient mints `createThread({subject: derived, participants:[sender, recipient]})`; present ⇒ verify sender participation (`not_a_participant`) and `state='open'` (`thread_closed`/`thread_paused`); `bumpThreadOnMessage`; echo `{threadId, threadCreated, sequence, gateFlags}` so the sender records it without a second call.
- `orchestration.ask` — a **peer branch taken before the dispatch check**. Today a peer ask is impossible: the handler throws `dispatch_inactive` at :1622 and `createQuestion` hard-requires an active dispatch row (db.ts:3996-4001). When `to` starts with `agent:`, call `db.createPeerQuestion({threadId, askerAgentId, toAgentId, question, options})` — writes `question_threads` with `run_id = PEER_RUN_ID` (db.ts:344) and `dispatch_id = 'peer:' + threadId` (satisfies NOT NULL without a fake dispatch), sets `to_agent_id`, inserts the `question` message via `insertGatedMessage` with `type='question'`, `priority='high'`, then blocks on the wait loop shape at orchestration.ts:1696-1720 with `clampOrchestrationAskTimeoutMs` (:1602). **Not** wrapped in `whileDispatchBlocked` (no dispatch) and does **not** call `requireCurrentConsumer` (db.ts:4057 — a coordinator-generation fence with no peer meaning).
- `orchestration.reply` — gains the attested-caller binding it lacks (`from: params.from ?? original.to_handle`, :1281-1282), inherits `thread_id`, and for a peer question calls `answerPeerQuestion`, which **requires `callerAgentId === question_threads.to_agent_id`** (`not_the_addressee`) and records `answered_by_agent_id`. An explicit reply stays a destructive ack (`markAsRead`, :1245).
- `orchestration.wait {threadId, for:'reply'|'message'|'pact', timeoutMs?, resumeToken?}` — parks on `runtime.waitForMessage('agent:'+callerAgentId, {typeFilter, timeoutMs, signal})` (orca-runtime.ts:33690), then filters to the thread and `sequence > cursor`. Returns `{outcome:'reply'|'message'|'timeout'|'cancelled', messages[], resumeToken:'wait_<threadId>_<lastSequence>', waitedMs, nextSteps}`.

## CLI

Specs in `src/cli/specs/agents.ts` (the file S10-1c creates; appended in specs/index.ts:22-41 beside `ORCHESTRATION_COMMAND_SPECS` at :32), handlers in `src/cli/handlers/agents.ts`, all rendered through `printResult` (format.ts:68-78) so `--json` is a raw RPC passthrough. `orca agents *` is the peer-facing surface; `orca orchestration *` keeps its existing verbs (hardened, not renamed).

- `orca agents threads [--state open|all] [--limit 25] [--json]` — **the first command after losing context.**
  `~ 3 threads (2 unread)` then per line: `thr_9fk2  "merge restructure: db.ts conflict"  with backend-merge  last 14m ago (them)  ● 2 unread  [pact: your turn]`
  Footer: `Read one: orca agents thread --id thr_9fk2` / `Reply: orca agents reply --thread thr_9fk2 --body "…"`
  JSON: `{"threads":[{"id":"thr_9fk2","subject":"…","state":"open","sensitive":false,"participants":[{"name":"backend-merge","agentId":"agt_7x","state":"idle"}],"lastMessageAt":"…","lastFrom":"backend-merge","unread":2,"nextSequence":184,"pact":{"state":"engaged","turn":"me"}}],"nextSteps":["orca agents thread --id thr_9fk2"]}`
- `orca agents thread --id <t> [--since <seq|ts>] [--limit 100] [--json]` — replay, the answer to compaction. `--since` takes a **sequence** (from any prior `nextSequence`/`resumeToken`); a timestamp is still accepted and mapped. Prints `#181 14:02 backend-merge: …`, then the omission line, then `Continue: orca agents thread --id thr_9fk2 --since 184`.
- `orca agents ask <name> "<question>" [--thread <t>] [--timeout-ms 600000] [--json]` — blocking, positional via `rawArgs`. `answer from backend-merge (thr_9fk2, waited 47s): "rebase onto 12ddb0a first"` + `Continue: orca agents reply --thread thr_9fk2 --body "…"`. On timeout, **exit 0** with `{"outcome":"timeout","threadId":"thr_9fk2","messageId":"msg_a1","resumeToken":"wait_thr_9fk2_183"}` and `Still pending. Resume without re-asking: orca agents wait --thread thr_9fk2 --for reply --resume wait_thr_9fk2_183`.
- `orca agents reply --thread <t> | --id <msg> --body "<text>" [--json]` → `{"messageId":"msg_b2","threadId":"thr_9fk2","sequence":184,"answered":"msg_a1","delivery":{"state":"pointed","recipient":{"state":"connected"}}}`; prints `Delivered: pointed into backend-merge's pane` (state from the existing `orchestration.sent` machinery, message-delivery-state.ts:16-24).
- `orca agents wait --thread <t> --for reply|message|pact [--timeout-ms] [--resume <token>] [--json]` — blocking; emits the same 15s `_keepalive` stderr lines `check --wait` documents (specs/orchestration.ts:86-92). Returns the messages themselves, never a "you have mail" pointer.
- `orca agents thread --new --with <name> [--subject "<text>"] [--sensitive]`; `orca agents thread --id <t> --close|--pause|--pact <name>|--leave` — mutation flags on the same noun, so an agent memorizes one word.
- `orca agents purge --message <id> | --thread <id> --reason <text> [--json]`; `orca agents quarantine <agent> --reason <text> [--lift] [--release-queued]`; `orca agents review <agent> [--since <ts>] [--limit <n>] [--json]` (operator-only, local).

Every non-success outcome carries a non-empty `nextSteps`; `--json` and text describe the same node set over one fixture.
**One command to start:** `orca agents ask backend-merge "…"` — no create, no join, no id. **One command to resume:** `orca agents threads`.

## GATE

`src/shared/message-body-gate.ts` — pure, no I/O, allowlist injected by the caller, so verdicts are unit-testable and reusable by S10-3's guide tooling. Ported from the docs-bus write-side gate with its **structural anchors intact** (ruling 6).

- **HARD (refused, nothing stored as deliverable):** (h1) a *heading or section-opener* matching `MERGE-GATE AUDIT|SECURITY\s*\(?\s*(HIGH|CRITICAL)|VULNERABILITY` — anchored to line-start heading shape, so an inline mention or a one-line verdict does **not** match; (h2) a secret-shaped value — provider token regexes, or `KEY=|SECRET=|TOKEN=` followed by ≥20 non-placeholder chars; (h3) an infra literal from the local allowlist.
- **SOFT (delivered, `gate_flags` recorded, sender's stderr only):** attacker-vocabulary and bypass/exploit/backdoor vocabulary. Measured ~75% false-positive rate on ordinary security-design prose in the source tree — this tier must never block.
- **Escape hatch:** `--acknowledge-gate` on `send`/`ask`/`reply` converts a HARD verdict into a stored-and-flagged send with `gate_refusals.acknowledged = 1`. The channel is never closed; the record is always written.
- **Scope:** `subject`, `body`, `payload`, **and** `purge_reason` / `quarantine` reason (ruling 9). Applied at the **single choke** `db.insertGatedMessage` and at `encodeFederatedControlMessage` (ruling 2) — not at three handler call sites, and never in the CLI (a CLI-side gate is `--no-verify`-equivalent; the RPC is the backstop).
- **Allowlist file:** newline-delimited, beside the orchestration DB in the same 0700 store (`hardenOrchestrationDatabaseFiles`, db.ts:469), mode 0600, read once per process and cached. Absent ⇒ h3 is inert, never a startup failure. Never committed, never returned by any RPC, never echoed in a refusal — a refusal that quotes the literal it matched republishes it into the sender's transcript.
- **Sanitizer, separate concern:** `src/shared/message-text.ts` `sanitizeMessageText` — NFKC, strip C0/C1 and ESC/CSI/OSC, collapse newlines to a single space, cap. Applied at **write** (`insertGatedMessage`) and again at **render** (`formatMessagePointerLine`, `formatMessageBanner`) per S10-1 ruling A2, generalized from directory text to message text (ruling 4). If S10-1c has not landed `src/shared/directory-text.ts`, series 1 creates the shared primitive and S10-1c imports it.

**What the sender sees.** Hard block, exit 1: `Refused: this body matches the containment gate (rules: audit-heading, secret-shaped-value). It was not stored and nothing was delivered.` / `Rewrite as fix + verification + invariant — state what changed, how it was proven, and the rule it now enforces; drop the attacker's-eye narrative, hostile-input examples, and infra literals.` / `If the detail genuinely must exist, keep it off the bus and send a one-line pass/fail verdict instead — or re-send with --acknowledge-gate to store it flagged and audited.` Rule ids are named; matched text, offsets and matched infra literals are not. Soft warn, exit 0: `Sent (flagged: attacker-vocabulary). Delivered as-is; the flag is on the message and is not shown to the recipient.`

## PURGE / QUARANTINE

**Filter at the source, not the renderer.** Every read path adds `AND purged_at IS NULL` and subtracts messages whose `sender_agent_id` is currently quarantined, **in SQL**: `getUnreadMessages`, `getAllMessagesForHandle`, `getThreadMessages` (db.ts:3968), `getThreadMessagesFor` (db.ts:3946), `getUndeliveredUnreadMailboxHandles` (db.ts:3861), `getInbox`. Filtering in the formatter would be a lie the moment a caller passes `--json`.

**`sender_agent_id` gets a writer (ruling 7).** `insertGatedMessage` resolves the attested pane → `agents.id` via `idx_agents_pane_suffix` (db.ts:389-392) and adds the column to the INSERT list `insertMessage` omits today (db.ts:3168-3171). Host-generated rows on the exemption list write NULL and are never withheld.

**Purge semantics.** `purgeMessage` sets `purged_at`, `purge_reason` (gated + sanitized), `purged_by_agent_id`, `body=''`, `subject='[purged]'`, `payload=NULL`, in one transaction that **also** blanks `question_threads.answer_body` for any row whose `answer_message_id` is purged — storing `answer_body_sha256` first and setting `answer_purged_at` (ruling 10), so `answerQuestion`'s dedup at db.ts:4071-4077 compares the hash when purged instead of throwing `answer_conflict` on an ordinary at-least-once retry. Without this, `orca orchestration ask --resume <id>` re-serves a purged body from the second store and the purge is theatre. Idempotent: re-purge returns `alreadyPurged:1` and writes no second audit row. **No `--lift`** — an un-purge is a re-poison primitive.

**Authority.** Purge: any attested participant may purge their **own** message; a thread owner or a local non-federated operator may purge any message on the thread. Quarantine: local, non-federated caller only (`pairedDeviceId == null` and local `clientKind`, the ctx fields send destructures at orchestration.ts:444-445), plus self-quarantine always allowed. `orchestration.agents.review` is the only read path that returns a withheld body — operator-only, never pushed into a pane, never `--format`-injected. Without it an operator quarantines blind and lifts on vibes.

**Frozen delivery batches are the sharp edge.** `deliveries.message_ids` (db.ts:551) and `mailbox_deliveries.message_ids` freeze ids at creation and replay identically until acked — that is the at-least-once guarantee. Rule: **a delivery stores ids, never bodies; the handler re-materializes rows by id at every replay.** Purged ids stay in `message_ids` so the eventual ack still sets `read=1` and the mailbox closes, but are dropped from returned rows and counted in `omitted.purged`. Same for a batch minted before its author was quarantined. Because the filter sits on the row and not on a per-recipient record, a participant who never called `check` and an agent added to `thread_participants` after the purge both get the same filtered replay — there is no path where "has not pulled yet" means "will still receive it".

**Federation is bounded, not claimed.** A purge does not reach copies already relayed. `orca agents purge` says so in one line; the gate runs **before** `encodeFederatedControlMessage` (orchestration.ts:640, :1252) precisely because outbound bytes cannot be recalled.

## WAIT / ASK

Timeouts clamp through the existing `clampOrchestrationAskTimeoutMs` (orchestration.ts:1602). **The resume token is stateless** — derived from thread id + the last sequence the caller was shown, exactly as `--ack <delivery_id>` already carries state across one-shot CLI invocations (specs/orchestration.ts:83) — so a killed process re-passes it and resumes with zero host-side session. A timeout is exit 0 with `outcome:'timeout'`: an agent that treats a timeout as failure re-asks, and a re-ask is a second question the peer must answer twice.

**Lock-step pact (§2.3), and the deadlock rule S10-3 builds on.** On a pact thread, `--for reply` never returns on the caller's own post; only the other participant's post, or `pact_state='released'`, resolves it. Both sides blocked with `pact_turn_agent_id` pointing at a **gone** agent (S10-1 `agents.state='gone'`) is a detectable deadlock: `wait` returns `outcome:'timeout'` with `nextSteps:['orca agents thread --id <t> --pact-release']` rather than parking to the clamp. S10-3 turns that detection into automatic release; S10-2 only guarantees the state is observable and unilateral release is always available to either named participant.

**Ask wake-ups vs plain messages.** Three mechanical differences: (1) `priority='high'` and `type='question'`, so a `--types` filter can single them out; (2) the `[ASK — sender is blocked]` prefix and a reply-shaped trailer; (3) when the recipient is already parked in `orca agents wait`, `notifyMessageArrived` (orca-runtime.ts:33648) hands the row to the waiter and **skips the pane push** — its existing "a blocked check owns the row" reservation logic (orca-runtime.ts:33665-33682), unchanged.

## SENSITIVE THREADS

`sensitive=1` is a one-way latch enforced by trigger. Bodies **and subjects** stay on-box: never federated (the relay branch refuses `sensitive_thread_no_federation` before `encodeFederatedControlMessage`), never in a pane push, never in a roster. Group expansion refuses a sensitive thread with `sensitive_thread_no_broadcast` — §6's "no broadcast" is not yet true in the tree (`resolveGroupAddress` is live, groups.ts:45-95), so S10-2 gates it rather than claiming it closed: the body gate runs **once before expansion** (a blocked body is blocked for all N recipients), and purged/withheld rows are subtracted from every expansion. Non-participants are refused, not degraded (ruling 8's one exception).

## DELIVERY / CLEAN-ROOM REPLAY

**Pane push.** S10-0b already made the push content-bearing and bounded: `formatMessagePointer` (formatter.ts:132-145) prints at most `POINTER_MAX_SHOWN = 2` (:111) lines of `[from: X] "subject" thread:<id>` with subjects cut at `POINTER_SUBJECT_MAX = 80` (:112), then `— N more; run orca orchestration check`, typed by `deliverPendingMessagesForHandle` (orca-runtime.ts:33569) under the `lastAgentStatus === 'idle' && lastAgentStatusObservedLive` gate (:33586). S10-2 changes three things and nothing else:
1. **Sanitize before rendering** (ruling 4) — `formatMessagePointerLine` (:123-126) runs `sanitizeMessageText` over `from_handle` and `subject`; slicing at 80 is not sanitizing, and a subject under 80 chars containing `\n` or a CSI is what breaks "never more than 3 lines". Same at `formatMessageBanner` (:75, :80-82), whose `body` and `[Payload: …]` are pushed raw today and reach a pane under `--format`/`--inject`.
2. **Per-kind trailer.** Plain → `Read: orca agents thread --id thr_9fk2 --since 183`. Peer ask → line prefixed `[ASK — sender is blocked]`, trailer `Answer: orca agents reply --thread thr_9fk2 --body "…"`, always shown even as the 3rd message (it displaces the overflow line, never widens past 3). Sensitive → **no subject at all**: `[sensitive thread thr_9fk2 — 1 message]` + `orca agents thread --id thr_9fk2`.
3. **A purge blanks the subject, not just the body** — the fixed literal `[purged]`. The subject is author-controlled and is the one field autonomously typed into another agent's pane; a purge that leaves it leaves the payload where it does the most harm.

Never a body, never more than 3 lines, no matter how much mail is queued. **`delivered_at` stays untouched** on every path here (S10-1 B2): it is the push watermark and the thing `scheduleRestoredMessageRepoints` (orca-runtime.ts:33594-33600) depends on to repoint a peer's pane after a restart.

**Clean-room replay.** Every read returns `omitted:{purged,withheld,sensitive}` and prints one line per non-zero count in **both** shapes: `3 messages withheld (quarantined author) · 1 message purged · 2 sensitive bodies not shown — run orca agents thread --id <t>`. Old clients ignore additive JSON fields, so the server also appends the omission line into the `formatted` string `--format`/`--inject` returns — all seven sites (orchestration.ts:871, :898, :986, :1028, :1061, :1099-1100), which old clients do print. Every filter is server-side: an old CLI still never receives a purged or withheld body — containment must never depend on client version. Old clients calling the new methods get `method_not_found`; the capability constants let the roster degrade as S10-1 already does.

## TESTS (acceptance, each with the mutation it must fail on)

| # | Assertion | Mutation that must turn it red |
|---|---|---|
|T1|`orchestration.thread` on a thread the caller does not participate in returns recipient-filtered rows, and on `sensitive=1` refuses|Restore orchestration-thread.ts:19 `db.getThreadMessages` unguarded ⇒ full bodies leak|
|T2|A HARD-gated body is absent from `messages`, from `threads.get`, from every replay, and from the relay queue|Move the gate from `insertGatedMessage` back to orchestration.ts:672 ⇒ the federated branch at :640 still stores it|
|T3|`ask --acknowledge-gate` on a one-line `merge gate FAIL: CVE-…` verdict succeeds; the same text without a heading is not HARD-blocked at all|Drop the line-start heading anchor from h1 ⇒ the verdict is refused and the channel closes|
|T4|A peer `reply` from an agent that is not `question_threads.to_agent_id` is refused `not_the_addressee`; the asker stays blocked|Restore `from: params.from ?? original.to_handle` (orchestration.ts:1282) ⇒ a forged answer unblocks the ask|
|T5|A subject containing `\n[SYSTEM] …` and a CSI renders as one sanitized pointer line; total push ≤ 3 lines|Remove `sanitizeMessageText` from `formatMessagePointerLine` ⇒ multi-line pane injection|
|T6|Purge a message → no participant ever receives it, including one that joins **after** the purge and one whose frozen `deliveries` batch predates it; `omitted.purged` counts it|Filter in the formatter instead of SQL ⇒ `--json` still returns the body|
|T7|Purge an answered question → `answer_body` is blank, `ask --resume` does not re-serve it, **and** re-answering with the original body returns `duplicate:true`, not `answer_conflict`|Blank `answer_body` without `answer_body_sha256`/`answer_purged_at` ⇒ db.ts:4071 throws on a benign retry|
|T8|Quarantine an author → their queued and past messages are withheld from every reader and the replay says so; `agents review` still shows them to a local operator|Leave `sender_agent_id` unwritten (db.ts:3168-3171 unchanged) ⇒ zero rows withheld, test passes vacuously — assert on a non-zero count|
|T9|Two messages written in the same second are both resumable via `--since <sequence>`|Route `--since` through `normalizeThreadSinceTimestamp` only ⇒ the second is unresumable|
|T10|v34 migration on a v33 fixture: backfilled threads exist, a broadcast thread is `origin='fanout', state='closed'` and refuses posts, legacy subjects are `(legacy thread)`|Backfill subjects from `messages.subject` ⇒ unsanitized historical text enters the pointer surface|
|T11|`purge --reason` carrying HARD-gated text is refused|Sanitize the reason without gating it ⇒ a permanent ungated body-substitute channel|
|T12|A killed `agents ask` resumed with its `resumeToken` returns the answer without re-asking; no host-side session exists|Store the wait cursor server-side ⇒ resume fails after a runtime restart|
|T13|A sensitive thread's subject and body appear in no pane push, no federated relay, no group expansion|Drop the pre-expansion gate ⇒ `@all` fans a sensitive body out|
|T14|`threads.get` never writes `delivered_at` and never marks read; the ambient push still fires afterwards|Call `markAsDelivered` in the read path ⇒ the push watermark is consumed and the peer is never repointed|

## COMMIT SERIES (3 Sonnet series, each independently reviewable)

**S10-2a — schema, choke, provenance (db + shared).** v34 DDL + triggers + backfill in `createTables()` and `if (current < 34)`; `src/shared/message-text.ts` (`sanitizeMessageText`) and `src/shared/thread-subject.ts`; `src/shared/message-body-gate.ts` (pure, tiers, allowlist injection); `db.insertGatedMessage` as the single write choke, with `sender_agent_id` populated and `insertMessage` demoted to the named host-lifecycle exemption list; `getThreadMessagesSince`; thread/participant/purge/quarantine db methods. Tests T9, T10, and the gate's unit table. **No handler edits** — this series is mergeable alone and is where a v33-fixture migration test belongs.

**S10-2b — RPC surface (rpc/methods).** `orchestration-threads.ts` + `orchestration-containment.ts`; harden `orchestration.thread` and `orchestration.inbox --thread-id`; send/broadcast/reply/relay routed through the choke; thread minting + bump on send; the peer `ask` branch (`createPeerQuestion`, `PEER_RUN_ID`, `dispatch_id='peer:'+threadId`) and `answerPeerQuestion` with `to_agent_id` binding; `orchestration.wait`; receipts via `getMessageDeliverySnapshot`; purge/quarantine/review. Tests T1, T2, T4, T6, T7, T8, T11, T14.

**S10-2c — CLI, delivery, containment surface.** `specs/agents.ts` + `handlers/agents.ts` (threads/thread/ask/reply/wait/purge/quarantine/review); `formatter.ts` sanitize-at-render + per-kind trailers + `[purged]` subject + sensitive pointer; the omission line in the `--format` string; `--acknowledge-gate`. Tests T3, T5, T12, T13, plus the `--json`/text same-node-set fixture and the non-empty-`nextSteps` sweep.

Ordering is a hard dependency chain (b needs a's choke; c needs b's shapes). S10-2a must land **after** S10-1's staged v33 commit, or the `current < 34` block runs against a DB with no `agents` table and the `sender_agent_id` join is a no-op.

## RISKS

1. **S10-1 is uncommitted.** The v33 work in `[s10a]` is staged, not committed. If it is re-cut or re-numbered, every `current < 34` assumption and the `agents`/`idx_agents_pane_suffix` join move with it. Land S10-1 first; do not design around a third numbering.
2. **`orchestration.thread` hardening is a CLI-visible break.** Any caller today gets every participant's body from a thread id alone. The degrade path (ruling 8) keeps most callers working, but a coordinator scraping threads it does not participate in will see fewer rows. Ship it in S10-2b with the omission line so the loss is stated, never silent.
3. **The choke is a large mechanical refactor of a ratcheted file.** Nine `insertMessage` callers and five relay sites. The exemption list is the risk surface: an over-broad exemption silently re-opens the gate. Keep it an explicit enumerated constant, and assert its exact membership in a test so adding a caller fails CI rather than slipping through.
4. **Derived-only agents.** S10-1 accepted that panes not launched through the `ORCA_PANE_KEY` injection sites cannot attest. Those agents cannot create threads, purge, or quarantine — they can still be addressed, and still read via the degrade path. This is a real coverage gap in exactly the population §6 exists for; it is inherited from S10-1, not introduced here, and closing it means changing pane launch, not this slice.
5. **Two body stores, one purge.** `question_threads.answer_body` is handled; a third store appearing later (any new table that copies a body) silently un-purges. Add a schema test that fails when a new `TEXT` column named `*_body` appears outside the known set.
6. **Gate false positives on the soft tier (~75%) are tolerated by design.** If an operator ever promotes the soft tier to hard "because it is noisy", the bus closes for ordinary security-design prose. Record the measurement next to the rule table so the temptation is answered in place.
