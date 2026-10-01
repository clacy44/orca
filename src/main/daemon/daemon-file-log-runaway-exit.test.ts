// F2 (G1): the next generation must read a W2 heap exit or a W1 stall abort as such, never as
// clean_shutdown (daemon-log-closed follows daemon_heap_exit) or silent_death.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyPredecessorLogEnd, createDaemonFileLog } from './daemon-file-log'

describe('classifyPredecessorLogEnd on runaway-protection exits', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-file-log-runaway-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not read a daemon_heap_exit followed by the close marker as clean_shutdown', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    log.log('startup')
    log.log('daemon_heap_exit', { ratio: 0.9 })
    log.close()
    expect(classifyPredecessorLogEnd(filePath)).toMatchObject({
      classification: 'heap_pressure_exit',
      lastEvent: 'daemon_heap_exit'
    })
  })

  it('does not read a daemon-stall-abort as silent_death', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    log.log('startup')
    log.log('daemon-event-loop-stall', { stalledMs: 1000 })
    log.log('daemon-stall-abort', { reason: 'rss-growth' })
    expect(classifyPredecessorLogEnd(filePath)).toMatchObject({
      classification: 'stall_abort',
      lastEvent: 'daemon-stall-abort'
    })
  })
})
