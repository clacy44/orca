// S10-19 W-3 (Ruling 24(a) PEER profile): the taskSpec-free preamble. Its only variable segments
// are dispatchId/taskId (grammar-checked at the ingress — RISK 1, assertPeerDispatchIds, so the
// whole string is host-constant once validated) and workerHandle/dispatchCapability/cliCommand,
// all host-minted. The task itself never lands here — it is delivered as the first mail item
// (insertGatedMessage + notifyMessageArrived, orchestration-federation.ts), read via
// `orca orchestration check` exactly as every follow-up is (Ruling 20(a)). Split out of
// orchestration-federation.ts to stay under the max-lines ratchet.
export function buildPeerDispatchMailPointerPreamble(params: {
  dispatchId: string
  taskId: string
  workerHandle: string
  dispatchCapability?: string
  cliCommand?: 'orca' | 'orca-ide'
}): string {
  const cli = params.cliCommand ?? 'orca'
  const capabilityFlag = params.dispatchCapability
    ? ` --dispatch-capability ${params.dispatchCapability}`
    : ''
  return `You are working inside Orca, a multi-agent IDE. You are a dispatched worker for a
federation peer's Run. Your task ID is: ${params.taskId}
Your dispatch ID is: ${params.dispatchId}

Your task was NOT pasted into this pane. Read it as mail:

  ${cli} orchestration check --terminal ${params.workerHandle}${capabilityFlag}

Follow the same CLI-based reporting flow every dispatched worker uses (worker_done, heartbeat,
ask, escalation) — see the task mail item itself for the full command reference. Run
${cli} orchestration check again after reading your task, and periodically thereafter, for
further instructions.`
}
