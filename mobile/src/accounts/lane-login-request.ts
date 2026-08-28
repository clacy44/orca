/**
 * S9-L2 (design rev 38 §2l/§3): the phone half of the login quartet. A designated phone may run
 * this — "a designated phone is a working configuration, not an inert one: it can display a URL
 * and take a code, so it can load the lane" (§2l).
 */
export type LaneLoginRpcResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string } }

export type LaneLoginRequestClient = {
  sendRequest: (method: string, params: unknown) => Promise<LaneLoginRpcResult<unknown>>
}

export type LaneLoginState =
  | { stage: 'idle' }
  | { stage: 'starting' }
  | { stage: 'awaiting-code'; loginSessionId: string; authorizeUrl: string; expiresAt: number }
  | { stage: 'submitting'; loginSessionId: string; authorizeUrl: string; expiresAt: number }
  | { stage: 'error'; message: string }
  | { stage: 'completed'; email: string }

export const IDLE_LANE_LOGIN_STATE: LaneLoginState = { stage: 'idle' }

export async function startLaneLogin(
  client: LaneLoginRequestClient,
  expectedEmail: string
): Promise<LaneLoginState> {
  const res = await client.sendRequest('accounts.lane.loginStart', { expectedEmail })
  if (!res.ok) {
    return { stage: 'error', message: res.error.message }
  }
  const result = res.result as { loginSessionId: string; authorizeUrl: string; expiresAt: number }
  return {
    stage: 'awaiting-code',
    loginSessionId: result.loginSessionId,
    authorizeUrl: result.authorizeUrl,
    expiresAt: result.expiresAt
  }
}

export async function submitLaneLoginCode(
  client: LaneLoginRequestClient,
  loginSessionId: string,
  code: string
): Promise<LaneLoginState> {
  const res = await client.sendRequest('accounts.lane.loginSubmitCode', { loginSessionId, code })
  if (!res.ok) {
    return { stage: 'error', message: res.error.message }
  }
  const result = res.result as {
    status: 'completed' | 'rejected'
    identity: { email: string } | null
    attemptsRemaining: number
  }
  if (result.status === 'rejected') {
    return {
      stage: 'error',
      message: `That code was not accepted (${result.attemptsRemaining} attempt(s) left).`
    }
  }
  return { stage: 'completed', email: result.identity?.email ?? '' }
}

export async function cancelLaneLogin(
  client: LaneLoginRequestClient,
  loginSessionId: string
): Promise<void> {
  await client.sendRequest('accounts.lane.loginCancel', { loginSessionId })
}
