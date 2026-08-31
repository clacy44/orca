export const AGENT_HOOK_ENDPOINT_FILE_NAMES = ['endpoint.env', 'endpoint.cmd'] as const

export type AgentHookEndpointFileName = (typeof AGENT_HOOK_ENDPOINT_FILE_NAMES)[number]

export type AgentHookEndpoint = {
  port: string
  token: string
  env: string
  version: string
  // S10-6 (R1): optional — AgentHookServer has no terminalHandle<->paneKey mapping to
  // populate these from today, so the writer never emits them yet. Parsed defensively so a
  // future writer can add them without a second file-format bump. This file is runtime-wide
  // (identical for every pane), so a future writer MUST NOT populate these from a single
  // "current" pane — readers treat these as a fallback only, used strictly after the caller's
  // own process-env evidence (see orchestration-compatibility-reattest.ts), never preferred
  // over it.
  paneKey?: string
  terminalHandle?: string
}

export function isAgentHookEndpointFileName(name: string): name is AgentHookEndpointFileName {
  return AGENT_HOOK_ENDPOINT_FILE_NAMES.some((fileName) => fileName === name)
}

export function parseAgentHookEndpointFile(contents: string): AgentHookEndpoint {
  const values = Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const normalizedLine = line.replace(/^set\s+/i, '')
        const [key, ...rest] = normalizedLine.split('=')
        return [key, rest.join('=')]
      })
  )
  if (
    !values.ORCA_AGENT_HOOK_PORT ||
    !values.ORCA_AGENT_HOOK_TOKEN ||
    !values.ORCA_AGENT_HOOK_ENV ||
    !values.ORCA_AGENT_HOOK_VERSION
  ) {
    throw new Error('Agent hook endpoint file is missing required fields')
  }
  // Why (S10-5 review F2): the port is interpolated directly into a request URL by callers
  // (orchestration-compatibility-reattest.ts); an unvalidated value like `1234/hook/claude?x=`
  // or a userinfo-form host lets a malformed endpoint file steer the request path. Reject
  // anything that isn't a bare 1-5 digit port up front so callers never build a malformed URL.
  if (!/^\d{1,5}$/.test(values.ORCA_AGENT_HOOK_PORT)) {
    throw new Error('Agent hook endpoint file has a malformed port')
  }
  return {
    port: values.ORCA_AGENT_HOOK_PORT,
    token: values.ORCA_AGENT_HOOK_TOKEN,
    env: values.ORCA_AGENT_HOOK_ENV,
    version: values.ORCA_AGENT_HOOK_VERSION,
    ...(values.ORCA_AGENT_HOOK_PANE_KEY ? { paneKey: values.ORCA_AGENT_HOOK_PANE_KEY } : {}),
    ...(values.ORCA_AGENT_HOOK_TERMINAL_HANDLE
      ? { terminalHandle: values.ORCA_AGENT_HOOK_TERMINAL_HANDLE }
      : {})
  }
}
