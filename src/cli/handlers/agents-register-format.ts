// Split out of agents.ts (max-lines ratchet, 300/.ts) by the F-9 addendum (delta review, Ruling
// 32 Addendum 9) that added the pendingPeerQuestions/unreadMailOnRetiredId sentences below.
import type { AgentView } from './agents'

export type RegisterResult = {
  agent: AgentView
  created: boolean
  reMinted: boolean
  repointedMessages: number
  pendingOnOldHandle: number
  adoptedThreads: number
  blockedByQuarantinedPredecessor: boolean
  pendingPeerQuestions: number
  unreadMailOnRetiredId: number
  unreadWaiting: number
}

export function formatAgentRegister(result: RegisterResult): string {
  const verb = result.reMinted ? 'Re-registered' : 'Registered'
  const role = result.agent.role ? ` — role: ${result.agent.role}` : ''
  const repointed =
    result.repointedMessages > 0
      ? `\n${result.repointedMessages} unread message(s) from your previous terminal handle moved into this mailbox.`
      : ''
  const pending =
    result.pendingOnOldHandle > 0
      ? `\n${result.pendingOnOldHandle} more unread message(s) on your previous terminal handle were NOT moved (backlog too large for one re-mint) and are no longer reachable from this agent.`
      : ''
  // R2 (S10-11): only on a fresh id (never reMinted — a rebind's threads were never orphaned).
  const adopted =
    result.adoptedThreads > 0
      ? `\nInherited ${result.adoptedThreads} thread(s) (including pact state) from a previous registration under this name.`
      : ''
  // F-9 (Ruling 32(b)): a bare 0 above reads the same whether there was nothing to inherit or
  // something was blocked — say which when it is the latter.
  const blocked = result.blockedByQuarantinedPredecessor
    ? '\nA quarantined previous registration under this name exists; its thread participation was NOT inherited (quarantine survives retire, by design).'
    : ''
  // F-9 (Ruling 32 Addendum 9): peer-facing authority and unread bare-handle mail are never
  // repointed onto a fresh registration (deferred by ruling) -- say plainly what is NOT reachable
  // from here and how to reach it, instead of letting "Inherited N thread(s)" read as complete.
  const pendingQuestions =
    result.pendingPeerQuestions > 0
      ? `\n${result.pendingPeerQuestions} pending peer question(s) addressed to your previous registration were NOT inherited; the asker must re-ask this agent's new id.`
      : ''
  const unreadOnRetired =
    result.unreadMailOnRetiredId > 0
      ? `\n${result.unreadMailOnRetiredId} unread message(s) on your previous registration were NOT inherited; read them with \`orca orchestration inbox --thread-id\` on the old threads -- they remain addressed to the old id.`
      : ''
  // F-19 B2 (Ruling 33(a)): waiting mail on the landed id — reclaimed or otherwise — needs a
  // loud, one-line nudge toward `check` instead of sitting pull-only.
  const unreadWaiting =
    result.unreadWaiting > 0
      ? `\n${result.unreadWaiting} unread message(s) waiting — run: orca orchestration check`
      : ''
  return (
    `${verb} agent "${result.agent.displayName}" (${result.agent.id})${role}.${repointed}${pending}${adopted}${blocked}${pendingQuestions}${unreadOnRetired}${unreadWaiting}\n` +
    `Next: orca orchestration send --to agent:${result.agent.id} --subject "..."`
  )
}
