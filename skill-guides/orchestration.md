---
name: orchestration
description: >-
  Use Orca orchestration for structured multi-agent coordination: threaded
  messages, blocking ask/reply flows, task dispatch, worker_done/escalation
  waits, task DAGs, decision gates, coordinator loops, or decomposing work
  across agents. Use `orca-cli` instead for full ownership handoffs, including
  requests phrased as "hand off", "handoff", "handover", "give this to another
  agent", or "another worktree" when the user did not explicitly ask to
  supervise, monitor, wait for results, or coordinate a DAG. Use `orca-cli` for
  ordinary terminal control, lightweight terminal prompts, shell commands, Orca
  worktree management, reading or waiting on terminals, and automation of the
  browser embedded inside Orca. Use Computer Use for browser windows, webviews,
  Orca app UI, or desktop UI outside Orca's embedded browser.
---

# Orca Inter-Agent Orchestration

Orchestration is Orca's structured coordination layer for agent messages, task ownership, dispatch state, and worker completion tracking.

Use this skill when coordination state matters. For lightweight terminal prompts or basic worktree/terminal/built-in-browser control, use `orca-cli`.

## Peer Path (read this first if two agents need to coordinate as equals)

```
orca agents register --name <my-name> --role "<one line>"
  -> {agent, created|reMinted}. Next: find your peer.

orca agents find "<plain-English description of the peer>" --json
  resolved   -> "To reach one: orca agents ask <name> \"...\""
  ambiguous  -> candidate list + the exact disambiguating command
  no_match   -> "orca agents list"

orca agents ask <name> "<question>" --json
  -> "<answer>\n(thread thr_9fk2, waited 47s)\nContinue: orca agents reply --thread thr_9fk2 --body \"...\""
  timed out (exit 0) -> "Still pending after 600s (thread thr_9fk2).
     Resume without re-asking: orca agents wait --thread thr_9fk2 --for reply"

orca agents reply --thread <t> --body "<text>"
  -> "Replied <msg_id>.\nNext: orca agents thread --id thr_9fk2"

orca agents wait --thread <t> --for reply
  -> blocks; returns the reply itself, never a pointer

Told to coordinate "in lock step" (neither side advances past a step
until the other confirms)? That's a pact, not ask/reply:
orca agents pact --with <name> --on <thread>          -> propose/engage
orca agents step --thread <t> --done "<what you did>" -> your turn, once
orca agents wait --thread <t> --for step               -> blocks for theirs
orca agents pact --show <t>                            -> a third party can check it tomorrow

New turn / lost context -> orca agents threads
  -> "Read one: orca agents thread --id thr_9fk2"
```

Every branch above ends in the exact next command the CLI itself prints — never guess or
remember one. "Lock step" resolves to `orca agents pact`, a named primitive, not a silent
substitution with `ask`+`wait --for reply` (that has no shared turn state, so neither side can
prove whose move it is, or that the other side hasn't skipped ahead).

## When To Use

1. Two already-running agents that need to coordinate as equals — neither is the
   other's coordinator, there is no shared Run or Dispatch. This is the Peer Path
   above: `orca agents register` -> `find` -> `ask`/`thread`/`wait`, or `pact` if
   neither side may advance until the other confirms.
2. Asked to coordinate with an agent you cannot address (no known handle, name,
   or terminal id — e.g. "tell the merge-restructure backend agent...")?
   -> `orca agents find "<plain-English description>"`. Never fall back to a
   docs-repo post or a guessed terminal handle because you don't have an address;
   `find` exists precisely for this case.
3. Send/reply/ask between agent terminals with persistent messages (peer, via
   `orca agents *`, or coordinator-to-worker, via `orca orchestration *`).
4. Dispatch structured tasks to workers and wait for `worker_done`/`escalation`.
5. Track task DAGs with dependencies; run coordinator loops or decision gates.

Do not use orchestration merely because the user says "hand off", "handoff",
"handover", "give this to another agent", or asks for another worktree/agent/
model/effort — those are full ownership transfers (see Full Handoffs) unless the
user explicitly asks to supervise, monitor, wait, coordinate a DAG, or keep a
blocking ask/reply loop.

## Mental Model

Agent ids are durable identity, minted once per agent and outliving any pane or terminal
restart; terminal handles are a cache the runtime rewrites underneath that id, never the other
way around. Peer mail and threads are durable and replayable — a thread survives a runtime
restart and answers "what conversations am I in" on your first turn after losing context
(`orca agents threads`). Wake-ups are summary-first: a pane push carries sender, role, subject,
thread id and a count, never a full body — pull the body yourself with `orca agents thread --id
<t>` when you need it. Docs repos are for documents, not coordination: a message committed there
has no purge, no delivery receipt, and no wake-up at all — contrast the pane-push mechanism that
gives peer mail its wake-up; a blocked peer never learns you replied until it happens to re-read
the file. Prefer the tool that has an address for the other agent over the tool that costs zero
lines to reach for.

## Containment (what happens to what you send)

Every `send`/`ask`/`reply` body (and `purge --reason`, and `quarantine --reason`) passes a gate
before it is stored:

- HARD block, refused, nothing stored, nothing delivered: a heading or section-opener shaped
  like `MERGE-GATE AUDIT` / `SECURITY (HIGH|CRITICAL)` / `VULNERABILITY`; a secret-shaped value
  (provider token pattern, or `KEY=`/`SECRET=`/`TOKEN=` followed by 20+ real characters); an
  infra literal on the local allowlist. An inline mention or a one-line pass/fail verdict does
  NOT match — only a heading-shaped line does.
- SOFT warn, still delivered: attacker/bypass/exploit vocabulary. This tier is measured at ~75%
  false positives on ordinary security-design prose and must never be tightened to a hard block
  for that reason.
- If refused, restate in remediation framing: state what changed, how it was proven, and the
  rule it now enforces. Drop the attacker's-eye narrative, hostile-input examples, and infra
  literals. A one-line pass/fail verdict with no audit heading is not gated at all.
- `--acknowledge-gate` does not bypass the gate — it converts a HARD verdict into a
  stored-and-flagged send. Use it only when the detail genuinely must travel on the bus; it is
  audited, not hidden. A pact step (`orca agents step --done "..."`) is gated the same way: a
  refused step writes no ledger row and does not pass the turn — re-send it with
  `--acknowledge-gate` to record it flagged and audited.
- `orca agents purge --message <id>|--thread <id> --reason <text>` tombstones a message: body
  blanked, provenance and reason kept, never replayed again to anyone, including a participant
  who joins later or hasn't pulled it yet. You may purge your own message; a thread owner or
  local operator may purge any message on the thread. There is no `--lift` on a purge — it is
  final by design.
- `orca agents quarantine <agent> --reason-code <code> [--lift]` fences an author's past and
  future messages from every reader; self-quarantine is always allowed, quarantining someone
  else is local/non-federated-operator only. A quarantined peer cannot be reached — `send`/`ask`
  to it is refused with `agent_quarantined`, and a pact cannot be proposed with, or joined by, a
  quarantined agent — coordinate without a pact using `orca agents ask` instead. Quarantine
  alone does not free the agent's name for reuse; `orca agents retire` is the deliberate second
  step for that.
- `orca agents retire <name|id> [--force]` tombstones an agent and frees its `display_name` for
  a fresh `orca agents register` to reclaim — local/non-federated-operator only, and refused for
  a currently live, attested agent unless `--force`. Idempotent by id (retiring an
  already-retired agent returns `already_retired`, never an error). A retired agent is never
  listed or resolvable again; mail to its old `agent:<id>` refuses with `agent_retired`, naming
  a same-name successor when one has since reclaimed the name.
- `--sensitive` threads keep bodies (and subjects) on-box: never federated, never pushed into a
  pane, never in a roster. Only named participants can pull them — bring a third party in with
  `orca agents invite --thread <t> --agent <name>` before a pact can involve them.

## Cross-Host

`orca agents find "<description>" --all-hosts` unions the directory across every saved
environment:

- Every host (local plus each saved environment) is probed live and bounded — never a stale
  mirror. A peer that does not answer in time lands in `unreached` with a reason and is counted
  in `hostsAnswered: n/m`; it is printed, never silently dropped, and it never vetoes a local
  resolution (a silent peer is not a "no").
- Every candidate is scored by the exact same resolver every host runs, on the *raw* rows pulled
  from each host — a peer's own claimed confidence is never trusted directly.
- A bare name that matches agents on 2+ hosts is `ambiguous` — local never wins the tie
  implicitly; a foreign candidate carries `foreign:true` and its address is `name@host`.
- `orca agents show <name>@<host>` and `orca agents ask <name>@<host> "<question>"` resolve and
  route straight to that saved environment, no `--environment` flag needed. `--id`/`--name` on
  `show` stay local-only (an id you copied off a local `list` row can never be a foreign one by
  accident).
- Quarantine stays host-local: a remote host can neither fence nor un-fence an agent registered
  here.
- Dispatch federation is a separate, narrower mechanism (`worker-start --on <env>`): a genuinely
  foreign agent id still has no reader on this host, so `agent:<id>` sends and `dispatch
  --inject` to it refuse — `ask`/`show` work by routing to the peer directly instead.

A peer that does not advertise the agent directory at all (an older runtime) degrades the same
way the roster does: it is skipped and named in `unreached`, never a hard error for the whole
query. A same-name hit that used to resolve locally may be a stale pairing once a second host
registers the same `display_name` — re-run `find` and read the `foreign` marker rather than
trusting a cached address.

`orca agents relink --env <name>` (S10-4 ruling 5) is the named recovery verb for a peer that was
reimaged/reinstalled inside the same pairing: it resets this host's own relay import/ack cursors
for that environment's active federated dispatches and bumps their relink generation, so
`relay_seen` records the next contact's per-item outcomes (incl. refusals) under a fresh
generation instead of colliding with this link's pre-relink history under the same sequence
number. A genuinely new install still needs `orca environment rm` + re-add, not relink.

## Agents & Threads (peer command reference)

```bash
orca agents register --name <slug> --role "<one line>" [--json]
orca agents list [--state live|idle|gone] [--include-quarantined] [--limit <n>] [--json]
orca agents find "<plain-English description>" [--limit <n>] [--all-hosts] [--json]
orca agents show <name|id|name@host> [--json]
orca agents quarantine <name|id> --reason-code <code> [--lift] [--json]
orca agents retire <name|id> [--force] [--json]
orca agents relink --env <name> [--json]

orca agents threads [--state open|paused|closed|all] [--limit 25] [--json]
orca agents thread --id <t> [--since <seq|ts>] [--json]
orca agents thread --new --with <name>[,<name>...] [--subject "<text>"] [--sensitive] [--json]
orca agents thread --id <t> --leave [--json]
orca agents invite --thread <t> --agent <name> [--json]

orca agents ask <name|name@host> "<question>" [--options a,b,c] [--timeout-ms <n>] [--acknowledge-gate] [--json]
orca agents ask --resume <question-id> [--json]
orca agents reply (--thread <t>|--id <msg>) --body "<text>" [--acknowledge-gate] [--json]
orca agents wait --thread <t> --for reply|message|pact|step [--timeout-ms <n>] [--resume <token>] [--json]
orca orchestration send --to <name>@<host> --subject <text> [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--json]

orca agents pact --with <name> --on <thread> [--steps <n>|--open] [--json]
orca agents pact --on <t> --accept|--decline [--reason <code>] [--json]
orca agents pact --pause --on <t> [--reason <code>] [--json]
orca agents pact --resume --on <t> [--json]
orca agents pact --release --on <t> [--reason <code>] [--json]
orca agents pact --show <t> [--json]
orca agents step --thread <t> --done "<what>" [--acknowledge-gate] [--json]

orca agents purge --message <id>|--thread <id> --reason "<text>" [--acknowledge-gate] [--json]
orca agents review <name|id> [--limit <n>] [--json]
```

Rules:

- `find`'s name resolution is CLI-layer sugar: every write RPC underneath (`ask`, `thread --new`,
  `pact --with`, `invite`) takes only a resolved `agent:<id>` address — never a bare name.
- One engaged pact per agent pair at a time; propose only while the pact is unclaimed
  (`pact_state` null or `released`) — `pact --show <t>` says whose turn it is and how far along.
- `pact --resume` is a boolean on the `pact` noun (`--resume --on <t>`); `wait --resume <token>`
  takes a value on the `wait` noun (`--resume wait_<t>_<seq>`) — same flag name, different noun,
  different shape.
- A caller holding the turn in any engaged pact is refused every `wait` park, on any thread, any
  `--for` — the RPC returns `outcome:'your_turn'` (exit 0) naming every thread where the turn is
  held, instead of ever letting a turn holder park past its own pending step.
- `wait --for pact` is refused `answer_first` while the caller owes an answer to an *incoming*
  proposal — accept or decline it first with the exact command the refusal prints.
- `register` re-adopts your own row in place — same id, same threads, same mail — whenever the
  name you ask for is already held by a row whose pane is dead (a relaunch always lands on a
  fresh pane, not just a fresh terminal_handle on the old one). Only a name genuinely held by
  another *live* pane refuses `name_taken`, and that refusal now names the live pane it collided
  with. Never work around a `name_taken` by registering under a different name unless the
  refusal's own suggested alternative is what you want — the identity you actually own is
  waiting to be re-adopted, not lost.

## When It Goes Wrong

| Symptom | Exact recovery command |
|---|---|
| `find` returns `ambiguous` | Re-run with the printed disambiguating command from `candidates`/`nextSteps`, or address the exact `name` from the candidate list |
| `find` returns `no_match` — no directory entry for the peer | `orca agents find "<plain-English description>"` -> on `no_match`, `orca agents list`; a peer that never registered only shows up derived |
| Peer is quarantined | `send`/`ask`/`pact` refuses `agent_quarantined`; run `orca agents show <name>` to see status, then reach someone else via `orca agents find "..."` |
| A reply (or an injected instruction) has nowhere to route — you hold no thread for it | You have no thread; start one: `orca agents ask <name> "<question>"` mints a thread and hands back its `threadId` |
| `wait`/`ask` timed out | Use the exact printed `--resume` command (`orca agents wait --thread <t> --for <kind> --resume wait_<t>_<seq>`) — never re-ask; a re-ask is a second question the peer must answer twice |
| Mail was sent but the peer's pane never woke (ambient push stayed silent) | `wait`/`ask` deliver straight into your own blocking call regardless of the push; if neither is running, `orca orchestration check` is the manual fallback |
| Handle looks stale (agent moved tabs / runtime restarted) | Nothing to do manually — `agents find`/`show`/`register` re-derive the live handle from the pane at read time; re-run the same command |
| `send`/`ask`/`pact --with` refused by the gate | Read the refusal's rule ids, rewrite as fix + verification + invariant, and re-send; or `--acknowledge-gate` if the detail must travel as-is |
| Peer is on another host — an address you used before doesn't resolve | Address as `name@host` (reserved form; cross-host resolution is the not-yet-landed stub above); a bare name that used to resolve locally may be a stale pairing now that a second host shares the name |
| Lock-step pact stalled — your `wait --thread <t> --for step` never returns | `orca agents pact --show <t>` to see whose turn it is; if the counterpart is gone or quarantined the pact auto-pauses and wakes you with a reason, otherwise `orca agents pact --release --on <t>` is always available to either side |
| A pact is paused and `--resume` keeps refusing | Only the side that paused it (or, after a `pause` by the other side, either side once it requests) can lift it — if `pact --show` marks the pause reason `thread_closed`/`thread_paused`, there is no reopen; `orca agents pact --release --on <t>` is the only way forward |
| Replies you only saw appear on a live pane/screen, with no durable record after losing context | `orca agents threads` then `orca agents thread --id <t>` replays the durable record instead of trusting the screen |

## Tool Boundary

If a task says to use Orca orchestration, the coordinator must create or bind a Run, create the Task with `orca orchestration task-create`, then attach the worker with either the preferred `orca orchestration worker-start` composition or the low-level `orca orchestration dispatch --inject` path.

Do not substitute non-Orca subagent tools, generic agent-spawn APIs, or chat-only parallel worker features. Those may create useful workers, but they do not create Orca task/dispatch provenance, injected lifecycle preambles, `worker_done` authority, or decision gates.

Before claiming a worker was orchestrated, verify the task/dispatch exists:

```bash
orca orchestration task-list --json
orca orchestration dispatch-show --task <task_id> --json
```

If the work was accidentally run outside Orca orchestration, say so plainly. To repair provenance, rerun or revalidate the needed work through a fresh Orca terminal plus injected dispatch; do not retroactively describe the external worker as orchestrated.

## Preconditions

- `orca status --json` should show a running runtime.
- `orca` must be on PATH (`orca-ide` on Linux).
- The orchestration experimental feature must be enabled in Settings > Experimental.
- `orca orchestration` commands are RPC calls to the running Orca runtime.

## Contract Migration

Orca adopts a live pre-update orchestration assignment into an ordinary Run. Adoption preserves the existing agent process, PTY/session, terminal handle, tab/leaf/pane, worktree or folder workspace, Task, and Dispatch; it never restarts or replaces the worker. The retired scheduler is not revived, and a newly created attempt uses the current grammar.

Treat the authority label on injected or formatted messages as definitive:

- `[LEGACY COMPATIBILITY]` is live and attested. Run only the exact supported command printed with the message, using the same CLI executable and arguments that the original prompt supplied.
- `[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]` is one bounded, at-least-once cutover replay. Process it idempotently and acknowledge it only through the exact displayed guidance.
- `[LEGACY READ-ONLY]` is inspection-only. It has no reply, acknowledgment, or lifecycle action.
- An unlabeled current message uses the current guide and current grammar.

An explicitly selected current Run, attested current Run binding, current Dispatch, or federated attachment takes precedence over legacy fallback. A retained adoption record alone never turns a current command into a legacy call.

Database provenance, an old-looking terminal, or a legacy Run ID does not prove mutation authority. If the runtime cannot prove liveness, principal ownership, capability, or the exact legacy contract, it degrades to read-only inspection and must not fall back to local execution. Exact recovery may restore the already-live PTY once in its original inactive background tab. It must not spawn, write, signal, stop, switch, focus, split, or inject a terminal. Loss of lifecycle authority does not invalidate the existing assignment, process, or filesystem work.

Compatibility retries have narrow guarantees. A pending ask, a reply, a final Dispatch settlement, and a consuming check have durable recovery identities. A-era heartbeat and escalation calls remain at-least-once across a manual A-to-B retry because identical later signals may be intentional. If an A-era ask may already have been answered, run the exact non-consuming recovery check printed by the runtime first; after its answer is printed and acknowledged, a new invocation with the same question creates a new question. Never guess among multiple identical question threads.

When a compatibility or recovery command returns structured next-step arguments, run those exact arguments with the same CLI executable. The arguments intentionally omit the executable name so the guidance works with `orca`, `orca-ide`, `orca-dev`, or another configured Orca CLI command. Do not translate the command from memory, broaden its recipient, or retry it as a current mutation unless the returned guidance explicitly says to.

On packaged Windows, a legacy ask uses a two-step commit/resume protocol. The initial command durably commits the question, prints its exact `ask --resume <message_id>` command, and exits with launcher status `75`; it does not wait for the answer. Run that exact resume command after the launcher or update boundary. Resume is idempotent and read-oriented: it waits for the already-committed question and does not create another one. For a WSL process that received compatibility proof at launch, use the printed executable `orca-ide` WSL resume command so the same distro and packaged launcher authority are preserved; do not substitute a PATH-resolved local CLI. Older WSL processes that never received the hidden launch token remain lifecycle read-only after the update, even while their terminal and filesystem work continue.

Legacy inspection remains available without consuming mail:

```bash
orca orchestration run-list --json
# run_legacy_local is an empty audit tombstone after adoption.
orca orchestration run-show --id run_legacy_local --json
# In run-list, find the ordinary Run whose objective is:
# "Recovered orchestration work from a contract update"
orca orchestration run-show --id <adopted_run_id> --json
orca orchestration task-list --run <adopted_run_id> --json
orca orchestration inbox --full --json
orca orchestration check --terminal <legacy_handle> --peek --format --json
orca terminal read --terminal <legacy_handle> --json
orca terminal wait --terminal <legacy_handle> --for tui-idle --timeout-ms 60000 --json
```

If the original coordinator is unavailable or cannot prove its retained authority, a current coordinator may explicitly take over the adopted Run from its own live agent terminal:

```bash
orca orchestration run-use --id <adopted_run_id> --takeover-legacy --json
orca orchestration check --run <adopted_run_id> --json
```

Takeover fences only the old coordinator, binds the current one, and moves pending worker mail into current Run Delivery. It is bound to the authenticated invoking terminal; `--from` cannot name another coordinator. Live legacy workers keep their original Tasks, Dispatches, processes, filesystems, and old prompt commands; their later questions, escalations, and completion reports route to the current coordinator. Do not use takeover while the original coordinator is still actively coordinating, because its later lifecycle mutations are rejected.

Do not launch a replacement editor merely because the desktop app or runtime was updated. If adoption cannot prove continuing authority, keep the original worker as the only editor until it reaches a stable handoff point, then use a new current Dispatch in a conflict-free placement for any remaining work.

## Ownership

New orchestration messages and tasks belong to one explicitly bound Run. A Run is only a durable namespace and coordinator inbox; it never schedules or places workers. Lifecycle authority comes from the active Dispatch. Agent ids (`orca agents register`) are durable identity; terminal handles are a cache the directory re-derives. Send `worker_done` and `heartbeat` from the worker's own terminal; Orca routes them to that Dispatch's Run.

Classify inherited context before sending lifecycle messages:

- Coordinated subtask: a live coordinator owns the DAG and waits on this dispatch. Follow the preamble exactly, including `worker_done`, heartbeat/status, `ask`, and `escalation`.
- Full handoff means ownership transfer, not supervised dispatch. The original actor is not monitoring a DAG, so do not create lifecycle obligations unless the user explicitly asks you to supervise.
- Classify requests containing "hand off", "handoff", "handover", "give this to another agent", "give this to another worktree", "another agent", or "another worktree" as full handoffs by default, even when the user names a custom model or reasoning effort.
- Use supervised orchestration only when the user explicitly asks you to "supervise", "monitor", "wait", "track completion", "wait for worker_done", return results, coordinate a DAG, use a decision gate, or manage ask/reply flow.
- Do not use `orca orchestration dispatch --inject` for full handoffs. It injects a coordinator preamble that tells the worker to send `worker_done`, heartbeat, and `ask` messages, then end its turn under the original terminal's dispatch lifecycle.
- Do not run `orca orchestration task-create`, `orca orchestration dispatch --inject`, or `orca orchestration check --wait` for full handoffs. Do not peek at terminal output after prompt delivery to monitor progress.
- A review-only `worker_done` reports findings; it does not authorize coordinator file edits. After a review-only completion, synthesize findings, ask a decision gate if ownership is unclear, and dispatch or hand off fixes unless the user explicitly asked the coordinator to own fixes.
- If the user's plan names a next owner agent (for example, "then use opencode to create a PR"), post-review corrections and PR prep belong to that named owner. The coordinator routes, synthesizes, asks decision gates when needed, and supervises; the named owner edits files and creates the PR.

If unclear, inspect orchestration state before sending lifecycle messages:

```bash
orca orchestration task-list --json
orca terminal list --json
# If inherited context includes a task id:
orca orchestration dispatch-show --task <task_id> --json
```

## Messaging

```bash
orca orchestration send --subject <text> [--to <run:id|dispatch:id|legacy_handle>] [--from <handle>] [--body <text>] [--type <type>] [--priority <level>] [--thread-id <id>] [--payload <json>] [--json]
orca orchestration check [--terminal <handle>] [--ack <delivery_id>] [--peek|--all] [--types <type,...>] [--format] [--wait] [--timeout-ms <n>] [--json]
orca orchestration reply --id <msg_id> --body <text> [--from <handle>] [--json]
orca orchestration ask (--question <text>|--resume <msg_id>) [--options <csv>] [--timeout-ms <n>] [--from <handle>] [--json]
orca orchestration inbox [--limit <n>] [--terminal <handle>] [--thread-id <id>] [--json]
orca orchestration sent --id <message_id> [--json]
orca orchestration thread --id <thread_id> [--since <timestamp>] [--json]
```

Rules:

- Omit `--from` unless impersonating another terminal; Orca auto-resolves it from the current terminal.
- A coordinator `check` returns the bound Run's oldest FIFO Delivery (up to 50 messages) and replays that exact batch until `--ack <delivery_id>`. Process every message before acknowledging; `check --ack <id> --wait` acknowledges, checks, and waits in one operation.
- A replayed batch renders as `Delivery <id> [REPLAY — N newer messages are blocked behind it; acknowledge with --ack <id>]`, and a full fresh batch renders `[N more queued behind this batch; ...]`. Both mean the same thing: acknowledge, or nothing newer can reach you. `--json` carries the same facts as `replayed` and `pendingBehind`.
- Use `--peek` and `--all` only for read-only history/debugging. Type filters decide when a waiter wakes; the returned actionable Delivery is still the oldest full batch.
- Use `dispatch:<id>` for coordinator guidance to one supervised worker. Orca routes that stable address locally or through the connected-server relay; do not substitute a remote terminal handle. Mail to that address is also announced in the worker's pane when it is idle and its PTY write path is healthy; that push is best-effort, so the worker's own `check` cadence stays the contract.
- Terminal handles remain appropriate for low-level pre-Dispatch messaging. Prefer `agentTerminalHandle` from the create response, fall back to `startupTerminal.handle` for older runtimes, then re-resolve with `orca terminal list --worktree ... --json` if missing or stale. Continue with the replacement handle only; never dual-send to old and new handles.
- `terminal list --json` omits `visualLayouts` because handle recovery does not need topology. Add `--include-visual-layouts` only for explicit tab and pane inspection.
- `orca orchestration check --peek --format --json` returns locally formatted unread mail without consuming it; it never writes to terminal input or remotely wakes another terminal. Use `orchestration dispatch --inject` to deliver a tracked task, or `terminal send` when an existing agent needs a free-form prompt.
- While supervising workers manually, use `check --wait --types worker_done,escalation,question --timeout-ms <n>` instead of sleep/poll loops. Process the whole Delivery, reply to `question` messages with `orca orchestration reply --id <msg_id> --body <answer> --json`, then acknowledge and keep waiting.
- Treat a `check --wait` timeout or `{count:0}` as a checkpoint, not a worker failure. Long coding tasks routinely run 15-60 minutes; keep using rolling waits unless you receive `worker_done`/`escalation`, the terminal exits or disappears, `waitInterrupted` is set, or the user explicitly asks you to stop.
- A `{count:0}` result carrying `waitInterrupted` is not a checkpoint. `consumer_fenced` means another consumer owns this Run's mailbox: `check` prints the `run-use` rebind command and exits non-zero, so stop the loop and rebind. `waiter_exists` means another actionable waiter already blocks on it. `outcome_unknown` means your `--ack` was applied but the wait's result was lost; re-run `check`.
- Heartbeats and visible terminal activity mean the worker is alive, not done. Do not stop, close, kill, or restart a worker just because it has not produced a completion message yet.
- The liveness reads are `worker-show`'s `observation.agentStatus` (`permission` at an interactive gate, `working` mid-turn, `idle` at a ready prompt, `unknown` when the runtime has no verdict), `lastHeartbeatAt`/`heartbeatAgeMs` (a `heartbeat=` token per row on `worker-list`), and `dispatchMailbox`/`workerMail` for undelivered mail. `orca terminal agent-status --terminal <handle> [--environment <peer>]` asks the same gate question directly and never writes to the terminal. An absent field renders `unknown` or `never` — never `0`, and never a stall verdict.
- An `escalation` whose `payload.origin` is `runtime` was written by Orca, not by your worker. Its `kind` is `liveness_breach` (no heartbeat arrived inside the Dispatch's window; size it with `worker-start --liveness-window-ms`, `0` disables it), `blocked_on_gate`, `input_not_consumed`, `worker_process_gone`, `relay_unreachable`, or `relay_recovered`. Heartbeats are presence; their absence inside a window the worker committed to is the one signal that says the worker may be dead. Each is evidence and never a verdict, and the Dispatch is untouched: confirm with `worker-show` and `worker-read`, answer a gate with a single `terminal send`, re-dispatch the Task if the worker is genuinely gone — and keep the existing rule that a timeout alone never justifies a release.
- For a federated worker, `worker-show`'s `sync` reports `lastSyncAt`, `lastError`, and `consecutiveFailures`, and it survives a runtime restart, so a peer that has been unreachable for days says so instead of reading as `never`. A `liveness_breach` carries the same reading as `syncHealth`, which is the discriminator: rising `consecutiveFailures` with a `lastError` means the transport died and the worker may be fine but unreachable, while a healthy `sync` — or none at all, which is what a local Dispatch has — means the silence is the worker's own. Never fail or release a worker over `relay_unreachable`; the link is the thing to fix, and `relay_recovered` arrives on its own once the pull lands again. A federated worker's liveness window also defaults wider (40 minutes, not 30): it parks in `ask` against the peer, and the home only learns it is alive from relayed heartbeats, so the blocked-worker subtraction a local Dispatch gets does not happen for this half.
- Use `ask` when a worker needs a blocking answer from the coordinator; it defaults to the active Dispatch's Run. Timeout or disconnect leaves the question pending, so resume by its original message ID instead of asking again.
- `check --wait` returns one bounded Delivery, not every future completion. Process every message, acknowledge it, then keep waiting until every expected Dispatch settles.
- Group addresses include `@all`, `@idle`, `@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, `@grok`, `@cursor`, and `@worktree:<id>`.
- Message types include `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`, `handoff`, `question`, `decision_gate` (legacy/gates), and `heartbeat`.
- `orchestration sent --id`'s `delivery.state` is one vocabulary everywhere it appears (this command, a thread replay's per-message annotation on your own sent messages): `queued` (nothing attempted yet), `queued_awaiting_pane` (a push was attempted and withheld — pane busy or unconfirmed idle), `pointed` (written into the recipient's pane, not yet read), or `read`. A message relayed to a peer host (cross-host `agents ask`) lives only in that host's own store — `sent --id` for it here answers a typed `message_not_found` naming `--environment <name of that host>` to retry against, never a bare "not found".
- Use group addresses only for messages that are genuinely useful to many terminals, such as `status` broadcasts or intentional fan-out questions. Do not send dispatch lifecycle messages to groups.
- `worker_done` belongs to the active Dispatch and defaults to its Run mailbox; never target a group.
- A valid `worker_done` for the active `taskId` + `dispatchId` marks the task and dispatch completed automatically. Do not follow it with `task-update --status completed`; reserve manual updates for explicit recovery or overrides.
- `heartbeat` is also Dispatch-scoped. Include both IDs and omit `--to` so Orca uses the owning Run; use `status` for broad progress updates.

## Tasks And Dispatch

A Run is the namespace/inbox, a Task is the work item, and a Dispatch assigns one Task attempt to a terminal. Create or bind a Run once before the common loop.

```bash
orca orchestration run-create --objective <text> --json
orca orchestration task-create --spec <text> [--deps <json_array>] [--parent <task_id>] [--json]
orca orchestration task-list [--status <status>] [--ready] [--brief] [--json]
orca orchestration task-update --id <task_id> --status <status> [--result <json>] [--json]
orca orchestration dispatch --task <task_id> --to <handle> [--from <handle>] [--inject] [--json]
orca orchestration dispatch-show --task <task_id> [--json]
```

Task statuses: `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`.

Dispatch rules:

- `--inject` sends the task spec plus preamble into a recognized agent CLI so it can report `worker_done`.
- If the target is a bare shell, omit `--inject`, dispatch for tracking if needed, then send the prompt manually with `orca terminal send --terminal <handle> --text <prompt> --enter --json`.
- After 3 consecutive failures on one task, the dispatch context circuit-breaks and the task is marked failed.
- Use `task-list --brief --json` for coordinator sweeps; it collapses whitespace and caps each echoed spec at 160 characters (`spec_truncated` marks shortened rows). Omit `--brief` when the full spec is required, or when an older CLI rejects it as an unknown flag.

## Preferred Supervised Worker Loop

Use `worker-start` for the normal supervised path. It composes the existing worktree, terminal, readiness, and dispatch primitives while returning exact created/reused effects. Agents still choose placement and concurrency; Orca does not schedule workers or infer conflicts.

Create the Run and every independent Task first, then start all independent workers before waiting:

```bash
orca orchestration run-create --objective "<objective>" --json
orca orchestration task-create --spec "<worker A task>" --json
orca orchestration task-create --spec "<worker B task>" --json
orca orchestration worker-start --task <task_a> --worktree current --agent codex --json
orca orchestration worker-start --task <task_b> --worktree current --agent claude --json
```

`current` and exact existing worktrees create a fresh agent terminal and do not rerun setup. Reuse an existing agent only with `--terminal <handle>`.

For a per-invocation Claude, Codex, or Cursor launch, pass an opaque provider model id with `--model`; add `--effort` only when that agent/model supports the level. These options apply only to fresh agent terminals, override general agent default arguments, and are reported under `launch.requested` and `launch.effective` in the receipt:

```bash
orca orchestration worker-start --task <task_id> --worktree current --agent claude --model opus --effort high --json
```

`--effort` requires `--model`, and neither option can combine with `--terminal`. A connected worker server must advertise launch-preference support before Orca forwards either option.

For a new worktree, setup runs by default and agent-first creation reuses the returned startup agent terminal:

```bash
orca orchestration worker-start --task <task_id> --worktree new-child --name <name> --agent codex --setup run --json
# Independent/top-level:
orca orchestration worker-start --task <task_id> --worktree new-top-level --name <name> --agent codex --setup run --json
```

Setup normally starts alongside the agent. Only a repository explicitly configured with `wait-for-setup` delays agent launch until setup succeeds. Use `--setup skip` or `--setup inherit` only for a concrete reason.

Read the returned receipt before continuing: `ready` plus setup `running` is normal for start-immediately, while wait-for-setup returns setup `succeeded` before accepting task input. A failed or unknown start exits nonzero; inspect its `stage`, `effects`, and `residualResources` instead of guessing or automatically retrying. A wait-for-setup timeout can honestly leave setup `running`, which is not proof of failure.

To run the worker on another connected Orca server, add `--on <saved-environment>`. The Run and Tasks remain authoritative on the current server; later commands route by Dispatch ID, so never repeat `--on`:

```bash
# Mac Run home -> Windows worker (the reverse is identical from a Windows Run home)
orca orchestration worker-start --task <task_id> --on windows --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent codex --setup run --json
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
orca orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<attempt-specific guidance>" --json
```

Remote `current` and `new-child` are intentionally invalid because those words are ambiguous across servers. Use an exact discovered remote worktree selector or `new-top-level` with an explicit remote repo selector.

The follow-up is structured inbox mail, not prompt injection. The worker's next
`orchestration check` receives it even when the Dispatch is on another connected Orca server.

`worker-read` defaults to `--source auto`: Orca returns the exact hook-reported Codex, Claude, OpenClaude, or Grok transcript when it can prove the worker session, otherwise it returns bounded terminal output with `source: "terminal"` and a typed `fallbackReason`. Continue with the returned top-level `cursor`; it stays pinned to that exact source. If Orca reports `source_changed`, start a fresh read without the old cursor. Never supply or guess a provider session ID or transcript path.

Wait until every expected Dispatch settles, not for a fixed number of batches:

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
# Process every message. For each accepted worker_done that is not immediately reused:
orca orchestration worker-release --dispatch <dispatch_id> --json
# Acknowledge only after every message and required release decision is handled:
orca orchestration check --ack <delivery_id> --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

Read three fields on every turn of that loop. `replayed`/`pendingBehind` say the batch is the one you already saw and how much is stuck behind it — acknowledge before waiting again. `waitInterrupted` says the wait ended for a reason that is not a timeout: on `consumer_fenced` the command also exits non-zero, so stop the loop and rebind with the printed `run-use` command instead of re-waiting.

After processing each accepted `worker_done`, choose the terminal's next owner before you acknowledge the Delivery or wait again. If the same exact agent has an immediate follow-up Task, read the `worker.agent_terminal_handle` field of `worker-show --dispatch <dispatch_id> --json`, then run `orca orchestration worker-start --task <next_task_id> --terminal <handle> --json` so Orca transfers cleanup ownership to the new Dispatch. Otherwise run `orca orchestration worker-release --dispatch <dispatch_id> --json`.

Run `worker-release` after both succeeded and failed `worker_done` reports unless the user explicitly asked to keep that worker live. Release is post-completion cleanup, not cancellation: Orca first preserves inspectable output, then closes only the exact agent terminal owned by that settled Dispatch. Reused or pre-existing terminals, setup terminals, coordinators, active workers, user-taken-over terminals, and identities Orca cannot prove are retained. If the user explicitly asks to keep the live terminal for debugging, record that exception with `orca orchestration worker-retain --dispatch <dispatch_id> --json` instead of silently skipping cleanup. When the user is finished, the same Dispatch can be passed to `worker-release`, which clears the requested retention and releases the terminal.

Do not release a worker because of a timeout, TUI idle state, heartbeat, status, question, escalation, or rejected/stale `worker_done`. If release returns `release_pending` or `release_unknown`, do not substitute `terminal close`; follow the exact recovery action in the receipt. A replayed Delivery may repeat `worker-release` safely.

Workers report exactly once using the IDs and capability injected by Orca; they do not supply Run/server/terminal identity:

```bash
orca orchestration send --type worker_done --subject "<status>" --body "<what changed, findings, and what remains>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a,path/b" --json
# On failure, use --outcome failed; never encode failure only in prose.
```

A worker question defaults to its owning Run. Timeout leaves it pending:

```bash
orca orchestration ask --question "<question>" --options "yes,no" --timeout-ms 600000 --json
orca orchestration ask --resume <message_id> --timeout-ms 600000 --json
# Coordinator:
orca orchestration reply --id <message_id> --body "<answer>" --json
```

Recovery is conditional, never a fixed destructive sequence:

- `worker-show --dispatch <id>` says `ready`: keep waiting or read bounded output. Read the same result's `observation.agentStatus` first — `permission` means the worker is parked at an interactive gate and waiting longer will not clear it, while `working` or a recent `heartbeat=` age means it is alive and mid-task.
- It proves `failed` or `stopped`: start a replacement with `worker-start --task <task> --retry-of <id>` plus an explicit `--on`/`--worktree` and `--agent`/`--terminal` choice. Retry does not silently inherit placement.
- It remains `outcome_unknown`: either `worker-stop --dispatch <id>` and inspect again, or explicitly `worker-abandon --dispatch <id>` while accepting that resources may still be live. Abandon performs no remote, process, or filesystem action.
- `worker-stop` closes only the exact supervised agent terminal. It never deletes the worktree, setup terminal, configured tabs, or unrelated processes.

Low-level `worktree create`, `terminal create`, and `dispatch --inject` remain valid recipes for custom argv or topology that `worker-start` does not express.

## Cross-Runtime Federation

Federation runs a worker on a **separate paired Orca runtime** — a laptop coordinating a worker on a VPS, or the reverse. The Run, Tasks, and coordinator stay on the home runtime; only the worker's terminal and worktree live on the peer. This is the `--on <saved-environment>` path above, named: the home runtime is the coordinator, the peer runtime is the worker server.

Register the peer before you can target it. `--on` resolves a **saved environment**, not a live socket, so a runtime that is only paired for remote-desktop control still reports `Unknown environment`. On the peer, run `orca serve` and copy its **runtime-scope** pairing code (the `orca://pair?code=...` link it prints, not the mobile QR from `--mobile-pairing`); on the coordinator, save it once. `orca serve` binds all interfaces (`0.0.0.0`) with no bind-restrict flag, so keep its port behind a host or network firewall:

```bash
# On the peer (the worker server): prints a runtime-scope pairing link
orca serve --pairing-address <peer-reachable-address>
# On the coordinator (the Run home): persist the peer as a named environment
orca environment add --name <peer> --pairing-code "orca://pair?code=..." --json
orca environment list --json
```

Federation is directional per Dispatch: the coordinator dials the worker server, never the reverse. For either runtime to coordinate the other, register the peer on **both** — each saves the other as an environment. Both runtimes must run matching builds so the peer advertises the federation capability; a peer that does not is refused before any worktree or terminal is created on it.

Start, observe, and stop a federated worker exactly like a local one, routing every follow-up by Dispatch ID and never repeating `--on`. Issue the command from a Run-bound coordinator terminal — its `--from` handle must name a pane bound to the Task Run, the same binding every coordinator needs:

```bash
orca orchestration worker-start --task <task_id> --on <peer> --worktree new-top-level --repo <exact_remote_repo_selector> --name <worktree_name> --agent <agent> --from <coordinator_handle> --json
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --limit 50 --json
orca orchestration send --to dispatch:<dispatch_id> --subject "Follow-up" --body "<attempt-specific guidance>" --json
orca orchestration worker-stop --dispatch <dispatch_id> --json
```

A new worktree requires `--name`; `--from` must name your Run-bound coordinator pane (omitting it auto-binds a pane that may be busy). Remote `current` and `new-child` stay invalid because those words are ambiguous across runtimes; supply an exact discovered remote worktree selector or `new-top-level` with an explicit remote repo selector. The worker's `orchestration check` receives coordinator mail across the federation link as normal inbox delivery, not prompt injection, so `worker_done`, `question`, and `escalation` flow home unchanged — but only while the Dispatch is active: after `worker_done`, `send --to dispatch:<id>` returns `dispatch_inactive`. Give a new worker ~60s before judging it stuck: for the first ~20s `worker-read` shows the preamble and task sitting in the agent's input box with no assistant turn, which is the TUI still starting — the runtime submits the prompt itself, so do not inject a keystroke to "help" (a premature `terminal send` races that submit). The one case that genuinely needs a keystroke is a peer whose agent has not trusted the worktree path: it stalls on the folder-trust prompt before the agent's first turn while `worker-show` still reads `ready`. Answer that from the coordinator with a single `orca terminal send --terminal <peer_terminal_handle> --environment <peer> --text "1" --enter`, then wait. If the peer is re-paired mid-Dispatch its identity key rotates and in-flight federated workers become unreachable until you refresh the saved environment with `orca environment add`.

## Gates And Legacy Inspection

```bash
orca orchestration gate-create --task <task_id> --question <text> [--options <json_array>] [--json]
orca orchestration gate-resolve --id <gate_id> --resolution <text> [--json]
orca orchestration gate-list [--task <task_id>] [--status <status>] [--json]
```

Use `ask` for worker-to-coordinator questions; it creates a `question` message that the coordinator answers with `reply`. Use `gate-create` only for coordinator-managed task DAG decisions, not for answering a worker's `ask`.

`coordinator-start`, `coordinator-stop`, `run`, and `run-stop` are retired scheduler commands. They perform no effects and return the current-skill recovery action. They are not aliases for lightweight Run creation or binding.

Recovery only: `orca orchestration reset --tasks|--messages|--all --json` clears the selected local orchestration database state. Do not run it during active coordination unless explicitly abandoning that state.

## Full Handoffs

For full ownership transfer, use non-lifecycle terminal/worktree commands and then stop monitoring unless the user asks for supervision.

Treat these as full handoff requests by default: "hand off", "handoff", "handover", "give this to another agent", "give this to another worktree", "send this to another agent", "another agent", "another worktree", or "launch another agent to own this." Custom model or reasoning effort words such as `gpt-5.5`, `high`, or `xhigh` do not make the handoff supervised.

Supervised orchestration remains available only when the user explicitly asks for supervision or coordination: "supervise", "monitor", "wait for worker_done", "wait for results", "track completion", "DAG", "decision gate", "ask/reply", or "coordinate workers."

Do not run `orca orchestration task-create`, `orca orchestration dispatch --inject`, or `orca orchestration check --wait` for full handoffs. `task-create` is also forbidden because it records coordinator-owned tracking state; if a task row is needed, the user asked for supervised orchestration. Do not create a `taskId`/`dispatchId`, inject a lifecycle preamble, wait for completion, or read the worker terminal after prompt delivery except to avoid losing the initial prompt.

New top-level worktree handoff:

```bash
orca worktree create --name <task-name> --no-parent --agent codex --prompt "<task brief>" --setup run --json
```

Before creating a new worktree from an active feature branch, decide and state whether the desired Orca lineage is child or top-level. Use child worktree lineage only when the new work is conceptually stacked under or dependent on the active worktree. For independent repo-wide fixes, standalone feature work, or unrelated follow-up tasks, create a top-level worktree with `--no-parent`.

Existing terminal handoff:

```bash
orca terminal send --terminal <handle> --text "<task brief>" --enter --json
```

Custom Codex model/effort handoff:

`orca worktree create --agent codex --prompt ...` launches the known Codex agent but does not accept Codex-specific `--model` or `-c model_reasoning_effort=...` arguments. When the user asks for a specific Codex model or effort, create the independent worktree first, launch Codex with the requested command in that worktree, wait only for TUI readiness if prompt delivery would otherwise race startup, send the prompt, and stop.

The two-step custom-argv path cannot enforce a repository's explicit `wait-for-setup` startup policy because the later `terminal create` is not the startup owned by `worktree create`. Use it only when the repository starts agents immediately. If the repository requires `wait-for-setup`, use an agent-first configured launcher that can preserve sequencing, or stop and ask rather than silently bypassing the policy.

Note: when no repo default-terminal configuration supplies a primary terminal, bare create opens a fallback shell before `terminal create` adds the agent. Configured default tabs are materialized instead and may run real commands. Prefer `--agent` whenever custom argv is not required. With the two-step path, target only the agent handle; close a prior terminal only after `terminal list` or `terminal show` confirms it is an unused shell.

Use the exact full `<repo-id>::<path>` worktree id returned by `orca worktree create --json`; a bare repo id cannot target the new worktree.

```bash
orca worktree create --name <task-name> --no-parent --setup run --json
orca terminal create --worktree id:<newFullWorktreeId> --title <task-name> --command 'codex --model gpt-5.5 -c model_reasoning_effort="xhigh"' --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca terminal send --terminal <handle> --text "<task brief>" --enter --json
```

Wait only for `tui-idle` when needed to avoid losing the prompt. Do not monitor task completion.

`--no-parent` only controls Orca lineage; it does not choose the Git base. If the work should start from the repo default base, omit `--base-branch` so Orca uses that default, or explicitly pass the repo default base (`origin/main`, `origin/master`, or the `orca repo show --repo <selector> --json` value); never base it on the current feature branch unless the user explicitly asks for stacked work or "branch from current". Put current-branch context in the prompt instead.

## Worker Terminals

Choose the worker location before creating a terminal. `Fresh worker` means a fresh agent session, not a new git worktree. For parallel work, create one fresh agent terminal per worker in the same required worktree, falling back to the active worktree when none is named. If the task says current worktree only, depends on uncommitted files/artifacts, or must validate/PR the current branch, keep every worker in the active worktree:

```bash
orca terminal create --worktree active --title <task-name> --command "codex" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

Reuse an idle agent in the required worktree only if the prompt allows reuse; otherwise create a fresh terminal there. Create a new worktree only when the user explicitly requests one or a concrete checkout or filesystem conflict makes sharing unsafe or impossible; if the user did not request it, state that conflict before running `worktree create`. Independent tasks, parallel execution, convenience, or a preference for separate checkouts are not isolation requirements.

When a new worktree is allowed, use child lineage for isolated work that is stacked under or dependent on the active worktree, and use `--no-parent` when it is not stacked. Decide the Git base separately: `--no-parent` makes the worktree top-level in Orca, while omitted `--base-branch` uses the repo default base.

For every new worktree, pass `--setup run` so any configured repository setup hook runs. This does not mean waiting for setup before agent launch: preserve the repository's startup policy, whose default starts setup and the agent side by side. Use `--setup skip` or `--setup inherit` only when there is a concrete task-specific reason, and state that reason before creating the worktree. This rule does not rerun setup for current or existing worktrees.

```bash
orca worktree create --name <task-name> --agent codex --setup run --json
# or: --agent claude | omp | pi | grok | ...
# Read <handle> from agentTerminalHandle, falling back to startupTerminal.handle.
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
```

For new-worktree workers, read the id and `agentTerminalHandle` from `worktree create`, falling back to `startupTerminal.handle` for older runtimes. Use that as the sole worker handle when present; otherwise use `terminal list` to resolve the agent handle. Omit `--repo` only inside an Orca-managed worktree; otherwise pass `--repo <selector>`.

**For an allowed new worktree, use agent-first:** `--agent` reveals the new worktree and launches the selected agent **in its first terminal**, without adding a separate fallback shell for that worker. Pass `--setup run`; repo setup and default-terminal settings may add intentional tabs or splits. Do **not** run bare `worktree create` and then `terminal create --command <agent>` for the same worker when agent-first create is available: without configured default tabs, that two-step path leaves a fallback shell + agent pair. Only use it when custom agent argv is required (for example Codex model/effort flags) or when an older CLI rejects `--agent`; if you must, message only the agent handle. Configured default tabs are intentional surfaces, so close a prior terminal only after `terminal list` or `terminal show` confirms it is an unused shell. Do not run `worktree create` when the task must stay in the current worktree.

Use `orca worktree create --prompt ...` or `orca terminal send ...` for full handoffs or untracked/lightweight prompts. Those paths do not attach `taskId`/`dispatchId`; the worker should not send lifecycle messages unless the prompt supplies a live orchestration preamble.

Sidebar lineage and orchestration lifecycle are related but not identical. A same-worktree worker may appear as a peer under that worktree in the sidebar while remaining a child dispatch in orchestration state; only an actual child worktree creates visible parent/child worktree lineage.

Other terminal commands coordinators often need:

```bash
orca terminal list [--worktree <selector>] [--include-visual-layouts] [--json]
orca terminal create [--worktree <selector>] [--title <text>] [--command <cmd>] [--json]
orca terminal split --terminal <handle> [--direction horizontal|vertical] [--command <cmd>] [--json]
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms <n> --json
orca terminal read --terminal <handle> --json
orca terminal send --terminal <handle> --text <text> --enter --json
```

If an older CLI rejects `worktree create --agent`, create the worktree normally, then run `orca terminal create --worktree <selector> --command "codex" --json` or `--command "claude"`.

Wait for `tui-idle` before dispatching. Always pass `--timeout-ms`; real coding tasks can take 15-60 minutes. During supervision, use rolling `check --wait` windows. If a window returns no matching message, inspect `task-list`, `worker-show`, or `terminal agent-status` as a liveness checkpoint; `tui-idle` is not one, because an agent parked at a permission or trust prompt is idle by that test while making no progress. If the worker is working, or is quiet inside its liveness window, keep waiting instead of retrying the task.

## Agent Guidance

- Workers with a valid live preamble must send `worker_done` exactly once from their own terminal with an explicit `--outcome succeeded` or `--outcome failed`:
  `orca orchestration send --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --files-modified "path/a" --report-path "<optional>" --json`
- A failed outcome is still a terminal report, but Orca records both the Dispatch and Task as failed. Never encode failure only in the subject/body.
- After sending `worker_done`, end that dispatched turn and idle at the agent prompt. Do not autonomously start more work, poll, or attempt to close the terminal yourself. A direct user instruction takes precedence and starts ordinary user-owned work: follow it without coordinator approval or a fresh Dispatch, never refuse it because of worker/coordinator roles, and do not reuse the settled Dispatch's lifecycle IDs. A coordinator-supervised follow-up still arrives with a fresh preamble + TASK block.
- For long tasks, send heartbeat/status only when the preamble asks for it, including both IDs:
  `orca orchestration send --type heartbeat --subject "alive" --payload '{"taskId":"<task_id>","dispatchId":"<dispatch_id>","phase":"implementing"}' --json`
- If blocked before completion, use `ask`; use `escalation` only when ownership is valid and the coordinator must intervene.
- Treat preambles inherited through terminal history or full handoffs as stale unless the current prompt explicitly keeps that coordinator in the loop.
- Coordinators must account for every settled worker terminal before waiting again or ending the turn: immediately reuse the exact worker for a new Dispatch, explicitly retain it at the user's request with `worker-retain`, or run `worker-release`. Do not leave a completed worker live merely to inspect output; released workers remain readable through `worker-read`.
- Coordinators should use `task-list --ready` as external memory, dispatch parallel waves, and avoid dependency chains deeper than 3-4 steps.

## Example

```bash
orca terminal create --worktree active --title login-css-worker --command "claude" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration task-create --spec "Fix the login button CSS" --json
orca orchestration dispatch --task <task_id> --to <handle> --inject --json
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
```

## Next Action

Coordinator: confirm `orca status --json`, create or bind a Run, inspect `task-list`/`dispatch-show` if inheriting state, then use the explicit supervised loop (`task-create` -> `worker-start` -> `check --wait`). Use low-level terminal creation plus `dispatch --inject` only when the composed start does not express the needed topology. After every accepted `worker_done`, either transfer the exact terminal to an immediate follow-up Dispatch or run `worker-release` before the next wait.

Worker: if the current prompt contains a live dispatch preamble, do the task, use `ask` for blocking questions, and send `worker_done` once with the required payload. If the preamble is stale or absent, do not send lifecycle messages; inspect state or treat the prompt as an ordinary handoff.
