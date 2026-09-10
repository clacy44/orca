# Windows hook host (R105-b)

## Why

Claude's Windows lifecycle hooks run as a spawned child, not a shell line: `windowsHide:true`,
`detached:false`, stdin is a pipe carrying the event JSON for every hook form (exec, shell,
powershell — see `diag-r105-binary-stdin-2026-09-08.md`). Two prior forms both failed in the
field (`drills/readouts/E-R105-desktop-2026-09-08.md`):

- **`conhost.exe --headless cmd.exe /d /c <script>`** — windowless, but `conhost --headless`
  gives `cmd.exe` a headless pseudoconsole; Claude's JSON lands in *conhost's* stdin, never
  reaching the script. The hook host never sees a payload.
- **Plain `cmd.exe /d /c <script>` (no conhost)** — the script's payload delivery is fine, but
  `cmd.exe` itself is windowless (`windowsHide` works) while the `curl.exe` it shells out to is
  a console-subsystem process with no console to inherit — Windows allocates a **new console
  window per hook event**. Every tool call flashed a window (owner field report, ~21:05Z).

The fix ships a second helper, `orca-hook-host.exe`, built `/target:winexe` (GUI subsystem — no
console is ever allocated for it) that reads stdin and does the HTTP POST to Orca's hook server
**in-process**. No shell, no child process, nothing console-subsystem in the tree.

## How it's built

- Source: `native/windows-hook-host/OrcaHookHost.cs` — .NET Framework 4.x, no external deps,
  no `Console.*` calls (a winexe process must never touch `Console` — it can allocate one on
  some runtimes), no `Process.Start`.
- Build script: `config/scripts/build-windows-hook-host.mjs`, a sibling of
  `build-windows-cli-launcher.mjs` — same `csc.exe` discovery, same "Windows host required"
  refusal, `/target:winexe`, output `native/windows-hook-host/.build/orca-hook-host.exe`.
- Wired into `config/scripts/build-native-for-platform.mjs` (runs alongside the CLI launcher
  build on `win32`) and packaged via `config/electron-builder.config.cjs`'s Windows
  `extraResources` → `resources/bin/orca-hook-host.exe`.
- **This repo's own build box cannot compile C#** (`csc.exe` requires a Windows host). The
  logic is mirrored line-for-line in `src/main/agent-hooks/windows-hook-host-mirror.ts`, which
  carries the same tests the C# would need — endpoint-file parsing, the PORT/TOKEN/PANE_KEY
  guard, descriptor parsing, and form-body assembly — and is what CI actually runs. Any change
  to the C#'s behavior must be mirrored there by hand.
  **M4 — this is a LOGIC mirror, not a WIRE mirror:** the TS side POSTs via Node's `fetch`; the
  C# side POSTs via `HttpWebRequest`. The mirror's tests prove parsing/encoding/guard behavior
  identical to the C#, never `HttpWebRequest`-specific transport details (redirect handling,
  `Expect: 100-continue`, proxy resolution, .NET's own request-size limits, or timeouts — the
  C# side bounds each phase independently via `Timeout`/`ReadWriteTimeout`, not a single
  whole-call budget) — those are provable only by the `describe.skipIf(win32)` spawn test in
  `windows-hook-host-mirror.test.ts`, which runs the real compiled `.exe` and is gated to actual
  Windows CI.
- **SignPath scope (R3 — OWNER ACTION ITEM, unverified from this repo):** SignPath signs the
  packaged Windows build externally, from outside this repo, so this cannot be confirmed here.
  Before shipping a build containing `orca-hook-host.exe`, the owner must confirm SignPath's
  signing glob covers `resources/bin/*.exe` — it already covers `orca.exe` (the CLI launcher),
  but `orca-hook-host.exe` is a new file in that same directory and needs the same check. An
  unsigned `orca-hook-host.exe` would fail SmartScreen/AV reputation checks the same way an
  unsigned `orca.exe` would.

## How it's migrated

`hook-settings.ts`'s `getWindowsManagedLifecycleHook` picks the host-exe form when
`resources/bin/orca-hook-host.exe` exists next to the running app (`process.resourcesPath`).
**M3 (chair decision, superseding the original conhost fallback):** when the exe is absent —
a dev/unpackaged build that hasn't run `build:native` — it returns `null` instead, and NEVER
falls back to the conhost form (conhost swallows Claude's stdin payload; see "Why" above).
`ClaudeHookService.install()` then leaves any existing managed entry (any generation: exe-form,
conhost, cmd.exe-direct) untouched rather than sweeping it, writes no new lifecycle entry, and
reports the loud `getStatus()` state `'skipped'` / `skipReason: 'windows_hook_host_unavailable'`
— surfaced wherever agent-hook status is shown, not just a once-only `console.error` line (the
line still fires too, for local debugging). `installer-utils.ts`'s `createManagedCommandMatcher`
needle is extension-less (`agent-hooks/<stem>`, not `<stem>.cmd`), so it matches the new host's
`--descriptor <path>.json` argument as well as every legacy `.cmd`/`.ps1`/`.sh`-carrying entry —
a fresh install (once the exe IS present) sweeps a conhost OR a direct-cmd.exe entry down to
exactly one new entry, and a second consecutive `install()` stays at one. OpenClaude never takes
this path (`supportsExecHookArgs: false`) and keeps its `.cmd` unchanged.

`ClaudeHookService.install()` writes a small JSON descriptor
(`~/.orca/agent-hooks/claude-hook.json`) beside the `.cmd` (kept for OpenClaude and as the
rollback target): `{"source":"claude","pathname":"/hook/claude","fields":[...]}`. If the
descriptor is ever missing or unreadable, the host falls open to the same built-in defaults
(`/hook/claude`, the 7-field list `buildWindowsAgentHookCurlPostCommand` already uses) rather
than failing the hook.

## Which build script actually produces this exe (L5)

`orca-hook-host.exe` is only ever produced by `build:native` (`config/scripts/
build-native-for-platform.mjs`, per "How it's built" above). Verified against this repo's
`package.json` (2026-09-08):

- `build` (line 76) runs `build:desktop && build:native` — includes it.
- `build:release` (line 77) runs `build:native` directly — includes it.
- **`build:win` (line 82) runs `build:desktop && ensure:electron-runtime && electron-builder`
  — it does NOT run `build:native`.** A Windows package built via `build:win` alone ships
  without `resources/bin/orca-hook-host.exe` (and without the CLI launcher `orca.exe`, the
  other `build:native` output) — `getWindowsManagedLifecycleHook` then always reports the M3
  unavailable-skip state on that package, on every install.
- CI's `.github/workflows/pr.yml:381` runs `build:native` as its own step before packaging,
  so PR builds are unaffected. This asymmetry between `build` / `build:release` and `build:win`
  predates this change (`config/scripts/package-electron-runtime-contract.test.mjs` already
  pins `build:win` to exclude `pnpm run build `) — this doc does not resolve it, only names it.

**Verify which script the owner's desktop release actually invokes before shipping a build
containing this exe** — if it is `build:win` on its own, that pipeline needs `build:native`
added ahead of it (or switched to `build:release`), or the shipped app will run in the
unavailable-skip state for every user.

## How to verify on a desktop

1. Run `orca` on Windows with a build that includes `resources/bin/orca-hook-host.exe`; open a
   Claude pane.
2. **SessionStart row before any prompt** — the pane should appear in the sidebar with a status
   row before the user types anything (this is the hook Claude fires on session start/resume).
3. **Working → idle** — send a prompt; the pane should show "working" while Claude is
   generating and flip to idle/waiting when it stops, driven by the hook POSTs, not by the
   title bar.
4. **Tool readout** — during a tool call, the pane should show the in-flight tool name/input
   (PreToolUse), not just the title-derived row.
5. **No window during 30 s of tool calls** — run a tool-heavy prompt (or a scripted loop of
   short tool calls) for at least 30 seconds and watch for ANY console flash. None should
   appear — this is the negative check the R105 field reversal exists to re-prove.
6. **M3 negative check — a build without the exe never shows a false "installed" state.** On a
   dev/unpackaged build missing `resources/bin/orca-hook-host.exe`, agent-hook status (wherever
   it's surfaced in the app) must read `skipped` / `windows_hook_host_unavailable`, never
   `installed` — and any pre-existing managed hook entry in `settings.json` (from an earlier
   packaged run) must be byte-for-byte unchanged, not swept.
