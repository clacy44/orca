import { createHash } from 'node:crypto'

/**
 * The one hashing function for an `ORCA_AGENT_LAUNCH_TOKEN` value. Never hash the raw token
 * anywhere else — the registry (`claimed-agent-pty-owner.ts`) and the daemon RPC only ever see
 * this digest, never the token itself (Ruling 32 Addendum 7).
 */
export function launchTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
