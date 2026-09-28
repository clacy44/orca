// 10z.5 R287 (T9): the caller-resume admission's liveness read on a session holder. True only when
// the delivery gate's own fresh confirm names claude itself; everything else is not live.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const PANE = 'tab1:leaf-holder'
const PTY = 'pty-holder'

type Confirm = ReturnType<typeof vi.fn>

function runtimeWith(options: {
  confirm?: Confirm
  controller?: boolean
  connected?: boolean
}): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  if (options.controller !== false) {
    runtime.setPtyController({
      spawn: vi.fn(),
      write: vi.fn(),
      kill: () => true,
      ...(options.confirm ? { confirmForegroundProcess: options.confirm } : {})
    } as never)
  }
  ;(runtime as unknown as { ptysById: Map<string, unknown> }).ptysById.set(PTY, {
    ptyId: PTY,
    paneKey: PANE,
    connected: options.connected !== false
  })
  return runtime
}

describe('OrcaRuntimeService.confirmClaudeForegroundOnPane', () => {
  it('is true when the confirm names claude', async () => {
    const confirm = vi.fn(async () => 'claude')
    expect(await runtimeWith({ confirm }).confirmClaudeForegroundOnPane(PANE)).toBe(true)
    expect(confirm).toHaveBeenCalledWith(PTY)
  })

  it.each([
    ['a shell', 'zsh'],
    ['a wrapper process', 'node'],
    ['another agent', 'codex'],
    ['a null read', null]
  ])('is false for %s', async (_name, processName) => {
    const confirm = vi.fn(async () => processName)
    expect(await runtimeWith({ confirm }).confirmClaudeForegroundOnPane(PANE)).toBe(false)
  })

  it('is false when the confirm throws', async () => {
    const confirm = vi.fn(async () => {
      throw new Error('read failed')
    })
    expect(await runtimeWith({ confirm }).confirmClaudeForegroundOnPane(PANE)).toBe(false)
  })

  it('is false when the controller has no confirmForegroundProcess', async () => {
    expect(await runtimeWith({}).confirmClaudeForegroundOnPane(PANE)).toBe(false)
  })

  it('is false with no controller at all', async () => {
    expect(await runtimeWith({ controller: false }).confirmClaudeForegroundOnPane(PANE)).toBe(false)
  })

  it('is false, without reading, when the pane has no connected pty', async () => {
    const confirm = vi.fn(async () => 'claude')
    const runtime = runtimeWith({ confirm, connected: false })
    expect(await runtime.confirmClaudeForegroundOnPane(PANE)).toBe(false)
    expect(await runtimeWith({ confirm }).confirmClaudeForegroundOnPane('tab9:leaf-none')).toBe(
      false
    )
    expect(confirm).not.toHaveBeenCalledWith(PTY)
  })
})
