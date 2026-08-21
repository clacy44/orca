# A1 — Ranked Failure-Mode Inventory

Orca fork, orchestration-resilience program. Repo: `/home/ubuntu/orca-fed-rebase`, branch `feat/federation-1.4.185` @ `3e52508383`.

Sources: seven investigation lanes plus an adversarial verification pass over every finding. Where a lane and its verdict disagreed, the code was the referee and the verdict wins. Evidence grades on every load-bearing claim: **[measured]** = observed in the field log, **[code-verified]** = read at the cited line in this repo, **[inferred]** = reasoned from code or field shape, not observed. Verdict status is marked **[confirmed]** / **[adjusted]** / **[refuted]**.

Nothing in this inventory was executed. No builds ran, no `orca` CLI was invoked, no repo file was modified.

---

## 1. Executive summary

Coordination does not die from one bug. It dies because the system has a delivery layer that silently drops one whole class of message, an observation layer that reports write-receipts as progress, and a reporting layer that discards the diagnostics it already computes. Each layer alone is survivable; together they make every failure look identical to a healthy long-running worker.

The single largest finding is also the cheapest to fix, and three independent lanes found it separately: the runtime already implements ambient "you have mail" delivery — notice text, batching, debounce, single-flight, watermark, pull-wins arbitration — and it is structurally unreachable for `dispatch:<id>`, the only mailbox a supervised worker reads and the exact address the skill guide tells coordinators to use. The fix is a resolution branch and two deleted guards, entirely wire-neutral.

Second: `state: ready, stage: input_accepted` is a receipt that bytes reached a pseudo-terminal, and nothing looks at that terminal again for the life of the dispatch. Third: the only stale-heartbeat evaluator in the codebase lives in a loop the taught workflow never starts, and emits to a discarded log.

Beyond that, most items are unrendered signals rather than missing ones. `workerMail`, `sync`, `last_heartbeat_at`, `agentStatus`, `waitInterrupted` and `replayed` all exist and reach nobody. That is the cheapest tranche of value in the inventory.

One candidate fix was fully refuted (agent trust preflight — it already ships and is already wired), and three field-supported claims were narrowed. Those are in the appendix; negative results saved real implementation effort.

---

## 2. THE RANKED INVENTORY

Ranking = (field frequency of killing real coordination) × (silence — does it rot quietly or fail loud) × (breadth — local *and* federated) ÷ (fix cost).

---

### 1. Dispatch mailboxes have no push path
**[confirmed] · merged from three independent lanes · effort: S**

*A coordinator's mid-dispatch follow-up to a supervised worker is never announced on any platform, local or federated: `send --to dispatch:<id>` returns `accepted: true`, the row lands in SQLite, nothing writes to the worker's terminal, and the mail sits unread until the worker voluntarily runs `orchestration check` — which nothing schedules.*

**MECHANISM.** The runtime already implements the whole ambient-notice mechanism the owner proposed. `formatMessagePointer` (`orchestration/formatter.ts:111-114`) builds the one-line notice; `deliverPendingMessages` (`orca-runtime.ts:33114-33305`) writes it into the recipient's PTY and submits it. Three gates exclude worker mailboxes from that path:

1. `deliverPendingMessagesForHandle` (`orca-runtime.ts:32371-32382`) resolves a mailbox to a terminal in exactly two ways — the handle is itself live in `this.handles`, or it starts with `run:` and the Run's `coordinator_handle` is live. `dispatch:ctx_…` satisfies neither, so the function returns at `:32379` without touching a PTY. **[code-verified — read at HEAD]**
2. `notifyMessageArrived` (`:32428`) guards the 2s repoint scheduler with `if (!handle.startsWith('dispatch:'))`. **[code-verified]**
3. `scheduleRestoredMessageRepoints` (`:32401`) applies the same exclusion, so a runtime restart does not repair it either. **[code-verified]**

The idle-edge trigger `deliverPendingMessagesForLeaf` (`:32415-32424`) covers only the leaf's own handle and `run:<id>` where that pane is the Run's coordinator; `runsBoundToPane` matches `coordinator_pane_key` only (`orchestration/db.ts:2450-2463`), so a worker pane has no Run mailbox to fall back on. The federated path is identical on the peer: imported coordinator mail is stored as `to = dispatch:<id>` (`federation-control-message.ts:62, 82-92`) and the peer calls `notifyMessageArrived('dispatch:'+id, …)` (`orchestration-federation-relay.ts:203`) into the same dead end.

Net effect is an inversion: mail sent to a worker's *terminal handle* gets ambient delivery; mail sent to its *Dispatch* does not — and `skill-guides/orchestration.md:141` instructs coordinators to use `dispatch:<id>` and explicitly not the terminal handle.

**EVIDENCE.**
- Field **[measured]**: `COORDINATION.md:11-16` — two coordinating agents hand-rolled a git branch as a message bus with a 60-second poll, restated three times (`:55`, `:88`, `:200`), because nothing told an agent that mail arrived. `:205` records a crossed reply. `:226-231`: `send --to dispatch:ctx_7811d1d68d42` returned `accepted: true`; the coordinator then wrote "Worker-side receipt still being read" and confirmation arrived ~11 minutes later bundled in `worker_done` (`:339-351`). The round trip closed only because the task spec told the worker to read its mail.
- Docs **[code-verified]**: `docs/reference/cross-runtime-federation.md:90` frames follow-ups as "delivered to the worker's next `orchestration check`" — pull-only by design.
- Contract **[code-verified]**: `skill-guides/orchestration.md:141`, `:227-228` steer every follow-up onto the address with no push, while `preamble.ts:128-129` gives `check` no cadence and `preamble.ts:155-176` forbids a settled worker from polling.
- Verdict correction: for a **federated** dispatch the home never reaches `orchestration.ts:690` at all — send takes the relay branch (`:576-621`) and returns `{relay:{accepted:true}}` with no local insert. `:690` is the *local* dispatch mail path. The peer-side dead end is `orchestration-federation-relay.ts:203`.

**CHEAPEST STRUCTURAL FIX.** Add a third branch to `deliverPendingMessagesForHandle` (`orca-runtime.ts:32371`): strip the `dispatch:` prefix and resolve the worker terminal from data already persisted — `getDispatchContextById(id).assignee_handle` (`types.ts:269`), `getWorkerDispatch(id).agent_terminal_handle` (`types.ts:152`), or peer-side `getRemoteDispatchAttachment(id).terminal_handle` (`db.ts:4727`, `types.ts:202`). Drop the two `dispatch:` guards at `:32401` and `:32428`. Add one new gate the existing paths don't need: point only while the dispatch is `pending`/`dispatched`, so a settled worker is never poked and the preamble's stop-after-`worker_done` rule stays intact.

Everything else is reused unchanged: notice text and batching (`formatter.ts:111-113`), the 2s per-handle debounce (`mail-pointer-repoint-scheduler.ts:1-21`), per-PTY single-flight with parking (`orca-runtime.ts:33058-33087`), the watermark and pointed-id de-dup (`:33175-33183`, `:33260-33269`), pull-wins arbitration against a blocked `check --wait` (`:32442-32465`), the dead-PTY liveness probe (`:33193-33245`), and the idle + `lastAgentStatusObservedLive` gate (`:32390`).

**Lives in:** `src/main/runtime/orca-runtime.ts`, one function plus two deleted conditions.

**Wire-compat posture:** fully neutral. No RPC params, response fields, stream opcodes or published content change. Each runtime already receives its own `notifyMessageArrived('dispatch:<id>', …)` and resolves the terminal from its own database, so a patched host federates unchanged with an unpatched peer. No capability negotiation, no `RUNTIME_PROTOCOL_VERSION` bump. SSH-remote and daemon-hosted PTYs use the same `ptyController.write` path already handled at `:33213-33220`.

**Test approach:** extend `orca-runtime.test.ts` (which already covers push-on-idle for terminal and `run:` mailboxes at ~`:34505-34600`) with a dispatch case asserting the pointer text then the submit. **Negative controls, all asserting zero writes:** a live `check --wait` waiter on that dispatch (pull must win); `lastAgentStatus === 'idle'` with `lastAgentStatusObservedLive === false` (cold-restore seed); a bare-shell leaf with a null agent status; a settled dispatch; a Cursor target (text without auto-Enter); a repeat trigger for the same rows (watermark suppresses); a `dispatch:` id resolving to no live terminal (must return cleanly, not throw). Add a federated case in `orchestration-federation-control-mail.test.ts` asserting peer-side import reaches the worker's PTY and a duplicate import writes nothing.

**Caveat.** The exclusions were introduced deliberately in `8460a63c61` and read as the author avoiding a repoint that could never resolve — consequence, not cause. Whether supervised workers were ever *intended* to get no ambient delivery is **[inferred]**; no design doc states it either way. Separately, `docs/reference/federation-live-test-findings.md:78-91` **[measured]** records a Linux/AppImage host where the runtime's own prompt-submit did not land within 90s, so this fix reduces latency dramatically where the PTY write path works and changes nothing where it does not. That is the reason to ship the contract-side cadence fix (§3) alongside it.

---

### 2. `ready` is a write-receipt, and nothing observes the worker after it
**[confirmed] · merged: ready-is-a-write-receipt + no-post-ready-observer + submit-gap-stall-class · effort: M**

*A coordinator reads `state: ready, stage: input_accepted` and waits forever on a worker whose agent never took a turn — and if the worker becomes blocked at any point afterwards it stays `ready` permanently, because the runtime stops looking at its terminal the moment the dispatch prompt is written.*

**MECHANISM.** Two halves of one hole.

*The receipt.* The last act of `worker-start` before stamping readiness is `await runtime.sendTerminalAgentPrompt(terminalHandle, preamble)` (`orchestration-workers.ts:234`). That resolves once `ptyController.write` returns true for every paste chunk and the submit suffix (`orca-runtime.ts:17635-17671`); its only failure modes are a thrown `suffixFailureError` or `terminal_not_writable` (`:17663-17671`). The very next statement is `db.markWorkerDispatchReady(...)` (`:241`), which unconditionally executes `UPDATE worker_dispatches SET state = 'ready', stage = 'input_accepted'` (`db.ts:4327-4331`). Nothing reads the terminal back. The federated peer mirrors it exactly (`orchestration-federation.ts:228` → `:247` → `db.ts:4856-4858`). A Claude-only render gate is awaited before the submit (`orca-runtime.ts:17673`), but it proves a render, not an accepted turn. **[code-verified]**

*The observer.* The worker lifecycle contains exactly one readiness observation — `waitForTerminal(condition:'tui-idle')` at `orchestration-workers.ts:197` — and it runs *before* the prompt is sent. After `markWorkerDispatchReady` the only thing armed is `monitorWorkerSetup` (`:242`), which watches the **setup** terminal and returns early unless a `role:'setup'` effect exists (`orchestration-worker-topology.ts:226-232`). For a local dispatch no timer revisits the worker's agent state at all; for a federated one, `tickOrchestrationFederationRelay` (`orca-runtime.ts:4882`) polls only `orchestration.federationPull` (`federation-sync.ts:79`) — no terminal observation crosses on a timer. `worker-show` inspects the terminal only when someone calls it (`orchestration-worker-control.ts:126`). **[code-verified]**

*Two distinct stall causes, one signature.* The trust gate (F5) and the measured Linux/AppImage submit gap are cause-independent instances of the same green-while-dead surface, which is why the fix must classify on observed behavior rather than on gate text.

**EVIDENCE.**
- **[measured]** `federation-live-test-findings.md` F5 (40-47): the gate "fires before the agent gets a turn, while `worker-show` reports `state: ready, stage: input_accepted` — i.e. it hangs indefinitely and looks green." `COORDINATION.md:268`: "the Run looks perfectly healthy while the worker is deadlocked."
- **[measured]** `federation-live-test-findings.md:78-91`: Windows/installed self-submits hands-off (~20s, 2/2); a hands-off Linux/AppImage local worker, `--agent claude`, no trust gate present, zero input, "stayed `source: terminal, transcript_missing, worker: ready` for a full 90s." Serve mode and the F6 shim were eliminated as causes; OS vs packaging remains open.
- **[measured]** `COORDINATION.md:05:12 UTC`: the only way anyone could learn a worker was stuck was a human polling `worker-read` by hand.
- Contract **[code-verified]**: `skill-guides/orchestration.md:266` tells a coordinator that `ready` means "keep waiting or read bounded output", so a compliant coordinator responds to a permanent deadlock by waiting longer.

**CHEAPEST STRUCTURAL FIX.** Two pieces, both reusing existing machinery.

*(a) Post-write evidence, near-free.* Immediately after the submit in `worker-start` and the peer attach, run the zero-IO `detectTerminalWaitBlockedReason(buildTerminalWaitText(...))` (both module-private in `orca-runtime.ts`, `:36533` and `:37618`) against the terminal tail, and when it fires record it as a new optional field on the start receipt and worker row (`inputEvidence: { submittedAt, blockedReason }`). One regex pass over a buffer already in memory. Covers only gates already rendered at that instant — deliberately a partial.

*(b) A post-ready observer.* Arm a per-dispatch observer where `monitorWorkerSetup` is armed (`orchestration-worker-topology.ts:242`), watching the agent terminal, reusing the notification path that file already demonstrates (`db.insertMessage` + `runtime.notifyMessageArrived`, `:250-265`). Each lazy tick (30–60s) calls the already-implemented `runtime.getTerminalAgentStatus(handle)` (`orca-runtime.ts:17064`). Emit **only on positive evidence**, never on silence:
- `blocked_on_gate` when status is `permission` AND `dispatch_contexts.last_heartbeat_at IS NULL` (`db.ts:588`) AND `now - waitBlockedAt` (`orca-runtime.ts:10187`) exceeds a dwell well past the measured ~20s boot window (≥90s);
- `input_not_consumed` when the tail still shows the preamble and `=== TASK ===` with no subsequent agent output and no heartbeat — cause-agnostic, covers the open Linux/AppImage case;
- `worker_process_gone` when incarnation classifies `dead` (`worker-terminal-process-liveness.ts:39-62`) or the terminal reports `exited` (`orchestration-worker-observation.ts:31`) without a settlement;
- **nothing at all** for a quiet worker. Self-disarm on settlement, `worker-release` and shutdown; fire once per dispatch per breach.

**Lives in:** `orchestration-workers.ts` / `orchestration-federation.ts` (a); a new observer module next to `orchestration-worker-topology.ts` (b).

**Wire-compat posture:** (a) is one additive optional field on `workerStart` / `federationStart` / the `workerShow` worker projection — old coordinators ignore it, no version bump. Do **not** widen `RuntimeTerminalWaitBlockedReason` (`runtime-types.ts:723-729`); that union is published on `terminal.wait` to paired clients, so carry any new class in the new optional field. (b) is internal for local dispatches; for federated ones the peer enqueues into the relay queue it already owns and the message crosses on the existing `federationPull` path. The message `type` must be an existing `MESSAGE_TYPES` value — see §12 for which.

**Test approach:** drive `worker-start` against a fake runtime whose prompt write succeeds while the tail carries the captured Claude gate text, and assert the receipt names it while `state` stays `ready`. Fake-clock observer tests: one message after the dwell and exactly one across many ticks; disarm on `worker_done`, `worker-stop`, `worker-release`. **Negative controls that must produce nothing:** a spinner-titled worker quiet for 30 minutes (this is the false positive that would destroy trust in the signal — `skill-guides/orchestration.md:146` says real tasks run 15-60 minutes); a worker in the first 60s; a worker that has sent any heartbeat; a manual-permission-mode agent legitimately awaiting tool approval *after* a heartbeat; the Windows-shaped control that self-submits at t+20s. Because the submit-gap cause is open and platform-varying, test against captured tails from both Linux/AppImage and Windows/installed runs, not one synthetic fixture.

**Caveat.** Blocking `worker-start` until submission is verified was considered and rejected: the measured self-submit is ~20s, so it would add up to 20s to every dispatch and still miss later gates. The dwell threshold must not be tuned to 20s — that figure is Windows-only **[measured, n=2]** and the Linux run showed no self-submit at 90s **[measured, n=1]**.

---

### 3. No liveness evaluator on the taught path
**[confirmed] · effort: M**

*A worker that stops sending heartbeats is never detected by anything: the sole staleness evaluator lives inside the `Coordinator` class that only the legacy `orchestration.run` DAG loop instantiates, and when it does run it emits a log line the RPC caller throws away.*

**MECHANISM.** `Coordinator.tick()` calls `warnStaleDispatches()` (`coordinator.ts:213`), which queries `db.getStaleDispatches(...)` and does exactly one thing with the result: `this.opts.onLog(...)` (`:219-228`, with the explicit warn-only design note at `:218`). `onLog` defaults to a no-op (`:107`). The only non-production-adjacent construction of a `Coordinator` is `orchestration.run`'s handler (`orchestration-gates.ts:63-69`) — verified as the only non-test `new Coordinator(` in the tree — and it passes no `onLog`, so every warning is discarded. `db.getStaleDispatches` (`db.ts:6842`) has exactly one non-test caller: `coordinator.ts:221`. The supervision flow the bundled guide teaches (`run-create` → `worker-start` → rolling `check --wait`, `skill-guides/orchestration.md:145-147`) never inserts a `coordinator_runs` row and never starts that loop. The threshold is a hardcoded `HUNG_THRESHOLD_MS = 10 * 60 * 1000` (`coordinator.ts:86`), not settable per Dispatch. **[code-verified]**

Verified as *not* the problem: the underlying data is sound. `last_heartbeat_at` is written on the send path before any coordinator reads mail (`orchestration.ts:674-675` → `lifecycle-reconciliation.ts:170` → `db.ts:6833-6839`), on federated import (`db.ts:5401-5402`), and `worker-start` does reach `status='dispatched'` (`db.ts:4314-4324`), so both status guards are satisfied. **[code-verified]**

**EVIDENCE.** **[measured]** `federation-live-test-findings.md` F6 (101-103): "a broken shim means worker_done/heartbeat/ask/escalation cannot be sent — the Dispatch hangs to timeout while the coordinator sees a healthy `ready` worker." `COORDINATION.md:251`: "a federated worker's only way home is that CLI. If it cannot run, the worker cannot send worker_done, heartbeat, ask, or escalation." Every "worker went quiet" cause — broken outbound CLI (F6), trust-gate deadlock (F5), peer teardown, agent crash, genuinely slow task — presents identically.

**CHEAPEST STRUCTURAL FIX.** Move the evaluation out of `Coordinator` into the runtime and make the breach arrive as mail, not a log line.
1. Optional `livenessWindowMs` on `WorkerStartParams` (`orchestration-worker-start-schema.ts:11-30`), persisted into the existing `start_options` blob (`orchestration-workers.ts:95-111`, `db.ts:4083-4087`) — a local column, never sent to a peer.
2. One runtime-owned interval calling a per-dispatch variant of `getStaleDispatches`; on breach, `db.insertMessage({to:'run:<runId>', type:'escalation', priority:'high', payload:{dispatchId, taskId, lastHeartbeatAt, windowMs, syncHealth}})` then `notifyMessageArrived('run:'+runId, 'escalation')` — the exact insert+notify pair `ask` uses (`orchestration.ts:1530-1538`).
3. **Default-on** with a generous window (30 min, matching `ORCHESTRATION_ASK_MAX_TIMEOUT_MS`), not opt-in. F5 and F6 are precisely the runs where nobody would have opted in; an opt-in liveness contract is discipline wearing a flag. Reserve `livenessWindowMs: 0` as the explicit disable.
4. Fire once per Dispatch per breach (a `liveness_breached_at` column cleared by the next `recordHeartbeat`).
5. Do **not** auto-fail the Dispatch. `coordinator.ts:218` and `skill-guides/orchestration.md:246` both deliberately forbid destructive action on a timeout; escalation preserves that and leaves the decision with the coordinator.

**Wire-compat posture:** additive and entirely home-local. Cross-runtime clock skew is a non-issue by construction and this is a real design advantage: every `last_heartbeat_at` value is stamped by the Run home — locally by the messages table's `datetime('now')` DEFAULT (`db.ts:370`), and for federated dispatches by `new Date().toISOString()` taken on the home at import (`federation-sync.ts:252`). No peer timestamp is ever compared. New optional param on `workerStart` degrades safely against an older home. No `RUNTIME_PROTOCOL_VERSION` bump.

**Test approach:** a dispatch aged past its window produces exactly one escalation into `run:<id>` and wakes a parked `check --wait`. **Negative controls, all producing no escalation:** a worker heartbeating on the 5-min cadence; a worker blocked in `ask` for 25 minutes (**this currently fails — see §14, which must land first**); a dispatch younger than its window; a settled dispatch; a late heartbeat from a failed retry (must not clear a breach on the current dispatch); `livenessWindowMs: 0`. Skew control: import a federated heartbeat from a peer clocked ±2h and assert the window is unaffected.

**Dependencies:** requires §12 (waking lane) and §14 (exemption). Delivery presupposes §1/§4/§9 — see section 4.

---

### 4. An unacknowledged Run Delivery permanently starves the coordinator mailbox
**[confirmed, with two glosses narrowed] · effort: S**

*A coordinator that reads mail but never passes `--ack <delivery_id>` sees the same first batch forever; every later `worker_done`, escalation and question is silently invisible, and `check --wait` stops blocking — it returns the stale batch instantly.*

**MECHANISM.** `getOrCreateRunDelivery` is a strict one-outstanding-delivery-per-Run protocol. On entry it returns any existing `status='outstanding'` delivery verbatim with `replayed: true` (`db.ts:2694-2707`); `message_ids` was frozen at creation (`:2741-2752`), so newly arrived messages never join it. The query that would build a fresh batch from unread rows (`:2726-2739`) is reached only when no outstanding delivery exists. `--wait` calls `readDelivery()` *before* waiting (`orchestration.ts:814-830`) and returns as soon as an outstanding delivery exists, so the long-poll degenerates into a busy loop returning identical content. `replayed` is returned by the RPC but is absent from the CLI's result type (`cli/handlers/orchestration.ts:644-654`) and never rendered (`shared/orchestration-check-output.ts:98-108`) — a replay is textually identical to fresh mail. **[code-verified]**

Verdict narrowing: acknowledgement is *not* the only exit from `outstanding` — fencing also exits it (`db.ts:1324`, `db.ts:2496`, the latter from the pane-displacement path in §10), and `markAsRead` (`db.ts:3555`) sets `read=1` for the dispatch and terminal-handle mailboxes. The starvation mechanism is unaffected; both matter for the negative controls.

**EVIDENCE.** Field: **not exercised** — the live session moved a handful of messages and no coordinator ran a multi-delivery ack loop (`COORDINATION.md:344-347`). Contract **[code-verified]**: `skill-guides/orchestration.md:139` documents the replay contract, so today the only defense is agent discipline. Graded **[code-verified]**, frequency **[inferred]**.

**CHEAPEST STRUCTURAL FIX.** Additive visibility first, optional auto-ack second.
1. In `getOrCreateRunDelivery`, when returning an outstanding delivery, also count unread `delivery_contract='current_delivery'` rows for `run:<id>` **not** in `message_ids`, and return it as `pendingBehind`.
2. Add `replayed` and `pendingBehind` to `OrchestrationCheckOutput` (`shared/orchestration-check-output.ts:34-43`) and render `Delivery <id> [REPLAY — N newer messages are blocked behind it; acknowledge with --ack <id>]`.
3. Optional: cache the last delivery id per (runtime, run, terminal handle) and auto-supply it as `--ack` on the next `check` for the same Run — receipt of the previous response is what proves the batch was seen. Must degrade to today's behavior when the cache is unwritable; never make correctness depend on it.

**Wire-compat posture:** two additive optional result fields on `orchestration.check`; rendering is client-local. No opcode, no version bump.

**Test approach:** create a delivery, insert 3 more messages, re-call and assert `replayed:true`, `pendingBehind:3`. **Negative controls:** after `--ack`, a fresh delivery with `pendingBehind:0`; an outstanding delivery with zero newer messages reports `0` (no false alarm); a fenced consumer still throws rather than reporting a count.

---

### 5. `orchestration reply` to a federated worker is a black hole
**[confirmed] · effort: S**

*A coordinator replies to a live federated worker's escalation, gets `Sent <id>`, and the reply is written into a mailbox on the home runtime that the remote worker cannot read and that is never relayed — the worker blocks on a prompt nobody sees, while the docs say this case errors out.*

**MECHANISM.** `orchestration.reply` has two branches. The *question* branch fences federated dispatches and enqueues a `kind:'reply'` relay item (`orchestration.ts:1110-1112`, `:1119-1130`). The *generic* branch — everything not a registered question row — falls through to a bare `db.insertMessage({from, to: original.from_handle, …})` (`:1143-1150`) plus `notifyMessageArrived(original.from_handle, …)` (`:1152`). For a federated worker, imported mail is stored with `from: dispatch:<id>` (`federation-sync.ts:108`), so the reply is inserted as a plain local row addressed to `dispatch:<id>` on the **home** runtime. No federation lookup, no relay, no fence. The worker reads its mailbox on the **peer** (fed only by `orchestration.federationImport`), so a home-local row is unreachable by construction. `insertMessage` validates only `requireRun` (`db.ts:2853`). There is no code path that will ever move it. **[code-verified]**

**EVIDENCE.**
- Docs contradiction **[code-verified]**: `cross-runtime-federation.md:192-195` states that *both* `send --to dispatch:<id>` **and** `orca orchestration reply` return `dispatch_inactive` "rather than queueing an item the relay can never push." The reply half is true only for the question branch.
- Contract **[code-verified]**: `skill-guides/orchestration.md:145` points coordinators at this verb and tells them to "process the whole Delivery" — which also carries `escalation`, with no warning that replying to those is inert.
- Field: **not exercised**. The live test proved the round trip only for `send --to dispatch:<id>` and the question flow (`federation-live-test-findings.md:12-17`), which is why the doc's contrary claim went unchallenged.

**Why it ranks high despite no field instance:** it fires while the worker is perfectly healthy and `ready`, so no state field, sync counter or `workerMail` count reveals it — `workerMail.pending` stays 0 because nothing was ever queued. Both sides look green until timeout. And an agent reasoning from the runbook will actively conclude the reply was fenced-or-delivered when it was neither.

**CHEAPEST STRUCTURAL FIX.** In the generic branch (between `orchestration.ts:1141` and `:1143`), detect `original.from_handle.startsWith('dispatch:')`, resolve `db.getFederatedDispatch(dispatchId)`, and if federated apply `requireFederatedDispatchAcceptsWorkerMail` + `db.enqueueFederationRelay({direction:'to_worker', kind:'control_message', payload: encodeFederatedControlMessage({…})})` + `runtime.ensureOrchestrationFederationRelay(run.id)` — byte-for-byte the calls the send path already makes at `:590-612`. If not federated, apply the local fence from §6. One implementation note: the reply's `from` defaults to `original.to_handle`, which for imported mail is `run:<id>` — pick the coordinator handle explicitly when building the control message.

**Wire-compat posture:** additive and home-local. The relay item is an existing `kind:'control_message'` with the existing payload encoder, which peers already decode (`orchestration-federation-relay.ts:186-204`). Reuse the existing capability gate verbatim (`orchestration.ts:581-589`; peer side `:187-195`) so an old peer degrades to a crisp `capability_unsupported` instead of a silent drop — strictly better than today. Both `dispatch_inactive` and `capability_unsupported` are already in `STRUCTURED_RUNTIME_PASSTHROUGH_CODES` (`rpc/errors.ts:74, 87`).

**Test approach:** in `orchestration-federation-control-mail.test.ts`, import an `escalation` so it lands with `from_handle = dispatch:<id>`, reply from the home coordinator, and assert a `control_message` item appears in `listPendingFederationRelay(dispatchId,'to_worker')` and becomes readable via the worker-side `check`. **Negative controls:** the existing question-reply relay test still produces exactly one `{kind:'reply'}` item and is not duplicated; a reply to a non-dispatch handle still inserts a plain local message with no relay lookup; a reply on a purely local dispatch enqueues nothing; the `legacy_read_only` and `request_mismatch` guards (`:1071-1092`) still fire first.

---

### 6. Non-federated `send --to dispatch:<id>` is not fenced at all
**[confirmed] · effort: S**

*On a purely local dispatch, `send --to dispatch:<ctx>` after `worker_done` prints `Sent msg_…` and inserts a real row, but the worker's `check` has already switched to a different mailbox — the message is read by nobody and never errors.*

**MECHANISM.** `orchestration.send` fences only the *federated* target. `resolveMessageRun` throws `dispatch_not_found` only when the row is absent (`orchestration.ts:317-322`) and never inspects `status`; `federatedTarget` is undefined for a local dispatch (`:575-578`), so control skips the fenced block (`:579-622`) and lands on `db.insertMessage` (`:625-641`), which validates only `requireRun` (`db.ts:2853`). Meanwhile the recipient has moved: `check` resolves the worker's mailbox via `findActiveDispatchForAssignee`, filtering `status IN ('pending','dispatched')` (`db.ts:6663`), and settlement sets `dispatch_contexts.status` to `completed`/`failed` (`db.ts:6785-6791`), so `check` falls through to the *terminal-handle* mailbox (`orchestration.ts:990-1027`). The `dispatch:<id>` row now has no reader. **[code-verified]**

The false premise that likely explains the gap is in the source: `federation-worker-mail-fence.ts:5-6` claims the federated fence mirrors "the way the non-federated send path fences a settled Dispatch." It does not.

**EVIDENCE.** Field **[measured]**: `COORDINATION.md:280-284` records the observed error verbatim — `dispatch_inactive — "Federated Dispatch ctx_05af09b220b0 is not active."` The word *Federated* is the tell; that string can only come from the federated-only fence. Contract **[code-verified]**: `skill-guides/orchestration.md:299` teaches the fence inside the cross-server section, and `cross-runtime-federation.md:192-195` asserts it as a general property — so a coordinator running **local** workers is taught a guarantee the local code does not provide. F7 was scoped entirely to the federated case; the local path was never tested.

**Why it matters more than the federated case:** there is no error at all. The follow-up is written to durable storage, counted as sent, read by nobody. Local dispatches are the common case; federation is the exception. And it is invisible to every diagnostic — `workerMail` is not even computed for non-federated dispatches (§9).

**CHEAPEST STRUCTURAL FIX.** Add the guard where the federated one lives, immediately before the local `db.insertMessage` at `orchestration.ts:625`: when `to.startsWith('dispatch:')` and the resolved `DispatchContextRow.status` is not `pending`/`dispatched`, throw `OrchestrationError('dispatch_inactive', …)` **carrying recovery data** (§16) naming the routable alternative — the worker's terminal handle, the mailbox `check` actually reads post-settlement. The dispatch row is already in hand. Fix the false comment at `federation-worker-mail-fence.ts:5-6` in the same change.

**Wire-compat posture:** runtime-local. `dispatch_inactive` is already allowlisted and its `data` forwarded verbatim (`rpc/errors.ts:74`, `:152-158`), and the CLI already renders `data.nextSteps` (`cli/format.ts:84-87`, `:139-150`). **One genuine consideration:** this turns a previously-succeeding call into an error, visible to old clients. That is the correct trade — the old success was a lie — but it must ship as a deliberate, changelogged behavior change, not a silent tweak.

**Test approach:** positive — a send while `dispatched` still inserts and is readable via the dispatch mailbox. Negative — settle, re-send, assert `dispatch_inactive` and no new row. **Negative controls that must not regress:** `--type worker_done` / `heartbeat` are rewritten to `run:<id>` before this point (`:558-564`) and must still be accepted from a settling worker (gating them would break the very lifecycle report that causes settlement); group addresses never enter this branch; `--to run:<id>` and bare handles unaffected; the legacy `legacy_direct` path still resolves; the federated fence still produces the "Federated Dispatch …" wording so the F7 observation stays reproducible.

---

### 7. A `tui-idle` waiter can resolve `satisfied: true` while a trust gate is on screen
**[adjusted] · effort: S**

*The one gate check in the whole worker lifecycle passes while the agent sits at a folder-trust modal, so the dispatch proceeds to write a prompt into a modal.*

**MECHANISM.** `waitForTerminal(condition:'tui-idle')` has five resolution points and not all consult `detectTerminalWaitBlockedReason`:
- The synchronous fast path checks blocked first (`orca-runtime.ts:17774`, `:17858`) — correct.
- The post-registration re-check (`:17924-17958`) checks blocked (`:17934-17939`) before idle (`:17940`) — correct. *(Verdict addition; the original finding missed this path.)*
- The fallback polls check `lastAgentStatus === 'idle'` at `:32894` (leaf) and `:32979` (pty) and resolve **before** reaching the blocked check at `:32920` / `:32988`.
- The title-transition resolvers `resolveTuiIdleWaiters` (`:32834-32848`) and `resolvePtyTuiIdleWaiters` (`:32869-32883`) resolve every registered `tui-idle` waiter and never look at blocked reason at all; they fire from title ingestion on any transition to idle (`:10684`, `:10735`). **[code-verified]**

Corrected claim: **three of five** paths can resolve a blocked terminal as satisfied — the two title-transition resolvers unconditionally, and the poll only for gate text arriving *after* waiter registration. That is exactly the F5 shape (agent still booting into the gate), so the thesis survives.

"Idle" is easy to reach with a modal up: `detectAgentStatusFromTitle` returns `'idle'` for any title beginning `✳ ` (`agent-title-status.ts:186`) and its final fall-through is a bare `return 'idle'` for any recognized agent name with no spinner and no working keyword (`:225`). A static trust modal emits no spinner.

**Vocabulary is not the problem for this gate** — verified by hand against the captured text (`COORDINATION.md:140-141`, "1. Yes, I trust this folder"): `lastIndexOf('trust this')` matches at `orca-runtime.ts:37763` and the `folder` qualifier holds at `:37770`, yielding `codex-trust-workspace`, and `findDismissedStartupModalIndex` (`:37638`, Codex/Antigravity/Cursor only) cannot suppress it for a Claude pane. **[code-verified]** The failure is ordering and bypass.

**EVIDENCE.** **[measured]** `federation-live-test-findings.md` F5 (40-47): `worker-show` reads ready/input_accepted throughout, i.e. the `agent_readiness` wait did not fail with `blockedReason`. `COORDINATION.md` "CURRENT STATE — worker is stalled" carries the verbatim gate text. `COORDINATION.md:04:56 UTC` **[measured]**: both stalling dispatches had `terminal action=reused_agent_terminal` (a pane already carrying title state), while the self-submitting one had `terminal action=created`.

**CHEAPEST STRUCTURAL FIX.** Move the blocked check above the idle check in both fallback polls (`:32894/:32920`, `:32979/:32988`), and give the two title-transition resolvers (`:32834`, `:32869`) the same check the fast path already performs. A reordering plus two guards in one file, reusing `detectTerminalWaitBlockedReason` unchanged. Makes "blocked beats idle" the single consistent rule across all five paths, matching the intent already documented at `:17866-17869`.

**Wire-compat posture:** no new fields, but it **is** a change in what the host publishes on `terminal.wait`: a paired old client that previously received `satisfied: true` for a blocked terminal now receives `satisfied: false` with an existing `blockedReason` value. The projection is strictly more correct and uses only values already in the shipped union, and the CLI formatter already prints `blockedReason` verbatim (`cli/terminal-format.ts:189-190`) — but it must be reasoned about and covered by the cross-version harness rather than shipped silently.

**Test approach:** tail contains the captured gate AND `lastAgentStatus='idle'` → `satisfied:false, blockedReason:'codex-trust-workspace'` on **all five** paths; drive the title-transition path specifically by flipping status null→idle with gate text present. **Negative controls:** a genuinely idle agent at its ready prompt must still resolve satisfied on all five (this is the regression that matters — `tui-idle` is on the critical path of every worker start, so a false "blocked" breaks dispatch entirely); a Cursor pane where `findDismissedStartupModalIndex` clears a stale hit must keep resolving satisfied.

**Also fixes:** `orca terminal wait --for tui-idle` — the CLI escape hatch the guide recommends at `:352/:366/:380/:398/:424` — currently returns `satisfied: true` on a blocked terminal, so the taught workaround is not reliable either.

---

### 8. Worker and terminal mailboxes are destructive-read with no delivery/ack
**[confirmed] · effort: M*

*A worker's `check` marks coordinator mail read **inside the runtime before the response is handed to the caller**, so any dropped response — SSH hiccup, killed CLI, timeout, context truncation — consumes the message permanently, while the coordinator's send already reported success.*

**MECHANISM.** The Run mailbox has a full at-least-once protocol: outstanding Delivery row, `requireCurrentConsumer`, replay, explicit ack (`db.ts:2684-2810`). The other two mailboxes do not. The worker branch reads unread rows for `dispatch:<id>` and calls `db.markAsRead(...)` before returning (`orchestration.ts:945-947`, and again on the post-wait path at `:976-977`); the bare-terminal branch does the same (`:1010-1018`). `markAsRead` is a bare `UPDATE messages SET read = 1` (`db.ts:3550-3556`) with no delivery row and no `acknowledged_at` — there is no record that anything was owed, so nothing can replay it. `getUnreadMessages` filters `read = 0` (`db.ts:3448`), so a consumed-but-never-seen message is invisible to every later `check`. Recoverable only via `--all`, itself capped at the newest 100 rows (`db.ts:3591`) — and the agent has no reason to run it because nothing told it a message was lost. **[code-verified]**

The asymmetry is the point: the mailbox with durable delivery semantics belongs to the **coordinator**; the mailbox without them belongs to the **worker** — the side on the far end of an SSH/relay hop, where response loss is most likely.

**EVIDENCE.** **[measured]** `COORDINATION.md:343-347` records the one live worker read — a single *successful* destructive read, which is exactly the observation that cannot distinguish this bug from correct behavior. **[measured]** F6 and F11 establish that the worker-side CLI on the AppImage host was broken and that aborted worker `orca` invocations were common in that session, i.e. the worker leg is precisely where calls die mid-flight.

**CHEAPEST STRUCTURAL FIX.** Implicit ack on next read — no new verb, no agent discipline. Replace the immediate `markAsRead(ids)` with `markAsDelivered(ids)` (`db.ts:3559`, which already exists and has no non-test caller) plus a per-mailbox in-flight batch, and mark `read=1` for the previous batch at the *start* of the next `check` for that mailbox: receipt of the next request is proof the previous response landed. Return the batch id as an additive optional `deliveryId` so a caller may also ack explicitly. Keep `getUnreadMessages` returning in-flight rows so a dropped response replays, and de-duplicate by id.

**One gap to close when landing it:** a Dispatch that settles right after one check never issues a next check, so its final batch would stay `delivered` forever. Close the in-flight batch on settlement or `worker-release`.

**Wire-compat posture:** additive optional `deliveryId` on an existing result. The behavior change is compatible in the observable direction — an old client that never acks still sees each message exactly once (its next check performs the implicit ack). Identical for SSH-remote and federated dispatches because the state lives in the runtime's own DB.

**Test approach:** send to `dispatch:<id>`, check, simulate response loss by issuing no follow-up ack, check again and assert the same message returns; a third check must not return it. **Negative controls:** two distinct messages must not collapse into one batch id; `--peek` must remain non-consuming and must not open a batch; the Run mailbox path untouched (existing delivery snapshots unchanged).

---

### 9. Peer/transport death has no event, and relay health is in-memory only
**[confirmed] · merged from three lanes · effort: M**

*When a peer runtime, its host, or the tunnel dies, the home records it only in a Map plus one `console.warn` — no mailbox item, no waiter wake — so a coordinator following the documented rolling `check --wait` loop sleeps straight through it; and after any restart a peer dead for days reports `sync: null`.*

**MECHANISM.** `FederationSyncHealth` (`federation-sync-health.ts:8-12`) is written on each sync settle (`orca-runtime.ts:4790-4805`), read at `:4870`, consumed only by the backoff (`:4897-4900` → `federation-sync-health.ts:35-43`, 1s doubling to a 60s cap), deleted on disarm (`:4914`) and cleared wholesale by `stopOrchestrationFederationRelay` (`:4975`). `federated_dispatches` has no column for any of it (`db.ts:473-486`). `resumeOrchestrationFederationRelayAfterRestart` (`:4847-4867`) re-arms relays with a zeroed failure count, laundering a live outage into `never/0`. The failure is logged at most once per dispatch per arming, guarded by `orchestrationFederationWarnings` (`:4806-4809`), to the runtime console — not to any mailbox, so `notifyMessageArrived` is never called and blocked waiters never resolve. The coordinator's wait times out with `{count:0, timedOut:true}`, which `skill-guides/orchestration.md:146` tells it to treat as a checkpoint. **[code-verified]**

The only agent-reachable surface is `sync` on `workerShow`, federated branch only (`orchestration-worker-control.ts:106`); the local branch returns none (`:127-133`). And the "check `sync` before believing the state" advice exists **only** in `cross-runtime-federation.md:196-200`, which is not bundled — grep of `skill-guides/orchestration.md` returns **zero** hits for `sync`, `lastSyncAt`, `consecutiveFailures`, and grep of the generated `src/cli/bundled-skill-guides.ts` returns zero for `lastSyncAt`. **[code-verified]**

**EVIDENCE.** **[measured]** `COORDINATION.md:818-829`: the isolated laptop runtime and reverse tunnel were torn down externally; nothing in Orca emitted an event and the coordinating agent discovered it by running its own `ss`/`pid` checks and reported it out of band. `:831`: a pairing credential silently became dead. `:642`: the expected failure signal was stated up front as "worker-show will surface it as a peer error" — i.e. only on a pull the coordinator chooses to make. Docs **[code-verified]**: `cross-runtime-federation.md:196-201` already concedes "a federated worker keeps reporting `ready` even when nothing is syncing."

**CHEAPEST STRUCTURAL FIX.**
1. **Escalate on sustained failure.** When `consecutiveFailures` crosses a threshold (the backoff saturates at 60s, so ≥5 is a reasonable bound — **[inferred]** from the curve, tune against a real unreachable peer), post one `escalation` into `run:<runId>` carrying `lastError`, `lastSyncAt`, `consecutiveFailures`, then suppress until the next success. One message per outage, one on recovery. Reuses the insert+notify pair at `orchestration.ts:1530-1538`.
2. **Persist** `last_sync_at` / `last_error` / `consecutive_failures` on the `federated_dispatches` row, seed the in-memory map when a relay re-arms, and have `getOrchestrationFederationSyncHealth` fall back to it so `sync` is never null for a dispatch that has ever synced — and so the resumed relay starts from the real backoff level rather than 1s.
3. **Teach it** in `skill-guides/orchestration.md` (the bundled guide), not only the unbundled reference, and include the discriminator in the liveness-breach payload from §3 so a coordinator learns *whether the worker went silent or the transport did* without a second call.

**Wire-compat posture:** home-local. The schema change is a local orchestration-DB migration, explicitly **not** a wire version. Populating `sync` where it used to be null does change what the host publishes on an existing path, so keep it strictly widening: same field name, same shape, only more often non-null. Use an existing `MESSAGE_TYPES` value (see §12); a new type would be a schema migration on both sides plus a hard import failure on an older home.

**Test approach:** a peer refusing connections produces exactly one escalation per outage and none on recovery-then-refail within the suppression window. Persistence: write health, restart, assert `worker-show` reports the real values and the resumed relay's first interval reflects the persisted backoff. **Negative controls:** a single transient failure that succeeds on retry produces nothing; a Dispatch settling during an outage does not escalate afterwards; a purely local Dispatch never produces sync escalations; an SSH-transported peer exercises the same path as direct TCP.

---

### 10. `run-create` / `run-use` silently orphan the pane's previous Run
**[confirmed] · merged from two lanes · effort: S**

*A second `run-create` (or a `run-use` switch) from a pane that already owns a Run silently un-binds it: coordinator handle nulled, consumer generation bumped, outstanding Delivery fenced, blocked waiters returned `{count:0, cancelled:true}` — after which that Run's workers report home into a mailbox with no consumer and no pointer, and nobody is told.*

**MECHANISM.** Both bind paths call `unbindOtherRunsForPane` first: `createRun` unconditionally (`db.ts:2242`), `bindRun` for every Run except the target (`:2366`). That helper NULLs `coordinator_handle`/`coordinator_pane_key`, executes `consumer_generation = consumer_generation + 1` (`:2477`) and calls `fenceOutstandingDelivery` (`:2482`, `:2493-2499`). The generation bump makes every later `check`/`ack` from the old binding throw `consumer_fenced` via `requireCurrentConsumer` (`:2653-2662`). The RPC then cancels the prior Run's waiters (`orchestration-runs.ts:62-64`, `:108-110`) — so it *demonstrably knows* which Run it displaced — and returns only `{run, binding}` (`:65`, `:111`). The CLI prints only the new Run (`cli/handlers/orchestration.ts:487`, `:499`). Once `coordinator_handle` is NULL, `deliverPendingMessagesForHandle('run:<id>')` returns early, so the orphaned Run's later mail is never pointed at any pane. The pane match is deliberately fuzzy — suffix matching plus `isEquivalentPaneKey` so "reminted tab halves keep matching" (`db.ts:2448-2464`) — which widens what counts as "the same pane." **[code-verified]**

`{count:0, cancelled:true}` is not an error (`orchestration.ts:889`), and `skill-guides/orchestration.md:146` tells coordinators to treat `{count:0}` as a checkpoint and keep waiting. `cancelled` appears **zero** times in that guide. **[code-verified]**

**EVIDENCE.** **[measured]** `COORDINATION.md:286-288` (F8): `run-create` with no `--from` picked a pane already running the user's unrelated coordination with live inbox traffic; assessed as "Nothing broke." It looked harmless *only* because `runsBoundToPane` filters `legacy = 0` and the annexed pane held a legacy run — a normal Run in that pane would have been displaced silently. F8 shipped as a docs-only fix (`federation-live-test-findings.md:133-136`), which does not remove the class: passing `--from` does not help when the pane really is the caller's own.

**CHEAPEST STRUCTURAL FIX.** Make displacement visible. `unbindOtherRunsForPane` already enumerates the Runs it unbinds (`db.ts:2471`) — return them, surface as an additive `unboundRuns: string[]` (optionally with a `pendingUnread` count) on `runCreate`/`runUse`, and print `Warning: unbound Run <id> from this pane; its mailbox now has no consumer. Rebind with: orca orchestration run-use --id <id>`. Add a capability-gated optional `takeover` param that refuses when the pane owns a non-legacy Run with unsettled dispatches; clients omitting it keep today's behavior. One line in the guide: `cancelled: true` is not a checkpoint — re-run `run-current` before waiting again.

**Wire-compat posture:** additive optional request param + optional response array; the refusal path is gated on the param so an older client's `runCreate` behaves as today. No opcode, no version bump. Pane binding is identical for folder workspaces and git worktrees.

**Test approach:** create Run B from a pane owning non-legacy Run A → A named in `unboundRuns`, generation incremented, delivery fenced; a blocked `check --wait` on A resolves cancelled. **Negative controls:** a legacy run is not displaced and produces no `unboundRuns` (this is why the field instance looked benign); re-binding the *same* Run reports empty and does not bump the generation; a bind from a different pane lists nothing unrelated; a pane with a reminted key is still recognized as the same pane; an old client (param absent) still gets a success, not a refusal.

---

### 11. `worker-show` is a blind instrument
**[confirmed] · merged from four lanes · effort: S**

*The one surface coordinators are taught to poll returns the terminal's last-output timestamp, title, preview, connection state, the mail backlog and the dispatch row containing `last_heartbeat_at` — and its text formatter prints four fields and discards the rest.*

**MECHANISM.** Four independent omissions on one surface.
1. **Text mode drops everything.** The local handler returns `{dispatch, worker, terminal, observation, terminalResource}` (`orchestration-worker-control.ts:128-134`) where `terminal` is a full `RuntimeTerminalShow` including `lastOutputAt`, `title`, `preview`, `connected` (`shared/runtime-types.ts:451-466`, `lastOutputAt` at `:464`, maintained per PTY data chunk at `orca-runtime.ts:9945` so it is live headless). The CLI formatter emits only `${dispatch.id} task=${task_id} [${state}] stage=${stage}` plus an optional `sync:` line (`cli/handlers/orchestration.ts:947-956`); `printResult` prints that string and nothing else when `json` is false (`cli/format.ts:75`). The CLI's declared type does not even model `terminal` or `observation` (`:936-943`). **[code-verified]**
2. **`workerMail` is never rendered anywhere.** It is emitted with an explicit rationale — "report it rather than leave it undelivered and unmentioned" (`orchestration-worker-control.ts:107-109`) — and grep finds **zero** references under `src/cli`, `src/renderer`, `src/shared`, and zero in `skill-guides/orchestration.md`. The only prose is `cross-runtime-federation.md:199-201`. **[code-verified]**
3. **`workerMail` measures the wrong stage anyway.** `summarizeQueuedWorkerMail` counts `listPendingFederationRelay(dispatchId,'to_worker')` (`federation-worker-mail-fence.ts:27`) — items not yet *pushed*. Once the relay delivers and the peer imports them into its own DB (`federation-control-message.ts:82-92`), `pending` drops to 0 while the mail may sit unread on the peer indefinitely. It answers "did the transport deliver?", never "did the worker read it?" **[code-verified]**
4. **`sync` and `workerMail` are federated-only**, so a local dispatch has no liveness-shaped field at all (`orchestration-worker-control.ts:106/109` vs `:128-134`); and `last_heartbeat_at` (`db.ts:588`, `types.ts:280`), faithfully maintained on three write paths, is read by exactly one non-test consumer — the unreachable `Coordinator` loop. Grep finds it in zero docs, zero skill-guides, zero renderer files. **[code-verified]**

**EVIDENCE.** **[measured]** F5 (42-44) and `COORDINATION.md`'s F5 section: both agents quote `worker-show` as reporting exactly `state: ready, stage: input_accepted` — the two fields the formatter prints — and neither ever mentions `lastOutputAt`, `preview` or `connected`. **[measured]** `COORDINATION.md:701, 712, 752-756, 781`: the investigating agent judged liveness by eyeballing `worker-read` output four separate times and drew a wrong conclusion each time, because no cheap authoritative liveness read existed. Contract **[code-verified]**: `skill-guides/orchestration.md:266` reduces the whole result to "keep waiting."

**CHEAPEST STRUCTURAL FIX.** Presentation plus symmetry; the data already exists and is already correct.
- Extend the text formatter: a terminal line when the observation is exact (`terminal: status=<running|exited> lastOutputAt=<iso|never>`), a `liveness: lastHeartbeat=<iso> age=12m window=30m` line, and a loud `mail: pending=N deliverable=false` line only when non-zero.
- Widen the CLI's declared `dispatch` type and add `lastHeartbeatAt` / `heartbeatAgeMs` to the `workerShow` result; add the same age to `worker-list` rows so a coordinator can scan a whole wave in one call.
- Return the liveness-shaped fields from **both** branches. Put the classification on `observation` (present on both), **never** on `sync` — that field is federated-only and semantically about relay pull health (`federation-sync-health.ts:6-12`), and hanging a stall verdict on it would silently give it a second, contradictory meaning on the local branch.
- Give the local branch a mail signal keyed on read-state (`getUnreadMessages('dispatch:'+id).length`, `db.ts:3448`) with `deliverable` keyed on dispatch status. **Name it distinctly from the federated `workerMail.pending`** — one field name with two denotations (relay-queue depth vs mailbox rows) is exactly the "value whose meaning changes" hazard the wire rules warn about.

**Wire-compat posture:** formatter changes are client-local. New optional fields on an existing method are additive; old clients ignore them and a newer CLI must guard on presence, never on version — absent must render `unknown`, never `stale` or `0`.

**Test approach:** CLI snapshot tests across federated-with-sync, local-without, exact observation, `identity_changed`, exited terminal, and a never-heartbeated dispatch (must render `never`, not age 0). **Negative controls:** the field must be **absent** rather than `0` when undeterminable, so existing snapshots don't shift; a healthy result stays terse (no mail line at `pending:0`); `--json` byte-compatibility for the pre-existing federated shape; a large `preview` must not dump into text mode (the field log shows agents pasting `worker-show` output verbatim into coordination messages); a settled Dispatch reports `deliverable:false` with a non-zero unread count, since that is the stranded case worth surfacing; `--peek` must not clear the count.

**Caveat.** ISO parse must handle both the SQLite space format stored by `datetime('now')` and the offset-bearing ISO the send path writes (`db.ts:185-192`) — the same mismatch `getStaleDispatches` already works around with `julianday()` (`db.ts:6841`). Getting this wrong silently misreports on one of the two paths.

---

### 12. A stall or breach notification has no message type that wakes a waiting coordinator
**[adjusted] · effort: S · gates §2, §3, §9**

*A correctly-detected problem announced with the natural message type lands in the inbox and does not wake the waiter — the same "printed into a void" shape the watchdog was built to fix.*

**MECHANISM.** Message types are a closed set (`orchestration/types.ts:1-11`) enforced in SQL by `CHECK(type IN (...))` on the messages table (`db.ts:360-363`) and rebuilt across migrations (~`:660-663`, `:789-792`), so a new `worker_stalled` type is a schema migration on both sides plus a hard import failure on any older home receiving it over the relay — not additive. The natural existing type is `status`, which is what the one precedent for a runtime-generated notification uses (`orchestration-worker-topology.ts:250-266`). But `notifyMessageArrived` filters waiters with `!messageType || !waiter.typeFilter || waiter.typeFilter.includes(messageType)` (`orca-runtime.ts:32444-32449`), and the guide teaches `check --wait --types worker_done,escalation,question` (`skill-guides/orchestration.md:145`, `:235`, `:427`) while stating that "type filters decide when a waiter wakes" (`:140`). A `status` message therefore does not wake the waiter. **[code-verified]**

The automated `Coordinator` handles `status` by logging only (`coordinator.ts:250-251`) and its stale-heartbeat warning likewise (`:219-228`) — and that class is instantiated solely by `orchestration.run` (`orchestration-gates.ts:63`), verified as the only non-test construction, so it does not apply to the taught workflow at all.

**CHEAPEST STRUCTURAL FIX.** Send runtime-generated stall/breach notifications as `type: 'escalation'`: already in the enum and the CHECK, already in the taught filter, and already carrying the right semantics. Set `priority: 'high'`, key the payload on `dispatchId`, and enforce strict once-per-dispatch idempotence. Do not introduce a new message type. Do not broaden the recommended filter to include `status` — that floods coordinators with routine setup notices.

**Wire-compat posture:** fully additive — an existing type on an existing path. Over federation it rides `federationPull` and is imported by `importFederatedRelayItem` (`federation-sync.ts:102-118`) with a type an older home already accepts, so the DB CHECK passes.

**Test approach:** assert the emitted message is `type:'escalation'` and that a `check --wait --types worker_done,escalation,question` waiter **actually wakes** — not merely that the row exists. Exactly one message per dispatch across many ticks and across a restart that re-arms the observer. **Negative controls:** nothing for a healthy worker; nothing after settlement; nothing for a dispatch whose worker already heartbeated; the federated escalation survives the relay's contiguous-sequence import.

**Caveat.** Using `escalation` means a runtime stall shares a channel with worker-raised escalations; the payload must be unambiguous about its runtime origin so a coordinator does not attribute it to the agent. Also, `Coordinator.processEscalations` will now see machine-generated escalations for spec-driven runs — check that path for assumptions that escalations always come from an agent.

---

### 13. The runtime computes "this worker is at an interactive gate" and neither orchestration nor the CLI can ask for it
**[confirmed] · merged with the first-turn-signal finding · effort: S**

*A coordinator has no verb that answers "is my worker sitting at a prompt?", even though the runtime computes exactly that verdict on an RPC the orchestration layer never invokes and the CLI never exposes.*

**MECHANISM.** `getTerminalAgentStatus(handle)` (`orca-runtime.ts:17064-17120`) returns `{handle, isRunningAgent, status: 'working'|'permission'|'idle'|null}` and **already fuses the tail-gate detector with title status**: `detectTerminalWaitBlockedReason(terminal.waitText)` at `:17068`, returning `status:'permission'` at `:17075`/`:17084` when the gate is actionable and not cleared by a live non-permission title. It uses `waitBlockedAt`, a per-PTY "gate first seen at" timestamp stamped continuously per data chunk (`:10187`), to break ties against fresher hook evidence. Headless-capable and cross-platform (Windows conpty at `local-pty-provider.ts:~1369-1382`; SSH foreground at `ssh-pty-provider.ts:265`). It is exposed as `terminal.agentStatus` (`rpc/methods/terminal.ts:1204`), whose **only** consumer in the entire codebase is `rpc/terminal-agent-send-guard.ts:20` — a send guard, not any observability path. `inspectWorkerTerminal` reaches for `runtime.showTerminal` instead (`orchestration-worker-observation.ts:19`), which carries no status field, and grep across `src/cli` confirms no `agent-status` verb exists. **[code-verified]**

Related conflation: `ORCHESTRATION_WORKER_READ_FALLBACK_REASONS` (`shared/orchestration-worker-output.ts:8`) puts `transcript_missing` ("hasn't started yet") alongside `provider_unsupported`, `session_not_reported`, `transcript_unreadable`, `transcript_parse_failed` and `remote_capability_unavailable` — so the one field-observed discriminator cannot distinguish "not started" from "this provider never has a transcript." **[code-verified]**

**EVIDENCE.** **[measured]** `COORDINATION.md` "CURRENT STATE — worker is stalled": the coordinator diagnosed the gate only by running `worker-read` and reading the raw screen by eye, then hand-crafted a `terminal send --text "1" --enter`. F5 (47): "the coordinator has no documented verb for it." F5 closing (93-96) lists "surface a coordinator verb for the gate" as one of three requested real fixes. **[measured]** The F12 episode (`COORDINATION.md:701-739`, retracted `:764-789`, contaminated peer run `:839-847`, wrong recipe committed and reverted `:571-577`/`:791-795`) is the cost of having no machine answer: four dispatches contaminated, a wrong recipe shipped into the bundled guide, hours lost — because the intervention is not passive, and a premature `terminal send` races the runtime's own submit.

**CHEAPEST STRUCTURAL FIX.** Two small additions.
1. Have `inspectWorkerTerminal` also call `runtime.getTerminalAgentStatus(handle)` best-effort and include the verdict on the `observation` object `workerShow` already returns: `agentStatus`, `blockedSince` (from `waitBlockedAt`), plus `promptSubmittedAt` / `firstTurnObservedAt` / `startupGraceMs` and a boolean `startedFirstTurn` — the last as a separate field rather than a new `fallbackReason` value, so the existing enum on an existing path is untouched.
2. Add `orca terminal agent-status --terminal <handle> [--environment <peer>] [--json]` wired to the existing RPC, so a coordinator can ask directly and — since `--environment` already routes the whole client (`cli/index.ts:89-111`) — can ask about a federated peer's worker too.

**Wire-compat posture:** additive optional fields inside an existing `observation` object; old coordinators ignore them. The CLI verb calls an already-shipping RPC, so an older host returns `method_not_found`, which the CLI already handles as a compatibility path elsewhere (`orchestration-worker-control.ts:163-166`). `blockedSince` must be optional-and-absent when unknown, never zero. No opcode, no version bump.

**Test approach:** `workerShow` against a fake runtime whose tail holds the captured gate → `observation.agentStatus === 'permission'` with `blockedSince` set while `worker.state` stays `ready`. Hands-off dispatch on Linux and Windows with **zero keystrokes sent by the test**: `firstTurnObservedAt` null before the submit lands, set after. **Negative controls:** a genuinely mid-task worker reports `working`, not `permission`; a stale handle reports the existing `identity_changed` rather than a fabricated status; a provider with no transcript still reports `startedFirstTurn` from `agentStatus`; an older peer omitting the fields renders **unknown**, never a false "stuck"; a genuinely gated worker reports `permission` with `startedFirstTurn:false` — the two must be distinguishable; no code path introduced here writes to a terminal.

**Caveat.** `getTerminalAgentStatus` throws for stale/exited handles (`terminal_gone` `:17126`/`:17135`, `terminal_exited` `:17132`, `terminal_handle_stale` `:17146`). Every new caller must treat a throw as *unknown*, not propagate it, or `worker-show` starts failing on workers whose terminals have exited — a regression on a path that currently succeeds and reports `status:'exited'`.

---

### 14. The preamble's heartbeat exemption for `ask` / `check --wait` is not implemented
**[adjusted — the proposed fix does not deliver its own property] · effort: M · blocks §3**

*The preamble tells agents to stop heartbeating while blocked in `check --wait` or `ask` because "those calls are themselves liveness signals" — neither call records any liveness anywhere, so the best-behaved workers are exactly the ones a liveness window would falsely kill.*

**MECHANISM.** `preamble.ts:91-93` grants the exemption verbatim. A repo-wide grep confirms exactly three non-test `recordHeartbeat` call sites — `lifecycle-reconciliation.ts:170`, `db.ts:3006`, `db.ts:5402` — all reachable only from a `type='heartbeat'` message. Neither `orchestration.check` (`orchestration.ts:919`) nor `orchestration.ask` (`:1511`) touches `last_heartbeat_at`. `ask` blocks for a clamped default of 600,000 ms and a maximum of 1,800,000 ms (`orchestration-ask-timeout.ts:1-2`); `check --wait` for 120,000 ms (`orchestration-message-wait-timeout.ts:1`). The existing "stale" threshold is 10 minutes (`coordinator.ts:86`) — one third of the `ask` maximum, and exactly the duration the preamble tells a blocked worker to stay silent. **[code-verified]**

**EVIDENCE.** The codebase already understands this hazard for a different signal: `preamble.ts:19-25` refuses to populate the drift section for fresh worktrees precisely because "polluting it … would train workers to ignore it." **[code-verified]** Field: none — the preamble's exemption has never been measured. The applicable field precedent is the F12 retraction (`COORDINATION.md:781`, "Four data points, one methodology error, repeated four times") — what happens when a liveness judgment rests on a signal that does not mean what the reader assumed. **[measured]**

**CHEAPEST STRUCTURAL FIX — corrected.** The originally proposed fix (write `recordHeartbeat` on entry and again on return in `check`/`ask`) **does not work and its own positive test would fail against it**: two point writes leave `last_heartbeat_at` 20 minutes stale at t=19:59 of a 20-minute `ask`, so a 15-minute window still breaches on a perfectly healthy blocked worker. Making the documented exemption real needs one of:
- **(a)** a periodic refresh while the waiter is parked — a timer inside the `waitForMessage` / `ask` wait ticking at `HEARTBEAT_INTERVAL_MIN`; or
- **(b)** a durable `blocked_since` marker on the dispatch row that the liveness window subtracts.

(b) is cheaper and has no timer to leak; (a) is more faithful to "heartbeat" semantics. Either must reuse the existing `dispatchId` + `status='dispatched'` guard (`db.ts:6836`) so it can neither refresh a settled Dispatch nor the wrong one, and must be strictly opportunistic — never an error path — because identity resolution may be best-effort in SSH-remote, WSL and remote-run-mailbox shapes.

Do **not** extend this to the relay's own successful pull: a healthy relay proves the peer runtime is up, not that the worker agent is alive, and conflating them recreates the F6 shape (green transport, dead worker).

**Wire-compat posture:** local-only; both call sites are home-runtime handlers writing a home-local column. **Documented asymmetry to pin, not fix:** for a federated worker, `ask`/`check` execute against the *peer*, so the peer's copy updates while the home's advances only via relayed heartbeats. Either relay a periodic liveness item, or set the federated default window generously enough to cover a full `ask` (≥30 min).

**Test approach:** a worker that calls `ask` and waits 20 minutes does not breach a 15-minute window. **Negative controls, none of which may write:** `check` from a terminal with no active Dispatch; `check`/`ask` from a settled Dispatch; `ask` from a worker whose Dispatch was failed and retried (must not land on the new Dispatch's row); `--peek`/`--all` reads behave identically. **Federated control:** assert the home's `last_heartbeat_at` does *not* advance from a peer-side `ask`, so the asymmetry is pinned rather than accidental.

**Rejected alternative:** deleting the exemption and requiring heartbeats while blocked — an agent inside a synchronous CLI call cannot run another CLI call, so the instruction would be unfollowable and would teach workers that the preamble contains impossible rules.

---

### 15. Coordinator→worker mail queued before a settlement is stranded forever behind `accepted: true`
**[adjusted — mechanism corrected, fix redirected] · effort: M**

*A coordinator sends a follow-up to a federated worker, the CLI prints "Queued `<id>` for worker Dispatch `<ctx>`", and the item is never delivered, never retried, never expired, never reported.*

**MECHANISM — corrected.** The original TOCTOU claim is **refuted**: `orchestration.ts:590` (the fence) and `:598` (the enqueue) are straight-line synchronous, with only a type check and a non-awaited `revalidateLegacyCoordinator?.()` between them; in a single-threaded runtime owning the SQLite handle there is no yield point. The real, non-racy window — and the one the repo's own test pins — is **queue-while-ready, then settle before the next relay tick**. `orchestration-federation-control-mail.test.ts:214-259` sends while `state==='ready'`, settles, and asserts `listPendingFederationRelay(...,'to_worker')` is still length 1. **[code-verified]**

Once settled, `settleWorkerReportInTransaction` flips `worker_dispatches.state` (`db.ts:6808-6814`) and the push gate `state === 'ready' ? listPendingFederationRelay(...) : []` (`federation-sync.ts:174-177`) returns empty forever. The relay is never re-armed — `FEDERATION_RELAY_ACTIVE_WORKER_STATES` is `{starting, ready, stopping}` (`federation-relay-arming.ts:3`) — and settlement never inspects `federation_relay_items` (`db.ts:6815` closes pending questions only). The send response already returned `{relay:{destination:'worker', accepted:true}}` (`orchestration.ts:613-620`), rendered as "Queued … for worker Dispatch …" (`cli/handlers/orchestration.ts:617-619`). The same strand is reachable with **no race at all** via `worker-stop`/abandon paths leaving `stopping`→`stopped` (`db.ts:5605, 5635, 5782, 5818`), which the same gate skips. **[code-verified]**

**EVIDENCE.** **[measured]** `COORDINATION.md:344-350`: the proven round trip used `send --to dispatch:… → relay_465804ca24e5 (destination: worker, accepted: true)` while the worker was ready — the *same receipt* a stranded item receives, so the field's success evidence and the failure mode are indistinguishable from the sender's side. Docs **[code-verified]**: `cross-runtime-federation.md:199-201` acknowledges the state explicitly ("`deliverable: false` with a non-zero `pending` means that mail was stranded by a settlement that landed first") and provides no recovery.

**CHEAPEST STRUCTURAL FIX — redirected.** Moving the fence inside the enqueue transaction closes essentially nothing, because it cannot refuse a send that is legitimately valid at send time. The fixes that reach the dominant case are:
1. **Drain-and-report at settlement.** Have `settleWorkerReportInTransaction` inspect `federation_relay_items` in the same savepoint and record the stranded items as a dead letter, plus one `escalation` into `run:<id>` naming them. Home-local, wire-neutral, and it converts a silent strand into a signal on the channel the coordinator already blocks on.
2. **Render the existing counter** (§11) so a coordinator can act *before* the fence closes.
3. Optionally keep an in-transaction guard as a cheap belt-and-braces for the `stopping`→`stopped` paths.

**Wire-compat posture:** home-local; the send response is unchanged for success, and the failure case uses the already-allowlisted `dispatch_inactive`. **Do not** attempt to make the push gate accept settled dispatches: the peer independently refuses (§ dual-sided enforcement, section 3) and the batch is contiguity-ordered, so a refused item wedges every later item.

**Test approach:** enqueue while ready (must stay green — `federation-worker-mail-fence.test.ts:62-77`), settle, assert the drain records the item and emits exactly one escalation. **Negative controls:** the `to_home` direction still enqueues from a non-ready worker (a worker's own `worker_done` is sent while the home-side row may be anything — gating the wrong direction would break the primary success path proven in the field); the heartbeat coalescing and `worker_done` dedupe branches (`db.ts:5023-5067`) are unaffected; a `reply`-kind `to_worker` item enqueued while ready still succeeds; the drain runs exactly once per settlement.

---

### 16. `dispatch_inactive` returns a dead-end error although the recovery-data channel exists and its neighbours use it
**[confirmed] · effort: S · highest leverage-to-cost in the inventory**

*`send --to dispatch:<id>` after settlement fails with a bare one-line message and exit 1, naming no alternative route, even though the runtime already has a recovery-data channel the CLI renders as `Next step:` lines.*

**MECHANISM.** `OrchestrationError` takes an optional third `data` argument (`orchestration-error.ts:5`). The CLI reads `data.nextSteps` off any `RuntimeClientError` and renders each as a `Next step:` line (`cli/format.ts:84-87`, `:132-137`, `:139-150`), and `dispatch_inactive` is on the structured-passthrough allowlist so its `data` is forwarded intact (`rpc/errors.ts:74`, `:146-158`; the envelope carries `data` at `:32`). The adjacent failure in the same handler uses this — `run_required` is thrown with `orchestrationSkillRecoveryData()` (`orchestration.ts:565-570`). The fence does not: `federation-worker-mail-fence.ts:12-16` throws with two arguments and an empty `data` slot. The plumbing is fully built, wired and rendered; this one call site simply does not use it. **[code-verified]** `reportCliError` also emits `data` into the `--json` envelope, so JSON consumers get the steps too.

**EVIDENCE.** **[measured]** `COORDINATION.md:280-284`: the coordinator received `error: dispatch_inactive — "Federated Dispatch ctx_05af09b220b0 is not active." (exit 1)` and its response was to reach for the docs, then file a doc-gap finding. F7 (`federation-live-test-findings.md:128-131`) resolved it as a documentation problem — the fix was placed in prose the agent had already failed to consult, rather than in the error the agent actually received. `COORDINATION.md:271-273` records the escape hatch a self-healing error should name (`orca terminal send --terminal <peer_terminal_handle> --environment <env> --text "1" --enter`), already proven live for the F5 trust prompt.

**This is the honest answer to the owner's question.** The instinct that a crisp error leaves the sender stuck is right about *this* error and wrong about the remedy: the deficiency is that the error is a dead end, not that it is an error. Filling the recovery slot converts every fence in this inventory from a wall into a signpost, and it is the piece that makes the stricter fences (§5, §6) safe to ship.

**CHEAPEST STRUCTURAL FIX.** Pass a third argument at `federation-worker-mail-fence.ts:12` carrying `{effectsApplied: false, nextSteps: [...]}` with concrete routable alternatives rather than generic advice — for a federated dispatch, `orca terminal send --terminal <remote_terminal_handle> --environment <env>` (the handle is on hand: `types.ts:183`, `:202`) plus "start a new Dispatch"; for the local fence in §6, `orca orchestration send --to <worker_terminal_handle>`. Mirror the same data on the peer-side `dispatch_inactive` (`orchestration-federation-relay.ts:172`).

**Wire-compat posture:** the cheapest and safest change in the inventory — strictly additive on a path that already exists end to end. An old CLI paired with a new host renders the steps with no client update; a new CLI paired with an old host sees no `data` and falls back to today's bare message. **Keep the message string's existing shape** — the "Federated Dispatch … is not active." wording is asserted in `federation-worker-mail-fence.test.ts:~51-53` and quoted in the field log.

**Test approach:** assert the thrown error still carries the exact existing message AND now exposes `data.nextSteps` as a non-empty string array with `data.effectsApplied === false`. CLI-side, assert a `RuntimeClientError('dispatch_inactive', msg, {nextSteps:[…]})` renders `Next step:` lines. **Negative controls:** an error with no `data` renders exactly as today (old-host compatibility); `data` with keys other than `nextSteps` neither throws nor leaks (assert a malformed entry is dropped, not rendered); the computer-use `invalid_argument` fallback still loses to error-specific recovery data; `run_required` unchanged.

---

### 17. The mail-pointer writer and the prompt writer contend for the same PTY with no mutual exclusion
**[adjusted — field evidence downgraded, one mechanism leg corrected] · effort: M · becomes first-order with §1**

*A mail pointer pushed into an idle agent pane during a concurrent preamble injection can interleave with the bracketed paste, so the notice is absorbed into the task spec and two `\r` submits fire ~500 ms apart.*

**MECHANISM.** `deliverPendingMessages` registers a per-PTY single-flight (`orca-runtime.ts:33058-33061`) and parks concurrent mail deliveries (`:33132-33145`) — but that flight is consulted **only by other mail deliveries**. `writeTerminalAgentPrompt` (`:17615-17672`), which carries the dispatch preamble (`orchestration-workers.ts:234`, `orchestration.ts:1395`, `orchestration-federation.ts:228`, `coordinator.ts:477`), neither registers a flight nor checks for one. The window is wide and explicitly yielding: chunks are written with `await new Promise(r => setTimeout(r, 0))` between them (`:17642`), then a render gate or `AGENT_PROMPT_SUBMIT_DELAY_MS` is awaited (`:17654-17659`) before the submit at `:17668`. Every await is a point where a scheduled `deliverPendingMessages` can fire `ptyController.write(ptyId, formatMessagePointer(...))` (`:33256`) — a **raw, non-bracketed** write that cannot be distinguished from typed text if it lands inside `\x1b[200~ … \x1b[201~` (`shared/agent-prompt-injection.ts:3-4, 38-39`). The mail path then arms its own `\r` (`:33278-33298`) while the prompt path arms its own. The idle gate does not prevent it: a pane awaiting a dispatch is precisely `idle && observedLive` (`:32390`), which is the state that *authorizes* the push. **[code-verified]**

*Corrected leg:* `terminal send --enter` does **not** route through `writeTerminalAgentPrompt` — `terminal.ts:1366` calls `runtime.sendTerminal`, which routes to `writeTerminalInputChunks` (`:17589`) and a separate suffix writer (`:17560-17586`). The hazard survives on that leg, because `writeTerminalInputChunks` also yields (`:17610`) and holds no mail flight, but the sibling writer is the correct citation.

**EVIDENCE — downgraded.** **[measured]** F5 (`federation-live-test-findings.md`) and `COORDINATION.md:786`: "a premature `terminal send` races the runtime's own submit and can double-submit" — the double-submit *class* is documented as real. `COORDINATION.md:781` **[measured]**: "The runtime submits the dispatch prompt itself. It just takes ~20s while the agent TUI boots… The Enter I sent was redundant" — establishing a seconds-to-tens-of-seconds window in which the runtime's own submit is pending.

**Explicitly not evidence:** `COORDINATION.md:567`, `:701`, `:712` (the "task text sitting unsent in the input box" observations) were **retracted** at `:764-789` and re-explained as normal ~20s TUI startup, and the resulting doc fix was reverted (`federation-live-test-findings.md:62-66`). Citing them as measured composer desync would reproduce the exact error the log retracted. No field occurrence of *this* interleaving exists; the claim that the writers can interleave is **[code-verified]**, and that it would corrupt a specific TUI's composer is **[inferred]** from bracketed-paste semantics.

**CHEAPEST STRUCTURAL FIX.** Promote `messageDeliveryFlightsByPtyId` from a mail-only latch to the PTY's structured-write claim: have `writeTerminalAgentPrompt` (and `writeTerminalInputChunks`) acquire the same flight for the whole paste→submit span and release it in the existing `finally`, reusing `settlePendingMessageDelivery` (`:33068`) so parked mail replays once afterwards. The mail side needs no change — it already parks (`:33132-33145`).

**Also in scope, independently worth fixing:** the mail path arms its Enter with a hardcoded `500` (`:33298`) rather than the platform-resolved `AGENT_PROMPT_SUBMIT_DELAY_MS` already imported at `:97` and used by the prompt path at `:17658`. One-token change. *(See the appendix for why the Windows-failure framing around this was withdrawn.)*

**Debatable half, flagged for a design decision rather than shipped as a bug fix:** whether to move the watermark advance (`:33260-33269`) into the Enter callback's success path. Today a notice whose submit never lands is still recorded as announced and never retried. The counter-argument is in the code's own comment at `:33277`: the `\r` is a submit *convenience* for TUIs that swallow it in the same write — the pointer **text** is the announcement and is already on screen. Advancing on the text write is defensible. Decide it; do not slip it in.

**Wire-compat posture:** n/a — entirely local to one runtime's PTY writer. Applies identically to local, SSH-remote and daemon-hosted PTYs (all funnel through `ptyController.write`).

**Test approach:** with a fake `ptyController` recording an ordered write log, begin a multi-chunk prompt write, fire `notifyMessageArrived` for a mailbox on the same PTY during an inter-chunk yield, and assert the paste sequence is contiguous (no pointer text between the bracketed markers) and exactly **one** `\r` before the pointer is written at all. **Negative controls:** with no concurrent prompt write the pointer path behaves exactly as today (guards against the lock deadlocking normal delivery); a prompt write that throws mid-paste still releases the flight and lets the parked delivery run (assert `retirePendingMessageDeliveryForPty` at `:33090` too); a parked delivery replays exactly once, not per chunk.

---

### 18. A federated worker's peer terminal is never re-resolved after a peer-side re-mint
**[confirmed] · effort: M**

*After the peer's renderer graph reloads or its runtime restarts without re-adopting, `worker-show` reports the worker as `missing` and `worker-read` throws `worker_identity_changed` on every subsequent call — while the agent process is still alive and working.*

**MECHANISM.** On the peer, `inspectRemoteAttachment` resolves the worker exclusively through `runtime.showTerminal(attachment.terminal_handle)` and returns `{terminal:null, exact:false, status:'missing'}` when that throws (`orchestration-federation-control.ts:175-184`). The durable identity is in the same row — `remote_dispatch_attachments.pane_key` and `process_incarnation` (`db.ts:495-496`) — but the pane key passed to the currency check is *derived from the handle* (`:187`), so once the handle is dead the stored pane key is unreachable. `federationRead`/`federationReadOutput` then hard-fail (`:49-54`, `:75-80`). The home side has nothing to fall back to either: `federated_dispatches` has no remote pane-key column (`db.ts:473-486`) and `updateFederatedDispatchResources` writes back only whatever handle the peer reported (`db.ts:4634-4650`). Handle loss on the peer needs no crash: `beginGraphReload` clears the maps (`orca-runtime.ts:28769-28782`), and adoption is refused on collision (`:9606-9626`) or incarnation change (`:9517-9529`). **[code-verified]**

**EVIDENCE.** Field: **not observed** — the logged session's peers stayed up. Supporting **[measured]**: `cross-runtime-federation.md:198-201` establishes that `worker-show`'s status fields are already known to mislead; F5 shows the peer terminal handle is the only lever for unblocking a stalled federated worker, so if it rots that lever is gone with no listed recovery. Severity is **[code-verified]** (permanent until settlement); frequency is **[inferred]**.

**Consequence.** Relayed mail still works (`dispatch:<id>` addressing is handle-free), so the worker can still finish — but `worker-read`, `worker-show`'s terminal block, and any trust-gate unblock are dead for the rest of the Dispatch. Because it presents as `missing`, a coordinator reasonably concludes the worker died and abandons or restarts work that is in progress.

**CHEAPEST STRUCTURAL FIX.** Peer-side, one function. In `inspectRemoteAttachment`, when `showTerminal` fails and `attachment.pane_key` is set, call `runtime.getTerminalHandleForPaneKey(pane_key)`, require `getTerminalProcessIncarnation(replacement) === attachment.process_incarnation`, and on a match adopt the replacement, persist it on the attachment row, and continue as `running`. On any mismatch or ambiguity, keep returning `missing`. The home needs no change — it already re-reads and writes back the handle on the next `worker-show`.

**Wire-compat posture:** changing the value the peer publishes in `attachment.terminal_handle` on an existing path reaches old homes with no codec change, so gate the re-resolve behind a new capability (e.g. `orchestration.federation-terminal-repin.v1` in `RUNTIME_CAPABILITIES`, `shared/protocol-version.ts:103`) and repin only when the authenticated home advertises it; otherwise keep today's `missing`. No `RUNTIME_PROTOCOL_VERSION` bump, no new opcode.

**Test approach:** in `federation-terminal-recovery.test.ts`, attach with handle H1/paneKey P/incarnation I, bump the graph epoch, issue H2 for P with incarnation I, assert `federationShow` returns `running` with H2 and the row now stores H2. **Negative controls:** incarnation changed → still `identity_changed`, never repin; `pane_key` null (older row) → `missing`, no crash; pane key now in a different worktree → refuse (`resolveTerminalPane`'s guard at `orca-runtime.ts:16764-16771`); home does not advertise the capability → byte-identical legacy behavior.

---

### 19. Ambient push to a coordinator pane dies on handle re-mint
**[adjusted — impact narrowed] · effort: S**

*After a renderer-graph reload or handle re-mint, the runtime silently stops pushing new orchestration mail into a coordinator's still-live pane.*

**MECHANISM.** `deliverPendingMessagesForHandle` short-circuits when `this.handles` lacks the handle, makes exactly one `runs.coordinator_handle` fallback for `run:` mailboxes, and returns (`orca-runtime.ts:32371-32382`); a `getLiveLeafForHandle` throw is swallowed by a bare catch whose comment concedes the outcome (`:32393-32395`). Handles go absent with no process death: `beginGraphReload` bumps `rendererGraphEpoch` and clears both maps (`:28769-28782`), as do three sibling paths (`:28834-28909`). The durable pane key sits one column away — `runs.coordinator_handle` / `coordinator_pane_key` are adjacent at `db.ts:342-343`, indexed at `:740` — and the runtime already owns the reverse lookup `getTerminalHandleForPaneKey` (`orca-runtime.ts:16749-16755`). Nothing rewrites `runs.coordinator_handle` outside create/bind and the NULL-ing paths, so a re-mint is never repaired. **[code-verified]**

**Impact correction (load-bearing).** The original claim that "every subsequent worker_done/question/escalation reaches the DB and never reaches the agent" is **false for the supervision pattern the guide teaches**. Message waiters are keyed on the **mailbox address**, not the terminal handle — `waitForMessage('run:<id>')` (`orchestration.ts:772`) — and `beginGraphReload`'s `rejectAllWaiters` iterates only the terminal-wait map. A coordinator sitting in `check --wait` **is** still woken by `notifyMessageArrived('run:<id>', …)` after a re-mint. **[code-verified, confirmed by direct read of `notifyMessageArrived`]** What actually dies is the ambient push to an **idle** coordinator pane — real and silent, but a narrower channel.

**EVIDENCE.** **[measured]** `COORDINATION.md:99`, `:287`: Runs carry `coordinator_handle term_8f3bf46e-…` as the coordinator's only routing identity, assigned opaquely with no second identity recorded. Owner-reported (out-of-band, not in the log): handles go stale across restarts and must be re-listed before every send. No missed push appears in the field log — the logged coordinators used explicit `check`, so the push path was never the sole channel. Mechanism **[code-verified]**; incidence **[inferred]**.

**CHEAPEST STRUCTURAL FIX.** In `deliverPendingMessagesForHandle`, when the handle is absent and the mailbox is `run:<id>`, fall back to `runs.coordinator_pane_key` → `getTerminalHandleForPaneKey(paneKey)` before returning; same for `dispatch:`-adjacent handles via `dispatch_contexts.assignee_pane_key` (`db.ts:577`). Gate adoption on the pane still resolving inside the expected worktree (`resolveTerminalPane` already enforces this at `:16764-16771`) and write the re-resolved handle back to `runs.coordinator_handle`. **Do not repoint across a process-incarnation change** — compare `getTerminalProcessIncarnation` and leave the mail undelivered rather than typing into a different agent.

**Wire-compat posture:** n/a — local to the Run-home runtime. Works identically for folder workspaces (pane key is `tabId:leafUUID`, not path-derived) and SSH-hosted PTYs.

**Test approach:** seed a Run with handle H1 + pane key P, bump the epoch, re-issue H2 for P, post mail to `run:<id>`, assert the pane is pointed and `coordinator_handle` is rewritten to H2. **Negative controls that must not deliver:** the pane key resolves in a different worktree; incarnation differs; the pane key resolves to two candidates (refuse, matching `planLegacyWorkerTerminalRecovery`'s ambiguity posture at `orchestration-legacy-worker-terminal-recovery.ts:100-113`); `leaf.lastAgentStatus` is busy (the idle gate must still hold).

---

### 20. A fenced coordinator's `check --ack --wait` renders as "No messages."
**[confirmed, severity calibrated down] · effort: S**

*A coordinator fenced while blocked in the exact loop the guide teaches is told "No messages." and keeps looping against a mailbox it no longer owns.*

**MECHANISM.** With both `--ack` and `--wait`, a fence during the wait does not throw — because effects were already applied, the handler returns `interruptedAcknowledgedCheck(...)`, a **success-shaped** object carrying `waitInterrupted: 'consumer_fenced' | 'waiter_exists' | 'outcome_unknown'` (`orchestration.ts:371-387`, returned at `:856`, `:861`, `:870`). That field is the only signal and nothing consumes it: absent from the CLI's `CheckResult` (`cli/handlers/orchestration.ts:644-654`) and from `OrchestrationCheckOutput` (`shared/orchestration-check-output.ts:34-43`). `formatOrchestrationCheckText` handles `count===0` by testing only `timedOut` and `cancelled`, then falls through to the literal `'No messages.'` (`:86-96`). A repo-wide grep finds `waitInterrupted` in exactly **two** places: the producer and one test (`orchestration-legacy-coordinator-race.test.ts:473`) — no renderer, no doc, no guide. The un-acked variant of the same fence *does* throw a real `consumer_fenced` error (`:863-866`), so the silence is specific to the acked path — i.e. specific to the loop taught at `skill-guides/orchestration.md:239`. **[code-verified]**

**EVIDENCE.** Field: **not exercised** — the two agents coordinated through a markdown file plus one worker probe and never contested a Run mailbox. **[code-verified]** throughout; exposure requires a contested Run mailbox, and `--json` survives as an undocumented escape hatch, which is why the lane's "critical" grade is calibrated to high-value-cheap-fix rather than top-rank.

**CHEAPEST STRUCTURAL FIX.** Pure client-side — the field already ships on the wire. Add `waitInterrupted` to `OrchestrationCheckOutput` and the CLI type, and branch before the `'No messages.'` fallback: for `consumer_fenced`, print `Wait ended: this mailbox consumer was replaced. Rebind with: orca orchestration run-use --id <runId>`; for `waiter_exists`, say another actionable waiter owns this Run. Set a non-zero `process.exitCode` for `consumer_fenced` so a scripted loop fails loudly. Document the field next to the check loop.

**Wire-compat posture:** no wire change at all; only the client type and renderer. An older host never sends the field and the renderer keeps today's behavior.

**Test approach:** unit-test the formatter for each `waitInterrupted` value with `count:0, timedOut:false, cancelled:false`. **Negative controls:** a genuinely empty mailbox (no `waitInterrupted`) still prints exactly `'No messages.'`; `timedOut:true` keeps its existing wording — proving the new branch does not swallow the two existing cases. Reuse the fixture at `orchestration-legacy-coordinator-race.test.ts:473` as the producer anchor so producer and renderer stay in sync.

---

### 21. A suppressed heartbeat reports `Sent <id>`
**[confirmed] · effort: S**

*A worker that keeps heartbeating a Dispatch the coordinator already settled or abandoned gets a success response indistinguishable from a delivered heartbeat, so it keeps working and keeps reporting liveness into a closed relationship.*

**MECHANISM.** `reconcileHeartbeatMessage` detects a dispatch that is missing or not `dispatched`, calls `markAsReadAndDelivered([msg.id])` to retire the row for audit, and returns `{action:'suppressed'}` (`lifecycle-reconciliation.ts:150-157`). The send handler treats that as a plain early return of `{message: msg}` — no `lifecycle` field, no warning, no error (`orchestration.ts:677-678`). The CLI prints `Sent ${r.message.id}` for any result containing `message` (`cli/handlers/orchestration.ts:613-615`), and the settlement guard is scoped to `worker_done` only (`orchestration-worker-settlement.ts:10-12`). Because `markAsReadAndDelivered` sets `delivered_at` (`db.ts:3569`) and `getUndeliveredUnreadMessages` filters `delivered_at IS NULL` (`db.ts:3497`), the row is permanently invisible. **[code-verified]**

The asymmetry: the coordinator→worker direction fences **loudly** (`dispatch_inactive`), while the worker→coordinator **liveness** direction fails open with a success string — on the worker's most frequent orchestration call (`preamble.ts:89-102` asks for one every 5 minutes).

**EVIDENCE.** Field: **not exercised** — the live workers ran to `worker_done` quickly. F7 documents the mirror behavior in the other direction; F5 describes a worker that "hangs indefinitely and looks green," which is the same illusion from the worker's side. **[code-verified]**

**CHEAPEST STRUCTURAL FIX.** Return the verdict that already exists internally: include `lifecycle: {action:'suppressed', dispatchId, reason:'Dispatch is no longer active.'}` on the suppressed response, and have the CLI print `Heartbeat suppressed: Dispatch <id> is no longer active — stop work and do not send worker_done for this Dispatch.` with a non-zero exit code.

**Wire-compat posture:** additive optional field on an existing result for a case that currently carries none. **Verified safe** against the existing client guard: `hasLifecycleVerdict` (`orchestration-worker-settlement.ts:96-117`) is consulted only for `worker_done`, and `requireWorkerDoneSettlement` returns early for `heartbeat`, so an unrecognized `action:'suppressed'` cannot turn a heartbeat into a spurious `operation_unknown`. The non-zero exit code is a behavior change for a previously-succeeding invocation and should be changelogged alongside §6.

**Test approach:** settle a Dispatch, send a heartbeat naming it, assert `lifecycle.action === 'suppressed'` and the CLI warning plus exit code. **Negative controls:** a heartbeat for a live `dispatched` Dispatch returns no lifecycle field and prints `Sent <id>` unchanged; a wrong-pane heartbeat still takes the existing `rejected`/`sender_not_assignee` path; a `worker_done` send is byte-identical to today.

---

### 22. The Run branch shadows the dispatch mailbox, and an unresolvable pane silently degrades to the handle mailbox
**[confirmed] · merged from two lanes · effort: S**

*Two ways `check` reads the wrong mailbox and reports success.*

**MECHANISM A — nesting.** `check` picks a mailbox by branch order, not by union. It resolves the pane key and `getCurrentRunForPane`, and if either `params.run` or a bound Run exists it takes the Run branch and returns from inside it in every path (`orchestration.ts:756-758`, returns at `:793-805`, `:816-830`, `:832-841`, `:877-916`). Only then is `getActiveDispatchForIdentity` reached (`:919`). Nothing prevents overlap: `runCreate`/`runUse` require only a stable pane (`orchestration-runs.ts:30-46`, `:52-66`) and never check for an active dispatch, while `findActiveDispatchForAssignee` matches independently of any Run binding (`db.ts:6653-6688`). So a worker pane that binds a Run (to supervise sub-workers) can never read its own `dispatch:` mail — while `send`/`ask` still resolve the active dispatch by pane, so it can talk but cannot listen. The reverse shadowing is impossible, making this strictly a nested-coordination hazard. **[code-verified]**

**MECHANISM B — degradation.** If the pane key is unresolvable and no `--run` was passed, `boundRun` is undefined, the Run branch is skipped, and execution falls through past the dispatch branch to the bare terminal-handle mailbox (`:989-1026`), returning `{count:0}` rendered as the literal `'No messages.'` No field names which mailbox was read. The Run verbs treat the identical condition as a hard `stable_pane_required` error (`orchestration-runs.ts:30-46`) — the asymmetry is the bug. The CLI widens the window: when `--terminal` is explicit it deliberately omits `terminalPaneKey` ("a local pane key names nothing on the peer", `cli/handlers/orchestration.ts:660-664`), leaving the runtime's own lookup as the only source of pane identity. **[code-verified]**

`'No messages.'` is the most misleading possible answer, because it is also the correct answer for a healthy idle mailbox — an agent has no reason to investigate.

**EVIDENCE.** Field: **not exercised** for either — the live topology was flat (two peer coordinators plus leaf workers), and the coordinators ran inside live panes throughout. Supporting **[measured]**: F8 shows the runtime auto-selecting a coordinator pane when `--from` is omitted, i.e. pane identity is inferred rather than asserted on these paths. **[code-verified]**

**CHEAPEST STRUCTURAL FIX.** Name the mailbox in the result. Add an optional `mailbox: 'run' | 'dispatch' | 'terminal'` (plus `runId`) at each return site, and render a warning whenever it is not `'run'` for a caller with no explicit `--run`. For nesting, additionally report `otherMailbox: {dispatchId, unread}` from the Run branch and add an optional `dispatch` request param that selects the worker branch directly. Keep the CLI's decision to withhold a local pane key from a peer — only the reporting improves. The stricter variant (refusing `run-create` from a pane with an active dispatch) removes the class outright but changes an existing path's success/failure, so it is a follow-up decision.

**Wire-compat posture:** one new optional request param and one or two optional result fields on `orchestration.check`. Old hosts ignore the param and keep today's branch order; old clients ignore the fields. No opcode, no version bump.

**Test approach:** bind a Run to a pane with an active dispatch, send one message to each mailbox, assert the default check returns the Run batch *and* reports `otherMailbox.unread === 1`, while `--dispatch <id>` returns the dispatch message. For degradation: call with a handle whose pane key does not resolve while a Run exists for that handle, assert `mailbox:'terminal'` plus the warning. **Negative controls:** a properly bound pane reports `mailbox:'run'` with no warning; a pure worker pane keeps today's exact result shape; an explicit `--run` takes the Run branch regardless of pane resolution (preserving remote-run-mailbox behavior); `--dispatch` for a dispatch that is not the caller's own is refused rather than reading someone else's mailbox.

---

### 23. `peer_changed` is an unrecoverable pin, and the documented remedy makes it permanent
**[confirmed] · effort: S (docs) + S (opt-in verb)**

*Once a saved environment's key no longer matches what a Dispatch pinned at start, every sync, show, read and stop for that Dispatch throws `peer_changed` forever, and `orca environment add` cannot clear it.*

**MECHANISM.** `federated_dispatches.peer_fingerprint` is written exactly once, in the dispatch-creation INSERT (`db.ts:~4092`). A repo-wide grep for the column returns six hits: the two `CREATE TABLE` statements (`:477`, `:881`), that INSERT, and three unrelated `home_peer_fingerprint` sites. **There is no UPDATE anywhere.** Both hot paths compare against it on every call (`federation-sync.ts:66-72`; `resolvePinnedFederatedServer`, `orchestration-worker-observation.ts:43-56`, which every worker-show/read/stop funnels through). The fingerprint is `sha256(publicKeyB64)` of the peer's E2EE key (`environment-transport.ts:24-26`), and that keypair is persisted per profile (`e2ee-keypair.ts:26-57`) so it survives ordinary restarts. Re-pairing with `environment add` rebuilds the environment through `createEnvironmentFromPairingOffer` (`runtime-environments.ts:62-95`), replacing `publicKeyB64` and bumping `pairingRevision` (`runtime-environment-store.ts:111-130`) — so after the documented remedy the mismatch is **guaranteed** rather than incidental. **[code-verified]**

**EVIDENCE.** Docs contradiction **[code-verified]**: `cross-runtime-federation.md:212-215` and `skill-guides/orchestration.md:299` both say in-flight workers become unreachable "until you refresh the saved environment with `orca environment add`." Field **[measured]**: `COORDINATION.md:162-169` shows the operators reasoning about pairing validity from `runtimeId` — which is not the pinned identity at all (see section 3). No `peer_changed` event occurred in the logged session.

**Consequence.** A Dispatch that hits this is dead: no sync (so `worker_done` never lands home), no show, no read, no stop — the coordinator cannot even clean up the peer-side terminal. Low frequency, total loss when it fires.

**CHEAPEST STRUCTURAL FIX.** (1) **Mandatory docs correction**: state that `environment add` restores connectivity for *new* dispatches only, that in-flight dispatches stay `peer_changed` permanently, and that the correct action is to settle/abandon and start a new Dispatch. (2) Optional local escape hatch: `orca orchestration worker-repin --dispatch <id> --confirm` rewriting the column to the currently-saved fingerprint, refusing without explicit confirmation and recording the old value. **Never repin implicitly** — the pin is the only thing preventing a rotated or substituted peer from inheriting an in-flight Dispatch's relay stream.

**Wire-compat posture:** docs are free; the verb is a new local RPC + CLI verb, exempt from a version bump, touching only home-local SQLite.

**Test approach:** after a simulated rotation, sync still throws; call repin, sync proceeds. **Negative controls:** repin without `--confirm` is refused and the row unchanged; repin on a settled dispatch refused; repin touches no other dispatch's pin; a doc-level check that the runbook no longer claims `environment add` clears it.

---

## 3. Protocol / docs-only items (non-structural)

These matter but build nothing. Several are prerequisites for the structural work to have any behavioral effect.

- **`check` has no cadence in the preamble.** `buildDispatchPreamble` attaches explicit capitalized rules to `worker_done` (`preamble.ts:77`), heartbeat (`:89-93`, backed by `HEARTBEAT_INTERVAL_MIN = 5` at `:40`) and `ask` (`:106-115`), and gives the inbound verb two bare lines with a comment (`:128-129`) — in a file whose header states that behavioral rules live at the point of use (`:42-46`). The only cadence-shaped statement about `check` is prohibitive (`:174`). **Fix:** one template string reusing the beat the worker already runs — "run this alongside every heartbeat and before any irreversible step; the coordinator's follow-ups only reach you here." Free, zero wire surface, and it is the **only** delivery mechanism left on hosts where the PTY write path is unreliable. An optional structural assist: return `pendingMail` on `orchestration.send` so the worker learns of waiting mail as a side effect of its heartbeat — but note it must be appended to **both** CLI branches (`Sent <id>` at `cli/handlers/orchestration.ts:614` *and* the relay branch at `:616-620`), or it is invisible to exactly the federated workers it targets. **[code-verified]**
- **"Hangs to timeout" names a bound that does not exist.** No dispatch-level timeout exists anywhere. The only `timeoutMs` on the worker-start path is a startup-readiness bound spent before the prompt is sent (`orchestration-workers.ts:197-200`); the complete set of timers in `src/main/runtime/orchestration` is `coordinator.ts:552`, `mail-pointer-repoint-scheduler.ts:12`, `federation-lifecycle-settlement.ts:65` — none expires a Dispatch. **Fix:** correct `federation-live-test-findings.md:102-103` and the runbook to say the Dispatch hangs indefinitely. A maintainer triaging F6 from the shipped doc will otherwise scope the fix as "the timeout is too long" against a mechanism that does not exist. **[code-verified]**
- **The guide has no vocabulary for "the worker may be dead."** Every sanctioned stop condition (`skill-guides/orchestration.md:146`) is unreachable in the two observed failure shapes; heartbeats are framed only as presence (`:147`), never absence; `:246` forbids releasing on a timeout; `:266` resolves `ready` to "keep waiting"; `:405` offers `tui-idle` as a liveness checkpoint, which is inverted for an agent parked at a prompt. Grep confirms the guide never mentions `last_heartbeat_at`, `sync`, `lastSyncAt`, `consecutiveFailures` or `observation.status`. **Fix:** one bullet naming the liveness-breach escalation and the recovery ladder, one sentence correcting `:405`, and the federated sync fields. **This is what converts a new signal into a behavior** — but it is inert until §3/§11/§13 give it a fact to point at. **[code-verified]**
- **Settlement enforcement is dual-sided — a posture constraint on every fence fix.** Three enforcement points on two machines: the home send-fence, the home push gate (`federation-sync.ts:174-177`), and the peer's per-item refusal in `federationImport` (`orchestration-federation-relay.ts:171-176`). That throw exits the item loop and fails the whole RPC, so `acknowledgeFederationRelay` never runs, the cursor does not advance, and the contiguity check (`:157-162`) pins every later item behind the refused one — a one-message loss becomes total coordination loss for that worker, degrading into 60s-capped backoff the coordinator sees only as a rising `consecutiveFailures`. **Consequence:** *tightening* is runtime-local and free (the peer already refuses at least as strictly); *loosening* requires capability negotiation against `FederatedDispatchRow.protocol_version`, following the control-mail precedent (`orchestration.ts:581-589`). Every fix in this inventory tightens or annotates; none loosens. **[code-verified]**; the wedge itself **[inferred]**.
- **Rerouting post-settlement mail to the Run mailbox is unsound — do not build it.** `run:<id>` is the *coordinator's own* inbox (`orchestration.ts:772`; `db.ts:2726-2735` selects with no sender filter), so a reroute delivers the follow-up back to its sender, in a Delivery it must then acknowledge — and it would not wake the taught `--types worker_done,escalation,question` filter (`db.ts:2710-2723`), so it would be swept into a later acknowledged batch as an echo. Meanwhile the preamble instructs workers to stop checking mail after `worker_done` (`preamble.ts:157-176`), so no destination has a reader. Version skew kills the notice too: the CLI branches on `destination === 'worker'` with exactly two outcomes (`cli/handlers/orchestration.ts:617-622`), so a third value or an added field is silently dropped by every shipped client. **The answer to "is silent rerouting worse than a crisp error?" is yes, decisively** — not for sender psychology, but because there is no reader at the other end, so the only thing rerouting changes is whether the sender finds out. Any notice about a reroute must travel as an **error**; errors are the only channel whose payload old CLIs already render. **[code-verified]**
- **`runtimeId` is the wrong identity to verify a peer with.** `runtimeId` is `randomUUID()` per process (`orca-runtime.ts:2775`), stamped into every response envelope (`dispatcher.ts:291`) and written into `orca-runtime.json` fresh each launch (`runtime-rpc.ts:1736-1738`); `environment list`'s value is just the last-seen `_meta.runtimeId` (`cli/runtime/client.ts:115-118`). The identity federation pins is the persisted E2EE key fingerprint. In the field the agents reasoned from `runtimeId` and proposed encoding "same runtimeId → skip re-pairing" into the runbook (`COORDINATION.md:72`, `:162-169`) — unsound as stated; their conclusion was right for a different reason. **Fix:** derive and display `peerFingerprint` **client-side** (the CLI already holds `publicKeyB64`; the fingerprint is a pure function of it), relabel the existing column as the per-process/session id it is, and correct the two docs. Zero wire change. **Do not** make `runtimeId` persistent — `worker.runtime_epoch !== getRuntimeId()` is how a mid-start runtime restart is detected (`orchestration-worker-control.ts:112-124`) and `remote_runtime_epoch === pulled.runtimeEpoch` gates the durable ack watermark (`federation-sync.ts:141-144`). **[code-verified]**
- **The bundled guide is a build artifact only a provisioned checkout can regenerate.** `config/scripts/generate-bundled-skill-guides.mjs:5` imports `yaml` — its *only* external dependency, used once at `:62` to parse front-matter — and `verify:bundled-skill-guides` is wired into `lint` (`package.json:14`). In the field this made a one-sentence contract fix take three cross-agent round trips, during which the **wrong** recipe was live in the guide every future worker reads (`COORDINATION.md:571-577` → `:640` → `:668` commit `870c232d` → `:790-793` → `:843-845`). **[measured]** **Fix:** make the generator dependency-free (a ~20-line front-matter parser) and have `--check` print the regenerate command. **Every docs fix in this inventory must budget for this regeneration or it never reaches an agent.**
- **Claude has no trust preset — prevent where possible, detect where not.** `AgentTrustPreset` is a closed union of `cursor|copilot|codex` (`agent-trust-presets.ts:8`) and `TUI_AGENT_CONFIG.claude` has no `preflightTrust` key (`tui-agent-config.ts:50-57`; presets only at `:86`, `:249`, `:308`). The agent that deadlocked in the field was `--agent claude`. The launch-flag alternative exists (`tui-agent-permissions.ts:7`) but the orchestration launch path applies no permission flags at all (`orchestration-worker-launch-preferences.ts:51-115`) — and the repository already rejects that substitution for Codex in the file that would host the fix ("would also change approval/sandbox policy, so it is not equivalent to 'trust this project'", `agent-trust-presets.ts:26-27`). **Honest answer:** there is no cheap structural prevention for Claude today; the gate becomes a coordinator-visible signal within ~90s via §2 instead. If a Claude preset is later added it must be modeled like the existing three, honor `CLAUDE_CONFIG_DIR`, and never be substituted with `--dangerously-skip-permissions`. Whether that flag even bypasses the folder-trust dialog is **not verified in this repo** and is not asserted. **[code-verified]**
- **Stall-class separability — the honest ceiling on any watchdog.** *(d) dead process* is cleanly separable and already computed (`orchestration-worker-observation.ts:31`; `worker-terminal-process-liveness.ts:39-62`). *(b) recognized gate* is separable via **positive** evidence with high precision and closed-vocabulary recall (`orca-runtime.ts:17068-17086`, dwell from `waitBlockedAt`). *(a) booting* and *(c) thinking silently* are **not** separable from each other for a title-less agent — the code carries an explicit workaround for exactly that ("cursor-agent emits no idle OSC title; infer idle from the tail", `:37665`). Crucially, `lastOutputAt` — the signal a silence-based watchdog would center on — is the **weakest** of the four: a spinner refreshes several times a second while thinking, a blinking modal may too, and a healthy agent awaiting a slow tool call refreshes not at all. `TUI_IDLE_QUIESCENCE_MS` is 3s (`:37575`), nowhere near a safe stall threshold. **Do not add a `stalled` verdict derived from silence.** A false "your worker is stuck" on a 40-minute refactor trains coordinators to ignore the signal — a worse end state than today. **[code-verified]**
- **The gate vocabulary is Codex-shaped, and its false-positive surface is `terminal.wait`.** `TERMINAL_WAIT_BLOCKED_SENTINEL_RE` (`orca-runtime.ts:37730-37731`) contains no sign-in/log-in/api-key/authentication/model-selection wording, and every member of `RuntimeTerminalWaitBlockedReason` is prefixed `codex-`. Scoping correction: `getTerminalAgentStatus` already computes `liveTitleClearsBlockedText` (`:17069-17073`) and suppresses a stale tail hit for **any** agent whose live title reports non-permission, so the consumer §2 and §13 build on is already protected; the unguarded surface is `terminal.wait`'s `blockedReason`, where a task spec containing "trust this folder" can synthesize a phantom gate. **Fix posture:** keep `blockedReason` emitting only the six shipped values (mapping new detections to the closest existing one, exactly as the code already does at `:37812` with the comment "preserve the existing remote receipt value for mixed-version clients") and carry any finer class in a new optional sibling field. Auth-gate occurrence in this workflow is **[inferred]**, not observed — the one field prediction of an auth gate was explicitly retracted. **[code-verified]**
- **Identifier allocation across runtimes.** A Run ID is meaningless outside its minting runtime (`cross-runtime-federation.md:110-113`), artifacts refuse `--environment` (`cli/handlers/artifacts.ts:47-52`), and the retarget matrix is learned by hitting per-handler refusals. In the field both agents independently minted colliding finding numbers and reconciled by hand (`COORDINATION.md:293`, `:551`, `:553-557`). **[measured]** **Fix:** docs only — when two agents co-author an artifact, identifiers come from one authority (coordinator allocates, or each agent prefixes its lane), and state plainly which verbs `--environment` retargets. The ids that matter (`relay_*`, `ctx_*`, delivery ids) are already server-minted and unique; the collision was in a human numbering scheme layered on top.
- **Crossed replies on a poll bus.** Measured repeatedly (`COORDINATION.md:205`, `:91`, `:551`; two consecutive confident-and-wrong SSH diagnoses at `:489-546` finally root-caused at `:590-607`; non-monotonic timestamps across the whole log) — but **all of it on the hand-rolled git-file bus**, not on the orchestration mailbox, which already has server UTC timestamps and a per-mailbox sequence. **[measured] for the bus, [inferred] for the mailbox.** The supported half is docs: peer-to-peer coordination goes through the run mailbox, never a hand-rolled file bus, and re-read with `check --peek` immediately before sending a slowly-composed reply. The `--after-sequence`/`staleReader` product attachment is speculative; treat it as optional.
- **`--user-data-dir` isolates the profile but not the worktree root.** The default workspace root is home-derived (`shared/constants.ts:165-169`; `computeWorkspaceRoot` resolves from `settings.workspaceDir`, never userData, `ipc/worktree-logic.ts:116`), so two runtimes on one host share a filesystem namespace and same-named worktrees collide — measured on Windows (`COORDINATION.md:745`). **[measured]** And runtime selection is ambient: `ORCA_USER_DATA_PATH` or the platform default, with no `--user-data-path` global flag (`cli/args.ts:14`). This is the configuration the federation runbook recommends for validation (`cross-runtime-federation.md:224-240`), documenting only the userData half. Adjacent to coordination rather than part of it, but data-loss-adjacent: one runtime's teardown can delete a directory the other owns.

---

## 4. Dependencies between fixes

```
§12 waking lane (escalation, not status)
   └── gates §2 observer · §3 liveness breach · §9 relay-death event · §15 strand report
        (all four are inert if the message type does not wake the taught filter)

§14 preamble exemption (blocked_since or periodic refresh)
   └── MUST land before §3 liveness window
        (otherwise the first production breaches are healthy ask-blocked workers,
         which trains coordinators to ignore the signal — permanently)

Run-mailbox delivery integrity
   §4 unacked starvation · §20 fenced-renders-as-no-messages · §19 handle-remint push · §10 orphaned Run
   └── ALL escalation-bearing fixes presuppose these
        (an escalation into a starved, fenced, or orphaned mailbox is another void)

§1 dispatch push
   ├── raises §17 (PTY write claim) from latent to first-order
   │    — the pairing "send follow-up" + "inject next dispatch into the same idle pane"
   │      is a normal, frequent sequence in the supervised loop; ship them together
   └── does NOT depend on §11, but §11 makes its effect observable

§16 recovery data on dispatch_inactive
   └── makes §5 and §6 (stricter fences) safe to ship
        (a stricter fence without a signpost is a better-labelled wall)

§13 agentStatus surfaced
   └── supplies the discriminator §2's observer classifies on
   └── §11 (formatter) must land in the same change or the new field is invisible in text mode

§18 peer terminal repin   ── independent, but pairs with §19 (both are pane-key indirection)
alias namespace (§3 list) ── presupposes exposing paneKey on RuntimeTerminalSummary

Every docs fix touching skill-guides/
   └── presupposes the bundled-guide regeneration (section 3)
        — a guide edit that is not regenerated never reaches an agent
```

**Cross-cutting posture (from the dual-sided enforcement item in section 3):** no fix in this inventory may loosen a fence. Tightening is runtime-local and free; loosening requires capability negotiation and risks wedging a Dispatch's entire inbound stream.

---

## 5. Recommended A2 subset — *recommendation only; the owner decides*

Chosen for one property: **after A2, no coordination failure in this inventory is silent.** Either delivery works, or the sender is told it did not.

**Tranche 1 — restore delivery (do not split these).**
| # | Item | Effort |
|---|---|---|
| §1 | Dispatch mailboxes get ambient push | S |
| §17 | PTY structured-write claim (mail vs prompt) | M |
| §3 (docs) | `check` cadence in the preamble | S |

§1 is the highest-value change in the program and is wire-neutral. §17 must ship with it, not after: wiring dispatch mailboxes in is exactly what makes the mail-vs-prompt contention frequent. The preamble cadence is the fallback that does not depend on the PTY write path at all — which matters because of the measured Linux/AppImage submit gap.

**Tranche 2 — make silence impossible.**
| # | Item | Effort |
|---|---|---|
| §12 | Use `escalation` as the waking lane | S |
| §16 | Recovery data on `dispatch_inactive` | S |
| §5 | Relay the generic `reply` branch | S |
| §6 | Fence local `send --to dispatch:<id>` | S |
| §21 | Suppressed heartbeat returns its verdict | S |

Five small changes that convert five separate silent drops into either a delivery or a signpost. §16 first, so §5 and §6 land as signposts rather than walls. §6 and §21 are behavior changes for old clients (a previously-succeeding call now errors / exits non-zero) — changelog them together as one deliberate correctness change.

**Tranche 3 — make the instruments readable.**
| # | Item | Effort |
|---|---|---|
| §11 | `worker-show` renders what it already receives | S |
| §13 | `agentStatus` reachable from orchestration + CLI | S |
| §20 | Fenced coordinator stops printing "No messages." | S |
| §4 | Replay/`pendingBehind` visibility on `check` | S |

Almost entirely rendering and additive fields against data the runtime already computes. This is the cheapest tranche per unit of diagnostic value in the whole inventory, and it is what lets the field verify tranches 1 and 2 actually worked.

**Tranche 4 — the watchdog, once its prerequisites hold.**
| # | Item | Effort |
|---|---|---|
| §14 | Make the liveness exemption real (`blocked_since`) | M |
| §3 | Per-dispatch liveness window → escalation | M |
| §2 | Post-ready observer + post-write evidence | M |
| §9 | Persist relay health + escalate on sustained failure | M |

Strictly after tranches 1–3. §14 before §3 is non-negotiable — shipping the window first produces false positives on the best-behaved workers and burns the signal permanently.

**Deliberately deferred to A3+:** §7, §10, §15, §18, §19, §22, §23. Each is real; none is on the critical path from "coordination dies silently" to "coordination fails loudly." §7 (blocked-beats-idle) is the strongest candidate to pull forward if A2 has capacity — it is a reordering in one file and it also repairs `orca terminal wait --for tui-idle`, the escape hatch the guide teaches.

**Explicitly out of A2:** any alias namespace, any retention/TTL work, any loosening of a fence, and any new message type.

---

## 6. Appendix — investigated and rejected

Negative results, one line each. Each of these saved implementation effort or prevented a wrong fix.

- **Agent trust preflight is missing from the orchestration worktree-create path** — **REFUTED.** `markLocalWorkspaceTrustedForAgent` (`orca-runtime.ts:21835`) and `markRemoteWorkspaceTrustedForAgent` (`:21853`) already exist in the main process, and `createManagedWorktree` calls the local one at `:22365` (plus 12 other sites) with `startupTrustAgent` derived from the `createdWithAgent`/`startupAgent` that `createWorkerWorktree` passes in (`orchestration-worker-topology.ts:143-144`). The proposed fix already ships. Surviving kernel: `claude` has no preset — that is the docs/detect item in section 3.
- **The stranded-relay-mail fence has a TOCTOU window** — **REFUTED.** `orchestration.ts:590` (fence) and `:598` (enqueue) are straight-line synchronous with no yield point in a single-threaded runtime. The real window is queue-while-ready then settle, which the repo's own test pins; the fix was redirected to drain-and-report (§15).
- **The mail pointer's hardcoded 500 ms causes a Windows submit failure** — **premise withdrawn.** The repo's own field record points the other way: the two "reproductions" are Windows *successes* that were later reclassified as normal ~20s startup (`federation-live-test-findings.md:62-76`), and the host where the runtime's submit did not land within 90s was Linux/AppImage, where 500 ms is already correct. The ConPTY 1500 ms rationale is about long bracketed pastes; the pointer is a ~70-byte raw write. The one-token constant swap is still worth doing (§17), just not on a Windows-failure premise.
- **Handle re-mint kills all mail to a coordinator** — **narrowed.** Message waiters are keyed on the mailbox address, not the terminal handle, so a coordinator in `check --wait` still wakes. Only the ambient push to an idle pane dies (§19).
- **`check --wait` on a settled Cursor worker strands notices permanently** — **narrowed to unreachable on the worker path.** The ordering defect is real (watermark advanced before the Cursor early-return, `orca-runtime.ts:33260-33275`), but the two `dispatch:` exclusions mean it is reachable today only for a Cursor pane acting as a *coordinator* or receiving bare terminal-handle mail. Low severity because of reachability, not because the failure is partial. Worth reordering four lines when §1 lands, since §1 makes the worker path reachable.
- **A fresh peer with no agent credentials fails at agent launch (field F12 prediction)** — **retracted in the field** (`COORDINATION.md:04:41 UTC`): credentials live in the host user's `~/.claude`, not the Orca profile. The auth-gate class remains uncovered by the detector vocabulary but is **not** an observed failure.
- **`dispatch_input: accepted` means the prompt was typed but not submitted (field F12)** — **retracted in the field** after two hands-off controls self-submitted at t+20s: "Four data points, one methodology error, repeated four times" (`COORDINATION.md:764-789`). The measured remnant is the narrow Linux/AppImage 90s observation, folded into §2. The retraction cost two commits to the bundled guide.
- **Relays are not re-armed after a runtime restart** — **REFUTED.** `src/main/index.ts:2562` calls `resumeOrchestrationFederationRelayAfterRestart`, and lazy DB init arms them again (`orca-runtime.ts:3933-3942`). The doc claim is true; what the doc omits is that health and backoff reset to zero with them (§9).
- **`--user-data-dir` fails to isolate the single-instance lock** — **REFUTED** by the field agents before use and re-verified: a packaged serve does take the lock (`single-instance-lock.ts:67-73`), a collision exits 3 (`:12`), and a duplicate start cannot promote a headless server to a desktop window (`:18`). Only the worktree root is unisolated (section 3).
- **The Codex-shaped detector missed the Claude trust gate's wording** — **REFUTED by hand-matching.** The captured text matches `trust this` + the `folder` qualifier and yields `codex-trust-workspace` (`orca-runtime.ts:37763`, `:37770`). The gate went undetected because of resolver ordering, not vocabulary (§7).
- **Auto-routing post-settlement mail to the Run mailbox** — evaluated and rejected: the Run mailbox is the coordinator's own inbox, the worker is contractually instructed not to read anything, and every shipped CLI silently drops a third routing outcome. Detail in section 3.

---

### Method and limits

Static analysis only, across seven lanes plus an adversarial verification pass. No builds, no `pnpm`, no `orca` CLI invocation (a production `orca serve` is live on this box), no writes to the repo. Every code claim was verified by reading the cited file at the cited line at `3e52508383`.

**Nothing in this inventory is graded "measured" on our own observation.** "Measured" means observed in `COORDINATION.md` or `docs/reference/federation-live-test-findings.md`. Consequently:

- **Frequency is unmeasured everywhere.** Mechanisms are established; base rates are not. This matters most for §4 (how often does an agent omit `--ack`), §19/§18 (how often do handles re-mint in a real headless serve), and §22 (how often does pane resolution fail).
- **The field session had a flat topology, both hosts up, short-lived dispatches, and coordinators in live panes throughout.** So §5, §6, §10, §18, §20, §21, §22 and §23 have no field instance by construction — the log never exercised the conditions. Each says so in place rather than stretching an adjacent F-number.
- **Windows behavior is entirely inferred.** The only Windows measurements are two hands-off self-submits at ~20s.
- **The Linux/AppImage submit gap's cause is open** (OS vs packaging; serve mode and the F6 shim were eliminated). §2's `input_not_consumed` classification is deliberately cause-agnostic so it stays correct whichever way it resolves.
- **Not audited:** the renderer/desktop UI (all observability claims are scoped to what a CLI-driven agent sees), the full `ORCA_USER_DATA_PATH` SSH passthrough list, every peer-side producer of the federated reconciliation response, and `worker-terminal-release-reconciliation.ts` (which could weaken §-adjacent claims about `worker_dispatches.state` persisting as `ready` after a PTY exit to "persists until some later reconcile").
