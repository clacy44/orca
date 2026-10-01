import {
  backgroundSessionDropCapChars,
  backgroundSessionKeepTailChars,
  dropOldestQueuedForSession,
  type PendingStreamDataBatch
} from './daemon-stream-keep-tail-drop'

export function evaluateDroppableEnqueue(
  batch: PendingStreamDataBatch,
  sessionId: string,
  queuedBefore: number,
  queuedAfter: number,
  isSessionDroppable: (sessionId: string) => boolean,
  salvageDroppedData: (dropped: string) => string
): void {
  let sessionDroppable: boolean
  if (queuedBefore <= 0) {
    sessionDroppable = isSessionDroppable(sessionId)
    if (queuedAfter > 0 && sessionDroppable) {
      batch.droppableQueuedSessionIds.add(sessionId)
    } else {
      batch.droppableQueuedSessionIds.delete(sessionId)
    }
  } else {
    sessionDroppable = batch.droppableQueuedSessionIds.has(sessionId)
  }
  if (!sessionDroppable) {
    return
  }

  const droppableQueued = batch.droppableQueuedSessionIds.size
  const dropCap = backgroundSessionDropCapChars(droppableQueued)
  const keepTail = backgroundSessionKeepTailChars(droppableQueued)
  if (queuedAfter > dropCap) {
    dropOldestQueuedForSession(batch, sessionId, keepTail, salvageDroppedData)
  }
  if (droppableQueued > (batch.lastEvaluatedDroppableSessionCount ?? 0)) {
    // Shared budget tightened, so producers that stopped enqueueing must also be re-trimmed.
    for (const [queuedSessionId, queued] of Array.from(batch.queuedCharsBySession)) {
      if (
        queued > dropCap &&
        queuedSessionId !== sessionId &&
        batch.droppableQueuedSessionIds.has(queuedSessionId)
      ) {
        dropOldestQueuedForSession(batch, queuedSessionId, keepTail, salvageDroppedData)
      }
    }
  }
  batch.lastEvaluatedDroppableSessionCount = droppableQueued
}

export function refreshDroppableSessionMembership(
  batches: Iterable<PendingStreamDataBatch>,
  sessionId: string,
  droppable: boolean
): void {
  for (const batch of batches) {
    if ((batch.queuedCharsBySession.get(sessionId) ?? 0) > 0 && droppable) {
      batch.droppableQueuedSessionIds.add(sessionId)
    } else {
      batch.droppableQueuedSessionIds.delete(sessionId)
    }
  }
}

/** W2 heap shed: drop every droppable (backgrounded) session's queued bytes across the given batches. */
export function shedDroppableSessionQueues(
  batches: Iterable<PendingStreamDataBatch>,
  isSessionDroppable: (sessionId: string) => boolean,
  salvageDroppedData: (dropped: string) => string
): { sessions: number; droppedChars: number } {
  let sessions = 0
  let droppedChars = 0
  for (const batch of batches) {
    for (const sessionId of batch.queuedCharsBySession.keys()) {
      if (!isSessionDroppable(sessionId)) {
        continue
      }
      const dropped = dropOldestQueuedForSession(batch, sessionId, 0, salvageDroppedData)
      if (dropped > 0) {
        sessions += 1
        droppedChars += dropped
      }
    }
  }
  return { sessions, droppedChars }
}
