// S10-21a C7m (Ruling 34 Addendum 30, item 4; D-R120 F4): the sweep milestone's deferral-count
// key. Family = the reason code WITHOUT its trailing per-pane suffix — the colon namespace is
// kept; only the last space-separated token after the colon (a ptyId, a seq, ...) is stripped,
// so "sweep_deferred: agent_pty_identity_ambiguous <ptyId>" and "sweep_deferred:
// controller_inventory_unavailable" key separately instead of collapsing onto the bare
// "sweep_deferred" namespace.
export function restoreSweepDeferralFamily(reasonCode: string): string {
  const colonIdx = reasonCode.indexOf(':')
  if (colonIdx === -1) {
    return reasonCode
  }
  const namespace = reasonCode.slice(0, colonIdx)
  const restParts = reasonCode
    .slice(colonIdx + 1)
    .trim()
    .split(' ')
    .filter((part) => part.length > 0)
  if (restParts.length < 2) {
    return restParts.length === 0 ? namespace : `${namespace}: ${restParts[0]}`
  }
  return `${namespace}: ${restParts.slice(0, -1).join(' ')}`
}
