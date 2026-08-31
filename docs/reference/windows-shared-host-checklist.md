# Windows shared-host deployment and pairing checklist

Owner-facing runbook for deploying Orca on a Windows Server box shared by
two people, and pairing each person into their own credential lane. Written
for an operator who has not read the design docs — every command is exact
and every stage ends with a verification block. For the full onboarding
sequence a *new* second developer walks through on their own machine, see
[`second-developer-onboarding.md`](./second-developer-onboarding.md).

**Environment assumed throughout:** the shared box runs `orca serve`
headless (no one drives its own desktop UI directly). The owner works from
their own desktop in **Git Bash**; the other developer works from their own
desktop in **PowerShell**. Neither uses WSL — this checklist does not cover
it. Every `orca.exe` invocation below runs from
`%LOCALAPPDATA%\Programs\Orca\resources\bin\orca.exe` unless a step says
otherwise.

**Discrepancy note.** Earlier planning assumed a shared `--pair-name` flag
at `orca serve` start and a credential "push" from each desktop. Neither
exists in the current design (S9 rev 31–32): pairing is a **per-person
minted invite** (`orca lane invite`), and a lane loads via **`orca lane
login`** — a real `claude auth login` inside the lane, never a push. This
checklist follows the current design.

## Stage 1 — Build the Windows exe

Build on the owner's own Windows 11 desktop, from
`feat/resilience-presence-integration`. The full build runbook — toolchain
prerequisites, the exact `pnpm` steps, packaging, and the resulting artifact
path — is owned by
[`docs/reference/windows-desktop-build.md`](./windows-desktop-build.md); do
not duplicate its internals here. In outline: clone, `git checkout
feat/resilience-presence-integration`, `pnpm install --frozen-lockfile`,
then that doc's six build steps (`typecheck`, `build:relay`, `build:cli`,
`build:electron-vite`, `verify:built-skills-cli`,
`build:web-from-renderer`), then package with `electron-builder --win`.

**Verify it worked:**

```powershell
& "dist\win-unpacked\resources\bin\orca.exe" status --json
```

Expected: JSON containing `"appVersion"` matching the commit you built, and
`dist\orca-windows-setup.exe` present on disk. If `appVersion` doesn't match
the branch tip, rebuild — do not install a stale artifact.

## Stage 2 — Install on the shared Windows Server host

Copy `dist\orca-windows-setup.exe` to the shared host and run it there:

```powershell
Start-Process "orca-windows-setup.exe" -Wait
```

This is a per-user install; it lands at `%LOCALAPPDATA%\Programs\Orca`, and
its profile data at `%APPDATA%\orca`. Open the inbound firewall port for
`orca serve` (default 6768), scoped to the `Private` profile only:

```powershell
New-NetFirewallRule -DisplayName "Orca serve" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 6768 -Profile Private
```

**Verify it worked:**

```powershell
Test-Path "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe"
Get-NetFirewallRule -DisplayName "Orca serve" | Select-Object Enabled,Direction,Action
```

Expected: `True`; and `Enabled: True`, `Direction: Inbound`, `Action: Allow`.

## Stage 3 — First-start verification

Start `orca serve` once, in the foreground, with the readiness contract on:

```powershell
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" serve --port 6768 `
  --pairing-address <this-box's-LAN-IP> --json
```

This prints one compact JSON line with `"type": "orca_server_ready"` and
`"schemaVersion": 1` — the versioned contract a supervisor should gate on.
Leave this running (or wrap it in a Scheduled Task / `nssm` service to
survive reboot — no packaged Windows service wrapper ships in this tree, so
this step is manual).

**Verify it worked:**

Confirm the line parses and both fields are present (from a second window,
or by eye in the first):

```powershell
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" status --json
```

Expected: `"appVersion"` present and matching Stage 1's build, and the serve
process's earlier stdout line showed `orca_server_ready` /
`schemaVersion: 1`. If `pairing` came back with `available:false`, read its
`reason`/`guidance` fields before continuing — do not proceed to Stage 4
against a server that couldn't mint an offer.

## Stage 4 — Per-person pairing

**Why per-person, not per-device or shared:** the S9 design's lane model is
per **person** (`principalId`), not per device — every grant (desktop,
phone) belonging to the same human shares that person's one lane; two
different humans must never share one, since a lane is the isolation
boundary. Each person needs their **own** invite, redeemed from **their
own** desktop — never one shared pairing code.

Run these on the shared host's own shell (owner runs both, once per
person):

```powershell
& $orca lane create-person --name "Owner"
& $orca lane create-person --name "Other Developer"
& $orca lane invite --person "Owner" --scope runtime
& $orca lane invite --person "Other Developer" --scope runtime
```

(`$orca` = `"$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe"`.)
`--scope runtime` is required — the default is `runtime`, but a `mobile`
scope link is refused outright by the redeeming dialog. Each invite is
single-person, expires within 24h (`--ttl` can only shorten that, never
extend it), and at most 16 can be pending across the host at once.

Hand each person their own printed link. **Each person redeems their own
link from their own desktop** — the Orca desktop app's Add Environment
dialog, or headless: `orca environment add --name <name> --pairing-code
<link>` — then opens **one terminal** against the new environment so the
grant is actually redeemed (a minted invite is an unbound device until
first contact).

**Verify it worked:**

```powershell
& $orca lane persons
```

Expected: both names listed. On each person's own desktop, the newly added
environment should show as connected (open one terminal against it — if it
opens, redemption succeeded).

## Stage 5 — Lane designation and login

Full step-by-step (who/where/verify for each of bind, designate, provision,
login) lives in
[`second-developer-onboarding.md`](./second-developer-onboarding.md#the-sequence-create-person--invite--bind--designate--provision--login).
Summary for both people at once, run on the shared host's own shell by the
owner (designation is a host-only, local-socket-only consent action — it
cannot run remotely):

```powershell
& $orca lane bind --device <owner-desktop-grant> --person "Owner"
& $orca lane bind --device <other-desktop-grant> --person "Other Developer"
& $orca lane designate --person "Owner" --device <owner-desktop-grant>
& $orca lane designate --person "Other Developer" --device <other-desktop-grant>
& $orca lane provision --person "Owner" --accept-unverified-platform
& $orca lane provision --person "Other Developer" --accept-unverified-platform
```

`--accept-unverified-platform` is required on Windows until the live
probes in Stage 6 below have passed on this box (design §9 steps 12–13) —
recorded on the lane's audit row as `platformAcceptance: 'unverified-win32'`,
never silent.

**Sign each lane in — the "login," not a push.** Runs at the host's own
shell, or from each person's own paired desktop via the desktop app's
**"Log in to an account"** action (only the designated device may start
it):

```powershell
& $orca lane login --person "Owner" --email owner@example.com
& $orca lane login --person "Other Developer" --email other@example.com
```

`--email` is required — prints an authorization URL, waits for a pasted
code.

**Verify it worked:**

```powershell
& $orca lane status --person "Owner"
& $orca lane status --person "Other Developer"
```

Expected: both show `loaded`, with the account you named. If a lane instead
authenticated as a different account than named, it refuses
`accounts.lane.login_identity_mismatch` and sweeps the half-written login —
that's the identity check working; just run `orca lane login` again with
the right account.

## Stage 6 — Lane verification (loaded, DACL, statusline)

Run these once per person after Stage 5, from a terminal opened against
that person's own lane pane on the shared host.

**1. Lane loaded and designated:**

```powershell
& $orca lane status --person "Owner" --json
```

Expected JSON shows `laneState: "loaded"` and `delegatedGrantId` pointing at
the designated device.

**2. Environment reaches the pane, before anything is typed:**

```powershell
echo $CLAUDE_CONFIG_DIR    # Git Bash
echo %CLAUDE_CONFIG_DIR%   # cmd / PowerShell prompt inside cmd
$env:CLAUDE_CONFIG_DIR     # PowerShell
```

Expected: the lane's own path (something like
`%APPDATA%\orca\claude-lanes\<principalId>`) — never `%USERPROFILE%\.claude`
and never empty. This must be true **before** running `claude` — a plain
shell is lane-scoped from spawn.

**3. Store permissions (DACL):**

```powershell
Get-Acl "$env:APPDATA\orca\claude-lanes\<principalId>" | Format-List
```

Expected: `AreAccessRulesProtected: True`, and exactly three access rules,
each `FullControl`, naming the current user, `SYSTEM`, and
`BUILTIN\Administrators` — no deny rule, no other identity. If this doesn't
match, do not treat the lane as isolated (see Stage 8).

**4. Statusline shows the correct account:**

Inside a `claude` session running in that person's lane pane, run `/status`
and confirm the *Login method* / account row names the account you signed
in during Stage 5. Repeat for the other person's already-open pane and
confirm it is unaffected.

## Stage 7 — Git Bash vs PowerShell gotchas

The two shells the owner and the other developer actually use behave
differently around environment variables. None of the following requires
you to change how a lane is provisioned — they are what to check when a
pane looks like it picked up the wrong account.

- **MSYS path conversion (Git Bash only).** MSYS rewrites POSIX-looking
  **command-line arguments** into Windows form before handing them to a
  native `.exe` — it does **not** rewrite environment variable values.
  Orca puts the lane's `CLAUDE_CONFIG_DIR` into the environment block,
  never onto a command line, so a lane pane should be unaffected. *If you
  see it anyway* (a lane pane picks up the wrong config dir, or a
  path-looking argument comes out mangled): don't hand-run `claude
  --config-dir <path>` — that shape is refused server-side for a lane
  anyway. Re-run Stage 6 step 2; if `$CLAUDE_CONFIG_DIR` itself is wrong,
  treat it as a provisioning problem (Stage 5), not a shell quirk.
- **`MSYS2_ENV_CONV_EXCL`.** The documented MSYS knob for excluding named
  variables from path-list conversion. Orca's own tree does not
  observably depend on it — unverified here. *If you see* a plain-string
  variable arriving reshaped like a path list inside Git Bash, that's this
  knob's symptom; `MSYS2_ENV_CONV_EXCL=CLAUDE_CONFIG_DIR` before launching
  Git Bash is the documented fix, but confirm with Stage 6 step 2 first —
  most "wrong account" symptoms are a designation/login problem, not this.
- **Profile scripts rewriting env (both shells).** PowerShell runs
  `$PROFILE`; Git Bash runs `/etc/profile`, `~/.bash_profile`,
  `~/.bashrc` — all **after** Orca has already set the lane's value, and
  Orca cannot police another user's dotfiles, so there is no refusal for
  this. *If you see* `/status` naming the wrong account, or
  `$CLAUDE_CONFIG_DIR` wrong in Stage 6 step 2 despite Stage 5 succeeding:
  check that person's `$PROFILE` / `~/.bashrc` for a line touching
  `CLAUDE_CONFIG_DIR` or any Claude auth env var, and remove it.
- **The `.cmd` runner rule.** Applies to project setup scripts, not lane
  credentials, but it's a real Git Bash trap here: never type `cmd.exe /c
  "C:\path\to\runner.cmd"` from a Git Bash pane — MSYS rewrites the bare
  `/c` switch into a drive path, so `cmd` opens interactively instead of
  running the script (issue #6896). *If you see* a `cmd` window sitting
  open and idle instead of running a script, that's this. Orca's own
  launcher already avoids it (a PowerShell `ProcessStartInfo` launcher, not
  a bare `cmd.exe /c`); do the same if scripting a runner by hand. Full
  mechanism: [`windows-setup-shell.md`](./windows-setup-shell.md).

## Stage 8 — Failure handling: refusal codes

Every refusal carries its own complete sentence when it fires — this table
is for recognizing the code and knowing the fix.

| Code | Plain meaning | What to do |
|---|---|---|
| `accounts.lane.no_login_device_designated` | Nobody has been ticked as this person's login device yet. | Run `orca lane designate --person <p> --device <d>`, then retry. |
| `accounts.lane.login_not_designated` | This grant is bound to the person, but isn't their designated device. | Designate the right device, or log in from the one that's already designated. |
| `accounts.lane.login_already_in_flight` | A login for this lane is already running somewhere. | Finish or cancel the in-flight login before starting another — it's refused, never queued. |
| `accounts.lane.login_identity_mismatch` | The account you actually authenticated as doesn't match `--email`. | The half-written login was swept automatically — just run `orca lane login` again with the correct account. |
| `accounts.lane.login_session_expired` | The authorization code wasn't pasted back within 180 seconds. | Start the login again. |
| `accounts.lane.login_store_full` | This lane already holds eight logins (`MAX_LANE_LOGINS`). | Remove one first: `orca lane accounts --person <p>` then remove an unused login. |
| `accounts.lane.provisioning_platform_gated` | Windows lane provisioning is off until the live Windows probes (DACL read-back, credential-store isolation) have passed on this box. | Add `--accept-unverified-platform` to proceed now (recorded, not silent), or run the probes and drop the flag. |
| `accounts.lane.switch_write_locked` | A live `claude` in the lane is holding `.credentials.json` open past the ~750ms Windows retry window. | The lane is unchanged — nothing was corrupted. Wait a moment and retry. |
| `accounts.lane.wipe_in_progress` | A logout/revoke/deprovision is currently sweeping this lane. | Wait for the sweep to finish, then retry. |
| `terminal.lane_wsl_shell_unsupported` | A lane pane's shell resolved to `wsl.exe`. | Not supported on this host — native shells only (Git Bash / PowerShell / cmd). Change the pane's shell. |
| `terminal.lane_shell_unsupported` | The Git Bash environment-passthrough probe (§5 step 12c in the design) hasn't been verified to carry the lane path correctly. | Use PowerShell or `cmd` for that lane pane until the probe is confirmed. |

For the full refusal-code reference (all fifteen lane codes, with fence and
latch behavior) see
[`lane-login-operations.md`](./lane-login-operations.md). For the sequence
that produced the lanes referenced throughout this checklist, see
[`second-developer-onboarding.md`](./second-developer-onboarding.md).
