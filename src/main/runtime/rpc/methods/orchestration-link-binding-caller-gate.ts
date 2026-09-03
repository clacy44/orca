// Ruling 28(h) (C8a)/protocol F10: the ONE local-caller gate, in the repo's own positive form
// (accounts.ts:163's precedent: admit only the named local caller shapes, refuse everything
// else first) — replacing the two duplicated denylists
// (`orchestration-link-binding-local.ts`'s old inline check and `rpc/methods/orchestration.ts`'s
// attention-field gate). A denylist (`pairedDeviceId != null || clientKind === 'mobile'`) silently
// admits any FUTURE `clientKind` value; this positive form admits only what is verified local
// today — the bare Unix-socket caller (`clientKind === undefined`) and the in-process
// `'runtime'` kind — and refuses every paired or mobile caller, and anything else, first.
import type { RpcContext } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'

export function isLocalOnlyCaller(ctx: Pick<RpcContext, 'pairedDeviceId' | 'clientKind'>): boolean {
  if (ctx.pairedDeviceId !== undefined) {
    return false
  }
  return ctx.clientKind === undefined || ctx.clientKind === 'runtime'
}

export function requireLocalCaller(ctx: RpcContext): void {
  if (!isLocalOnlyCaller(ctx)) {
    throw new OrchestrationError('forbidden', 'Link binding state is local-operator only.')
  }
}
