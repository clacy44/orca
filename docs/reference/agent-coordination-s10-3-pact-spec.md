# S10-3 — Lock-step pact (implementation spec, rev 3 — 2026-08-30)

Owner's words: *"coordinate with the merge-restructure backend agent, in lock step"* — neither side advances past a step until the other confirms, and the agreement must be checkable tomorrow by a third party.

**Rev 2 closes the rev-1 refutation (F1-F11) under five chair rulings:** waiters are keyed by `(agent, thread)`; one engaged pact per pair plus a host-wide turn guard on `wait`; `propose` only on an unclaimed pact and no `step` while paused; `orca agents pact …` is the canonical verb family and S10-2's `--pact` flag is dropped; **every flag printed anywhere below is defined in a spec table** (swept by K18). **Rev 3 (chair, after the rev-2 re-review): the push filter joins the waiter keying (A1 names `messageTypeHasLiveWaiter` and the `deliverPendingMessages` call site; reservation is per pending row); P4' is restated as a park-ordering argument and gains the "turn arrived while parked elsewhere" wake; `getEngagedPactWith` is symmetric and the pair index covers `proposed`; quarantine withholding is read-time only (no `withheld_reason` column); accept/decline/release wake a parked proposer (`wait --for pact`); four cite drifts fixed.**

Binding upstream: design §2.3 (`agent-coordination-s10-design.md:97`) and §6 poison containment (`:156-167`, clean-room reads `:166`); `agent-coordination-s10-1-spec.md` (directory, resolver, attested identity, CONTAINMENT `:146`); `agent-coordination-s10-2-spec.md` (`threads.pact_*` `:39-41`, `threads.pact` `:114`, `wait` `:122`, the deadlock rule `:173`). Code cites re-verified in **[s10a]** `/home/ubuntu/orca-s10a` on `feat/s10-0a` (HEAD `35c40517e9`, S10-1 staged-but-uncommitted); rev 1's cites predate the tree's move and are superseded. The docs half is `orchestration-skill-guide-rewrite.md`.

## SCOPE

A pact is **host-local**. `pact --with agent:<id>@<host>` refuses `pact_not_federated` + `nextSteps`: a turn flip and its ledger append must be one `BEGIN IMMEDIATE` transaction, and S10-4 has no cross-host transaction. This spec **supersedes** `s10-2-spec:114`'s one-shot engage (propose/accept replaces it) and `:173`'s `--pact-release` spelling.

## AMENDMENTS TO S10-2 (binding — S10-3 does not land without them)

**A1 — waiters are keyed by `(agent, thread)`, not by agent.** Today `MessageWaiter` (`orca-runtime.ts:2189-2195`) carries `handle` + `typeFilter` only, `messageWaitersByHandle` (`:3083`) keys on the handle, and `notifyMessageArrived` (`:33675`) treats **any** type-matching waiter as the consumer (`:33690-33693`) and returns without the pane push. One agent in two pacts therefore *loses* a step: a `pact_step` on thr_1 wakes a park on thr_2, the RPC's own `sequence > cursor` filter finds nothing, and `deliverPendingMessagesForHandle` (`:33596`) never runs. Required edits:

- `MessageWaiter` gains `threadId?: string`; `waitForMessage(handle, {typeFilter, threadId, timeoutMs, signal, exclusive})` (`:33717`) stores it beside the rest of the waiter (`:33734-33740`).
- `notifyMessageArrived(handle, messageType, threadId?)` — the consumer predicate (`:33690-33693`) gains `&& (!waiter.threadId || waiter.threadId === threadId)`. A waiter that registered with no `threadId` still consumes everything its `typeFilter` admits.
- **Reservation is per pending row, never per notify.** `messageTypeHasLiveWaiter(waiters, type)` (`orca-runtime.ts:2210-2223`) gains a third parameter and the same conjunct — `(!w.threadId || w.threadId === threadId)` — and its call site in `deliverPendingMessages` (`:34459-34463`, the `unread` filter) passes `message.thread_id`. The `reservedTypes` snapshot at `:33701` is left as the code has it (it only matters inside the no-consumer branch, where the eligible set is empty by construction); the row-level predicate is what keeps a thr_2 waiter from reserving a thr_1 row. Without this edit the notify predicate is correct and the row is still lost one function to the right: the push re-reads the waiter set, sees a live `pact_step` waiter, filters the thr_1 row out, and returns with nothing pushed.
- The no-consumer branch is unchanged in shape and now load-bearing: **whenever no eligible waiter consumes the row, the queued `deliverPendingMessagesForHandle` push (`:33709`) still fires.** No message is both unconsumed and unpushed.
- `orchestration.wait` (`s10-2-spec:122`) passes `threadId` into `waitForMessage` instead of scoping only after the wake; the cursor filter stays where it is. The notify hook's callers pass the row's `thread_id`. K14 is the acceptance test — without A1, both F2's lost step and F1's *silent* cross-pact stall return.

**A2 — verb reconciliation. S10-2 must carry this paragraph verbatim:**

> The `--pact <name>` mutation flag listed for `orca agents thread --id <t>` (CLI §, `:136`) is **dropped**; the thread mutation flags are `--close|--pause|--leave`. The lock-step pact's entire surface is S10-3's `orca agents pact` verb family — `pact --with <name> --on <t>`, `pact --on <t> --accept|--decline`, `pact --resume --on <t>`, `pact --release --on <t>`, `pact --show <t>` — and the escape hatch printed in every refusal and every `nextSteps`, here and at `:173`, is `orca agents pact --release --on <t>`, never `thread --id <t> --pact-release`. `orchestration.threads.pact` (`:114`) keeps its RPC name and takes S10-3's propose/accept/decline/release parameters; one-shot engage is removed.

**A3 — `invite` gets a CLI spelling.** `orchestration.threads.invite` (`s10-2-spec:112`) is RPC-only today, so S10-3's sensitive-thread refusal had nothing legal to point at. S10-2's CLI § adds `orca agents invite --thread <t> --agent <name> [--json]`.

## RULINGS

1. **No CHECK rewrite, ever.** S10-2 lands `pact_state CHECK(… IN ('proposed','engaged','released'))` (`s10-2-spec:40`); SQLite cannot alter a CHECK without the table rebuild S10-2's migration test forbids. Paused ≡ `pact_state='engaged' AND pact_paused_at IS NOT NULL`. Corollary, and the F7 lesson: **every enum below must be complete at v35** — a code absent on the first landing can never be added.
2. **The ledger is its own table, not a view over messages.** Steps must survive purge; message bodies must not. So `pact_steps`: append-only, tombstoned, never deleted — and **never elided**. A reader who meets an ordinal gap it cannot explain is exactly the clean-room failure `s10-design:166` forbids, so withheld and purged rows keep their skeleton and say why.
3. **Third-party *check* ≠ third-party *read*, and the ledger is never a wider read path than its thread.** `pact --show` returns the **skeleton** (ordinal, actor `display_name`, kind, timestamp, first 12 hex of `summary_sha256`) to any **participant of the thread**, and the ≤120-char summaries only to the two pact participants and to a local non-federated caller (`pairedDeviceId == null` with a local `clientKind`, the ctx fields at `orchestration.ts:447-448`) — which has no `agents` row and is exempt from `no_pane_identity` on this read path only. A non-participant of the thread is refused `not_a_participant`, exactly as `threads.get` refuses one (`s10-2-spec:110`). `sensitive=1` → skeleton to thread participants, nothing to anyone else.
4. **One engaged pact per pair, and a parked agent holds no turn anywhere.** The two halves of the cross-pact fix (F1), proved as P4' below. The pair rule is stated on the *ordered* pair; the index normalizes it with `MIN`/`MAX` because the mirror pact (B proposing to A) is precisely the two-cycle F1 constructs.

## SCHEMA — v35, additive only

`SCHEMA_VERSION = 35`, DDL verbatim in `createTables()` **and** under `if (current < 35)`, inside the same `BEGIN IMMEDIATE` migration txn S10-2a extends (`s10-2-spec:26`). Ids from `generateId`, never caller-supplied.

```sql
ALTER TABLE threads ADD COLUMN pact_proposer_agent_id TEXT;
ALTER TABLE threads ADD COLUMN pact_steps_total INTEGER;                 -- NULL = --open
ALTER TABLE threads ADD COLUMN pact_ordinal INTEGER NOT NULL DEFAULT 0;  -- last committed step
ALTER TABLE threads ADD COLUMN pact_paused_at TEXT;
ALTER TABLE threads ADD COLUMN pact_pause_reason TEXT                    -- enum code ONLY, never free text
  CHECK(pact_pause_reason IS NULL OR pact_pause_reason IN
        ('counterpart_gone','counterpart_left','counterpart_quarantined',
         'thread_paused','thread_closed','operator'));                   -- frozen by ruling 1

CREATE UNIQUE INDEX IF NOT EXISTS idx_pact_pair_engaged ON threads(       -- ruling 4, F1
  MIN(pact_proposer_agent_id, pact_with_agent_id), MAX(pact_proposer_agent_id, pact_with_agent_id))
  WHERE pact_state IN ('proposed','engaged');                            -- rev 3: two live proposals between one pair are the same hazard

CREATE TABLE IF NOT EXISTS pact_steps (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,                 -- 0 for non-step kinds; 1..n for step
  kind TEXT NOT NULL CHECK(kind IN ('propose','accept','decline','step',
                                    'pause','resume_request','resume','release')),
  -- no who-paused column: the pausing side is the latest `pause` row's actor_agent_id (NULL = host or
  -- operator), and a resume is pending when a `resume_request` follows it with no `resume` after it
  actor_agent_id TEXT,                      -- the attested caller; never params.from
  actor_pane_key TEXT, actor_host_id TEXT,  -- NULL only on host/operator rows, rendered as `system`
  CHECK(actor_agent_id IS NOT NULL OR kind IN ('pause','resume')),        -- F6
  message_id TEXT,                          -- the step-complete message; NULL for non-step kinds
  summary TEXT,                             -- sanitized, <=120, single line; NULL once purged
  summary_sha256 TEXT NOT NULL,             -- of the sanitized text; survives purge ('' when none)
  summary_purged_at TEXT,
  turn_after_agent_id TEXT,                 -- whose turn this row produced
  reason_code TEXT,                         -- pause/release/decline only; enum, no free text
  at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX IF NOT EXISTS idx_pact_step_ordinal
  ON pact_steps(thread_id, ordinal) WHERE kind = 'step';
CREATE INDEX IF NOT EXISTS idx_pact_steps_thread ON pact_steps(thread_id, seq);
```

Triggers (in the DB, not the handler — the shape `trg_agents_origin_immutable` (`db.ts:398`) and `trg_agent_audit_no_update` (`db.ts:432`) already set):

- `trg_pact_steps_no_delete` `BEFORE DELETE ON pact_steps` → unconditional `RAISE(ABORT,'pact ledger is append-only')`.
- `trg_pact_steps_append_only` `BEFORE UPDATE ON pact_steps` WHEN any column changes **except** the ONE permitted transition — `summary → NULL` with `summary_purged_at NULL → value` (rev 3: withholding is read-time only, so no column is written on quarantine or lift; see CONTAINMENT)red — → `RAISE(ABORT)`. Written as the explicit inequality list, like `trg_messages_purge_final` (`s10-2-spec:80`).
- `trg_pact_turn_membership` `BEFORE UPDATE ON threads` WHEN `NEW.pact_state='engaged' AND (NEW.pact_turn_agent_id IS NULL OR NEW.pact_turn_agent_id NOT IN (IFNULL(NEW.pact_proposer_agent_id,''), IFNULL(NEW.pact_with_agent_id,'')))` → `RAISE(ABORT,'an engaged pact needs a turn held by a participant')`. **Load-bearing half of P4'** — in the database, so no handler edit can weaken it.
- New `OrchestrationDb` methods: `proposePact`, `acceptPact`, `declinePact`, `appendPactStep`, `pausePact`, `requestPactResume`, `resumePact`, `releasePact`, `getPactState`, `getEngagedPactWith(agentId, peerAgentId)` — **symmetric** (rev 3): matches `pact_state IN ('proposed','engaged')` with the two ids in either column order, so the mirror propose is refused at `propose` with the sentence, and the index is only the backstop, `getTurnsHeldBy(agentId)`, `getPactLedger(threadId, readerAgentId)`.

## RPCS

Added to S10-2b's `rpc/methods/orchestration-threads.ts` under the existing `orchestration.threads.v1` capability — additive methods need no protocol bump. Every one resolves identity through `runtime.verifyOrchestrationCompatibilityCaller(evidence, {currentRuntimeLaunchSufficient:true})` (`orca-runtime.ts:13015`) → pane → `agents` row via `idx_agents_pane_suffix` (`db.ts:392`). `null` → `no_pane_identity` + `nextSteps`, with ruling 3's one carve-out.

- `orchestration.threads.pact {id, with, steps?, open?, accept?, decline?, resume?, release?, reasonCode?}` — replaces `s10-2-spec:114`.
  **Propose** requires thread participation **and an unclaimed pact**: refused `pact_exists` unless `pact_state IS NULL OR pact_state='released'`, so a third thread member can never seize an engaged pact or rewrite its parties (F3); refused `pact_exists_with_peer` when `getEngagedPactWith(caller, with)` returns a row (ruling 4). `with` resolves through S10-1 `agents.find`; only `outcome:'resolved'` proceeds, `ambiguous` refuses with the candidate list and addresses nobody. Writes `pact_state='proposed'`, `pact_proposer_agent_id=caller`, `pact_with_agent_id`, `pact_steps_total` (`--steps n`) or NULL (`--open`), **`pact_ordinal=0`** so ordinals stay monotone within one pact era, ledger `propose`.
  **Accept:** only `pact_with_agent_id` → `pact_state='engaged'`, `pact_turn_agent_id=pact_proposer_agent_id` (the proposer moves first), ledger `accept`. **Decline/release:** → `'released'`, `pact_turn_agent_id=NULL`, ledger row + `reason_code`. **Resume:** authority below; clears `pact_paused_at`/`pact_pause_reason` and restores `pact_turn_agent_id` from the `pause` row's `turn_after_agent_id`. **Rev 3 — a parked proposer is woken:** accept, decline and release each resolve any waiter parked on this thread with `for:'pact'` (listed at `s10-2-spec:122`) or `for:'step'`, returning `outcome:'accepted'|'declined'|'released'` plus `nextSteps` (accepted → `orca agents step --thread <t> --done …`, you move first), on the same wake path as the auto-pause wakes below — never a park to the clamp on the success path.
- `orchestration.threads.step {threadId, done, acknowledgeGate?}` → `{ordinal, of, turn, messageId, sequence, gateFlags, nextSteps}`. Refused `not_your_turn` off-turn and **`pact_paused` whenever `pact_paused_at IS NOT NULL`** (F4). One transaction: `insertGatedMessage` (`type='pact_step'`) → `pact_steps` append → `UPDATE threads SET pact_ordinal=pact_ordinal+1, pact_turn_agent_id=<other side>`.
- `orchestration.threads.pactLedger {threadId}` → skeleton + summaries per ruling 3; `omitted:{purged,withheld}` in the S10-2 shape (`s10-2-spec:110`, `:190`).
- `orchestration.wait` gains `for:'step'` — passes `threadId` into `waitForMessage` (A1), filters `type='pact_step'` with `sequence > cursor`, plus P4's entry guard and the liveness wakes below.

## CLI

Specs and handlers extend S10-1c's `src/cli/specs/agents.ts` / `src/cli/handlers/agents.ts`, rendered through `printResult` so `--json` is a raw RPC passthrough. `pact --resume` is a boolean on the `pact` noun; `wait --resume <token>` takes a value on the `wait` noun — the spec table types them separately.

- `orca agents pact --with <name> --on <thread> [--steps <n>|--open] [--json]` → `pact proposed with backend-merge on thr_9fk2 (6 steps).` / `They accept with: orca agents pact --on thr_9fk2 --accept` / `Wait for their answer: orca agents wait --thread thr_9fk2 --for pact`
- `orca agents pact --on <t> --accept|--decline [--reason <code>] [--json]` → `pact engaged. Your turn is second; wait: orca agents wait --thread thr_9fk2 --for step`
- `orca agents step --thread <t> --done "<what>" [--acknowledge-gate] [--json]` → `step 3/6 recorded. Turn passed to backend-merge.` / `Wait: orca agents wait --thread thr_9fk2 --for step`
- `orca agents wait --thread <t> --for step [--timeout-ms <n>] [--resume <token>] [--json]` — blocking, same 15 s `_keepalive` stderr lines as S10-2's `wait`.
- `orca agents pact --release --on <t> [--reason <code>] [--json]`; `orca agents pact --resume --on <t> [--json]`; `orca agents pact --show <t> [--json]`.

```
$ orca agents pact --show thr_9fk2
pact thr_9fk2   fable-chair <-> backend-merge    engaged, 3/6, turn: backend-merge
 #   when      kind     who             what
 -   14:01:07  propose  fable-chair     6 steps
 1   14:06:12  step     fable-chair     "spec frozen at rev 2; no further column adds"
 2   14:19:55  step     backend-merge   [withheld - author quarantined - sha256 4c1e77b0a233]
 3   15:02:30  step     fable-chair     [summary purged 15:10 - sha256 9f3a1c2b7d40]
Third-party check: orca agents pact --show thr_9fk2 --json
```

**Refusal sentences (exact), all fix-plus-next-step and free of matched literals.** Quarantined either side: `Refused: a pact needs two accountable participants and backend-merge is quarantined. Lift it (orca agents quarantine backend-merge --lift) or coordinate without a pact using orca agents ask.` Sensitive-without-membership: `Refused: thr_9fk2 is a sensitive thread and backend-merge is not a participant. A pact cannot add one - invite them (orca agents invite --thread thr_9fk2 --agent backend-merge) or open a non-sensitive thread for the coordination.` Second pact with the same peer: `Refused: you already have an engaged pact with backend-merge on thr_1. One pact per pair at a time - release or finish thr_1 first (orca agents pact --show thr_1), then propose here.` Pact already claimed: `Refused: thr_9fk2 already has a pact (engaged, 3/6). Read it (orca agents pact --show thr_9fk2); a released pact can be proposed on again.` Step while paused: `Refused: this pact is paused (counterpart_gone). Resume it (orca agents pact --resume --on thr_9fk2) or release it (orca agents pact --release --on thr_9fk2).` Resume by the non-pausing side: `Requested: backend-merge paused this pact, so lifting it is theirs to confirm. They accept with: orca agents pact --resume --on thr_9fk2.`

## TURN-TAKING AND THE DEADLOCK PROOF

`pact_turn_agent_id` is a single turn token. The deadlock rule S10-2 defers to S10-3 (`s10-2-spec:173`) is discharged by four invariants:

**P1 — the token is one column, moved once per step, atomically.** `appendPactStep` performs the gated message insert, the ledger append and the turn flip in one `BEGIN IMMEDIATE`. SQLite's write lock serializes concurrent steps and the partial unique index `idx_pact_step_ordinal` turns a duplicate ordinal into a constraint failure rather than a double advance. There is no window in which both sides read "mine".

**P2 — waiting takes no lock and never writes the turn.** `wait` parks on `runtime.waitForMessage('agent:'+callerAgentId, {threadId, typeFilter})` (`orca-runtime.ts:33717`), an in-memory waiter set. A parked side cannot delay the other side's step commit — waiting is never itself blocking — and under A1 a park on one thread never swallows another thread's step.

**P3 — every park is bounded, and nothing can unbound it.** `waitForMessage` arms `setTimeout` unconditionally before registering the waiter (`orca-runtime.ts:33757-33760`). The 120 s constant (`shared/orchestration-message-wait-timeout.ts:1`) is the default for an **undefined** timeout only — `options?.timeoutMs ?? DEFAULT` at `:33732` is `??`, not `||` — and `clampOrchestrationAskTimeoutMs` (`shared/orchestration-ask-timeout.ts:5-10`) is `min(max(0,t), 1_800_000)`, which maps 0 to 0: an immediate timeout, never an unbounded park. `wait --for step` additionally **floors a supplied 0 to the 120 s default**, so a scripted `--timeout-ms 0` cannot become a hot re-ask loop against a peer (`s10-2-spec:171`: a resume returns the pending answer without re-asking (`s10-2-spec` T12). No `--forever`/`--no-timeout` exists on any verb and K7 asserts the spec table never grows one.

**P4' — no wait cycle can form: at entry a parked agent holds no turn, a turn can reach a parked agent only through its counterpart's step, and no pair has two live pacts.** Two guards, independently enforced, plus an ordering argument (rev 3 — the rev-2 wording claimed the no-turn property as *standing*, which is false: a turn can be handed to an agent that is already parked elsewhere):
- `wait --for step` **refuses at entry** whenever `getTurnsHeldBy(caller)` is non-empty — the caller's own pact included, and any other engaged pact with the same counterpart or a different one: `outcome:'your_turn'`, exit 0, `nextSteps:['orca agents step --thread <t> --done "…"']` naming every thread where the turn is held. It never registers a waiter. The check is at **entry only**; what keeps it sufficient is the ordering below.
- `propose` refuses `pact_exists_with_peer` **in both directions** (symmetric `getEngagedPactWith`, covering `proposed` and `engaged`), and `idx_pact_pair_engaged` (now `WHERE pact_state IN ('proposed','engaged')`) makes a second live pact between the same two agents a constraint failure as the backstop — never a raw abort surfaced at `--accept`.

`trg_pact_turn_membership` guarantees an engaged pact always has a turn held by one of its two participants. A waiter on a pact is therefore waiting on that pact's turn holder, and a turn holder is structurally refused a park — so **no parked agent is ever waiting on a parked agent.** The wait graph has no cycle of any length: the two-thread A/B cycle of F1 is unreachable twice over (at `propose` and at `wait`), and the n-party ring is unreachable by the same guard. **Ordering argument (the actual proof):** consider a wait cycle X1→X2→…→Xk→X1, each Xi parked and waiting on X(i+1)'s step. X(i+1) held the turn Xi is waiting on at the moment Xi parked (or acquired it later through a step by someone — which can only be Xi's counterpart in that pact, i.e. a *non-parked* actor). For X(i+1) itself to be parked it must have parked while holding no turn (entry guard) and only afterwards received the turn Xi waits on — so X(i+1) parked strictly before Xi did. Around the cycle, park times strictly decrease and return to X1: a contradiction. A cycle of any length, including the F1 two-thread case and the n-party ring, is therefore unreachable; the liveness bullet **turn arrived while parked** below turns the remaining bounded-but-useless park (an agent handed a turn while parked elsewhere) into an immediate wake.

**Deadlock — a set of agents each parked and each waiting on another member of the set — requires a wait cycle (P4': unreachable) *or* an unbounded park (P3: unreachable). Either invariant alone suffices; all are enforced, two in the database and two in the runtime, and each has its own killing mutation (K5, K7, K13).**

**Liveness — a bounded-but-useless park is still a bad outcome**, so each starving case wakes immediately with a reason instead of running to the clamp:

- Counterpart `agents.state='gone'` — S10-2 only *detects* this. S10-3 acts: the same liveness refresh `agents.list` already performs sets `pact_paused_at`, `pact_pause_reason='counterpart_gone'`, appends a host `pause` row and wakes the waiter now with `outcome:'paused'` + `nextSteps:['orca agents pact --release --on <t>']`.
- Counterpart quarantined — their step summaries are withheld (CONTAINMENT), so the pact can only starve. Auto-pause `counterpart_quarantined`, same immediate wake, reason printed.
- **Counterpart leaves the thread or the thread closes/pauses** (F7). `.leave` is *always allowed* (`s10-2-spec:112`) and `.close`/`.pause` move thread state with no regard for a pact, so a leaver is neither gone nor quarantined and would otherwise keep the turn while the other side parks to the clamp with no code that describes why. Auto-pause `counterpart_left` / `thread_closed` / `thread_paused`, same immediate wake and the same release nextStep. **A pact may not assume its parties stay in its thread.**
- **Turn arrived while parked elsewhere (rev 3).** When a step flips a pact's turn to an agent that currently has a waiter registered on a *different* thread (detectable exactly: the new turn holder appears in `getTurnsHeldBy` while `messageWaitersByHandle` holds a waiter for it), the host wakes that waiter immediately with `outcome:'turn_arrived', threadId:<the pact now waiting on it>` and `nextSteps` (`orca agents step --thread <that> --done …`). The waiter's original thread is left untouched; the agent re-parks after stepping. Without this, B (turn arrived on thr_1 while parked on thr_2) and A (parked on thr_1 waiting for B) both run to the clamp — bounded, but useless.
- Proposal never accepted — the proposer's `wait` returns `timeout` at its clamp; the pact stays `proposed` and `pact --show` says so. Nobody is blocked past one clamp.
- Parked side crashes — the resume token is stateless (`wait_<threadId>_<lastSequence>`, S10-2 WAIT/ASK) and `removeMessageWaiter` fires on both timeout and abort (`orca-runtime.ts:33745`, `:33758`), so a dead client leaves no permanent waiter and re-parks at the same cursor.
- **Release is always unilateral, always available to either participant, always recorded** — the escape hatch of last resort is never gated on the counterpart, which is the party most likely to be gone.

## PANE PUSH ON A STEP

Reuses `formatMessagePointer` unchanged in shape — `POINTER_MAX_SHOWN = 2`, `POINTER_SUBJECT_MAX = 80` (`formatter.ts:111-112`), sanitized at render in `formatMessagePointerLine` (`:131-141`, S10-2 ruling 4). Summary-first, never a body, never more than 3 lines: `[STEP 3/6 — your turn] backend-merge: "v35 DDL + triggers landed, migration test green"` / `Confirm and take yours: orca agents step --thread thr_9fk2 --done "…"`. Sensitive thread → no summary at all: `[pact step 3/6 on thr_9fk2 — your turn]` + `orca agents pact --show thr_9fk2`. The push is skipped **only** when an eligible waiter — same agent **and** same thread — consumes the row, per A1; a park on another thread reserves nothing and the push fires as usual (`orca-runtime.ts:33695-33711`).

## CONTAINMENT

- **Same choke, no side door.** `--done` text is a message body: it passes `db.insertGatedMessage` and `message-body-gate.ts` like any other. A HARD verdict refuses the step, **writes no ledger row and does not flip the turn** — a gated step is not a completed step, and a pact never advances past work that was never said. The sender gets S10-2's refusal sentence (rule ids, never matched text, `s10-2-spec:153`) plus `Re-send the step with --acknowledge-gate to record it flagged and audited.` — the flag exists on `step` (CLI §) and as `acknowledgeGate?` on the RPC, so S10-2's never-closed channel (`:148`) stays open here too. `pact_steps.summary` is written only after the gate passes, `sanitizeMessageText`d, ≤120, single line; `summary_sha256` is of that sanitized text.
- **Purge keeps the row and loses the words.** `purgeMessage` on a `type='pact_step'` message, in the same transaction, sets `pact_steps.summary=NULL` and `summary_purged_at` — the S10-2 ruling-10 shape used for `question_threads.answer_body`. Ordinal, actor, timestamp and hash survive. **A purge can erase what a step said; it can never erase that the step happened** — that asymmetry is the whole "checkable tomorrow" guarantee.
- **Quarantine withholds words, never ordinals** (F5). A quarantined author's steps keep their skeleton row; the summary alone is replaced by `[withheld - author quarantined]`, subtracted **in SQL inside `getPactLedger`** and never in the renderer — the same filter-at-the-source rule S10-2 applies to the message read paths (`s10-2-spec:157`, which `pact_steps` is not on) — and counted in `omitted:{withheld}`. An ordinal is never elided: a gap the reader cannot explain is the failure ruling 2 exists to prevent. **Read-time only (rev 3):** there is no stored withholding flag; `getPactLedger` joins `agents.quarantined` at read time, so a `--lift` un-withholds every step by construction and a step authored before the quarantine but read after the lift is shown in full.
- **`summary_sha256` is a confirmation oracle and is kept deliberately.** One ≤120-char line is guessable, so a surviving digest lets a reader confirm a guessed summary a purge was meant to remove. It is what makes the step checkable tomorrow, so it is bounded rather than dropped: returned only to thread participants and the local operator, never federated, and `pact --show` prints its first 12 hex.
- **Pause, decline and release reasons are enum codes, never free text.** S10-2's T11 exists because a free-text reason is an ungated body channel; a pact must not reopen it.
- **Ruling 3 bounds the ledger, not the thread.** A step's `--done` text is an ordinary thread message, so thread participants read it in full via `orca agents thread --id` — the summary is a truncation of something they can already see. The ledger's narrower surface is not a claim about the thread's.
- Federation: none (SCOPE). Sensitive pacts: skeleton only, never in a pane push and never relayed.

## AUTHORITY

Identity is the attested caller only (`orca-runtime.ts:13015`) — never `params.from`, never a `--terminal` flag, never a client `paneKey`; send's confirm-a-claim pattern (`orchestration.ts:467-469`) is not reused on this surface for any reason. **Propose:** a thread participant, on an unclaimed pact, with no engaged pact against that peer. **Accept/decline:** `pact_with_agent_id` only. **Step, pause, release:** `pact_proposer_agent_id` and `pact_with_agent_id` only; anyone else gets `not_a_participant` + `nextSteps`. **Resume:** the pausing side (the latest `pause` row's `actor_agent_id`) unilaterally; the counterpart only after a `resume_request` the pausing side accepts with its own `pact --resume`; either participant when the pause row is a host row (`actor_agent_id IS NULL`) **and** its condition has cleared; and the local non-federated caller lifting a quarantine (`s10-2-spec:163`). Because `step` is refused while paused, the turn restore can never overwrite a completed flip (F4). A quarantined participant may not step. `pact --show` authority is ruling 3. Every propose/accept/decline/step/pause/resume_request/resume/release writes one `agent_audit` row, under the no-update trigger at `db.ts:432`.

## TESTS (acceptance, each with the mutation it must fail on)

| # | Assertion | Mutation that must turn it red |
|---|---|---|
|K1|`step` from the non-turn side is refused `not_your_turn`; ledger and `pact_ordinal` unchanged|Drop the turn check ⇒ both sides advance and lock-step is decoration|
|K2|Two concurrent `step` calls: exactly one commits, the other fails `idx_pact_step_ordinal`, `pact_ordinal` advances by 1|Split message insert, ledger append and turn flip into separate txns ⇒ double advance|
|K3|A HARD-gated `--done` stores no message, appends no ledger row, leaves the turn where it was; `--acknowledge-gate` stores it flagged and advances|Gate after the ledger append ⇒ a refused step still advances the pact|
|K4|Purge a step → `pact --show` still lists ordinal, actor, time, `[summary purged]` + hash; a quarantined author's step still lists ordinal, actor and time with `[withheld - author quarantined]`, counted in `omitted.withheld`, never a missing ordinal; `UPDATE pact_steps SET summary='x'` and `DELETE` both abort|Derive the ledger from `messages`, or drop the row instead of the words ⇒ purge/quarantine erases the record git would have kept|
|K5|`wait --for step` by the turn holder returns `your_turn` and registers no waiter (waiter-set size stays 0)|Remove the entry guard ⇒ both sides park and the pact deadlocks|
|K6|Counterpart flipped to `state='gone'` → the parked side wakes `outcome:'paused'`, reason `counterpart_gone`, far inside the clamp|Keep S10-2's detect-only behaviour ⇒ a 30-minute silent park|
|K7|No unbounded / `0`-means-forever timeout exists on `wait` in the spec table; `--timeout-ms 0` floors to 120 s; every pact park is clamped|Add `--no-timeout`, or pass 0 through ⇒ P3 falls and mutual waiting or a hot re-ask loop becomes reachable|
|K8|`--with` a quarantined agent, and `--with` a non-participant on a `sensitive=1` thread, both refuse with the exact sentences; `pact_state` stays NULL|Refuse only at `step` time ⇒ a pact is recorded that can never run|
|K9|A thread participant outside the pact gets ordinals/actors/times/hashes and zero summaries; a pact participant gets summaries; a **non-participant of the thread** is refused `not_a_participant`, sensitive or not|Return the skeleton to any attested caller ⇒ the ledger is a wider read path than `threads.get`|
|K10|The step pane push is ≤3 lines, summary cut at 80 and sanitized; a sensitive pact pushes no summary|Skip `sanitizeMessageText` on the step trailer ⇒ multi-line pane injection (S10-2 T5's shape)|
|K11|`pact --release` from either side, in any state including paused, succeeds and appends a `release` row; a third party's release is refused|Require the counterpart to agree ⇒ the escape hatch needs the party that may be gone|
|K12|`--json` and text of `pact --show`, `step` and `wait --for step` describe the same node set; every non-success carries non-empty `nextSteps`|Print the ledger in text only ⇒ the third-party check is unscriptable|
|K13|**Cross-pact (F1).** A and B engaged on thr_1: `pact --with B --on thr_2` from A AND the mirror `pact --with A --on thr_2` from B are both refused `pact_exists_with_peer` with the exact sentence at `propose` (symmetric `getEngagedPactWith`); with the handler guard forced open, the insert fails `idx_pact_pair_engaged`; a `proposed` (not yet accepted) pact between the pair blocks a second proposal the same way|Check only the ordered pair, or index only `engaged` ⇒ the mirror proposal lands and surfaces as a raw constraint abort at `--accept` with no sentence|
|K14|**Waiter keying (A1).** A parked on thr_1 and on thr_2: a `pact_step` on thr_1 resolves the thr_1 waiter only, the thr_2 waiter is still registered; and with **only** the thr_2 waiter parked, the thr_1 step reaches A's pane through `deliverPendingMessagesForHandle`|Key waiters by agent alone, or snapshot `reservedTypes` over all waiters ⇒ the step is lost, not delayed|
|K15|A third thread member's `pact --with` on an engaged pact is refused `pact_exists`; proposer, counterpart, turn and ordinal are unchanged; a re-propose after `release` resets `pact_ordinal` to 0|Allow re-propose ⇒ any thread member seizes the pact and the ledger's parties change mid-run|
|K16|A `step` during an auto-pause is refused `pact_paused`, ledger and `pact_ordinal` unchanged; `resume` by the pausing side restores the pre-pause turn exactly; `resume` by the counterpart without acceptance writes only `resume_request` and leaves the pact paused|Allow a paused step, or a unilateral counterpart resume ⇒ the turn rolls back over a committed step and both sides read "mine"|
|K17|The v35 `pact_pause_reason` CHECK admits all six codes; a counterpart's `.leave`, and a thread `--close`, each auto-pause with `counterpart_left`/`thread_closed` and wake the parked side immediately|Ship five codes ⇒ ruling 1 makes the sixth unaddable and a leaver starves the other side unexplained|
|K18|Every flag appearing in any pact refusal sentence, `nextSteps` entry or pane trailer exists in a CLI spec table (S10-2's as amended, or S10-3's) — a fixture sweep over all printed strings|Print a flag no spec defines ⇒ the agent copies out an escape hatch that does not run (the F8 defect)|
|K19|**Turn arrived while parked.** B parked on thr_2 (pact with C); A steps on thr_1 (pact with B) handing B the turn: B's thr_2 waiter wakes within the same tick with `outcome:'turn_arrived', threadId:'thr_1'` and `nextSteps` naming `step --thread thr_1`; A's later `wait --thread thr_1 --for step` is not refused and returns when B steps|Drop the turn-arrival wake ⇒ B and A both park to the clamp while B holds a turn nobody can take|
|K20|**Proposer wake.** Proposer parks `wait --thread thr --for pact`; counterpart `--accept` → wake `outcome:'accepted'` + `nextSteps` (step first) inside the same tick; `--decline` → `outcome:'declined'`, pact `released`; the same waiter is also resolved by `--release`|Resolve only `pact_step` messages ⇒ the proposer sleeps to the clamp holding a turn on the success path|
|K21|**Push filter keying (A1, rev 3).** With only a thr_2 waiter parked, a `pact_step` row on thr_1 for the same agent is pushed into its pane by `deliverPendingMessages` (the `unread` filter keeps it); with a thr_1 waiter parked, the same row is consumed by the waiter and not pushed|Leave `messageTypeHasLiveWaiter` type-only ⇒ the thr_1 row is filtered out and neither returned nor pushed|

## COMMIT SERIES (2 Sonnet series, each independently reviewable)

**S10-3a — schema, ledger, RPC, and the S10-2 waiter amendment.** A1's `MessageWaiter`/`waitForMessage`/`notifyMessageArrived` edits and the `orchestration.wait` `threadId` pass-through; v35 ALTERs, `idx_pact_pair_engaged`, `pact_steps` and the three triggers in `createTables()` and `if (current < 35)`; the twelve `OrchestrationDb` pact methods; `orchestration.threads.pact` propose/accept/decline/resume/release, `orchestration.threads.step`, `orchestration.threads.pactLedger`; `wait --for step` with the host-wide turn guard and the liveness wakes; the purge and quarantine hooks into `getPactLedger`. Tests **K1-K9, K11, K13-K17**. No CLI files touched.

**S10-3b — CLI, ledger rendering, pane trailer.** `pact` and `step` in `src/cli/specs/agents.ts` + `src/cli/handlers/agents.ts` (including `--acknowledge-gate` and A3's `invite`); `--for step` on `wait`; the `pact --show` renderer; the per-kind step trailer and its sensitive form in `formatter.ts`; the `--json`/text parity fixture, the `nextSteps` sweep and K18's printed-flag sweep. Tests **K10, K12, K18**. Ordering is a hard chain: 3b needs 3a's shapes, and 3a must land after S10-2a (with A1-A3 in it), or `if (current < 35)` runs against a DB with no `threads` table and every `pact_*` ALTER fails.

## RISKS

1. **S10-2 is not merged, and rev 2 now amends it.** Every `pact_*` column is spec, not schema, and A1-A3 change files S10-2 owns. Land S10-2 first with the amendments in it; do not fork the waiter contract across two series.
2. **Auto-pause inherits liveness quality.** `agents.state='gone'` is derived from the terminal roster; a false `gone` pauses a healthy pact. Pause is cheap and reversible while a false `live` costs one clamp — the asymmetry is deliberate, but liveness bugs will surface here first.
3. **Turn-taking assumes exactly two parties.** One token and `--steps <n>` do not generalize to three; a three-way pact needs a different token and is not a flag away. Refuse it rather than half-ship it.
4. **P4' is a real usability cost, deliberately paid.** An agent holding a turn cannot *begin* a park anywhere: it must step first. A turn that arrives while it is already parked wakes it (`turn_arrived`) rather than stranding it. Softening the entry guard back to per-pact scope reopens the F1 ring; the ordering argument above is the invariant, the entry guard is how it is enforced.
5. **The guide half decides adoption.** The pact is unreachable if `## When To Use` still has no entry for two peers coordinating as equals (`skill-guides/orchestration.md:38-42`) and `:143` still frames peer messaging as a degraded precursor. Shipping 3a+3b without the docs half under-delivers exactly as design §5(v) warns.
