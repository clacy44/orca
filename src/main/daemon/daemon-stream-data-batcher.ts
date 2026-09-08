import type { Socket } from 'node:net'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'
import {
  clampToSafeSplitIndex,
  encodeStreamDataEvent,
  writeStreamDataEvents
} from './daemon-stream-data-split'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { DaemonEvent } from './types'
import { appendDaemonStreamData, type DaemonStreamEnqueueOptions } from './daemon-stream-data-entry'
import {
  evaluateDroppableEnqueue,
  refreshDroppableSessionMembership
} from './daemon-stream-droppable-membership'
import {
  createSocketWriteCeilingHold,
  shouldHoldControlEntryOverCeiling,
  SOCKET_WRITE_CEILING_BYTES
} from './daemon-stream-socket-write-ceiling'
import { shouldHoldForShallowSocket } from './daemon-stream-shallow-echo-hold'

type StreamDataClient = {
  streamSocket: Socket | null
}

// 2ms: each chunk waits a half-window here AND again in main's PTY batch; a smaller interval still coalesces bursts while cutting the fixed latency tax (~8ms of the measured ~19ms DSR-under-load latency).
const STREAM_DATA_BATCH_INTERVAL_MS = 2

// R117 FIX 3 hysteresis (D-R164 H1): the PTY-producer pause daemon-server.ts drives off client
// socket depth is a SEPARATE decision from daemon-stream-shallow-echo-hold's own hold-gate.
// Mirrors the reference controller's HIGH/LOW shape (pty-producer-flow-control.ts:8-9,44-64), but
// this 256KB HIGH is composed UNREACHABLE in practice (D-R167 M-1): the shallow gate holds bulk at
// 128KB and a held slice writes at most BULK_WRITE_SLICE_CHARS (64KB below), so the client socket
// peaks around ~192KB — never far enough past LOW to need this HIGH. The pacer therefore engages
// only as the BACKSTOP behind daemon-stream-shallow-echo-hold's 32MB write-through valve
// (heldWriteThrough), not as a socket-depth pacer. Memory stays bounded (~32MB queue +
// SOCKET_WRITE_CEILING_BYTES's 64MB + 128KB × sessions per client). Exported here (not from
// daemon-stream-shallow-echo-hold.ts) because daemon-server.ts already imports from this file.
export const PRODUCER_PAUSE_HIGH_WATERMARK_BYTES = 256 * 1024
export const PRODUCER_PAUSE_LOW_WATERMARK_BYTES = 32 * 1024
// Sliced writes: a coalesced entry can grow to megabytes; writing it whole would re-deepen the socket past the gate in one call.
// Exported: D-R164 M3 test tightens queuedCharsForClient's real bound (keep-tail × sessions + one slice) against this exact value instead of the ceiling override.
export const BULK_WRITE_SLICE_CHARS = 64 * 1024

type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  /** Fires after each non-control-entry stream-socket write with the client and session it wrote
   *  for — the only place backlog grows, so the backpressure pacer checks the client socket's
   *  depth here and pauses/resumes that session's producer. */
  onAfterSocketWrite?: (clientId: string, sessionId: string) => void
  /** True for sessions whose queued output may be keep-tail dropped (main-marked background sessions). */
  isSessionDroppable?: (sessionId: string) => boolean
  /** Test-only override for SOCKET_WRITE_CEILING_BYTES (R117 FIX 1) — production callers omit it. */
  socketWriteCeilingBytes?: number
  /** Carve reply-eliciting query bytes (DSR/DA/DECRQM/OSC probes) out of dropped data — the hidden program blocks on the reply, so they must still be delivered even when their flood is not. */
  salvageDroppedData?: (dropped: string) => string
}

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined
  private maxLineBytes: number
  private onAfterSocketWrite: ((clientId: string, sessionId: string) => void) | undefined
  private isSessionDroppable: (sessionId: string) => boolean
  private salvageDroppedData: (dropped: string) => string
  private holdOverSocketWriteCeiling: ReturnType<typeof createSocketWriteCeilingHold>
  // D-R164 L1: control entries need the same ceiling value the data-entry hold above uses, to hold
  // them over it too (see the flush() control-entry branch).
  private socketWriteCeilingBytes: number

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
    this.onAfterSocketWrite = options.onAfterSocketWrite
    this.isSessionDroppable = options.isSessionDroppable ?? (() => false)
    this.salvageDroppedData = options.salvageDroppedData ?? (() => '')
    this.socketWriteCeilingBytes = options.socketWriteCeilingBytes ?? SOCKET_WRITE_CEILING_BYTES
    this.holdOverSocketWriteCeiling = createSocketWriteCeilingHold(
      this.salvageDroppedData,
      this.socketWriteCeilingBytes
    )
  }

  enqueue(
    clientId: string,
    sessionId: string,
    data: string,
    options: DaemonStreamEnqueueOptions = {}
  ): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    const batch = this.getOrCreateBatch(clientId)
    const queuedAfter = appendDaemonStreamData(batch, sessionId, data, options)
    const queuedBefore = queuedAfter - data.length
    evaluateDroppableEnqueue(
      batch,
      sessionId,
      queuedBefore,
      queuedAfter,
      this.isSessionDroppable,
      this.salvageDroppedData
    )

    if (
      options.flushImmediately === true &&
      this.queuedCharsForSession(batch, sessionId) <=
        (options.flushMaxChars ?? Number.POSITIVE_INFINITY)
    ) {
      this.flushSession(clientId, sessionId)
      return
    }
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  /** Append a pre-shaped stream event at the current position in the session's byte order (scan handoff markers, gaps, transient facts). */
  enqueueControlEvent(clientId: string, sessionId: string, control: DaemonEvent): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }
    const batch = this.getOrCreateBatch(clientId)
    batch.queue.push({ sessionId, data: '', control })
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  refreshSessionDroppability(sessionId: string): void {
    const droppable = this.isSessionDroppable(sessionId)
    refreshDroppableSessionMembership(this.pendingByClient.values(), sessionId, droppable)
  }

  private getOrCreateBatch(clientId: string): PendingStreamDataBatch {
    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = {
        timer: null,
        queue: [],
        queuedChars: 0,
        queuedCharsBySession: new Map(),
        droppableQueuedSessionIds: new Set()
      }
      this.pendingByClient.set(clientId, batch)
    }
    return batch
  }

  queuedCharsForClient(clientId: string): number {
    return this.pendingByClient.get(clientId)?.queuedChars ?? 0
  }

  flush(clientId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    if (batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      // A vanished stream socket drops the batch — the model owns the bytes and reconnect restores from a snapshot.
      this.pendingByClient.delete(clientId)
      return
    }

    const socket = client.streamSocket
    // A session that held an entry must hold all its later entries this pass — writing around a held entry would reorder that session's bytes.
    const heldSessions = new Set<string>()
    const retained: PendingStreamDataBatch['queue'] = []
    const ceiling = this.socketWriteCeilingBytes
    while (batch.queue.length > 0) {
      const entry = batch.queue[0]
      if (entry.control) {
        // Control entries respect the held-session order latch; at ~100B, writing them onto a deep
        // socket is as harmless as the small-session bypass. D-R164 L1: past the hard socket-write
        // ceiling itself, hold most of the rest too (see shouldHoldControlEntryOverCeiling).
        const writableLength = socket.writableLength ?? 0
        const hold = shouldHoldControlEntryOverCeiling(entry.control, writableLength, ceiling)
        if (heldSessions.has(entry.sessionId) || hold) {
          heldSessions.add(entry.sessionId)
          retained.push(entry)
          batch.queue.shift()
          continue
        }
        batch.queue.shift()
        socket.write(encodeNdjson(entry.control))
        this.onAfterSocketWrite?.(clientId, entry.sessionId)
        continue
      }
      // R117 FIX 1 (daemon-stream-socket-write-ceiling.ts): the socket's own OS write buffer, not
      // just this batcher's queue, is what actually grows unbounded — hold this pass and trim.
      const writableLength = socket.writableLength ?? 0
      if (this.holdOverSocketWriteCeiling(batch, entry, writableLength, heldSessions, retained)) {
        continue
      }
      // Hold this flooding session's entry; small talkers keep flowing. No timer: a deep socket implies a prior false write(), so 'drain' (routed back to flush) is guaranteed to resume held bulk.
      const sessionHeld = batch.queuedCharsBySession.get(entry.sessionId) ?? 0
      const alreadyHeld = heldSessions.has(entry.sessionId)
      if (shouldHoldForShallowSocket(writableLength, batch.queuedChars, sessionHeld, alreadyHeld)) {
        heldSessions.add(entry.sessionId)
        retained.push(entry)
        batch.queue.shift()
        continue
      }
      const end =
        entry.transformed || entry.data.length <= BULK_WRITE_SLICE_CHARS
          ? entry.data.length
          : clampToSafeSplitIndex(entry.data, 0, BULK_WRITE_SLICE_CHARS)
      const slice = entry.data.slice(0, end)
      const entrySequenceChars = entry.sequenceChars ?? entry.data.length
      const sliceSequenceChars = entry.transformed
        ? entrySequenceChars
        : entrySequenceChars === 0
          ? 0
          : slice.length
      if (end >= entry.data.length) {
        batch.queue.shift()
      } else {
        entry.data = entry.data.slice(end)
        const remainingSequenceChars = entrySequenceChars - sliceSequenceChars
        entry.sequenceChars =
          remainingSequenceChars === entry.data.length ? undefined : remainingSequenceChars
      }
      batch.queuedChars -= slice.length
      const sessionHeldAfter =
        (batch.queuedCharsBySession.get(entry.sessionId) ?? slice.length) - slice.length
      if (sessionHeldAfter <= 0) {
        batch.queuedCharsBySession.delete(entry.sessionId)
        batch.droppableQueuedSessionIds.delete(entry.sessionId)
      } else {
        batch.queuedCharsBySession.set(entry.sessionId, sessionHeldAfter)
      }
      writeStreamDataEvents(
        socket,
        entry.sessionId,
        slice,
        this.maxLineBytes,
        sliceSequenceChars,
        entry.seq,
        entry.transformed
      )
      this.onAfterSocketWrite?.(clientId, entry.sessionId)
    }
    if (retained.length > 0) {
      batch.queue = retained
      // 'drain' only fires when the buffer fully empties (one gate-depth/turn = seconds for multi-MB backlogs); arm a no-op data event whose flush callback re-flushes while bytes are still in flight.
      this.armHeldQueueRefill(socket, clientId, retained[0].sessionId)
      return
    }
    this.pendingByClient.delete(clientId)
  }

  private refillArmedClients = new Set<string>()

  private armHeldQueueRefill(socket: Socket, clientId: string, sessionId: string): void {
    if (this.refillArmedClients.has(clientId) || socket.destroyed) {
      return
    }
    this.refillArmedClients.add(clientId)
    // Must be a real protocol no-op line, not an empty write: an empty write's callback fires immediately, defeating the in-flight re-flush.
    socket.write(encodeStreamDataEvent(sessionId, ''), () => {
      this.refillArmedClients.delete(clientId)
      this.flush(clientId)
    })
  }

  private queuedCharsForSession(batch: PendingStreamDataBatch, sessionId: string): number {
    let chars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        chars += entry.data.length
      }
    }
    return chars
  }

  private flushSession(clientId: string, sessionId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    const flushed: PendingStreamDataBatch['queue'] = []
    const retained: PendingStreamDataBatch['queue'] = []
    let flushedChars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        flushed.push(entry)
        flushedChars += entry.data.length
      } else {
        retained.push(entry)
      }
    }
    if (flushed.length === 0) {
      return
    }

    batch.queue = retained
    batch.queuedChars -= flushedChars
    batch.queuedCharsBySession.delete(sessionId)
    batch.droppableQueuedSessionIds.delete(sessionId)
    if (batch.queue.length === 0) {
      if (batch.timer) {
        clearTimeout(batch.timer)
        batch.timer = null
      }
      this.pendingByClient.delete(clientId)
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    for (const entry of flushed) {
      if (entry.control) {
        client.streamSocket.write(encodeNdjson(entry.control))
        this.onAfterSocketWrite?.(clientId, entry.sessionId)
      } else {
        writeStreamDataEvents(
          client.streamSocket,
          entry.sessionId,
          entry.data,
          this.maxLineBytes,
          entry.sequenceChars ?? entry.data.length,
          entry.seq,
          entry.transformed
        )
        this.onAfterSocketWrite?.(clientId, entry.sessionId)
      }
    }
  }

  clear(clientId?: string): void {
    const batches =
      clientId === undefined
        ? Array.from(this.pendingByClient.entries())
        : [[clientId, this.pendingByClient.get(clientId)] as const]

    for (const [id, batch] of batches) {
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      this.pendingByClient.delete(id)
    }
  }
}
