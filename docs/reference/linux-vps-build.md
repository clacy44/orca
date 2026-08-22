# Building the Linux AppImage on a VPS

Notes for producing `orca-linux.AppImage` on a bare Linux server — a minimal
cloud image with no desktop packages, a modern glibc, and a few GB of RAM. This
is the path used to build fork artifacts for headless deployments; for running
the result see [headless Linux server](./headless-linux-server.md).

Release CI builds on an older, fatter runner and hits none of this. Everything
below is about the gap between that runner and a stock VPS.

## The three traps

### 1. No `unzip` on the box

Installing the Electron binary extracts a zip, and
[`config/scripts/install-electron-package-binary.mjs`](../../config/scripts/install-electron-package-binary.mjs)
shells out to `unzip` to do it. Minimal cloud images frequently do not ship
`unzip` at all, and on a VPS where you have no root you cannot simply install it.

The script honors an override:

```js
file: process.env.ORCA_UNZIP_BIN || 'unzip'
```

BusyBox is present on most minimal images and its `unzip` applet accepts the same
`-q <zip> -d <dir>` form the script passes. Point `ORCA_UNZIP_BIN` at a two-line
shim:

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec busybox unzip "$@"\n' > ~/.local/bin/unzip
chmod +x ~/.local/bin/unzip
export ORCA_UNZIP_BIN=~/.local/bin/unzip
```

Pair it with `ORCA_STRICT_ELECTRON_INSTALL=1`. Without that flag a failed
Electron install is downgraded to a warning during postinstall
([`rebuild-native-deps.mjs`](../../config/scripts/rebuild-native-deps.mjs)
`continuePostinstallWithoutElectron`), and the failure only resurfaces much later
as a confusing packaging error. With it, a broken extractor fails immediately.

### 2. A modern glibc silently raises the floor

Read [Linux glibc compatibility](./linux-glibc-compatibility.md) first — it
explains the floor (Ubuntu 20.04 / glibc 2.31), why node-pty is the module that
breaks it, and the `.symver` pinning strategy.

The VPS-specific wrinkle is that a build host newer than the CI runner can
introduce *new* relocated symbols. Every glibc release that re-versions a
function node-pty calls adds another one. As of glibc 2.42, `cfsetospeed` and
`cfsetispeed` gained new default versions for arbitrary baud rates:

```console
$ objdump -T /lib/x86_64-linux-gnu/libc.so.6 | grep cfsetospeed
0000000000129ff0 g    DF .text  00000000000002c2  GLIBC_2.42  cfsetospeed
0000000000196e40 g    DF .text  0000000000000054 (GLIBC_2.2.5) cfsetospeed
```

The unparenthesized node is the default the compiler binds to, so building
node-pty on glibc ≥ 2.42 emits `cfsetospeed@GLIBC_2.42` and the result cannot
load on the floor. `config/patches/node-pty@1.1.0.patch` therefore pins these two
alongside `openpty`/`forkpty`/`pthread_sigmask`:

```c
__asm__(".symver cfsetospeed,cfsetospeed@" ORCA_GLIBC_COMPAT_VERSION);
__asm__(".symver cfsetispeed,cfsetispeed@" ORCA_GLIBC_COMPAT_VERSION);
```

Unlike `openpty`, whose two versions share one address, the `cfset*speed` pair
are genuinely different implementations at different addresses — the compat
alias is the classic fixed-baud behavior, which is what node-pty wants anyway.

You do not have to discover this by hand. The packaging gate
[`verify-linux-glibc-floor.cjs`](../../config/scripts/verify-linux-glibc-floor.cjs)
runs in electron-builder's `afterPack` and names the offending file and symbol
version. A passing build prints:

```
[verify-linux-glibc-floor] OK — 18 bundled native binaries all load on Ubuntu 20.04 (glibc 2.31 / libstdc++ GLIBCXX_3.4.28)
```

That gate has since passed on a **glibc 2.43** build host. 2.43 re-versioned
nothing node-pty calls — `cfsetospeed`/`cfsetispeed` still default to
`GLIBC_2.42`, which the patch already pins — so 2.42 remains the newest release
that raised the floor.

If a future glibc adds yet another one, the gate fails with the new symbol named;
add a matching `.symver` line to the patch and regenerate it (see
[Regenerating the node-pty patch](#regenerating-the-node-pty-patch)).

### 3. Memory — build serially, not via `build:desktop`

`pnpm run build:desktop` chains typecheck plus five build steps. On a VPS with
single-digit GB of RAM the Vite/Rollup and `tsc` steps are the peak consumers and
a chained run can OOM partway through, leaving a half-written `out/` that
produces confusing downstream errors.

Run the same steps as separate processes so each one's heap is reclaimed at exit,
and raise the per-process limit:

```bash
export NODE_OPTIONS=--max-old-space-size=4096
```

Skip `typecheck` for a packaging-only build — it is the heaviest step and it
verifies nothing about the artifact. Run it separately if you want it.

## The build

Environment (source this before every step; shell state does not persist across
a reconnect):

```bash
export PATH="$HOME/.local/bin:$PATH"
export ORCA_UNZIP_BIN="$HOME/.local/bin/unzip"
export ORCA_STRICT_ELECTRON_INSTALL=1
export NODE_OPTIONS=--max-old-space-size=4096
export CI=1
```

Install, then build each step in its own process:

```bash
pnpm install --frozen-lockfile

pnpm run build:relay
pnpm run build:cli
pnpm run build:electron-vite
pnpm run verify:built-skills-cli
pnpm run build:web-from-renderer
```

Package. Unset `CI` first — electron-builder's CI auto-detection turns on
publish/upload paths; `--publish never` is the explicit guard, and dropping the
variable keeps the two from arguing:

```bash
unset CI
pnpm run ensure:electron-runtime
pnpm exec electron-builder --config config/electron-builder.config.cjs \
  --linux AppImage --publish never
```

The artifact lands at `dist/orca-linux.AppImage`. `pnpm run build:linux` does all
of the above in one shot and also builds a `.deb`; prefer the split form on a
memory-constrained host.

## Regenerating the node-pty patch

Hand-editing `config/patches/node-pty@1.1.0.patch` means recomputing hunk offsets
and the blob hash, which is easy to get subtly wrong. Regenerate it instead:

```bash
# 1. pristine source
npm pack node-pty@1.1.0 && tar xzf node-pty-1.1.0.tgz && mv package work
cd work && git init -q . && git add -A -f && git commit -qm pristine

# 2. current patched state, plus your edit
git apply /path/to/orca/config/patches/node-pty@1.1.0.patch
$EDITOR src/unix/pty.cc

# 3. regenerate (the committed patches carry no trailing whitespace on
#    empty context lines, so strip it to keep the diff to your change)
git diff --full-index | sed 's/[[:space:]]*$//' > node-pty@1.1.0.patch
```

Then update the lockfile. `pnpm-lock.yaml` pins each patch by content hash, which
is the plain SHA-256 of the patch file:

```bash
sha256sum config/patches/node-pty@1.1.0.patch
# paste into pnpm-lock.yaml → patchedDependencies → node-pty@1.1.0 → hash
```

Skip that and every clean install fails with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. Verify both halves before committing:

```bash
git apply --check path/to/pristine-node-pty  # patch still applies
pnpm install --frozen-lockfile --lockfile-only --ignore-scripts  # hash matches
```

## Smoke-testing the artifact next to a running server

If the box already runs a production `orca serve`, the CLI will happily talk to
*it* instead of your new build — and worse, the build you launch will boot on the
production profile. The obvious variable only does half the job.

**`ORCA_USER_DATA_PATH` steers the CLI; a packaged app never reads it.** A shell
started from an Orca terminal inherits it (plus a dozen other `ORCA_*` vars)
pointing at the production profile, and for the CLI it does outrank
`HOME`/`XDG_CONFIG_HOME`
([`src/cli/runtime/metadata.ts:50-69`](../../src/cli/runtime/metadata.ts)). The
packaged app ignores it in both directions:
[`configureDevUserDataPath()`](../../src/main/startup/configure-process.ts)
returns early when `!isDev` (`configure-process.ts:174-176`; the only override it
honours is `ORCA_DEV_USER_DATA_PATH`, dev-only, `:177`), and
`configureOrcaUserDataPathEnv()` then *overwrites* `process.env.ORCA_USER_DATA_PATH`
with `app.getPath('userData')` (`:195-198`). They run in that order at
[`src/main/index.ts:665-666`](../../src/main/index.ts). Set it alone and you get a
split brain: your CLI reads the scratch profile while the app it spawned runs on
production's.

That is not hypothetical. `orca-linux.AppImage serve --port 16799` with only
`ORCA_USER_DATA_PATH` exported resolved to `~/.config/orca`, contended for
production's single-instance lock, and exited 3 before writing anything
([`src/main/index.ts:818-822`](../../src/main/index.ts)). It stayed harmless only
because the argv said `serve`: `shouldActivateDesktopForSecondInstance()` returns
false for serve-mode argv, so the live production instance was never promoted to a
desktop window
([`src/main/startup/single-instance-lock.ts:18-20`](../../src/main/startup/single-instance-lock.ts)).
Argv that stops parsing as serve mode — a mistyped subcommand, or `--help`
anywhere in the line — removes that protection and pokes the running server
instead.

So isolate four things:

- **`HOME` and `XDG_CONFIG_HOME` — this is what actually moves the app.** Packaged
  userData resolves to `<appData>/orca`: `$XDG_CONFIG_HOME/orca`, falling back to
  `$HOME/.config/orca`. That is the same directory
  [`metadata.ts`](../../src/cli/runtime/metadata.ts) computes for the CLI, so
  pointing both at one scratch root is what keeps the two halves agreeing.
- **`ORCA_USER_DATA_PATH`, still — for the CLI.** Scrub the inherited `ORCA_*`
  vars, then set this to the very path the app will pick.
- **Path length.** The runtime binds UNIX sockets under the user-data directory;
  a deep scratch path blows past the 107-byte `sun_path` limit and the runtime
  fails to start with `EINVAL`. Use something short like `/tmp/ocsm`.
- **The sandbox, in two different places.** An AppImage extracted as a non-root
  user leaves `chrome-sandbox` without its setuid bit and Electron aborts rather
  than run unsandboxed; `ORCA_APPIMAGE_NO_SANDBOX=1` makes the CLI pass
  `--no-sandbox` to the app it spawns
  ([`src/cli/runtime/launch.ts:90-92`](../../src/cli/runtime/launch.ts)). Do not,
  though, drive the new build through a *generated* `orca` shim: it execs the
  outer AppImage under `ELECTRON_RUN_AS_NODE=1`
  ([`src/main/cli/appimage-cli-wrapper.ts:31`](../../src/main/cli/appimage-cli-wrapper.ts)),
  AppRun injects `--no-sandbox`, and Node rejects it with `bad option` — F6, still
  live in 1.4.185. Invoke the extracted tree's own binary, which never goes
  through AppRun.

```bash
./orca-linux.AppImage --appimage-extract >/dev/null   # once, next to the artifact
EXTRACTED=$PWD/squashfs-root

for v in $(env | sed -n 's/^\(ORCA_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
export HOME=/tmp/ocsm
export XDG_CONFIG_HOME=/tmp/ocsm/.config
export ORCA_USER_DATA_PATH=/tmp/ocsm/.config/orca
export ORCA_APPIMAGE_NO_SANDBOX=1
mkdir -p "$ORCA_USER_DATA_PATH"

# The artifact's own CLI, bypassing AppRun. out/cli/index.js self-runs under
# `require.main === module` and main() defaults to process.argv.slice(2), so
# plain argv works — no `-e` bootstrap needed.
smoke() {
  ELECTRON_RUN_AS_NODE=1 "$EXTRACTED/orca-ide" \
    "$EXTRACTED/resources/app.asar.unpacked/out/cli/index.js" "$@"
}

smoke serve --port 16799 --no-pairing &
smoke status --json          # check appVersion + capabilities
smoke environment roster --json
```

Confirm two things, not one: `status --json` reports the runtime ID and
`appVersion` of your build rather than the production one, **and**
`orca-runtime.json` has appeared under `/tmp/ocsm/.config/orca`. The second is
what proves the *app* moved off the production profile — a CLI pointed at a
scratch directory can report a clean-looking failure while the server it started
is running on production's.
