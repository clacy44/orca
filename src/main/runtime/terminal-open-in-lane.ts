import { ClaudeLaneRefusal } from '../../shared/claude-lane-refusals'
import type { TerminalPresenceRegistry } from './terminal-presence-registry'

/** §2g: the seed prompt is terminal input, never a shell command line, so it is bounded like a paste. */
export const MAX_LANE_SEED_PROMPT_BYTES = 4096

/**
 * Rejects a seed prompt that is over the byte budget or carries a control character other than a
 * newline (§2g). Newlines are the one control character a multiline prompt legitimately holds; every
 * other C0/C1 byte is an escape or a submit the caller must not smuggle into another lane's terminal.
 */
export function assertLaneSeedPromptWithinBounds(seed: string): void {
  if (Buffer.byteLength(seed, 'utf8') > MAX_LANE_SEED_PROMPT_BYTES) {
    throw new ClaudeLaneRefusal(
      'terminal.lane_seed_too_long',
      `That starting prompt is too long. Keep it to ${MAX_LANE_SEED_PROMPT_BYTES} bytes or fewer and try again.`
    )
  }
  for (const char of seed) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\n') {
      continue
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      throw new ClaudeLaneRefusal(
        'terminal.lane_seed_control_char',
        'That starting prompt contains a control character Orca will not type into a terminal. Remove it and try again — only plain text and line breaks are allowed.'
      )
    }
  }
}

/**
 * §2g's authorization join, as a pure predicate so its two anchors can be mutated in a test:
 *
 *   attachmentsOf(ptyId) → each attachment's grant → principalOf → equals the CALLER's principal.
 *
 * Anchor 1 — `grantsAttachedTo`, not `connections()`: a merely-registered grant authorizes nothing,
 * because every authenticated socket registers. Only a grant ATTACHED to this pty counts.
 * Anchor 2 — the compare is by PRINCIPAL, not by grant: a person's phone may open a pane their own
 * desktop grant is attached to, which a `grant === caller.pairedDeviceId` compare would refuse (§2h).
 */
export function callerMayOpenSourceLane(args: {
  registry: Pick<TerminalPresenceRegistry, 'grantsAttachedTo'>
  sourcePtyId: string
  caller: { principalId: string; pairedDeviceId: string }
  principalOfGrant: (pairedDeviceId: string) => string | null
}): boolean {
  const attachedGrants = args.registry.grantsAttachedTo(args.sourcePtyId)
  return attachedGrants.some((grant) => args.principalOfGrant(grant) === args.caller.principalId)
}
