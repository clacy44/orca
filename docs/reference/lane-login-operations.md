# Lane login operations

The operator's view of per-lane credential login (S9 rev 32+). Design
source: `docs/reference/agent-identity-s9-design.md` §2b–§2f, §3, §9.

## What a lane is

A lane is a per-person credential sandbox: its own `CLAUDE_CONFIG_DIR`,
pinned to every terminal, agent session and worktree that person's
grants launch on this host. It is not a copy of anyone's desktop
credential — it is signed in the same way a laptop is, by running
`claude auth login` with `CLAUDE_CONFIG_DIR` pointed at it. Nothing is
pushed from a desktop into it.

## Where logins live

- `<lane>/.credentials.json` and the `oauthAccount` block in
  `<lane>/.claude.json` — the lane's **active** login.
- `<lane>/claude-accounts/<laneAccountId>/auth/` — one directory per
  login the lane has ever completed, each a complete, independently
  usable OAuth grant (up to eight, `MAX_LANE_LOGINS`). `selectAccount`
  ("switch") rewrites the active pair from one of these; it is a local
  file rewrite, no browser, no network.
- `<lane>/claude-accounts/index.json` — the store's **authority**: one
  row per completed login (id, verified identity, owner-set label, which
  is active). A directory with no index row is never offered to a human.

## Session states

A login session (`loginStart`/inline `orca lane login`) moves through
`live` → `child-exited` → `captured`, or to terminal `cancelled` from
either of the first two — never from `captured`. Sessions are
**process-local**, in memory and never persisted, so an Orca restart
ends every in-flight session (the directory/child may outlive it — see
Quarantine directories below).

## Refusal codes an operator will see

| Code | Meaning |
|---|---|
| `accounts.lane.login_not_designated` | This grant is bound to the principal but is not the designated login device. |
| `accounts.lane.no_login_device_designated` | The principal has no designated login device yet — run `orca lane designate`. |
| `accounts.lane.login_already_in_flight` | A login is already running for this lane (only one at a time, any entry point). |
| `accounts.lane.login_session_unknown` | The session id is unknown to this caller — wrong grant, expired session, or a restart ended it. |
| `accounts.lane.login_session_expired` | The session outlived its TTL (180s) with no completed code. |
| `accounts.lane.login_cancelled` | A logout/revoke/designation change cancelled this session before it captured. |
| `accounts.lane.login_url_unparsed` | The CLI's printed authorization URL could not be parsed — a scraped-contract failure, not a code entry. |
| `accounts.lane.login_identity_mismatch` | The account actually authenticated does not match `--email`; also raised when identity is unverifiable at all (fails closed). |
| `accounts.lane.login_store_full` | The lane already holds eight logins — remove one first. |
| `accounts.lane.account_unknown` | The named `laneAccountId` has no index row (never minted, or purged by a wipe). |
| `accounts.lane.switch_in_progress` | Another write (switch or capture) is already using the lane's write queue. |
| `accounts.lane.wipe_in_progress` | A logout/revoke/deprovision wipe is running or pending for this lane — retry after. |
| `accounts.lane.logout_incomplete` | The sweep behind a logout did not finish cleanly — do not treat the lane as clear. |
| `accounts.lane.login_cli_unsupported` | The installed `claude` build is below the tested floor, on another major version, or its `--version` output could not be read. Newer builds are allowed (one advisory log line). |
| `accounts.lane.provisioning_platform_gated` | macOS/Windows lane provisioning is off until its §9 live probe passes (override: `--accept-unverified-platform`). |

All fifteen carry a complete human sentence — the remedy for most is
"run the login again" or "wait and retry."

## Fence and latch, in plain words

A **logout, a revoke of a person's last grant, or a deprovision**
cancels every in-flight login for that lane before it sweeps — so a
login that was seconds from completing does not land a fresh credential
into a lane that was just certified empty. A capture that was already
past that point (child exited, writing its final files) is invalidated
too and writes nothing.

If a wipe cannot **confirm** the process holding the lane's credential
is dead (a probe or login child that will not die), the lane reports
`absent` with `laneWipePending: true` rather than a false "clean," and
retries. This is the **latch**: it releases itself on a bounded retry
budget, so a lane can never be stuck un-loginnable for the process's
life. To end a stuck wipe immediately: `orca lane wipe --person <name>
--force`, which writes its own audit row.

## Quarantine directories

At startup, each lane's login-directory store is reconciled against its
own `index.json`. If the index parses, any directory with no matching
row is deleted outright (a crash between the CLI writing files and the
index row costs one login — not revoked upstream, just gone from this
box). **If the index is missing or does not parse**, nothing is
deleted: every unindexed directory is renamed
`<laneAccountId>.quarantined-<ts>` and logged, never offered as a login,
never counted against the eight-login cap. A quarantined directory is a
complete, usable grant at rest under a name nothing resolves — clean it
up by inspecting `ls <lane>/claude-accounts` and removing it, or simply
run `orca lane logout` for that person, which sweeps quarantined
directories along with everything else.

**Shared quota:** independent logins on one account share whatever
account-level rate limit or seat quota Anthropic applies — Orca does not
mediate it between a lane's login and anyone's own desktop login.

## Revocation

`orca lane logout --person <name>` runs `claude auth logout` **inside
the lane** before sweeping local files. Whether that CLI call performs a
server-side revoke or only clears local state is unverified as of this
writing (§7 question 15) — until confirmed, treat `logout` as "every
credential of this lane's is gone from this box," not a guaranteed
claude.ai-side revoke. To revoke definitively regardless, sign in to
claude.ai and remove the session from the account's own settings. On a
suspected compromise, also check the Console's API-key list:
`org:create_api_key` means a key minted from the grant survives revoking
the grant itself.

## Two owner-ratified residuals

- **Unbounded credential at rest.** A lane's login sits on disk from
  sign-in until an explicit logout, last-grant revoke, or deprovision —
  not on disconnect, idle timeout, or host reboot: a real confidentiality
  regression against a box co-tenant, ratified because the alternative
  (wipe on disconnect) turns every dropped connection into a
  re-authorization.
- **`org:create_api_key` scope.** Every login can mint an API key with
  its own lifetime; revoking the OAuth grant does not necessarily kill a
  key already minted. Accepted, with the Console check above added to
  the incident runbook.
