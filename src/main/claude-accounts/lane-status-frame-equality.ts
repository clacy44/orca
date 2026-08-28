import type { ClaudeCredentialIdentity } from '../../shared/claude-credential-identity-types'
import type { ClaudeLaneStatus } from '../../shared/claude-lane-delegation'

/**
 * Field-by-field comparison of a flat, JSON-serializable status frame; null is its own state.
 *
 * `heldIdentity` (an object) cannot be compared with `!==` — every status frame arrives as freshly
 * parsed JSON, so two structurally identical frames never share references and a `!==` scan on
 * that key would report `changed` on every call. Recurse into it field-by-field instead; every
 * other key is a scalar and stays `!==`.
 */
export function laneStatusEqual(a: ClaudeLaneStatus | null, b: ClaudeLaneStatus | null): boolean {
  if (a === b) {
    return true
  }
  if (a === null || b === null) {
    return false
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ClaudeLaneStatus>
  for (const key of keys) {
    if (key === 'heldIdentity') {
      if (!credentialIdentityEqual(a.heldIdentity, b.heldIdentity)) {
        return false
      }
      continue
    }
    if (a[key] !== b[key]) {
      return false
    }
  }
  return true
}

function credentialIdentityEqual(
  a: ClaudeCredentialIdentity | null,
  b: ClaudeCredentialIdentity | null
): boolean {
  if (a === b) {
    return true
  }
  if (a === null || b === null) {
    return false
  }
  return (
    a.accountUuid === b.accountUuid &&
    a.email === b.email &&
    a.organizationUuid === b.organizationUuid
  )
}
