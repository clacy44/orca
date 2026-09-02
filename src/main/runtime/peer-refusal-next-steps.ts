// S10-19 W-5..W-7 review F4 / Ruling 24(v), §9.1/R11 (FROZEN): per-method next steps for a
// `method_not_available` refusal, never the allowlist itself. Seven families, keyed by the
// refused method name. Split out of runtime-peer-rpc-allowlist.ts to stay under the max-lines
// ratchet.
const HOST_MUTATING_METHOD_PREFIXES = [
  'terminal.create',
  'files.',
  'computer.',
  'repo.',
  'worktree.',
  'git.',
  'settings.',
  'accounts.'
]
const FEDERATED_REPLACEMENT_METHODS = new Set([
  'orchestration.workerStart',
  'orchestration.workerStop',
  'terminal.read',
  'terminal.wait'
])

export function nextStepsForRefusedMethod(method: string): readonly string[] {
  if (HOST_MUTATING_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return [`run it on that host: the local orca command for '${method}'`]
  }
  if (FEDERATED_REPLACEMENT_METHODS.has(method)) {
    return [
      'use the federated verb from the coordinator: orca orchestration worker-{start,stop,read} …'
    ]
  }
  if (
    method === 'terminal.send' ||
    method === 'terminal.write' ||
    /federationWorkerInput/i.test(method) ||
    method.includes('binaryStream')
  ) {
    return [
      "a federation pairing never writes input to a pane; answer a startup prompt with worker-answer-prompt, or send the worker mail with 'orca orchestration send --to dispatch:<id>'"
    ]
  }
  // W-5..W-7 review finding 4 (Ruling 24 addendum 4(dd)): the default arm must NAME an
  // alternative, never restate the refusal message — a restated message satisfies no §9.1
  // family and falsifies the skill guide's "names the local, non-peer alternative" claim.
  return [
    "this pairing is a federation-peer grant; a full runtime grant is minted with 'orca lane invite --person <you> --scope runtime --profile full' on that host"
  ]
}
