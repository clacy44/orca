// S10-21a C7g (Ruling 34 Addendum 25): the read-only main->renderer push carrying a covered
// launch's admission classification, so the renderer can reconcile
// `sleepingAgentSessionsByPaneKey` against a fresh admission decision — the host-notice path
// (`writeHostNoticeToPane`) types text into the pty, never the renderer store, so this is a
// second, structured channel for the same fact. No writable counterpart, no wire/RPC exposure
// (local Electron IPC only, same class as `agentStatus:set`/`orchestration:sweepRestoreMark:list`).
export type LaunchAdmissionNoticeClassification =
  | 'HOST_RESUME'
  | 'SELF_RESUME_HOST'
  | 'SELF_RESUME_CALLER'
  | 'HOST_MINTED'
  | 'UNRECORDED'

export type LaunchAdmissionNoticePayload = {
  paneKey: string
  classification: LaunchAdmissionNoticeClassification
}

export const LAUNCH_ADMISSION_NOTICE_CHANNEL = 'orchestration:launchAdmission'
