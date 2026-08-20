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
*it* instead of your new build unless you isolate three things:

- **`ORCA_USER_DATA_PATH`.** A shell started from an Orca terminal inherits this
  (plus a dozen other `ORCA_*` vars) pointing at the production profile, and it
  outranks `HOME`/`XDG_CONFIG_HOME` in
  [`src/cli/runtime/metadata.ts`](../../src/cli/runtime/metadata.ts). Scrub all
  `ORCA_*` vars and set this one explicitly.
- **Path length.** The runtime binds UNIX sockets under the user-data directory;
  a deep scratch path blows past the 107-byte `sun_path` limit and the runtime
  fails to start with `EINVAL`. Use something short like `/tmp/ocsm`.
- **The sandbox.** Running from an AppImage extracted as a non-root user leaves
  `chrome-sandbox` without its setuid bit and Electron aborts rather than run
  unsandboxed. Set `ORCA_APPIMAGE_NO_SANDBOX=1`, which makes the CLI pass
  `--no-sandbox` to the app it spawns.

```bash
for v in $(env | sed -n 's/^\(ORCA_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
export ORCA_USER_DATA_PATH=/tmp/ocsm/.config/orca
export ORCA_APPIMAGE_NO_SANDBOX=1
orca serve --port 16799 --no-pairing &
orca status --json          # check appVersion + capabilities
orca environment roster --json
```

Confirm `status --json` reports the runtime ID and `appVersion` of your build,
not the production one — that is the tell that isolation actually worked.
