# Second-developer onboarding

Full onboarding sequence for a new second developer joining the shared
Windows Server host, from account creation through their first agent
session and finding other agents on the box. For the box-level deployment
and Git-Bash/PowerShell gotchas this sequence assumes are already handled,
see
[`windows-shared-host-checklist.md`](./windows-shared-host-checklist.md).

Two roles appear below: **owner** (runs the shared host, has the
provisioning shell) and **new developer** (the person being onboarded).
`$orca` = `"$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe"` on the
shared host; on the new developer's own machine it's wherever their Orca
desktop app installed its CLI.

## The sequence: create-person → invite → bind → designate → provision → login

### 1. Create the person

**Who:** owner. **Where:** the shared host's own shell.

```powershell
& $orca lane create-person --name "New Developer"
```

**Verify it worked:**

```powershell
& $orca lane persons
```

Expected: `New Developer` appears in the list.

### 2. Invite

**Who:** owner. **Where:** the shared host's own shell.

```powershell
& $orca lane invite --person "New Developer" --scope runtime
```

`--scope runtime` is required (the default) — a `mobile`-scope link is
refused by the redeeming dialog. Prints a pairing link, valid up to 24h
(`--ttl` can only shorten that).

**Verify it worked:** the command prints a link starting `orca://pair?...`
with no error. If it refuses `directory_full`-shaped errors, an invite is
still pending from a prior attempt — reuse it or let it expire.

### 3. Redeem the invite

**Who:** new developer. **Where:** their own desktop.

Paste the link into the Orca desktop app's **Add Environment** dialog, or
headless:

```powershell
orca environment add --name "shared-host" --pairing-code "<link>"
```

Then open **one terminal** against the newly added environment — a minted
invite is an unbound device until first contact.

**Verify it worked:** the environment shows connected in the app, and the
terminal opens to a shell prompt on the shared host.

### 4. Bind

**Who:** owner. **Where:** the shared host's own shell.

```powershell
& $orca lane bind --device <new-developer-desktop-grant> --person "New Developer"
```

`--device` takes a device id, a unique id prefix, or the pairing label
shown when the new developer redeemed the invite.

**Verify it worked:**

```powershell
& $orca lane status --person "New Developer" --json
```

Expected: the device now appears among that person's bound grants.

### 5. Designate

**Who:** owner. **Where:** the shared host's own shell (host-only,
local-socket-only consent action — cannot run remotely).

```powershell
& $orca lane designate --person "New Developer" --device <new-developer-desktop-grant>
```

This ticks the device as the lane's **login device** — the only grant
allowed to start a login and see the authorization URL. Provisioning
refuses `accounts.lane.no_login_device_designated` until this has run.

**Verify it worked:** re-run step 4's status check; the designated device
should now be reflected as `delegatedGrantId` in the JSON output.

### 6. Provision

**Who:** owner. **Where:** the shared host's own shell.

```powershell
& $orca lane provision --person "New Developer" --accept-unverified-platform
```

`--accept-unverified-platform` is required on Windows until the box has
passed its live DACL/credential-isolation probes (design §9 steps 12–13) —
it's recorded on the lane's audit row as `platformAcceptance:
'unverified-win32'`, not silent. Drop it once those probes have passed.

**Verify it worked:**

```powershell
& $orca lane audit --person "New Developer"
```

Expected: a `provision` row, showing the platform-acceptance flag if used.

### 7. Login

**Who:** either the owner (at the host shell) or the new developer (from
their own paired desktop, via the desktop app's **"Log in to an account"**
action on the host row) — only the designated device may start it.

```powershell
& $orca lane login --person "New Developer" --email new-developer@example.com
```

`--email` is required. Prints an authorization URL; complete it in any
browser, paste the code back.

**Verify it worked:**

```powershell
& $orca lane status --person "New Developer"
```

Expected: `loaded`, with the named account. A wrong account refuses
`accounts.lane.login_identity_mismatch` and sweeps the half-written
login automatically — re-run the command.

## Once the box is set up: the S10 agents directory

With the lane loaded, the new developer can register their long-lived
panes so other agents (their own, the owner's, or automation) can find
them by plain-English description instead of a pane id.

**Register** — run this once per long-lived pane, from inside that pane:

```powershell
orca agents register --name "nd-backend" --role "backend API work on feat/resilience-presence-integration"
```

`name` must be unique on the host; a collision with a live registration
returns `name_taken` with a concrete alternative. Re-registering from the
same pane is idempotent (updates the existing row rather than erroring).

**Verify it worked:**

```powershell
orca agents list
```

Expected: the new row, with `state` live and the name/role you gave it.

**Find** — from any other pane, locate an agent by describing what it
does rather than knowing its name:

```powershell
orca agents find "who's working on the backend API"
```

This is deterministic and host-side (no model call). It returns scored
candidates — `resolved` (one clear match), `ambiguous` (several close
matches — pick by name), or `no_match`. It never returns message content,
only ids, names, roles and state.

**Verify it worked:** the command prints your teammate's registered name
and role as the top (or only) candidate.

## Daily driver — quick reference

```powershell
# Check your lane is loaded and see which account you're signed in as
orca lane status --person "New Developer"

# Confirm the environment reached your shell before typing anything
echo $CLAUDE_CONFIG_DIR          # Git Bash
$env:CLAUDE_CONFIG_DIR           # PowerShell

# Register a new long-lived pane so others can find it
orca agents register --name "<short-name>" --role "<what this pane does>"

# Find a teammate's pane by description
orca agents find "plain English description"

# See every account your lane currently holds
orca lane accounts --person "New Developer"

# Switch your lane's active login (no browser, local file rewrite)
orca lane use --person "New Developer" --account <id>

# Sign out of this lane entirely (does not touch your own laptop's login)
orca lane logout --person "New Developer"
```

For the box-level checklist this onboarding assumes (build, install,
firewall, shell gotchas, DACL verification), see
[`windows-shared-host-checklist.md`](./windows-shared-host-checklist.md).
For the full refusal-code reference, see
[`lane-login-operations.md`](./lane-login-operations.md).
