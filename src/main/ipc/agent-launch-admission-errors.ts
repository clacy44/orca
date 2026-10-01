// S10-21a C3-v2: split out so the lock module and the classification module can both throw a
// typed refusal without importing the (larger) admission orchestrator.
import {
  HOST_ELEVATED_REFUSED_CODE,
  type DaemonIntegrityReport,
  type ProcessIntegrityLevel
} from '../../shared/host-integrity-types'

export class LaunchAdmissionRefusedError extends Error {
  readonly reasonCode: string
  constructor(reasonCode: string) {
    super(`launch admission refused: ${reasonCode}`)
    this.name = 'LaunchAdmissionRefusedError'
    this.reasonCode = reasonCode
  }
}

export type HostElevatedRefusalData = {
  source: 'main' | 'daemon'
  main: ProcessIntegrityLevel
  daemon: DaemonIntegrityReport | null
}
/** INV-P-023. Subclasses LaunchAdmissionRefusedError: chair-restore reads that as "refused before any row write". */
export class HostElevatedRefusedError extends LaunchAdmissionRefusedError {
  readonly code = HOST_ELEVATED_REFUSED_CODE
  readonly data: HostElevatedRefusalData
  constructor(sentence: string, data: HostElevatedRefusalData) {
    super(HOST_ELEVATED_REFUSED_CODE)
    this.name = 'HostElevatedRefusedError'
    // Why: crosses RPC verbatim (structured passthrough); clients keep no string table.
    this.message = sentence
    this.data = data
  }
}

export const RESUME_TARGET_LIVE_REFUSED_CODE = 'resume_target_owned_by_another_pane'

export type ResumeTargetLiveRefusalData = {
  sessionId: string
  holderPaneKey: string
  holderTerminal: string | null
  via: 'claude_foreground' | 'hook_report' | 'session_holder'
  chair: string | null
  nextSteps: string[]
}
/** 10z.5 R287. Subclasses LaunchAdmissionRefusedError (refused before any row write); crosses RPC
 * verbatim through the structured passthrough, so the sentence and the recovery steps reach the CLI. */
export class ResumeTargetLiveRefusedError extends LaunchAdmissionRefusedError {
  readonly code = RESUME_TARGET_LIVE_REFUSED_CODE
  readonly data: ResumeTargetLiveRefusalData
  constructor(sentence: string, data: ResumeTargetLiveRefusalData) {
    super(RESUME_TARGET_LIVE_REFUSED_CODE)
    this.name = 'ResumeTargetLiveRefusedError'
    this.message = sentence
    this.data = data
  }
}
