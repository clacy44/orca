// Why: DeviceEntry.name is persisted in the secure registry, interpolated into the serve readiness
// banner, and (B1 §2.1) becomes the presence label broadcast to every peer, so every entry point must
// hand it over already bounded and free of control characters — a newline in a name would otherwise
// forge extra readiness lines in output operators and scripts read.
export const PAIRING_DEVICE_NAME_MAX_LENGTH = 64

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
}

/** Trims, flattens C0/C1 controls to spaces and caps the length; '' means "treat as unnamed". */
export function normalizePairingDeviceName(name: string | null | undefined): string {
  return [...(name ?? '')]
    .map((character) => (isControlCharacter(character) ? ' ' : character))
    .join('')
    .trim()
    .slice(0, PAIRING_DEVICE_NAME_MAX_LENGTH)
    .trim()
}
