# Building and installing the Windows desktop app

Runbook for producing `orca-windows-setup.exe` from a `feat/*` branch of
`github.com/clacy44/orca` on a Windows 11 desktop, then installing it on a
Windows Server machine. Every claim is cited `path:line`; anything not
traceable in this tree is marked **unverified**.

## Prerequisites

- **Node 24** — pinned by `"engines": { "node": "24" }`
  (`package.json:279-281`).
- **pnpm 10.24.0** — pinned by `"packageManager": "pnpm@10.24.0+sha512..."`
  (`package.json:282`). This matches the owner's prior `npx pnpm@10.24.0`
  setup exactly — no difference to flag.
- **Git**, with the fork remote reachable.
- **A C++ toolchain for `node-pty`**: its README requires Python + a C++
  compiler, the **Windows SDK** ("Desktop C++ Apps"), and Spectre-mitigated
  MSVC libraries (`node_modules/node-pty/README.md:97-108`) — in practice
  **Visual Studio Build Tools 2022**, "Desktop development with C++"
  workload (the toolchain `windows-2022` GitHub runners ship pre-installed,
  `.github/workflows/windows-signing-rehearsal.yml:35,48-57`). Required:
  `@electron/rebuild` runs with `force: true`, calling `node-gyp` directly
  instead of using node-pty's bundled `win32-x64`/`win32-arm64` prebuilds
  (`node_modules/node-pty/prebuilds/`; comment at
  `config/scripts/rebuild-native-deps.mjs:103-108,133-147`).
- **.NET Framework 4.x** (default on Windows 11) — the Windows CLI
  launcher `orca.exe` (distinct from `Orca.exe`) compiles from
  `native/windows-cli-launcher/OrcaCliLauncher.cs` via the Framework's
  `csc.exe` at `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
  (`config/scripts/build-windows-cli-launcher.mjs:45-54`); no Visual
  Studio project involved.

## Clone, checkout, environment

```powershell
git clone https://github.com/clacy44/orca.git
cd orca
git checkout feat/<branch-name>
$env:CI = "1"; $env:NODE_OPTIONS = "--max-old-space-size=4096"
```

`CI=1` is unset again before packaging (electron-builder's CI auto-detect
changes publish behavior — `docs/reference/linux-vps-build.md:134-136`).
Two of five build steps already auto-size `--max-old-space-size` from host
RAM (`node-old-space-limit.mjs:1-19`, wired at `run-electron-vite-build.mjs:12`,
`run-vite-web-build.mjs:12`); the var still covers `typecheck`/`build:cli`.

## Install

```powershell
pnpm install --frozen-lockfile
```

Postinstall runs `rebuild-native-deps.mjs`, also rebuilding
`windows-native-registry` on `win32` (`package.json:77`;
`rebuild-native-deps.mjs:14-17,62-66`) — exercises the C++ toolchain above.

## Build, one step per process

`build:win` chains `typecheck` plus five build steps into a single `pnpm`
process (`package.json:74,81`) — the same shape flagged as an OOM risk for
the Linux VPS build (`docs/reference/linux-vps-build.md:92-107`). Split
them out, as that doc recommends:

```powershell
pnpm run typecheck            # package.json:45
pnpm run build:relay          # package.json:55
pnpm run build:cli            # package.json:68
pnpm run build:electron-vite  # package.json:70
pnpm run verify:built-skills-cli   # package.json:62
pnpm run build:web-from-renderer   # package.json:73
```

## Package

```powershell
Remove-Item Env:\CI -ErrorAction SilentlyContinue
pnpm run ensure:electron-runtime
pnpm exec electron-builder --config config/electron-builder.config.cjs --win --publish never
```

Unlike macOS, no separate `build:native` step is needed: electron-builder's
`beforeBuild` hook (`config/electron-builder.config.cjs:500`,
`electronBuilderNativeRebuild`) already compiles `orca.exe`
(`config/scripts/electron-builder-native-rebuild.cjs:12-17`) and reruns the
native-module rebuild for the target platform/arch
(`electron-builder-native-rebuild.cjs:18-21,28-45`) before packing.

## Artifact

electron-builder's default output directory is `dist/` (no
`directories.output` override — only `directories.buildResources` is set,
`config/electron-builder.config.cjs:100`). The installer name comes from
`nsis.artifactName`:

```
dist/orca-windows-setup.exe
```

(`config/electron-builder.config.cjs:324-325`, confirmed by
`windows-signing-rehearsal.yml:208-209`.) The unpacked tree used for smoke
testing lands at `dist/win-unpacked/Orca.exe` (`executableName: 'Orca'`,
`config/electron-builder.config.cjs:295`; confirmed at
`windows-signing-rehearsal.yml:91-92`).

**Note:** the fork's build is unsigned — CI signs inner PE files and the
installer via SignPath as a separate post-build step
(`windows-signing-rehearsal.yml:1-13`, `electron-builder.config.cjs:298-301`)
not covered here, so SmartScreen will flag the installer.

## Smoke check

The packaged CLI (`resources\bin\orca.cmd`/`orca.exe`, next to `Orca.exe`)
already sets `ELECTRON_RUN_AS_NODE=1` itself
(`OrcaCliLauncher.cs:48-49`) — unlike the Linux AppImage path, which needs
a manual bootstrap (`docs/reference/linux-vps-build.md:252-258`):

```powershell
& "dist\win-unpacked\resources\bin\orca.exe" status --json
```

`status --json` reports `appVersion` (`src/cli/runtime/status.ts:49`) —
confirm it matches the built branch/commit, not a production install.
**Unverified**: there is no `orca --version` flag; only the Linux/serve
doc states this (`docs/reference/headless-linux-server.md`).

## Installing on Windows Server

Run the installer:

```powershell
Start-Process "dist\orca-windows-setup.exe" -Wait
```

**userData location.** `appId` (`com.stablyai.orca`) and `productName`
(`Orca`) (`config/electron-builder.config.cjs:49,94`) do not drive
`userData` — Electron resolves it from `app.getName()`, defaulting to
`package.json`'s `"name"` (`orca`, `package.json:2`) until
`app.setName('Orca')` runs at `whenReady`. Orca captures the canonical
path *before* that rename (`src/main/index.ts:839-847,2147`), and no
production path calls `app.setPath('userData', ...)` outside dev/E2E
overrides (`src/main/startup/configure-process.ts:169-170,180,184`). So
the profile lands at `%APPDATA%\orca` — matching the documented Linux
equivalent (`<XDG_CONFIG_HOME or $HOME/.config>/orca`,
`docs/reference/linux-vps-build.md:219-223`).

**Starting `orca serve`.** No Windows analogue of
`docs/reference/headless-linux-server.md` (systemd unit, Xvfb, AppImage
extraction) exists in `docs/reference/` — confirmed by grep. No
AppImage/FUSE concerns on Windows, so the desktop-app CLI path applies. The
`nsis` config has no `perMachine`/install-dir override
(`config/electron-builder.config.cjs:324-332`, its own comment mentioning
"the install dir under LOCALAPPDATA"), so electron-builder's default
per-user location applies, `%LOCALAPPDATA%\Programs\Orca`:

```powershell
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" serve --port 6768
```

Wrap it in a Scheduled Task or service wrapper (`nssm`) to survive
reboot/logoff — **unverified**: no such script exists in this tree; only
the Linux systemd unit is documented.

**Firewall.** `orca serve` binds all interfaces on Windows too — F10
(`docs/reference/federation-live-test-findings.md:146-153`) confirms
`0.0.0.0:6769` on Windows, and `--pairing-address` changes only the
*advertised* endpoint, not the bind; there is no `--bind`/`--host` flag.
Restrict with an inbound rule scoped to port and profile:

```powershell
New-NetFirewallRule -DisplayName "Orca serve" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 6768 -Profile Private
```

(mirrors the scoped pattern Orca's own mobile-pairing rule uses,
`src/main/runtime/windows-mobile-firewall.ts:229`) — don't leave it open
on `Public`/`Domain` or unscoped.

## One-time lane setup on the serve box

Before anyone opens a lane-scoped terminal on this box, run the day-one
`orca lane` sequence once, as the owner, at the shell — this box is
headless (`orca serve`, above), so there is no desktop AccountsPane to
drive the equivalent consent writes from:

```powershell
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane create-person --name "<owner>"
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane create-person --name "<other developer>"
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane bind --device <owner-desktop> --person "<owner>"
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane bind --device <other-desktop> --person "<other developer>"
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane designate --person "<owner>" --device <owner-desktop>
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane designate --person "<other developer>" --device <other-desktop>
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane provision --person "<owner>" --accept-unverified-platform
& "$env:LOCALAPPDATA\Programs\Orca\resources\bin\orca.exe" lane provision --person "<other developer>" --accept-unverified-platform
```

create-person twice, bind each paired device, designate each person's
desktop as their lane's pusher, then provision both lanes — in that
order, since designate is required before provision will succeed
(`accounts.lane.no_pusher_designated` otherwise). `provision` carries
`--accept-unverified-platform` here because Windows is a gated platform
until the shared box has passed the §9 live-box probes (steps 12 and
13 — DACL read-back, credential-store isolation); without the flag,
provisioning refuses `accounts.lane.provisioning_platform_gated`. The
override is recorded, not silent: it writes `platformAcceptance:
'unverified-win32'` onto that lane's `provision` audit row, visible
back via `orca lane audit` as `platform=unverified-win32`. Once steps
12–13 have actually passed on this box, drop the flag — re-provisioning
is not required, but a fresh provision no longer needs it either. The
one remaining step, delegating each person's account onto this box,
has no CLI verb and is done from each person's own desktop Accounts
pane instead, via the "Delegate" action under "Load an account onto a
host." Full verb list, refusal codes and rationale:
`docs/reference/agent-identity-s9-design.md` §9 ("Day-one setup"),
§10 item 39, and §10(f) (the 2026-08-24 release audit that added the
override).
