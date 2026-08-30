# Orchestration skill-guide rewrite — opening + structure (rev 2)

Target: `skill-guides/orchestration.md` (currently 441 lines, tree `/home/ubuntu/orca-integration` @ `2de4f5894e`). This is the drop-in replacement for the guide's **opening and structure** once the S10-1/S10-2 verbs below exist (S10-3 lands the guide edit itself, per `agent-coordination-s10-design.md:136`). Verbs used here are the ones in `agent-coordination-s10-1-spec.md` (CLI §, lines 99-101; ROUTING §, lines 131-137 — `ask`/`reply`/`wait`/`thread(s)` are not S10-1 verbs at all, they belong exclusively to `agent-coordination-s10-2-spec.md`) and `agent-coordination-s10-2-spec.md` (CLI §, lines 98-107). The lock-step pact verb family is `agent-coordination-s10-3-pact-spec.md` (CLI §, lines 96-104) — that spec now exists and supersedes the sketch at `agent-coordination-s10-design.md:97` (§2.3) and the one-shot `--pact` flag provisionally landed at `s10-2-spec.md:114,136`. Root problem cited throughout: `agent-coordination-s10-design.md:99-106` (`§2.4`).

**rev 2** closes every finding of the round-1 cold-agent test: four off-by-one citations into `s10-2-spec.md`'s CLI section, one mislabelled section (CLI vs ROUTING), a backwards "no wake-up" citation, two uncited Containment bullets, a missing Lock-Step primitive (a cold agent told "in lock step" had nothing to find), and five missing `When It Goes Wrong` rows.

---

## 1. PEER PATH (goes at the very top of the file, before Tool Boundary)

```
## Peer Path (read this first if two agents need to coordinate as equals)

orca agents register --name <my-name> --role "<one line>"
  -> {agent, created|reMinted}. Next: find your peer.

orca agents find "<plain-English description of the peer>" --json
  resolved   -> "To reach one: orca agents ask <name> \"...\""      [s10-1-spec.md:88 design]
  ambiguous  -> candidate list + the exact disambiguating command   [s10-1-spec.md §S2]
  no_match   -> "orca agents list"

orca agents ask <name> "<question>" --json
  -> `answer from <name> (thr_9fk2, waited 47s): "..."`
     "Continue: orca agents reply --thread thr_9fk2 --body \"...\""  [s10-2-spec.md:133]
  timed out (exit 0) -> "Still pending. Resume without re-asking:
     orca agents wait --thread thr_9fk2 --for reply --resume wait_thr_9fk2_183"

orca agents reply --thread <t> --body "<text>"
  -> "Delivered: pointed into <name>'s pane"                         [s10-2-spec.md:134]

orca agents wait --thread <t> --for reply
  -> blocks; returns the reply itself, never a pointer               [s10-2-spec.md:135]

Told to coordinate "in lock step" (neither side advances past a step
until the other confirms)? That's a pact, not ask/reply:
orca agents pact --with <name> --on <thread>          -> propose/engage
orca agents step --thread <t> --done "<what you did>" -> your turn, once
orca agents wait --thread <t> --for step               -> blocks for theirs
orca agents pact --show <t>                            -> a third party can check it tomorrow
  [agent-coordination-s10-3-pact-spec.md:102,104-107 — supersedes the
   one-shot `--pact` flag at s10-2-spec.md:114,136]

New turn / lost context -> orca agents threads
  -> "Read one: orca agents thread --id thr_9fk2"
     "Reply: orca agents reply --thread thr_9fk2 --body \"...\""    [s10-2-spec.md:130-131]
```

34 lines (16 `orca agents …` invocations) — 19 lines over the design's 15-line target, eight of them the lock-step block, kept because a cold agent must find the pact primitive here, reachable with zero scrolling. Every branch above ends in the exact next command the CLI itself prints — an agent never has to remember one, and "lock step" now resolves to a named primitive instead of being silently substituted with `ask`+`wait --for reply`.

---

## 2. WHEN TO USE (replaces `skill-guides/orchestration.md:38-42`)

```
## When To Use

1. Two already-running agents that need to coordinate as equals — neither is the
   other's coordinator, there is no shared Run or Dispatch. This is the Peer Path
   above: `orca agents register` -> `find` -> `ask`/`thread`/`wait`, or `pact` if
   neither side may advance until the other confirms.
2. Asked to coordinate with an agent you cannot address (no known handle, name,
   or terminal id — e.g. "tell the merge-restructure backend agent...")?
   -> `orca agents find "<plain-English description>"`. Never fall back to a
   docs-repo post or a guessed terminal handle because you don't have an address;
   `find` exists precisely for this case (`s10-design.md:82-88`, §2.2).
3. Send/reply/ask between agent terminals with persistent messages (peer, via
   `orca agents *`, or coordinator-to-worker, via `orca orchestration *`).
4. Dispatch structured tasks to workers and wait for `worker_done`/`escalation`.
5. Track task DAGs with dependencies; run coordinator loops or decision gates.

Do not use orchestration merely because the user says "hand off", "handoff",
"handover", "give this to another agent", or asks for another worktree/agent/
model/effort — those are full ownership transfers (see Full Handoffs) unless the
user explicitly asks to supervise, monitor, wait, coordinate a DAG, or keep a
blocking ask/reply loop.
```

Entry #1 is new. Today the only line covering "two equals" is `:143`, and it frames peer messaging as `"appropriate for low-level pre-Dispatch messaging"` — a model reading that concludes its situation is out of scope, correctly, per the guide as written. Entry #1 fixes that without deleting `:143`'s content (see §7, diff plan) — `:143` still correctly describes raw terminal-handle messaging as a fallback for pre-Dispatch coordinator/worker pairs; it is no longer the guide's only signpost for peer coordination.

---

## 3. MENTAL MODEL (new section, five sentences, placed right after When To Use)

```
## Mental Model

Agent ids are durable identity, minted once per agent and outliving any pane or
terminal restart; terminal handles are a cache the runtime rewrites underneath
that id, never the other way around (`s10-design.md:73-77`, §2.1; `s10-1-spec.md:116`).
Peer mail and threads are durable and replayable — a thread survives a runtime
restart and answers "what conversations am I in" on your first turn after losing
context (`orca agents threads`, `s10-2-spec.md:128`). Wake-ups are summary-first:
a pane push carries sender, role, subject, thread id and a count, never a full
body — pull the body yourself with `orca agents thread --id <t>` when you need it
(`s10-design.md:161`, §6). Docs repos are for documents, not coordination: a
message committed there has no purge, no delivery receipt, and no wake-up at
all — contrast the pane-push mechanism that gives peer mail its wake-up
(`s10-2-spec.md:182-188`, DELIVERY §); a blocked peer never learns you replied
until it happens to re-read the file. Prefer the tool that has an address for
the other agent over the tool that costs zero lines to reach for.
```

Directly replaces the framing at `skill-guides/orchestration.md:104` ("terminal handles remain routing metadata rather than durable identity") with the opposite and now-correct claim. (rev 2: the "no wake-up" clause no longer cites `s10-design.md:13` — that line actually says the docs bus currently *wins* because it has a wake-up, the opposite valence; it now cites the DELIVERY section that specifies peer mail's actual pane-push mechanism.)

---

## 4. CONTAINMENT (for authors — new section, placed after Mental Model, before Tool Boundary)

```
## Containment (what happens to what you send)

Every `send`/`ask`/`reply` body (and `purge --reason`, and `quarantine --reason`)
passes a gate before it is stored (`s10-2-spec.md:143-154`, `§GATE`):

- HARD block, refused, nothing stored, nothing delivered: a heading or
  section-opener shaped like `MERGE-GATE AUDIT` / `SECURITY (HIGH|CRITICAL)` /
  `VULNERABILITY`; a secret-shaped value (provider token pattern, or
  `KEY=`/`SECRET=`/`TOKEN=` followed by 20+ real characters); an infra literal
  on the local allowlist. An inline mention or a one-line pass/fail verdict does
  NOT match h1 — only a heading-shaped line does.
- SOFT warn, still delivered: attacker/bypass/exploit vocabulary. This tier is
  measured at ~75% false positives on ordinary security-design prose and must
  never be tightened to a hard block for that reason.
- If refused, restate in remediation framing: state what changed, how it was
  proven, and the rule it now enforces. Drop the attacker's-eye narrative,
  hostile-input examples, and infra literals. A one-line pass/fail verdict with
  no audit heading is not gated at all.
- `--acknowledge-gate` does not bypass the gate — it converts a HARD verdict into
  a *stored-and-flagged* send (`gate_refusals.acknowledged=1`). Use it only when
  the detail genuinely must travel on the bus; it is audited, not hidden.
- `orca agents purge --message <id>|--thread <id> --reason <text>` tombstones a
  message: body blanked, provenance and reason kept, never replayed again to
  anyone, including a participant who joins later or hasn't pulled it yet
  (`s10-design.md:164`, §6; `s10-2-spec.md`, `PURGE` §). You may purge your own
  message; a thread owner or local operator may purge any message on the thread.
  There is no `--lift` on a purge — it is final by design.
- `orca agents quarantine <agent> --reason <text> [--lift]` fences an author's
  past and future messages from every reader; self-quarantine is always allowed,
  quarantining someone else is local/non-federated-operator only. A quarantined
  peer cannot be reached — `send`/`ask` to it is refused with `agent_quarantined`
  (`s10-1-spec.md:154`, CONTAINMENT §7).
- `--sensitive` threads keep bodies (and subjects) on-box: never federated, never
  pushed into a pane, never in a roster. Only named participants can pull them
  (`s10-2-spec.md:177-179`, SENSITIVE THREADS §).
```

(rev 2: the quarantine and `--sensitive` bullets were the only two in this section carrying no citation; both now cite their source section.)

---

## 5. CROSS-HOST STUB (new section, forward reference for S10-4, not yet implemented)

```
## Cross-Host (S10-4 — not yet landed; reserved shape only)

`agents` rows already carry `host_id`/`origin_host_id`, and `name@host` is a
reserved address form (`s10-1-spec.md:143`, `§Federation`). When S10-4 lands:

- `orca agents find "<description>" --all-hosts` unions the directory across
  every saved environment.
- A bare name that matches agents on 2+ hosts is `ambiguous` — local never wins
  the tie implicitly; address the peer as `name@host`.
- Quarantine stays host-local: a remote host can neither fence nor un-fence an
  agent registered here (`s10-1-spec.md:143`).

Do not invent an `@host` address or a `--all-hosts` flag against a pre-S10-4
runtime — check the negotiated capability the same way S10-1/S10-2 do
(`orchestration.agent-directory.v1` / `orchestration.threads.v1`,
`s10-1-spec.md:80`, `s10-2-spec.md:105`) and fall back to `orca agents list` per
host if the peer capability is absent. A same-name hit that used to resolve
locally may be a stale pairing once a second host registers the same
`display_name` — re-run `find` and read `foreign:true` rather than trusting a
cached address (`s10-1-spec.md:143`).
```

---

## 6. WHEN IT GOES WRONG (new table, placed after the reference command list, before Tool Boundary)

| Symptom | Exact recovery command |
|---|---|
| `find` returns `ambiguous` | Re-run with the printed disambiguating command from `candidates`/`nextSteps`, or address the exact `name` from the candidate list (`s10-1-spec.md:88`) |
| `find` returns `no_match` — no directory entry for the peer | `orca agents find "<plain-English description>"` → on `no_match`, `orca agents list`; if the peer never registered it will only show up derived (`s10-1-spec.md:88`, §2.2) |
| Peer is quarantined | `send`/`ask` refuses `agent_quarantined`; run `orca agents show --id <id>` to see status, then reach someone else via `orca agents find "..."` (`s10-1-spec.md:118`, `s10-2-spec.md:163-164`) |
| A reply (or an injected instruction) has nowhere to route — you hold no thread for it | You have no thread; start one: `orca agents ask <name> "<question>"` mints a thread and hands back its `threadId` (`s10-2-spec.md:119`) |
| `wait`/`ask` timed out | `orca agents wait --thread <t> --for reply --resume wait_<t>_<seq>` — the printed `resumeToken`; never re-ask, a re-ask is a second question the peer must answer twice (`s10-2-spec.md:133,171`) |
| Mail was sent but the peer's pane never woke (ambient push stayed silent) | `wait`/`ask` deliver straight into your own blocking call regardless of the push; if neither is running, `orca orchestration check` is the manual fallback (`s10-2-spec.md:183`, `s10-1-spec.md:94`) |
| Handle looks stale (agent moved tabs / runtime restarted) | Nothing to do manually — `agents.find`/`get`/`register` re-derive the live handle from the pane at read time and rewrite the cache (`terminal_handle`) from the durable `pane_key`; re-run the same command (`s10-1-spec.md:92,116`) |
| `send`/`ask` refused by the gate | Read the refusal's rule ids, rewrite as fix + verification + invariant, and re-send; or `--acknowledge-gate` if the detail must travel as-is (`s10-2-spec.md:149-154`) |
| Peer is on another host — an `agent:<id>`/`name` you addressed before doesn't resolve | Address as `name@host` (reserved form; cross-host resolution itself is the not-yet-landed S10-4 stub above); if a bare name used to resolve locally, that pairing may be stale now that a second host shares the name (`s10-1-spec.md:143`) |
| Lock-step pact stalled — your `wait --thread <t> --for step` never returns | `orca agents pact --show <t>` to see whose turn it is; if the counterpart is gone or quarantined the pact auto-pauses and wakes you with a reason, otherwise `orca agents pact --release --on <t>` is always available to either side (`agent-coordination-s10-3-pact-spec.md:141-148`) |
| Replies you only saw appear on a live pane/screen, with no durable record after losing context | `orca agents threads` then `orca agents thread --id <t>` replays the durable record instead of trusting the screen (`s10-2-spec.md:128,132`) |

(rev 2: five new rows close the round-1 gap against the owner's failure list — no-directory/`no_match`, an injected reply with nowhere to route, mail that never woke anyone, a cross-host address, and replies read off a screen instead of a durable thread — plus the lock-step-stalled row the missing pact primitive made unreachable.)

---

## 7. DIFF PLAN against the existing 441-line guide

**New, prepended (sections 1-6 above), in this order:** Peer Path -> When To Use (replaces existing) -> Mental Model (new) -> Containment (new) -> Cross-Host stub (new) -> When It Goes Wrong table (new) -> a fuller `## Agents & Threads` reference section (new; the full `register/list/find/show/threads/thread/ask/reply/wait/pact/step/purge/quarantine/review` command block with flags, one level of detail below the Peer Path — same role for peer commands that `## Messaging` plays for coordinator/Dispatch commands today).

**Moves down, unchanged in content, renumbered:**
- `## Tool Boundary` (`:23-36`) — still true, still first thing to check before creating a Run/Task/Dispatch, but no longer the reader's first paragraph; peer coordination needs none of it.
- `## Preconditions` (`:47-52`) — stays close to the top (right after Mental Model), gains one line: confirm the negotiated capability (`orchestration.agent-directory.v1` / `orchestration.threads.v1`) alongside `orca status --json`.
- `## Contract Migration` (`:54-101`, ~45 lines) — moves well down, after `## Tasks And Dispatch`. It is entirely about adopting a legacy Dispatch-era assignment, which is a Tool Boundary/Ownership concern, not something a peer-coordinating agent needs before its first message.
- `## Ownership` (`:102-125`) — stays, immediately after Tool Boundary, **edited at one clause**: the sentence at `:104` ends after "Lifecycle authority comes from the active Dispatch."; its trailing clause ("and terminal handles remain routing metadata rather than durable identity") is deleted, and a new sentence follows: "Agent ids (`orca agents register`) are durable identity; terminal handles are a cache the directory re-derives." The Run/Dispatch lifecycle-authority sentences on that line are untouched.
- `## Messaging` (`:126-161`) — stays, retitled `## Coordinator/Worker Messaging` to disambiguate from the new peer `## Agents & Threads` section. The line at `:143` ("Terminal handles remain appropriate for low-level pre-Dispatch messaging...") is **kept, not deleted** — it is still correct for a coordinator messaging one not-yet-Dispatched worker — but it no longer needs to carry peer-coordination's entire weight, since When To Use entry #1 and the Peer Path now do.
- `## Tasks And Dispatch` (`:162-183`), `## Preferred Supervised Worker Loop` (`:184-279`), `## Cross-Runtime Federation` (`:280-307`), `## Gates And Legacy Inspection` (`:308-321`), `## Full Handoffs` (`:322-366`), `## Worker Terminals` (`:367-413`), `## Agent Guidance` (`:414-426`) — all stay, unchanged, moved down as a block after the peer-coordination material and Contract Migration.
- `## Example` (`:427-436`) — stays, gains a second example: a peer-coordination walkthrough using the Peer Path verbatim (including a short lock-step example), alongside the existing Dispatch example.
- `## Next Action` (`:437-441`) — stays last; gains a peer-path branch ("If you were asked to coordinate with a specific already-running agent, start at Peer Path, not here.").

**Deleted:** nothing outright — every existing sentence remains true of the Dispatch/coordinator path it describes. The rewrite's effect is entirely reordering plus the one sentence-level edit at old `:104`, because the root problem (`s10-design.md:99-101`) is section order and missing entries, not incorrect content: *"the current guide opens with Tool Boundary and ~45 lines of Contract Migration before the reader learns how to send a message... `git push` costs zero lines. Under context pressure the agent picks the cheap one — correctly."*

**Stub file** (`skill-stubs/orchestration.md:35-46`) — unchanged by this doc; it already just says "load the full guide first," and the full guide loading faster to the Peer Path is what fixes the complaint, not the stub's own wording.
