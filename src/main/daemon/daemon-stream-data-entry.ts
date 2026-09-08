import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'

// R117 FIX 2: mirrors session.ts:667's 64KB coalesce cap — an uncapped coalesce lets a single
// entry fuse an entire 32MB HELD_WRITE_THROUGH backlog, forcing a rope-flatten on drain (measured
// 24ms + a 32MB transient vs ~0ms capped) and making queuedCharsForSession effectively O(queue).
const COALESCE_MAX_CHARS = 64 * 1024

export type DaemonStreamEnqueueOptions = {
  flushImmediately?: boolean
  flushMaxChars?: number
  rawLength?: number
  transformed?: boolean
  seq?: number
}

export function appendDaemonStreamData(
  batch: PendingStreamDataBatch,
  sessionId: string,
  data: string,
  options: DaemonStreamEnqueueOptions
): number {
  const last = batch.queue.at(-1)
  // Why: control and transformed spans mark indivisible source-stream positions.
  if (
    last?.sessionId === sessionId &&
    !last.control &&
    !last.transformed &&
    options.transformed !== true &&
    last.data.length < COALESCE_MAX_CHARS
  ) {
    last.data += data
    const rawLengthBefore = last.sequenceChars ?? last.data.length - data.length
    const combinedRawLength = rawLengthBefore + (options.rawLength ?? data.length)
    last.sequenceChars = combinedRawLength === last.data.length ? undefined : combinedRawLength
    last.seq = options.seq
  } else {
    batch.queue.push({
      sessionId,
      data,
      ...(options.rawLength === undefined || options.rawLength === data.length
        ? {}
        : { sequenceChars: options.rawLength }),
      ...(options.transformed ? { transformed: true } : {}),
      ...(options.seq === undefined ? {} : { seq: options.seq })
    })
  }
  batch.queuedChars += data.length
  const queuedAfter = (batch.queuedCharsBySession.get(sessionId) ?? 0) + data.length
  batch.queuedCharsBySession.set(sessionId, queuedAfter)
  return queuedAfter
}
