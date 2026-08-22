import {
  canonicalizePathForContainment,
  isCanonicalPathWithinRoot
} from './canonical-path-containment'
import { getClaudeLanesRoot } from './claude-lanes-root'

export type CaptureSourceKind = 'claude-config-dir' | 'codex-home'

const CAPTURE_SOURCE_LABEL: Record<CaptureSourceKind, string> = {
  'claude-config-dir': 'Claude config directory',
  'codex-home': 'Codex home directory'
}

/**
 * Refuses a credential capture whose source canonically is, or sits under, the
 * claude-lanes root — otherwise `orca account add --config-dir <lane>` turns a
 * co-tenant's momentary lane into permanent host-managed possession. Applies to every
 * caller class, the anonymous local socket included.
 *
 * A symlinked source is refused outright: following it would let its owner swap the
 * target between this check and the read. A path that does not exist is left to the
 * caller's own existence check, which reports it far more usefully.
 */
export function assertCaptureSourceOutsideClaudeLanes(
  candidatePath: string,
  kind: CaptureSourceKind,
  lanesRoot: string = getClaudeLanesRoot()
): void {
  const label = CAPTURE_SOURCE_LABEL[kind]
  const canonical = canonicalizePathForContainment(candidatePath)
  if (canonical.kind === 'symlink') {
    throw new Error(`That ${label} is a symbolic link. Pass the directory it points at instead.`)
  }
  if (canonical.kind === 'canonical' && isCanonicalPathWithinRoot(lanesRoot, canonical.path)) {
    throw new Error(
      `Refusing to capture credentials: that ${label} is inside Orca's per-principal credential lane storage.`
    )
  }
}
