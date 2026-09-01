export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

// S10-15 finding 16: `@` and `:` are the two characters `name@host` addressing (agents-shared.ts
// parseAgentSelector, splitting on the LAST `@`) and the `agent:`/`run:`/`dispatch:` prefix
// namespace both rely on being absent from a saved environment's own name — an environment named
// `a@b` cannot round-trip through `orca agents find --all-hosts`'s own `addressOf`, and one
// containing `:` collides with a mailbox prefix. `local` is the reserved sentinel
// (LOCAL_FIND_HOST/LOCAL_PEER_HOST) that means "this host, not a saved environment" — an
// environment genuinely named `local` would silently address the wrong host on every `name@local`
// send. Refused at the door (name is chosen once, at `add`); the door is a NAME-shape check only
// — it never re-validates an existing store, so a name saved before this check keeps working
// exactly as it does today.
export function validateEnvironmentNameCandidate(
  name: string
): { ok: true } | { ok: false; reason: string } {
  if (name.includes('@')) {
    return {
      ok: false,
      reason: 'An environment name cannot contain "@" (reserved for name@host addressing).'
    }
  }
  if (name.includes(':')) {
    return {
      ok: false,
      reason:
        'An environment name cannot contain ":" (reserved for agent:/run:/dispatch: addressing).'
    }
  }
  if (name.trim().toLowerCase() === 'local') {
    return {
      ok: false,
      reason:
        '"local" is reserved (it means "this host", never a saved environment) and cannot be used as an environment name.'
    }
  }
  return { ok: true }
}

export function assertAddressableEnvironmentName(name: string): void {
  const validation = validateEnvironmentNameCandidate(name)
  if (!validation.ok) {
    // No rename verb exists today — RuntimeEnvironmentStoreError carries no structured
    // nextSteps (see toRuntimeClientErrorCode in cli/runtime/environments.ts), so the working
    // fix is folded into the message itself: add under a valid name, then remove the old one.
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `${validation.reason} Choose a different name, then run "orca environment remove <old name>" once the new one is saved and working.`
    )
  }
}
