import { describe, expect, it, vi } from 'vitest'

// H16 (Ruling 35 Addendum 3 R2): collectDiagnosticBundle must never wire
// daemon.stderr.log into the collectBundle() call — that payload is what gets
// uploaded/previewed, and the stderr file is local-only evidence (copied
// beside the preview by ipc/diagnostics.ts instead).

const { collectBundleMock } = vi.hoisted(() => ({
  collectBundleMock: vi.fn((_opts: Record<string, unknown>) => ({
    bundleSubmissionId: 'x'.repeat(22),
    payload: '{"type":"bundle-header"}\n',
    bytes: 25,
    spanCount: 0
  }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-index-test' }
}))

vi.mock('./bundle', () => ({
  collectBundle: collectBundleMock
}))

vi.mock('./diagnostic-bundle-upload', () => ({
  uploadBundle: vi.fn(),
  deleteBundle: vi.fn()
}))

vi.mock('./tracer', () => ({
  setActiveSink: vi.fn()
}))

import { collectDiagnosticBundle } from './index'

describe('collectDiagnosticBundle wiring', () => {
  it('H16: never passes a daemonStderrLogFilePath — the stderr file is local-only, not part of the uploaded/previewed payload', () => {
    collectDiagnosticBundle({
      appVersion: '1.4.186',
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.0',
      orcaChannel: 'dev'
    })

    expect(collectBundleMock).toHaveBeenCalledTimes(1)
    const passedOptions = collectBundleMock.mock.calls[0][0]
    expect(passedOptions).not.toHaveProperty('daemonStderrLogFilePath')
    expect(passedOptions).not.toHaveProperty('daemonStderrLogMaxFiles')
  })
})
