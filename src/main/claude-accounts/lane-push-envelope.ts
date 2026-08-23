import { z } from 'zod'
import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import {
  LANE_DISPLAY_NAME_MAX_LENGTH,
  isPrintableLaneString
} from '../../shared/claude-lane-delegation'
import { hasClaudeOauthAccessToken } from './lane-credential-writer'

/**
 * §2b's payload validation, in full, BEFORE any byte reaches a lane.
 *
 * The envelope has exactly three members and no others; each file is bounded; `.credentials.json`
 * must satisfy the same `claudeAiOauth.accessToken` predicate a launch runs on, and
 * `oauth-account.json` must parse to a JSON object. Everything that fails is one refusal —
 * `accounts.lane.push_malformed` — so a well-formed-envelope-but-garbage blob fails at the RPC
 * and not at the next launch.
 *
 * Nothing here logs, echoes or re-serializes a member into an error message: the strings it
 * validates ARE the credential.
 */

/** §2b: each file member is bounded at 64 KiB, measured in UTF-8 bytes, not characters. */
export const LANE_PUSH_MEMBER_MAX_BYTES = 64 * 1024

const BoundedFileMember = z.string().min(1)

const PushEnvelopeSchema = z
  .object({
    credentialsJson: BoundedFileMember,
    oauthAccountJson: BoundedFileMember,
    displayName: z.string().max(LANE_DISPLAY_NAME_MAX_LENGTH).optional()
  })
  .strict()

const DelegationSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    principalId: z.string().min(1).max(128),
    delegatedGrantId: z.string().min(1).max(256),
    since: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const PushParamsSchema = z
  .object({
    envelope: PushEnvelopeSchema,
    basedOnRefreshTokenSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    reauthenticated: z.boolean().optional(),
    /** DETECTION data for R-DR2 only (§2e); never a writer of the lease. */
    delegation: DelegationSchema
  })
  .strict()

export type LanePushEnvelope = {
  credentialsJson: string
  oauthAccountJson: string
  displayName: string | null
}

export type LanePushRequest = {
  envelope: LanePushEnvelope
  /** The parsed `oauth-account.json`, so no caller re-derives identity from an unvalidated string. */
  oauthAccount: Record<string, unknown>
  basedOnRefreshTokenSha256: string | null
  reauthenticated: boolean
  delegation: z.infer<typeof DelegationSchema>
}

export function laneEnvelopeMemberBytes(value: string): number {
  return Buffer.byteLength(value, 'utf-8')
}

/**
 * Parses and validates one `accounts.lane.push` payload.
 *
 * Every failure — an extra member, an oversized file, an unparseable or non-object
 * `oauth-account.json`, a credentials blob with no usable access token, a display name with a
 * control character — is `accounts.lane.push_malformed`.
 */
export function parseLanePushRequest(params: unknown): LanePushRequest {
  const parsed = PushParamsSchema.safeParse(params)
  if (!parsed.success) {
    throw malformed()
  }
  const { envelope } = parsed.data
  if (
    laneEnvelopeMemberBytes(envelope.credentialsJson) > LANE_PUSH_MEMBER_MAX_BYTES ||
    laneEnvelopeMemberBytes(envelope.oauthAccountJson) > LANE_PUSH_MEMBER_MAX_BYTES
  ) {
    throw malformed()
  }
  if (envelope.displayName !== undefined && !isPrintableLaneString(envelope.displayName)) {
    throw malformed()
  }
  if (!hasClaudeOauthAccessToken(envelope.credentialsJson)) {
    throw malformed()
  }
  const oauthAccount = parseJsonObject(envelope.oauthAccountJson)
  if (!oauthAccount) {
    throw malformed()
  }
  return {
    envelope: {
      credentialsJson: envelope.credentialsJson,
      oauthAccountJson: envelope.oauthAccountJson,
      displayName: envelope.displayName?.trim() || null
    },
    oauthAccount,
    basedOnRefreshTokenSha256: parsed.data.basedOnRefreshTokenSha256 ?? null,
    reauthenticated: parsed.data.reauthenticated === true,
    delegation: parsed.data.delegation
  }
}

function parseJsonObject(contents: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(contents)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function malformed(): ClaudeLaneRefusal {
  // One sentence for every arm on purpose: naming WHICH member failed would tell a caller how
  // close its blob came to being written, and the remedy is the same for all of them.
  return new ClaudeLaneRefusal(
    'accounts.lane.push_malformed',
    'Orca refused this Claude account push because the payload was not the two credential files it expects, so nothing was written to the lane. Re-select the account on the desktop that owns it and try again.'
  )
}
