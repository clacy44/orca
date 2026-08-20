# Cross-Runtime Federation

Use this guide to run an orchestration worker on a **different Orca runtime**
from the one that owns the Run — for example, a laptop coordinating a worker on
a VPS, or a VPS coordinating a worker on a laptop. Orca calls this federation.

Federation keeps the Run, its Tasks, and the coordinator on the **home**
runtime. Only the worker's terminal and worktree live on the **peer** (the
worker server). Coordinator mail (`worker_done`, `question`, `escalation`) flows
home across the federation link as normal inbox delivery. It reuses the same
`orca orchestration worker-start --on <environment>` path as any cross-server
worker — this guide is the end-to-end runbook for the two-runtime case.

## When to use it

- One machine owns the repositories, agents, and credentials you want a worker
  to run against, and the other machine is the one you drive from.
- You want a worker to keep running on an always-on box (a VPS) while you
  coordinate from a laptop that sleeps and reconnects.

For running the whole runtime on one machine and only viewing it from another,
use a [Remote Orca Server](./headless-linux-server.md) instead — that is UI
projection, not federation. Federation is two runtimes, each owning its own
agents, cooperating on a single Run.

## Prerequisites

- Both machines run **matching Orca builds**. Federation is capability-gated:
  the coordinator refuses a peer that does not advertise the federation
  capability before it creates anything on that peer.
- The peer can run `orca serve` and is reachable from the coordinator on a
  private network path you control (Tailscale, WireGuard, a trusted LAN, or an
  SSH tunnel). **`orca serve` binds all interfaces (`0.0.0.0`)** and has no
  bind-restrict flag (`--pairing-address` only sets the *advertised* address, not the
  bind). You must therefore block direct ingress to the runtime port with a host or
  network firewall; a private path such as an SSH tunnel is how the coordinator reaches
  the peer — an *additional* access path, not a substitute for firewalling. Never run
  `orca serve` on an untrusted network without ingress filtering in place.
- The coordinator drives orchestration from a Run-bound terminal (the normal
  coordinator requirement): create or bind a Run and pass that terminal's handle
  as `--from`.

## 1. Advertise the peer as a worker server

On the **peer**, start the runtime and copy the runtime-scope pairing link it
prints (the `orca://pair?code=...` line — not the mobile QR from
`--mobile-pairing`):

```bash
orca serve --pairing-address <peer-reachable-address>
```

## 2. Register the peer on the coordinator

`--on` resolves a **saved environment**, not a live socket. A runtime that is
only paired for remote-desktop control still reports `Unknown environment` when
targeted by `--on`. Save the peer once on the coordinator:

```bash
orca environment add --name <peer> --pairing-code "orca://pair?code=..." --json
orca environment list --json
```

Federation is directional per Dispatch: the coordinator dials the worker server,
never the reverse. For **either** machine to be able to coordinate the other,
run steps 1–2 in both directions so each runtime has the other saved.

## 3. Start, observe, and stop the federated worker

From a Run-bound coordinator terminal on the home runtime:

```bash
# Start (routes by Dispatch ID afterward; never repeat --on).
# --name is REQUIRED for a new worktree; --from must name YOUR Run-bound
# coordinator pane (omitting it auto-binds a pane that may be busy).
orca orchestration worker-start \
  --task <task_id> \
  --on <peer> \
  --worktree new-top-level \
  --repo <exact_remote_repo_selector> \
  --name <worktree_name> \
  --agent <agent> \
  --from <coordinator_handle> \
  --json

# Observe
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-read --dispatch <dispatch_id> --limit 50 --json

# Send follow-up mail (delivered to the worker's next `orchestration check`)
orca orchestration send --to dispatch:<dispatch_id> \
  --subject "Follow-up" --body "<attempt-specific guidance>" --json

# Stop (idempotent; closes only that worker's agent terminal on the peer)
orca orchestration worker-stop --dispatch <dispatch_id> --json
```

Remote `current` and `new-child` worktrees are intentionally invalid — those
words are ambiguous across runtimes. Use an exact discovered remote worktree
selector, or `new-top-level` with an explicit remote repo selector.

## Remote run mailbox

A Run — its Tasks, its mailbox, its Deliveries — lives in exactly one runtime's
SQLite. `orca orchestration check --run <run_id>` reads that runtime's database
and nothing else. Posting mail into a Run and then telling an agent on a
**different** runtime to "check `run_X`" therefore fails by construction unless
one of the two rules below holds.

**Addressing rule.** Posting mail into a Run and telling an agent on another
runtime to check it REQUIRES either this feature on both builds, or targeting a
Run that lives on the recipient's runtime. There is no third option: a Run ID is
meaningless outside the runtime that minted it.

With matching builds, add `--environment <peer>` to route the mailbox operation
to the runtime that owns the Run:

```bash
# Read (and consume) mail sitting in a Run on the peer
orca orchestration check --run <run_id> --environment <peer> --json

# Acknowledge the delivery the previous read returned — the ack lands in the
# PEER's database, which is the authoritative one; nothing is mirrored locally.
orca orchestration check --run <run_id> --ack <delivery_id> --environment <peer> --json

# Post into that Run's mailbox
orca orchestration send --to run:<run_id> --subject "..." --body "..." \
  --environment <peer> --json

# Answer a question raised inside that Run
orca orchestration reply --id <message_id> --body "..." --environment <peer> --json
```

### When to use it vs federated dispatch mail

| Situation | Use |
| --- | --- |
| You started the worker with `worker-start --on <peer>`; the Run is yours | Federated dispatch mail (`send --to dispatch:<id>`), which relays home automatically |
| The Run lives on the other runtime and you were told to read/answer its mail | Remote run mailbox (`--environment <peer>`) |
| Both runtimes own separate Runs that need to talk | Remote run mailbox in both directions; there is no shared Run |

Federated dispatch mail is Run-home-authoritative and relayed by the coordinator;
the remote run mailbox is a direct, synchronous call against the owning runtime.
Do not reach for the remote mailbox to talk to a federated worker you started —
`dispatch:<id>` addressing already handles that and enforces the settlement fences.

### Why this is not a privilege escalation

Ordinary Run scope asks "is the caller's *pane* the Run's current consumer".
A paired peer owns no pane on the Run's runtime, so that question is
unanswerable rather than merely unanswered. The remote mailbox path answers a
different question — "is this an authenticated runtime-scope paired device" —
checked against the authenticated socket identity, never against a
caller-supplied handle. That credential already grants terminal-drive rights on
the host (`terminal.send`, `worker-start`), so the peer could always read and
post Run mail by driving a local pane; calling the mailbox directly is strictly
less capable. Mobile-scope pairings are refused. The read joins the Run's
**current consumer generation** rather than rebinding it, so a locally bound
coordinator is never fenced, and acks land in the owning runtime's database
(`--retry-request <id>` gives the same `request_mismatch` idempotency there as
it does locally).

### Version skew

The peer advertises `orchestration.remote-run-mailbox.v1`. The CLI checks that
capability before it relies on the new `remoteRunMailbox` parameter, because an
older peer silently strips the field (zod `.strip()`) and then refuses the call
as an unbound coordinator. When the capability is missing and the peer refuses
on Run binding, the CLI reports `peer does not support remote run mailbox (needs
matching build)` instead of a misleading "No Run is bound". `RUNTIME_PROTOCOL_VERSION`
is unchanged — new methods and new optional params are additive.

## Operational notes

- **Give a new worker ~60s before judging it stuck.** For roughly the first 20s after
  `worker-start` returns, `worker-read` shows the preamble and `=== TASK ===` block sitting
  in the agent's input box with no assistant turn — that is the agent TUI still starting,
  and the runtime submits the prompt itself. Do not inject keystrokes to "help"; a
  premature `orca terminal send` races the runtime's own submit.
- **A remote worktree the peer's agent has not trusted will deadlock on its folder-trust
  prompt.** The worker stalls on "Is this a project you trust?" *before the agent takes a
  turn*, while `worker-show` still reports `ready`/`input_accepted` — it looks green but
  hangs until answered. Whether it fires depends on the peer host's agent
  trust store, not on the worktree being new. Unblock it from the coordinator with a single
  send, then wait:
  `orca terminal send --terminal <peer_terminal_handle> --environment <peer> --text "1" --enter`.
- **`orca serve` binds every interface.** `--pairing-address` sets only the advertised
  address; the listener opens on `0.0.0.0` and there is no bind/host flag. Block direct
  ingress to the port with a host or network firewall (a private tunnel is an additional
  access path, not a replacement) — that ingress filtering is what satisfies the "do not
  expose the runtime port" guidance above.
- **Coordinator→worker mail only reaches an ACTIVE Dispatch.** After the worker sends
  `worker_done` the Dispatch is fenced and both `orca orchestration send --to dispatch:<id>`
  and `orca orchestration reply` return `dispatch_inactive` rather than queueing an item the
  relay can never push. Send follow-ups before completion, or start a new Dispatch.
- **`worker-show` reports the relay's own health.** `sync` carries `lastSyncAt`,
  `lastError` and `consecutiveFailures` for the home-driven pull — a federated worker keeps
  reporting `ready` even when nothing is syncing, so check `sync` before believing the
  state. `workerMail` reports coordinator mail still queued for the worker and whether the
  Dispatch can still receive it; `deliverable: false` with a non-zero `pending` means that
  mail was stranded by a settlement that landed first.
- **A failing relay backs off.** Sync retries start at 1s and double to a 60s cap while the
  peer is unreachable, resetting on the first success, and relays for unsettled dispatches
  are re-armed automatically when the runtime restarts.
- **`orca environment roster` lists terminals across every runtime at once.** It polls
  the local runtime and each saved environment in parallel with a bounded per-peer
  timeout, so a peer that is down contributes one `unreachable(<reason>)` row instead of
  failing the roster. Use it to find a peer terminal handle without guessing which
  `--environment` owns it.
- **Inspecting a saved peer uses `--environment`, not `--name`:**
  `orca environment show --environment <selector>` (only `environment add` takes `--name`).
- **Peer re-pairing rotates the peer's identity key.** If the peer is re-paired
  while a Dispatch is in flight, in-flight federated workers become unreachable
  (`peer_changed`) until you refresh the saved environment with
  `orca environment add`.
- **Sync is a home-driven pull.** The coordinator polls the worker server on a
  short interval, importing `worker_done`/heartbeat/question items and
  acknowledging through the last synced sequence; nothing needs to run on the
  peer beyond `orca serve`.
- **Version skew.** Any change to federation RPC params or frames must stay
  capability-negotiated for mixed-version peers — see
  [Remote wire compatibility](./remote-wire-compatibility.md).

## Verifying the pairing transport

The federation unit suites exercise the relay and ack state machine over an
in-process transport; they do not dial a real peer. To prove the live pairing
transport end-to-end, run the two-runtime smoke test on two machines (or two
runtimes on one host with separate profile directories and ports).

To run a **second runtime on the same host**, give it its own profile and port, and
address it from the CLI with `ORCA_USER_DATA_PATH` (the second runtime is otherwise
invisible to `orca` commands, which target the default profile):

```bash
# Launch the second runtime (own profile + port; leaves the default profile untouched)
orca --user-data-dir <scratch>/fedprofile serve --port 6769 --pairing-address 127.0.0.1
# Address it from the CLI
ORCA_USER_DATA_PATH=<scratch>/fedprofile orca status --json
```

```bash
# Peer runtime
orca serve --pairing-address <addr>            # copy the orca://pair?code=... link
# Coordinator runtime
orca environment add --name peer --pairing-code "orca://pair?code=..." --json
orca orchestration worker-start --task <task_id> --on peer \
  --worktree new-top-level --repo <selector> --name <worktree_name> \
  --agent <agent> --from <handle> --json
orca orchestration worker-show --dispatch <dispatch_id> --json
orca orchestration worker-stop --dispatch <dispatch_id> --json
```
