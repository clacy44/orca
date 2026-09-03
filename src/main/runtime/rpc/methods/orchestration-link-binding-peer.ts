// S10-16 C3, R7/R8/R9 (design v6, frozen): the two peer-facing link-binding RPCs. Both are
// peer-by-design (Ruling 20 CORE RULING, R13) — reachable only over a paired runtime link, never
// a local caller. Split across sibling modules to stay under the max-lines ratchet: wire shapes in
// orchestration-link-binding-wire.ts, pending state + the containment gate in
// orchestration-link-binding-pending.ts, and each verb's handler body in its own
// orchestration-link-binding-{probe,confirm}.ts. This file only aggregates the two.
import type { RpcMethod } from '../core'
import { FEDERATED_LINK_PROBE_METHOD } from './orchestration-link-binding-probe'
import { FEDERATED_LINK_CONFIRM_METHOD } from './orchestration-link-binding-confirm'

export const ORCHESTRATION_LINK_BINDING_PEER_METHODS: RpcMethod[] = [
  FEDERATED_LINK_PROBE_METHOD,
  FEDERATED_LINK_CONFIRM_METHOD
]
