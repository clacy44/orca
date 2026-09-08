# `orca chairs restore`

One command per machine restores every "chair" (a named, discoverable agent — e.g. one of the
per-repo orchestration chairs) listed in a manifest: it opens each chair's pane in its worktree,
resumes its conversation under the SAME conversation id, registers its name/role, and prints a
verification line per chair. Idempotent — re-running it after a chair is already live does
nothing to that chair.

## The manifest

Default location: `~/.orca/chairs.json`. Example, for two machines:

```json
{
  "version": 1,
  "chairs": [
    {
      "name": "backend-dll",
      "role": "backend server DLL plugin: build, wire contracts, data model",
      "worktree": "path:/home/user/repos/backend",
      "agent": "claude",
      "conversationId": "b6b1d492-...",
      "host": "desktop"
    },
    {
      "name": "vps-services",
      "role": "production VPS: services, deploys, watchers, routing, box config",
      "worktree": "path:/home/ubuntu/orca-fork",
      "agent": "claude",
      "conversationId": "5d079c9-...",
      "lastSessionId": "9a1c...",
      "host": "vps"
    }
  ]
}
```

Fields:

- `name` — the chair's display name in the agent directory.
- `role` — free text, shown alongside the name (optional).
- `worktree` — a worktree selector: `path:<absolute path>`, `id:<worktree id>`, or
  `folder:<folder workspace id>`.
- `agent` — always `"claude"` today.
- `conversationId` — the immutable seed: the conversation's original id. Always present.
- `lastSessionId` — the live head, written back automatically after every successful restore.
  Omit it on first use; `orca chairs restore` fills it in.
- `host` — which machine this chair runs on, compared against that machine's own `os.hostname()`
  (never an internal id — a manifest shared across machines names each with its real hostname).
  Omit it for a chair that lives on every machine the manifest is used on; set it when a manifest
  is shared across machines (see below).
- `model` / `effort` — optional per-chair launch preferences, threaded straight through to the
  new session (e.g. `"model": "opus"`, `"effort": "max"`).

## The one-shot flow after a full Orca restart

On EACH machine that holds chairs:

```
orca chairs restore
```

This resumes every chair whose `host` field is absent or matches the local machine. A chair
whose `host` names a DIFFERENT machine is listed as pending, with the exact command to run
there — `orca chairs restore` never opens a pane on a machine it isn't running on.

Use `--dry-run` first to see what would happen without touching anything:

```
orca chairs restore --dry-run
```

Restore only some chairs with `--only`:

```
orca chairs restore --only backend-dll,frontend-stack
```

A name absent from the manifest refuses the whole call (never a silent no-op for that name).

This whole surface (`restore`/`status`/`export`) is local-transport only: a paired device (mobile
or a runtime-kind peer) is refused regardless of any other check.

## Reading the output

Each restored or already-live chair prints one line:

```
backend-dll  [ok]  pane=tab:leaf-1 recorded=sess-abc minted=sess-abc paneLive=true attested=true autoRestoreArmed=true
```

- `pane` — the pane key the chair now lives on.
- `recorded` — the session id the host's own launch record carries for that pane.
- `minted` — the session id the manifest asked for (`lastSessionId` if set, else `conversationId`).
- `paneLive` — whether the pane currently resolves live.
- `attested` — whether the hook channel has reported this session live; `unknown` when that check
  is unwired (never a silent false).
- `autoRestoreArmed` — whether the conversation's own transcript carries a real turn (a
  zero-turn stub transcript would not auto-restore on the next restart).

There is no independent `running` column: no primitive on this surface reads back the live pty's
actual resolved launch command, so this table makes no claim about the process beyond `recorded`
and `paneLive`. `[ok]` means `recorded == minted` and the pane is live. Any inequality prints as
`[SHORT]`, and the command exits non-zero.

A chair whose conversation id is currently live on a DIFFERENT pane than the manifest names is
refused loudly, naming the pane — restore never forks a conversation; fork it manually if that
is genuinely what you want.

## `orca chairs status`

Same plan, without acting on it — use it to check what a restore WOULD do:

```
orca chairs status
```

## `orca chairs export`

Writes a manifest from the current agent directory (this machine's currently registered
chairs and their newest launch session ids), stamping each entry's `host` with THIS machine's
own `os.hostname()`:

```
orca chairs export
```

Refuses to overwrite any existing file at the target path unless `--force` is passed (an
existence check, not a parse attempt — a non-manifest file there is refused too).
