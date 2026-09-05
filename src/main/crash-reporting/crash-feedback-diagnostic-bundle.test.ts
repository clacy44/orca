// H18 (10k-2, Ruling 35 Addendum 4, Gate-3 condition D-V4): the crash-feedback route builds
// its own upload attachment independently of the diagnostics-upload leg (ipc/diagnostics.ts),
// so it must strip the daemon stderr tail itself before the attachment is POSTed to the
// vendor feedback endpoint (ipc/feedback.ts). This suite proves that leg does the stripping.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDiagnosticsStatusMock, collectDiagnosticBundleMock, resolveDiagnosticOrcaChannelMock } =
  vi.hoisted(() => ({
    getDiagnosticsStatusMock: vi.fn(),
    collectDiagnosticBundleMock: vi.fn(),
    resolveDiagnosticOrcaChannelMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3-test' }
}))

vi.mock('../observability', () => ({
  collectDiagnosticBundle: collectDiagnosticBundleMock,
  getDiagnosticsStatus: getDiagnosticsStatusMock
}))

vi.mock('../observability/diagnostic-upload-endpoint', () => ({
  resolveDiagnosticOrcaChannel: resolveDiagnosticOrcaChannelMock
}))

import { prepareCrashDiagnosticBundle } from './crash-feedback-diagnostic-bundle'

// Same fixture shape as observability/bundle.test.ts's B3 (H17) strip test: the tail is
// nested inside `attributes` (here `breadcrumb.data`), not a top-level field.
function makeSpanLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'effect-span',
    name: 'crash.breadcrumb',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    kind: 'internal',
    startTimeUnixNano: '0',
    endTimeUnixNano: '1',
    durationMs: 1,
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': 'daemon_lifecycle',
      'breadcrumb.data': {
        daemonStderrTail_stack: 'FATAL ERROR: JavaScript heap out of memory'
      }
    },
    events: [],
    exit: { _tag: 'Success' },
    ...overrides
  })
}

describe('prepareCrashDiagnosticBundle', () => {
  beforeEach(() => {
    getDiagnosticsStatusMock.mockReset()
    collectDiagnosticBundleMock.mockReset()
    resolveDiagnosticOrcaChannelMock.mockReset()
    getDiagnosticsStatusMock.mockReturnValue({
      localFileEnabled: true,
      bundleEnabled: true,
      traceFilePath: '/tmp/main.trace.ndjson',
      traceFamilySize: 1
    })
    resolveDiagnosticOrcaChannelMock.mockReturnValue('dev')
  })

  it('H18: the feedback attachment carries the stripped payload, not the daemon stderr tail', () => {
    const header = JSON.stringify({ type: 'bundle-header', bundle_submission_id: 'sub-id-1' })
    const spanLine = makeSpanLine()
    const payload = `${header}\n${spanLine}\n`
    collectDiagnosticBundleMock.mockReturnValue({
      bundleSubmissionId: 'sub-id-1',
      payload,
      bytes: Buffer.byteLength(payload, 'utf8'),
      spanCount: 1
    })

    const attachment = prepareCrashDiagnosticBundle(true)

    const feedbackAttachment = attachment.feedbackDiagnosticBundle
    expect(feedbackAttachment).toBeDefined()
    if (!feedbackAttachment) {
      throw new Error('expected feedbackDiagnosticBundle to be set')
    }

    // The tail never leaves the box via this route.
    expect(feedbackAttachment.content).not.toContain('FATAL ERROR: JavaScript heap out of memory')
    expect(feedbackAttachment.content).toContain('[local-only]')

    // `bytes` describes the content actually attached (the stripped string), not the
    // original collected payload's byte length.
    expect(feedbackAttachment.bytes).toBe(Buffer.byteLength(feedbackAttachment.content, 'utf8'))
    expect(feedbackAttachment.bytes).not.toBe(Buffer.byteLength(payload, 'utf8'))

    // spanCount is unaffected — stripping replaces values, it never removes spans.
    expect(feedbackAttachment.spanCount).toBe(1)
    expect(feedbackAttachment.content.split('\n').length).toBe(payload.split('\n').length)

    // Non-attachment fields are unchanged: the local/status side of the bundle keeps the
    // original unstripped byte count exactly as today.
    expect(attachment.diagnosticBundle).toEqual({
      status: 'attached',
      bundleSubmissionId: 'sub-id-1',
      bytes: Buffer.byteLength(payload, 'utf8'),
      spanCount: 1
    })
    expect(feedbackAttachment.bundleSubmissionId).toBe('sub-id-1')
  })
})
