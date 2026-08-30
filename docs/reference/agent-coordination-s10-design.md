# S10 — Agent directory, plain-English discovery, durable threads (design, rev 1 — 2026-08-30, synthesized from the S10 understand workflow wf_c23e3870-2cd; chair-appended §6 poison containment)

Tree of record: `/home/ubuntu/orca-integration` @ `2de4f5894e`. Owner evidence and the desktop agent's own rationale ("terminal handles die between sessions and a handshake contract agreed only in a terminal is one nobody can check tomorrow") are the spec.

All claims verified against `/home/ubuntu/orca-integration` @ `2de4f5894e`. Two of the inherited findings needed correction; noted inline.

---

# S10 — Agent Directory, Resolver, Durable Threads

## 0. Root cause (one line)

Orca's orchestration layer is a **supervision tree** (Run → Task → Dispatch → worker). Two agents the owner started by hand share no Run and no Dispatch, so the only address one has for the other is an ephemeral terminal handle. The docs bus wins because it is the only substrate in the room with stable names, durable history, a replayable thread, and a wake-up. The agents were rational; the tool had no address for "the merge-restructure backend agent."

**Evidence-#1 verdict:** does not reproduce as stated. `RuntimeTerminalSummary` carries `handle` as its first field (`src/shared/runtime-types.ts:577-578`), both renderers emit it, and `printResult` is a raw passthrough. But `RuntimeTerminalVisualTab` is `{tabId, title, activeLeafId, panes}` with **no handle** (`src/shared/runtime-types.ts:619-624`) — and `--json` *drops* `visualLayouts` while text keeps them (`src/cli/handlers/terminal.ts:62`). An agent that walked the tab nodes saw exactly what the owner reported. Treat #1 as real (BUG 1) regardless of build.

---

## 1. BUGS TO FIX NOW

**1. Title-bearing JSON nodes carry no handle; `--json` and text are structurally different documents.**
`src/shared/runtime-types.ts:619-624` (tab node: no handle) vs `:598-606` (pane node has one); `src/cli/handlers/terminal.ts:62` (`includeVisualLayouts: !json || flags.has('include-visual-layouts')`).
*Fix:* add optional `handle`/`activeHandle` to `RuntimeTerminalVisualTab`, mirroring the pane its `activeLeafId` names, and make `--json` and text return the same shape — always include `visualLayouts`, or never. The asymmetry is the trap: text-mode humans and JSON-mode agents disagree about what a "terminal row" is.
*Test:* `terminal list --json` and `terminal list` over the same fixture yield identical node sets; every node with a non-null `title` has a resolvable `handle`.

**2. No row anywhere carries a role.**
`src/shared/runtime-types.ts:577-597` (title, worktreePath, branch, connected, preview — nothing about purpose); `src/cli/runtime/environment-terminal-roster.ts:165` (`agent: getAgentLabel(terminal.title)`), which via `src/shared/agent-title-identity.ts:46-61` only guesses the *product* ("Claude Code" / "OpenCode" / Gemini), never the job.
*Fix:* additive optional `role?: string` on `RuntimeTerminalSummary`, written by `orca terminal set-role --text <purpose>`. The write path already exists as `terminal.rename` (`src/cli/handlers/terminal.ts:143-148`). Surface in both renderers.
*Test:* set a role on terminal A; `terminal list --json` from terminal B shows it; `terminal rename` does not clobber it.

**3. `send` prints a receipt that is about the sender.**
`src/cli/handlers/orchestration.ts:677` prints `Sent ${r.message.id}${mailHint}`, where `pendingMailHint` (`:144-152`) reads `result.pendingMail` — the **sender's own** unread coordinator mail. It reads as a delivery confirmation and is not one. Meanwhile `delivered_at` and `read` are both written per message (`src/main/runtime/orchestration/db.ts:3638-3667`) and no verb exposes either.
*Fix:* return `{delivery: {state: 'queued'|'pointed'|'read', recipient: {state, lastSeenAt}}}` from the columns already maintained; add `orca orchestration sent --id <msg_id>`. Relabel the hint `Your unread mail:`.
*Test:* send to an absent peer → `queued`; peer idle → `pointed`; peer runs `check` → `read`.

**4. Threads are write-only.**
`send --thread-id <id>` writes `messages.thread_id` (`src/cli/specs/orchestration.ts:45-70`), indexed at `src/main/runtime/orchestration/db.ts:385`. No reader: `check` (`specs:81-86`), `inbox` (`specs:123-127`, flags `limit|terminal|full` only) and `reply` have no thread flag. An agent can create a durable thread and can never resume it — this alone forfeits "resumable days later" to git.
*Fix:* `orca orchestration thread --id <thread_id> [--since <ts>] --json` over `idx_thread`; add `--thread-id` to `inbox`.
*Test:* send three messages on one thread from two terminals; `thread --id` replays all three in order after a runtime restart.

**5. Peer mailboxes are a destructive read with no ack.**
`src/main/runtime/rpc/methods/orchestration.ts:999-1001` and `:1035-1036` (dispatch mailbox) and `:1077` (bare handle) call `db.markAsRead(...)` *before* the RPC response is handed back. The Run mailbox has a real at-least-once protocol (Delivery rows, replay, explicit `--ack`, `src/main/runtime/orchestration/db.ts:387-402`); the peer-to-peer mailboxes — the only ones two hand-started agents can use — have none. A dropped response consumes the message permanently while the sender already saw `Sent`. **Storage is durable; delivery is not.**
*Fix:* A1 §8's remedy — `markAsDelivered` on read (the method exists, `db.ts:3647`, and is uncalled from the runtime), implicit-ack on the *next* read. One release of overlap, then flip.
*Test:* kill the client mid-`check`; re-run `check`; the message is still there. Run `check` twice normally; the second returns empty.

**6. Ambient push has a pane-key fallback for Dispatches and none for peers.** *(correction to inherited finding)*
`deliverPendingMessagesForHandle` (`src/main/runtime/orca-runtime.ts:33516-33524`) **does** now fall back via `resolveMailboxTerminalHandle` — but that resolves `dispatch:<id>` addresses only (`:33473`, `:33486-33497`). A bare terminal handle that went stale on graph reload still returns early and the push dies silently. `runs.coordinator_pane_key` exists (`db.ts:351`) and `getTerminalHandleForPaneKey` exists (`orca-runtime.ts:33001`); the durable key is one lookup away for the peer case too. A1 §19 was deferred to A3+ and is still open for this path.
*Test:* send to a peer, force a graph reload, confirm the idle pane is still pointed.

**7. The wake-up works and says nothing worth waking for.** *(highest leverage)*
The push primitive the owner assumes is missing is **built** — `orca-runtime.ts:33532` writes into an idle pane and presses Enter. What it types is `formatMessagePointer` (`src/main/runtime/orchestration/formatter.ts:112-115`): *"You have N orchestration messages. Run `orca orchestration check`."* No sender, no role, no subject, no thread, no urgency. The docs-bus Monitor delivers **content**. An agent mid-flow reads a contentless pointer as an interrupt of unknown value and defers it.
*Fix:* pointer carries sender name + role, subject, thread id, count. `formatMessagesForInjection` (`formatter.ts:102-110`) already renders full banners — use it for ≤2 short messages and reserve the pointer for overflow.
*Test:* peer receives `[from: merge-restructure-backend] "lock-step: schema freeze" thread:th_… — 1 more`.

**8. `ask` is coordinator-only.**
`src/cli/specs/orchestration.ts:187-191`: `--to <run:id>`. Two siblings cannot open a blocking question without one first manufacturing a Run and adopting the other as a worker — a role change, not a message. The `question_threads` machinery (`db.ts:775`) is address-agnostic.
*Fix:* accept `--to agent:<id>`; answer from the peer's `check` via `orchestration reply`.
*Test:* A asks B, B replies, A unblocks; A times out and resumes with `--resume <msg_id>`.

---

## 2. S10 DESIGN SKETCH

### 2.1 Directory

New table `agents` in the same SQLite file (`orchestration.db`, WAL, `orca-runtime.ts:4054`) — durable across runtime restart and pane close by construction:

```
agents(id PK, display_name, role, pane_key, terminal_handle, process_incarnation,
       worktree_id, host_id, state live|idle|gone, derived INT, last_seen_at, registered_at)
```

`id` is minted **once per agent**, not per terminal — this is the fix that makes identity outlive the pane. `display_name` is unique per host, human-typable (`merge-restructure-backend`).

**Registration is self-service and idempotent.** `orca agents register --name <n> --role <one line>` from inside a pane, keyed on `ORCA_PANE_KEY` (already exported into every pane, `src/main/ipc/pty.ts:2489`), so re-running after a restart updates rather than duplicates. **Derivation fills the gaps:** an unregistered pane gets a provisional row from title + cwd + `getAgentLabel`, flagged `derived: true` so the resolver ranks it lower and can say so. This is what stops S10 from being a feature only disciplined agents benefit from.

**Routing rewrites `terminal_handle` from `pane_key` on every re-mint** — A1 §19 generalized from Runs to agents, and the reason the identity survives terminal churn.

### 2.2 Resolver

```
orca agents find "the merge-restructure backend agent" --json
→ {resolved|ambiguous|no_match, candidates:[{id,name,role,host,state,confidence,why}], nextSteps:[...]}
```

Scoring is boring, auditable, host-side: token overlap against `role`, then `display_name`, then `title`, then worktree path/branch, times a liveness multiplier, minus a penalty for `derived`. **Deliberately not an LLM call** — the caller is already a model; the host ranks, the agent decides.

**It must refuse rather than guess.** One candidate clear of the margin → `resolved`. Two inside it → `ambiguous` with the list *and the exact disambiguating command*. None → `no_match` plus `orca agents list`. This mirrors the refuse-on-ambiguity posture already used in legacy worker recovery. Every terminal output ends with the populated next command — `To reach one: orca agents ask merge-restructure-backend "…"`. Agents follow printed commands far more reliably than remembered guidance; the codebase already banks on this (`nextSteps`, `src/cli/handlers/orchestration.ts:156-159`).

### 2.3 Durable threads

Promote `thread_id` to a first-class table: `threads(id, subject, participants[agent ids], created_at, last_message_at, state)`. Storage is already durable — **addressing and a reader are the whole gap.** Every peer message carries a thread; mint one if absent and echo it in the send result so the sender can record it.

- `orca agents thread --id <t> [--since <ts>]` — replay, the answer to compaction.
- `orca agents threads` — "what conversations am I in, and what was last said" — the verb an agent needs on its first turn after losing context. Nothing today answers this (`inbox` is recipient-scoped and newest-first, `specs:123-127`).
- Delivery into the next turn: banner-with-content push (BUG 7) + delivered/read receipts (BUG 3) + implicit-ack durability (BUG 5).
- **Lock-step pact:** `orca agents pact --with <name> --on <thread>` records a two-party agreement in `threads.state`; each side's `agents wait --thread <t> --for reply` blocks until the other posts. This is what the owner asked for in plain English: neither side advances until both have.

### 2.4 Skill-guide rewrite

The guide is 441 lines and opens with Tool Boundary and ~45 lines of Contract Migration before the reader learns how to send a message; the stub demands the full guide load *first* (`skill-stubs/orchestration.md:35-46`). `git push` costs zero lines. Under context pressure the agent picks the cheap one — correctly.

- **A 15-line peer path at the top**, before any migration text: register → find → thread → ask. Reachable without reading the rest.
- **`## When To Use` (`skill-guides/orchestration.md:38-42`) currently has no entry for "two agents already running that need to coordinate as equals."** Add it as entry #1. Today the only line covering the owner's exact situation is buried at `:143` and frames peer messaging as a *degraded precursor* — "appropriate for low-level pre-Dispatch messaging." An agent reading that concludes its situation is out of scope, and it is reading correctly.
- Delete the framing at `:104` ("terminal handles remain routing metadata rather than durable identity") in favour of: agent ids **are** durable identity; handles are cache.
- Add the missing procedure the guide has nowhere: *"asked to coordinate with an agent you can't address? → `orca agents find`."*

---

## 3. Supersedes / reuses from A2+B2

| Reuse | Supersede |
|---|---|
| SQLite orchestration DB, WAL, migration pattern (`db.ts:334-341`) — S10 tables are additive | A1 §19 pane-key fallback: **generalize** from `runs.coordinator_pane_key` to `agents.pane_key`; the Dispatch-only fallback at `orca-runtime.ts:33519` becomes a special case |
| Ambient push machinery (`orca-runtime.ts:33516-33532`) — built and working, only its payload is wrong | A1 §18 (federated peer never re-resolved) — subsumed by directory re-mint rewrite |
| Bounded-parallel peer probe (`environment-terminal-roster.ts:71-86`) — the federation primitive S10-4 needs | `environment roster`'s title-guessed `agent` field (`:165`) → real `role`; roster becomes a directory view |
| B2 presence (who's-typing) — orthogonal, keep as a row decoration | A1 §3's deferred "alias namespace" — S10's `display_name` **is** that namespace, now unblocked |
| Refuse-on-ambiguity + `nextSteps` recovery pattern | A1's docs-only remedy for the file-bus antipattern ("tell agents not to") — replaced by making the tool win on affordances |
| `question_threads` (`db.ts:775`) for peer ask/reply | — |

**Not progress on this ask despite the name:** `agent-identity-s9-design.md` is per-lane Claude-account *login*, not agent role. `multi-agent-worktree-discipline.md` is git hygiene.

---

## 4. Slice plan

**S10-0 — Bugs (sonnet, med).** Bugs 1-4, 6, 7. Additive types, two new read verbs, one pointer rewrite.
*Owner test:* "Ask an agent to list terminals as JSON and tell you which one is the backend — it names a handle, not a guess. Send a message to an idle pane and read what appears there: it names the sender and the subject."

**S10-1 — Directory + resolver (opus, high).** `agents` table, `register`, derivation, re-mint rewrite, `find`/`list`. Bug 5 lands here (delivery durability) since it touches the same read path.
*Owner test:* "Ask agent A, in plain English, to find the merge-restructure backend agent. It finds it without asking you. Now open a second lookalike terminal and ask again — it refuses and asks you which."

**S10-2 — Durable threads + delivery (opus, high).** `threads` table, `thread`/`threads`, receipts, content-bearing push, peer `ask`/`reply`/`wait`.
*Owner test:* "Ask A to start a thread with B. Close A's terminal. Restart Orca. Ask A what conversations it's in — the thread comes back with everything B said while it was gone."

**S10-3 — Lock-step pact + skill guides (opus, high; docs sonnet).** `pact`, guide rewrite, `When To Use` entry, printed next-commands everywhere.
*Owner test:* "Tell A to coordinate with B in lock step. Neither moves past a step until the other confirms — and neither one touches the docs repo."

**S10-4 — Federation (opus, high).** Directory union across saved environments; `find --all-hosts`; `agent:<id>@<host>` addressing.
*Owner test:* "From the VPS, find an agent running on the desktop by its role and open a thread with it."

---

## 5. Risks and owner decisions

**Risks.** (i) Registration is voluntary — if agents don't register, the directory is only as good as derivation; mitigated by provisional rows + `derived` flag, but a low-quality directory is worse than none because it teaches agents not to trust `find`. (ii) `display_name` uniqueness is host-local; federation needs `name@host` and a collision policy. (iii) Content-bearing push types more into a pane — a mid-flow agent gets a bigger interruption, so cap at ~2 short messages and gate on the existing `lastAgentStatusObservedLive` check (`orca-runtime.ts:33532`). (iv) Implicit-ack changes peer-mailbox semantics; needs one release of overlap. (v) None of this can force preference over the docs bus — only make the tool cheaper. Ship S10-3's guide rewrite or the rest under-delivers.

**Decisions only the owner can make:**

1. **Should an unregistered pane get an auto-derived directory row?** → **Yes** (recommended). Without it, S10 only helps agents that already read the guide, and the owner's four terminals would have shown one useful entry. Cost: `find` can return a plausible-looking wrong answer, tempered by `derived: true` in the output.
2. **Should `orca agents find` ever auto-address on a single strong match, or always hand back candidates?** → **Always hand back** (recommended). The caller is a model and can decide; a silently-wrong auto-address is exactly the failure the owner is complaining about, one layer up.
3. **Should peer messages default to implicit-ack (durable) even though it changes existing `check` semantics for `dispatch:` mailboxes?** → **Yes, with one release of dual-behavior** (recommended). Fire-and-forget is the thing the owner hates; leaving the destructive read in place keeps the durability story a half-truth.

---

## 6. Poison containment (R-P) — owner hard constraint, chair-appended

The coordination bus must be **purgeable and containable**, and the failure mode is on the **write path** (lower-tier agents posting security notes in a shape that trips stricter models for every reader). Every S10 slice carries these rules and their acceptance tests:

- **No broadcast.** Delivery only to explicit thread participants; `find` never returns message content; `threads` lists subjects, not bodies.
- **Summary-first delivery.** The pane push (BUG 7) carries sender, role, subject, thread id and a count — never a body beyond one short line; bodies are pulled with `thread --id`.
- **Provenance** on every message: agent id, host, pane key, time — immutable.
- **Post-time gate.** A message is checked at `send`/`ask` with the same remediation-framing gate designed for the docs bus (hard block on audit/vuln-shaped structure, infra literals, secret-shaped values; soft warn on attacker vocabulary); a blocked message is refused with the rewrite sentence and is never stored as deliverable.
- **Purge and quarantine verbs.** `orca agents purge --message <id>|--thread <id> --reason <text>` tombstones (body removed, provenance + reason kept, never delivered or replayed again, including to participants who have not pulled it); `orca agents quarantine <agent> [--lift]` fences an author's past and future messages. Both write audit rows.
- **Sensitive threads.** `--sensitive` threads keep bodies on-box (never federated, never pushed into a pane); participants pull explicitly.
- **Clean-room reads.** Replays omit purged/quarantined items and state the count omitted; nothing is silently missing.
- **Tests:** purge a message → no participant ever receives it (including one that joins later); quarantine an author → their queued messages are withheld and the recipient's replay says so; a blocked send never appears in any replay; a sensitive thread's body never appears in a pane push or a federated roster.
