// W2 (D-26b): shedding pending output flags overflow so the next take falls back to one full snapshot.
import { afterEach, describe, expect, it } from 'vitest'
import { Session } from './session'

function createMockSubprocess() {
  let onData: ((data: string) => void) | null = null
  return {
    pid: 12345,
    getForegroundProcess: (): string | null => null,
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill() {},
    forceKill() {},
    signal(_sig: string) {},
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(_cb: (code: number) => void) {},
    dispose() {},
    simulateData(data: string) {
      onData?.(data)
    }
  }
}

let session: Session | null = null
afterEach(() => {
  session?.dispose()
  session = null
})

describe('Session.shedPendingOutput', () => {
  it('drops queued records, sets overflow and reports the bytes freed', () => {
    const subprocess = createMockSubprocess()
    session = new Session({
      sessionId: 'shed-test',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: false
    })
    subprocess.simulateData('hello world')

    expect(session.shedPendingOutput()).toBeGreaterThan(0)
    expect(session.pendingOutputByteCount).toBe(0)
    const take = session.takePendingOutput(false)
    expect(take?.overflowed).toBe(true)
    expect(take?.records).toEqual([])
  })

  it('leaves a session with nothing pending untouched', () => {
    session = new Session({
      sessionId: 'shed-empty',
      cols: 80,
      rows: 24,
      subprocess: createMockSubprocess(),
      shellReadySupported: false
    })
    expect(session.shedPendingOutput()).toBe(0)
    expect(session.takePendingOutput(false)?.overflowed).toBe(false)
  })
})
