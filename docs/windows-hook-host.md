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
- **SignPath scope (R3, unverified from this repo):** SignPath signs the packaged Windows
  build externally; confirm `resources/bin/*.exe` is in its signing glob before shipping — it
  already covers `orca.exe` (the CLI launcher) but `orca-hook-host.exe` is a new file in that
  same directory and needs the same check.

## How it's migrated

`hook-settings.ts`'s `getWindowsManagedLifecycleHook` picks the host-exe form when
`resources/bin/orca-hook-host.exe` exists next to the running app (`process.resourcesPath`);
otherwise it falls back to the old conhost form and logs once (dev/unpackaged builds that
haven't run `build:native`). `installer-utils.ts`'s `createManagedCommandMatcher` needle is
extension-less (`agent-hooks/<stem>`, not `<stem>.cmd`), so it matches the new host's
`--descriptor <path>.json` argument as well as every legacy `.cmd`/`.ps1`/`.sh`-carrying entry —
a fresh install sweeps a conhost OR a direct-cmd.exe entry down to exactly one new entry, and a
second consecutive `install()` stays at one. OpenClaude never takes this path
(`supportsExecHookArgs: false`) and keeps its `.cmd` unchanged.

`ClaudeHookService.install()` writes a small JSON descriptor
(`~/.orca/agent-hooks/claude-hook.json`) beside the `.cmd` (kept for OpenClaude and as the
rollback target): `{"source":"claude","pathname":"/hook/claude","fields":[...]}`. If the
descriptor is ever missing or unreadable, the host falls open to the same built-in defaults
(`/hook/claude`, the 7-field list `buildWindowsAgentHookCurlPostCommand` already uses) rather
than failing the hook.

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
