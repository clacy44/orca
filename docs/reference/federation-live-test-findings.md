# Cross-Runtime Federation — Live Two-Node Test Findings

Findings from a real VPS↔laptop federation run (Ubuntu VPS `orca serve` AppImage
1.4.180 as worker; laptop desktop 1.4.180 as coordinator). The unit suites mock the
pairing transport; this is what only a live run surfaces. Two agents drove it and
recorded results; IDs are from the actual session.

**Headline: laptop→VPS federation works end to end.** A real worker ran on the peer,
created a git worktree, and `worker_done` relayed home. Both worktree modes
(existing-folder and `new-top-level`) and both mail directions passed.

Coordinator→worker mail was not merely accepted on the send side — it was **round-tripped**.
The coordinator planted a token in `send --to dispatch:<id>` (relayed as
`relay_465804ca24e5`, `destination: worker`); the worker read it through
`orchestration check` and quoted the exact subject and body back, echoing the token
verbatim in its `worker_done` (`relay_bc0a2f554e03`). That closed loop over the real
network transport is the property the mocked unit suites cannot demonstrate.

The findings below are the friction encountered on the way.

## F1 — `worker-start` on a new worktree requires `--name` (doc gap)
`--worktree new-top-level` without `--name` fails. The working invocation was
`--worktree new-top-level --repo name:<repo> --name <name>`. The skill guide's
cross-server example and this runbook now include `--name`. *(Docs fixed.)*

## F2 — folder-kind repos cannot take a `new-top-level` git worktree (expected, now documented)
A folder-kind repo (e.g. a bare `/home/ubuntu`) rejects `new-top-level`. Register a
git-kind repo on the peer for the documented happy path. *(Runbook notes this.)*

## F3 — version reporting confusion (process, not product)
The coordination doc referred to a `1.4.178-rc.2` *build*; the actual `orca serve`
runtime was `1.4.180`, matching the laptop. Federation is capability-gated
(`orchestration.federation.v1`), not version-gated, so matched serve versions
handshake cleanly. No product issue.

## F4 — `orca environment show` uses `--environment`, not `--name` (doc trap)
`environment add` takes `--name`; `environment show` takes `--environment <selector>`.
The asymmetry is easy to trip on. *(Runbook now spells both out.)*

## F5 — fresh remote worktrees deadlock on the agent folder-trust prompt (RELIABILITY BUG)
A worker launched into a worktree the peer's agent has not trusted stalls on the agent's
"Is this a project you trust?" gate **before the agent gets a turn**, while
`worker-show` reports `state: ready, stage: input_accepted` — i.e. **it hangs indefinitely
and looks green.** (Both live occurrences were answered within seconds, so "blocks
indefinitely" is inferred from the gate being an interactive confirmation rather than
measured — a hands-off run on an untrusted peer path would confirm it.) The injected "never use
AskUserQuestion" rule cannot help because the gate precedes the agent's first turn.

Whether it fires depends on the **agent's own trust store on the peer host**, not on the
worktree being new. Observed both ways in one session: two `new-top-level` worktrees on the
Linux peer hit the gate, while three fresh `new-top-level` worktrees on the Windows host did
not (that host had already trusted the enclosing path). So this is host-provisioning
dependent — do not assume `new-top-level` always triggers it, and do not assume it never
will.

Manual unblock — answer the gate, then **wait, do not keep typing**:

```bash
orca terminal send --terminal <peer_terminal_handle> --environment <peer> --text "1" --enter
```

**Do not send a follow-up Enter.** An earlier revision of this document claimed a second
bare Enter was required to submit a prompt the trust dialog had swallowed. That was wrong
and is retracted. Controlled re-testing (below) showed the runtime submits the dispatch
prompt on its own; the "unsent prompt" is simply what an early read looks like while the
agent TUI is still starting.

**Reading a worker too early looks exactly like a hang.** For roughly the first ~20s after
`worker-start` returns, `worker-read` shows the injected preamble and `=== TASK ===` block
sitting in the agent's input box with no assistant turn and `Context Remaining: TBD`. This
is normal startup, not a stall. Two hands-off controls on Windows 1.4.180 / `--agent claude`,
with zero input sent, both self-submitted at t+20s and ran to `worker_done` / `succeeded` —
one into an existing worktree (`terminal action=created`) and one into a fresh
`new-top-level` worktree (`terminal action=reused_agent_terminal`). Wait at least 60s and
re-read before concluding a worker is stuck, and prefer `worker-read` over injecting
keystrokes: a premature `terminal send` races the runtime's own submit and can double-submit.

**Measured platform difference in the runtime's prompt-submit (open cause).** On identical
serve mode (both sides headless `orca serve`, `Bound endpoint: ws://0.0.0.0`) and identical
version (1.4.180): Windows/installed **self-submits** the dispatch prompt hands-off (~20s, 2/2
dispatches → `succeeded`); Linux/AppImage **does not** (a hands-off local worker, `--agent
claude`, no trust gate present, zero input, stayed `source: terminal, transcript_missing,
worker: ready` for a full 90s; it ran to `worker_done` only once a bare Enter was sent).
Eliminated as causes: **serve mode** (both headless) and the **F6 shim** (that is the worker's
*outbound* CLI path — the prompt-submit is the runtime writing to the agent PTY, which never
touches the bare-`orca` dispatcher). Two candidate causes remain: **OS** (Linux vs Windows) and
**packaging** (AppImage vs installed build); a hands-off local `worker-start --agent claude` on
a non-AppImage desktop-Linux build separates them. Impact: an unattended worker on Linux/AppImage
serve does nothing while reporting `ready`. (An earlier revision over-claimed a *universal*
"never submitted" bug from a Linux run contaminated by a keystroke injected at t+50s —
retracted; the clean hands-off measurement above replaces it.)

This needs a real fix, not just docs: pre-trust the created worktree path on the peer at
creation, launch the peer agent with its trust bypass for orchestration-created worktrees,
or surface a coordinator verb for the gate. Until then an unattended federated worker on a
fresh worktree is not reliable. *(Runbook documents the unblock; flagged for a code fix.)*

## F6 — packaged AppImage `orca` CLI shim is broken on Linux serve (RELEASE BLOCKER)
On an AppImage `orca serve` host the bare-`orca` dispatcher fails:
`/tmp/.mount_orca-*/orca-ide: bad option: --no-sandbox` (exit 9). Reproduced
independently on the worker host. Because a federated worker's only channel home is that
CLI, a broken shim means `worker_done`/`heartbeat`/`ask`/`escalation` cannot be sent — the
Dispatch hangs to timeout while the coordinator sees a healthy `ready` worker. In the live
test the worker only completed because the driving agent hand-rolled an alternate
invocation.

**Root cause (in source):** `src/main/cli/appimage-cli-wrapper.ts:31` emits
`ELECTRON_RUN_AS_NODE=1 exec "$APPIMAGE" -e <script> -- "$@"`. Routing through the
AppImage's AppRun injects `--no-sandbox`; under `ELECTRON_RUN_AS_NODE` the binary is Node,
which rejects the flag before the `-e` bootstrap runs. The existing `--no-sandbox`
handling in `src/main/startup/appimage-cli-redirect.ts` covers only the in-app redirect
path — neither `appimage-cli-wrapper.ts` nor `linux-bare-orca-dispatcher.ts` references
it, so the standalone shim is uncovered. Shipped in 1.4.180.

**Candidate fixes (measured on the worker host):**
- **A — boot as Electron and use the existing redirect** (`exec "$APPIMAGE" "$@"`, drop
  `ELECTRON_RUN_AS_NODE`/`-e`). Verified working headless for `status` and
  `orchestration run-list`. Correct, but ~**2.9s** per call vs ~**0.2s** for the pure-node
  path — a real regression on the per-heartbeat worker channel.
- **B — keep the fast node path, prevent AppRun's `--no-sandbox` from reaching Node**
  (e.g. exec the bundled node directly once `APPDIR` is known, or suppress the AppRun
  injection under `ELECTRON_RUN_AS_NODE`). Preserves ~0.2s latency; needs an AppRun-bypass
  and an AppImage repackage to validate end to end.

Left for maintainer decision because the tradeoff (correctness vs the deliberately-chosen
fast path) and the packaged-build validation are theirs to make. Not shipped here.

## F7 — `send --to dispatch:<id>` returns `dispatch_inactive` after `worker_done` (doc gap)
Correct fencing — a settled Dispatch is closed — but the runbook's flat
`start→show→read→send→stop` sequence implied `send` is always available. *(Runbook now
states coordinator→worker mail only reaches an active Dispatch.)*

## F8 — `run-create`/`worker-start` without `--from` can annex a busy pane (footgun)
Omitting `--from` binds to an auto-selected coordinator pane that may already be doing
unrelated work. Harmless when Runs are namespaced, but on a shared machine it is a
footgun. *(Runbook now says to pass an explicit `--from`.)*

## F9 — running two runtimes on one host needs `ORCA_USER_DATA_PATH` (doc gap)
The runbook suggests validating with "two runtimes on one host with separate profile
directories and ports" but does not say how to *address* the second runtime from the CLI.
A packaged build honors `ORCA_USER_DATA_PATH=<profile>` as a CLI-side runtime selector,
alongside `--user-data-dir=<profile> serve --port <n>` to launch the second runtime.
Verified on a real second runtime (separate profile, port 6769) that left the default
profile byte-identical. *(Runbook "Verifying the pairing transport" now documents it.)*

## F10 — `orca serve` binds all interfaces with no restrict flag (SECURITY)
`orca serve` binds `0.0.0.0` (confirmed on Linux `0.0.0.0:6768` and Windows
`0.0.0.0:6769`), while the desktop app binds loopback. `--pairing-address` changes only the
*advertised* endpoint, not the bind, and `orca serve --help` exposes no `--bind`/`--host`
option. So the only way to satisfy this runbook's own "do not expose the runtime port to
the public internet" is an external firewall — on the VPS an ipset does the work; on a
laptop `orca serve` is reachable by the whole LAN (e.g. café wifi) with no in-product
defense. Recommend a `--bind`/`--host` flag, or defaulting the bind to loopback when
`--pairing-address` is a loopback address. *(Runbook now states the bind behavior and the
firewall requirement explicitly.)*

## F11 — the broken shim leaks an AppImage FUSE mount per invocation (compounds F6)
Every failed bare-`orca` call on the AppImage host leaves an orphaned mount behind. After
a few dozen invocations the worker host's `/tmp` was littered with dead mountpoints, and
globbing them errors outright:

```
$ ls -d /tmp/.mount_orca-*
ls: unknown io error: '/tmp/.mount_orca-lAQda8U', 'Os { code: 107, kind: NotConnected,
    message: "Transport endpoint is not connected" }'      (repeats per stale mount)
```

Each is a mount attempt of a ~204 MB AppImage. Two consequences: a long-lived `orca serve`
host accumulates dead FUSE mounts until it exhausts mounts or inodes, and the F6 workaround
gets progressively harder because locating the *live* mount means filtering out the dead
ones (the mount hash also rotates every launch — `.mount_orca-lbkSA8U`, `-l2thNAh`,
`-lSDYhiD`, `-lLaiiH9` were all observed in one session, so nothing may hardcode it).
Whatever fix F6 lands should also ensure the shim does not leak a mount per call.
