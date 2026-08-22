import type { CommandHandler } from '../dispatch'
import { formatEnvironment, formatEnvironmentList, printResult } from '../format'
import {
  formatEnvironmentTerminalRoster,
  formatTerminalPresence
} from '../environment-roster-format'
import { getOptionalPositiveIntegerFlag } from '../flags'
import { getDefaultUserDataPath, RuntimeClient, RuntimeClientError } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeTerminalListResult } from '../../shared/runtime-types'
import {
  collectEnvironmentTerminalRoster,
  DEFAULT_ROSTER_PROBE_TIMEOUT_MS,
  LOCAL_ROSTER_ENVIRONMENT,
  type RosterProbe,
  type RosterProbeResponse
} from '../runtime/environment-terminal-roster'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment,
  type EnvironmentAddResult,
  type EnvironmentRemoveResult
} from '../runtime/environments'

export const ENVIRONMENT_HANDLERS: Record<string, CommandHandler> = {
  'environment add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const pairingCode = getRequiredStringFlag(flags, 'pairing-code')
    const environment = redactRuntimeEnvironment(
      addEnvironmentFromPairingCode(getDefaultUserDataPath(), {
        name,
        pairingCode
      })
    )
    printResult(
      localSuccess({ environment }),
      json,
      (result: EnvironmentAddResult) =>
        `Saved environment ${result.environment.name} (${result.environment.id}).`
    )
  },
  'environment list': async ({ json }) => {
    const environments = listEnvironments(getDefaultUserDataPath()).map(redactRuntimeEnvironment)
    printResult(localSuccess({ environments }), json, formatEnvironmentList)
  },
  'environment show': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const environment = redactRuntimeEnvironment(
      resolveEnvironment(getDefaultUserDataPath(), selector)
    )
    printResult(localSuccess({ environment }), json, ({ environment: value }) =>
      formatEnvironment(value)
    )
  },
  'environment roster': async ({ flags, client, json }) => {
    const timeoutMs =
      getOptionalPositiveIntegerFlag(flags, 'timeout-ms') ?? DEFAULT_ROSTER_PROBE_TIMEOUT_MS
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const userDataPath = getDefaultUserDataPath()
    const probes: RosterProbe[] = [
      {
        environment: LOCAL_ROSTER_ENVIRONMENT,
        environmentId: null,
        listTerminals: () => listRosterTerminals(client, limit)
      },
      ...listEnvironments(userDataPath).map((environment) => ({
        environment: environment.name,
        environmentId: environment.id,
        // Why: one client per saved environment reuses the pairing-offer routing the
        // global --environment flag uses, so the roster needs no new RPC method.
        listTerminals: () =>
          listRosterTerminals(
            new RuntimeClient(userDataPath, timeoutMs, null, environment.id),
            limit
          )
      }))
    ]
    printResult(
      localSuccess(await collectEnvironmentTerminalRoster(probes, { timeoutMs })),
      json,
      formatEnvironmentTerminalRoster
    )
  },
  'environment rm': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const removed = redactRuntimeEnvironment(removeEnvironment(getDefaultUserDataPath(), selector))
    printResult(
      localSuccess({ removed }),
      json,
      (result: EnvironmentRemoveResult) =>
        `Removed environment ${result.removed.name} (${result.removed.id}).`
    )
  }
}

async function listRosterTerminals(
  client: RuntimeClient,
  limit: number | undefined
): Promise<RosterProbeResponse> {
  const response = await client.call<RuntimeTerminalListResult>('terminal.list', {
    limit,
    includeVisualLayouts: false,
    // Why unconditional and not probed: `TerminalListParams` is non-strict, so a pre-presence peer
    // strips the key and answers exactly as today — and a capability probe would cost a second call
    // per peer to learn less than the per-row key already tells us.
    includePresence: true
  })
  return {
    runtimeId: response._meta.runtimeId,
    terminals: response.result.terminals.map((terminal) => ({
      handle: terminal.handle,
      title: terminal.title,
      worktreePath: terminal.worktreePath,
      // Why the `in` check rather than `?? null`: a peer that published no key is unknown, and the
      // roster column must be able to say so instead of claiming nobody is attached.
      ...('presence' in terminal ? { presence: formatTerminalPresence(terminal.presence) } : {})
    })),
    truncated: response.result.truncated
  }
}

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}
