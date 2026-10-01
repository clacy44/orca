import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { DAEMON_DEATH_REANCHOR_PROMPT } from '../../../../shared/daemon-death-reanchor-prompt'

// Why all three: the flag is set only on a chair verdict, and host text may ride only the daemon-session-lost relaunch.
export function reanchorResumePrompt(
  agent: string | undefined,
  record: SleepingAgentSessionRecord | undefined,
  isRecoveryRelaunch: boolean
): string | null {
  return agent === 'claude' &&
    isRecoveryRelaunch &&
    record?.reanchorAfterDaemonDeath === true &&
    (record.origin === 'live' || record.origin === 'daemon-death')
    ? DAEMON_DEATH_REANCHOR_PROMPT
    : null
}
