// S10-21a C7g (Ruling 34 Addendum 25): the renderer's reconciliation of
// `orchestration:launchAdmission` against `sleepingAgentSessionsByPaneKey`.
import { describe, expect, it } from 'vitest'
import {
  HOST_MINTED_SLEEPING_RECORD_NOTICE_TEXT,
  resolveLaunchAdmissionNoticeAction
} from './launch-admission-notice-reconciliation'

describe('S10-21a C7g: resolveLaunchAdmissionNoticeAction', () => {
  it('clears the record on HOST_RESUME when its origin is daemon-death', () => {
    expect(resolveLaunchAdmissionNoticeAction('daemon-death', 'HOST_RESUME')).toEqual({
      kind: 'clear'
    })
  })

  it('clears the record on SELF_RESUME_HOST when its origin is daemon-death', () => {
    expect(resolveLaunchAdmissionNoticeAction('daemon-death', 'SELF_RESUME_HOST')).toEqual({
      kind: 'clear'
    })
  })

  it('keeps the record and raises the fresh-session notice on HOST_MINTED', () => {
    expect(resolveLaunchAdmissionNoticeAction('daemon-death', 'HOST_MINTED')).toEqual({
      kind: 'keep-and-notify',
      text: HOST_MINTED_SLEEPING_RECORD_NOTICE_TEXT
    })
  })

  it('does nothing for SELF_RESUME_CALLER or UNRECORDED', () => {
    expect(resolveLaunchAdmissionNoticeAction('daemon-death', 'SELF_RESUME_CALLER')).toEqual({
      kind: 'none'
    })
    expect(resolveLaunchAdmissionNoticeAction('daemon-death', 'UNRECORDED')).toEqual({
      kind: 'none'
    })
  })

  it('does nothing when the pane has no record, or a record of a different origin', () => {
    expect(resolveLaunchAdmissionNoticeAction(undefined, 'HOST_RESUME')).toEqual({ kind: 'none' })
    expect(resolveLaunchAdmissionNoticeAction('quit', 'HOST_RESUME')).toEqual({ kind: 'none' })
    expect(resolveLaunchAdmissionNoticeAction('worktree-sleep', 'HOST_MINTED')).toEqual({
      kind: 'none'
    })
    expect(resolveLaunchAdmissionNoticeAction('live', 'HOST_RESUME')).toEqual({ kind: 'none' })
  })
})
