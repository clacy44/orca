// S10-21a C7g (Ruling 34 Addendum 25): the pure reconciliation decision for
// `orchestration:launchAdmission` — the host-notice path types text into the pty, never this
// store, so a sleeping record captured at a daemon-death remount (origin 'daemon-death') needs
// this second, structured channel to know when it can be cleared or must be kept.
import type { LaunchAdmissionNoticeClassification } from '../../../shared/launch-admission-notice'

export type LaunchAdmissionNoticeAction =
  | { kind: 'clear' }
  | { kind: 'keep-and-notify'; text: string }
  | { kind: 'none' }

export const HOST_MINTED_SLEEPING_RECORD_NOTICE_TEXT =
  'Restored as a fresh session — previous conversation kept as a sleeping record'

export function resolveLaunchAdmissionNoticeAction(
  recordOrigin: string | undefined,
  classification: LaunchAdmissionNoticeClassification
): LaunchAdmissionNoticeAction {
  if (recordOrigin !== 'daemon-death') {
    return { kind: 'none' }
  }
  if (classification === 'HOST_RESUME' || classification === 'SELF_RESUME_HOST') {
    return { kind: 'clear' }
  }
  if (classification === 'HOST_MINTED') {
    return { kind: 'keep-and-notify', text: HOST_MINTED_SLEEPING_RECORD_NOTICE_TEXT }
  }
  return { kind: 'none' }
}
