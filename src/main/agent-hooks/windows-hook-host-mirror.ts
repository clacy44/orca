// TS mirror of native/windows-hook-host/OrcaHookHost.cs (R105-b), used to test that binary's
// logic on this (non-Windows) build box, where the C# cannot be compiled. Each exported function
// below names its C# counterpart method; keep both files in sync by hand on any behavior change.
//
// This module never runs in production — Windows uses the compiled .exe; POSIX/SSH/remote never
// reach it. It exists solely so `windows-hook-host-mirror.test.ts` can exercise the host's
// endpoint-file parsing, guard, and form-body assembly against a real AgentHookServer.
//
// M4: this is a LOGIC mirror (Node's `fetch`), not a WIRE mirror of `HttpWebRequest` — it proves
// parsing/encoding/guard behavior, not HttpWebRequest-specific transport details (redirect
// handling, Expect: 100-continue, proxy resolution). Those are covered only by the
// Windows-only `describe.skipIf` spawn test in the same test file. Timeouts are also
// LOGIC-only here: the native host's Timeout/ReadWriteTimeout are per-phase (connect,
// response, body write), not a single whole-call budget.

import { cancelUnreadResponseBody } from '../lib/unread-response-body'

export type WindowsHookHostEndpointCoordinates = {
  port: string
  token: string
  env: string
  version: string
}

const ENDPOINT_PORT_PATTERN = /^\d{1,5}$/
const DESCRIPTOR_PATHNAME_PATTERN = /^\/[A-Za-z0-9._~/-]*$/

// Counterpart: OrcaHookHost.cs `ParseEndpointFile`. Mirrors
// src/shared/agent-hook-endpoint-file.ts:25-61's `set K=V` CRLF parsing + port guard.
export function parseWindowsHookHostEndpointFile(
  contents: string
): WindowsHookHostEndpointCoordinates | null {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const normalized = line.replace(/^set\s+/i, '')
    const separatorIndex = normalized.indexOf('=')
    if (separatorIndex === -1) {
      continue
    }
    values[normalized.slice(0, separatorIndex)] = normalized.slice(separatorIndex + 1)
  }
  const port = values.ORCA_AGENT_HOOK_PORT
  const token = values.ORCA_AGENT_HOOK_TOKEN
  if (!port || !token || !ENDPOINT_PORT_PATTERN.test(port)) {
    return null
  }
  return {
    port,
    token,
    env: values.ORCA_AGENT_HOOK_ENV ?? '',
    version: values.ORCA_AGENT_HOOK_VERSION ?? ''
  }
}

export type WindowsHookHostContext = WindowsHookHostEndpointCoordinates & { paneKey: string }

// Counterpart: OrcaHookHost.cs `ResolveCoordinates` + the PORT/TOKEN/PANE_KEY guard in `Run`.
// `endpointFileContents` is null when ORCA_AGENT_HOOK_ENDPOINT is unset/unreadable — the whole
// coordinate set then comes from process env, never a per-field merge of both sources.
export function resolveWindowsHookHostContext(opts: {
  endpointFileContents: string | null
  processEnv: Record<string, string | undefined>
}): WindowsHookHostContext | null {
  const fromFile = opts.endpointFileContents
    ? parseWindowsHookHostEndpointFile(opts.endpointFileContents)
    : null
  const coordinates: Partial<WindowsHookHostEndpointCoordinates> = fromFile ?? {
    port: opts.processEnv.ORCA_AGENT_HOOK_PORT,
    token: opts.processEnv.ORCA_AGENT_HOOK_TOKEN,
    env: opts.processEnv.ORCA_AGENT_HOOK_ENV,
    version: opts.processEnv.ORCA_AGENT_HOOK_VERSION
  }
  const paneKey = opts.processEnv.ORCA_PANE_KEY
  if (!coordinates.port || !coordinates.token || !paneKey) {
    return null
  }
  // M2 (counterpart: OrcaHookHost.cs `ResolveCoordinates`): the env-fallback port is otherwise
  // unvalidated — it is interpolated straight into the request URL in postWindowsHookHostPayload.
  if (!ENDPOINT_PORT_PATTERN.test(coordinates.port)) {
    return null
  }
  return {
    port: coordinates.port,
    token: coordinates.token,
    env: coordinates.env ?? '',
    version: coordinates.version ?? '',
    paneKey
  }
}

// Field order matches buildWindowsAgentHookCurlPostCommand (installer-utils.ts:182-198).
export const WINDOWS_HOOK_HOST_DEFAULT_FIELDS = [
  'paneKey',
  'tabId',
  'launchToken',
  'worktreeId',
  'env',
  'version',
  'payload'
] as const

export type WindowsHookHostDescriptor = {
  source: string
  pathname: string
  fields: readonly string[]
}

const DEFAULT_DESCRIPTOR: WindowsHookHostDescriptor = {
  source: 'claude',
  pathname: '/hook/claude',
  fields: WINDOWS_HOOK_HOST_DEFAULT_FIELDS
}

// Counterpart: OrcaHookHost.cs `ParseDescriptor` — falls open to the built-in default on any
// missing/malformed input, matching the host's "unreadable descriptor never blocks the POST".
export function parseWindowsHookHostDescriptor(json: string | null): WindowsHookHostDescriptor {
  if (!json) {
    return DEFAULT_DESCRIPTOR
  }
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_DESCRIPTOR
    }
    const record = parsed as Record<string, unknown>
    if (typeof record.pathname !== 'string' || !Array.isArray(record.fields)) {
      return DEFAULT_DESCRIPTOR
    }
    const fields = record.fields.filter((field): field is string => typeof field === 'string')
    if (fields.length === 0) {
      return DEFAULT_DESCRIPTOR
    }
    // M2 (counterpart: OrcaHookHost.cs `ParseDescriptor`): an unvalidated pathname is
    // interpolated straight into the request URL — a crafted `@evil.example/x` value could
    // redirect the POST (and its token) off 127.0.0.1.
    if (!DESCRIPTOR_PATHNAME_PATTERN.test(record.pathname)) {
      return DEFAULT_DESCRIPTOR
    }
    return {
      source: typeof record.source === 'string' ? record.source : DEFAULT_DESCRIPTOR.source,
      pathname: record.pathname,
      fields
    }
  } catch {
    return DEFAULT_DESCRIPTOR
  }
}

// Counterpart: OrcaHookHost.cs `EncodeRfc3986` (H2). A hand-rolled RFC-3986 percent-encoder over
// UTF-8 bytes, not `encodeURIComponent` — the C# side cannot use `encodeURIComponent` (it does
// not exist in .NET) and `Uri.EscapeDataString` throws past ~65,520 chars on .NET Framework, so
// the fix there is a byte-level encoder; this mirrors that byte-level behavior exactly rather
// than JS's own (unlimited, but differently-escaping) built-in.
const UNRESERVED_BYTE = /^[A-Za-z0-9\-._~]$/
function encodeRfc3986(value: string): string {
  const bytes = Buffer.from(value, 'utf-8')
  let out = ''
  for (const byte of bytes) {
    const char = String.fromCharCode(byte)
    out += UNRESERVED_BYTE.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

// Counterpart: OrcaHookHost.cs `BuildFormBody`.
export function buildWindowsHookHostFormBody(
  fields: readonly string[],
  values: Partial<Record<string, string>>
): string {
  return fields
    .map((field) => `${encodeRfc3986(field)}=${encodeRfc3986(values[field] ?? '')}`)
    .join('&')
}

// Counterpart: OrcaHookHost.cs `ReadStdinWithDeadline`. Operates on any readable stream (a real
// piped stdin in production; a PassThrough in tests) rather than reopening process.stdin itself.
export async function readWindowsHookHostStdin(
  stream: NodeJS.ReadableStream,
  opts: { deadlineMs: number; capBytes: number }
): Promise<string> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      resolvePromise(Buffer.concat(chunks).toString('utf-8'))
    }
    const onData = (chunk: Buffer): void => {
      const remaining = opts.capBytes - total
      if (remaining <= 0) {
        finish()
        return
      }
      const taken = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(taken)
      total += taken.length
      if (total >= opts.capBytes) {
        finish()
      }
    }
    const onEnd = (): void => finish()
    const onError = (): void => finish()
    const timer = setTimeout(finish, opts.deadlineMs)
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}

// Counterpart: OrcaHookHost.cs `PostPayload`, which disposes the response with
// `using (request.GetResponse()) { }`. Swallows every failure — the host always exits 0. Mirrors
// that disposal by cancelling the response body on every path (success and !ok) via
// cancelUnreadResponseBody; an unread global-fetch body can crash the process (see
// global-fetch-call-site-audit.test.ts).
export async function postWindowsHookHostPayload(opts: {
  port: string
  token: string
  pathname: string
  body: string
  totalTimeoutMs?: number
}): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.totalTimeoutMs ?? 1500)
  try {
    const response = await fetch(`http://127.0.0.1:${opts.port}${opts.pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Orca-Agent-Hook-Token': opts.token
      },
      body: opts.body,
      signal: controller.signal
    })
    await cancelUnreadResponseBody(response)
  } catch {
    // Why: mirrors OrcaHookHost.cs's top-level try/catch — a failed POST must never surface.
  } finally {
    clearTimeout(timer)
  }
}

// Counterpart: OrcaHookHost.cs `Run`. The single entry point tests drive end to end.
export async function runWindowsHookHostOnce(opts: {
  stdin: NodeJS.ReadableStream
  endpointFileContents: string | null
  descriptorJson: string | null
  processEnv: Record<string, string | undefined>
}): Promise<'sent' | 'guard-exit'> {
  const context = resolveWindowsHookHostContext({
    endpointFileContents: opts.endpointFileContents,
    processEnv: opts.processEnv
  })
  if (!context) {
    return 'guard-exit'
  }
  const payload = await readWindowsHookHostStdin(opts.stdin, {
    deadlineMs: 2000,
    capBytes: 1_000_000
  })
  const descriptor = parseWindowsHookHostDescriptor(opts.descriptorJson)
  const body = buildWindowsHookHostFormBody(descriptor.fields, {
    paneKey: context.paneKey,
    tabId: opts.processEnv.ORCA_TAB_ID,
    launchToken: opts.processEnv.ORCA_AGENT_LAUNCH_TOKEN,
    worktreeId: opts.processEnv.ORCA_WORKTREE_ID,
    env: context.env,
    version: context.version,
    payload
  })
  await postWindowsHookHostPayload({
    port: context.port,
    token: context.token,
    pathname: descriptor.pathname,
    body
  })
  return 'sent'
}
