export type ProcessTreeRow = {
  pid: number
  ppid: number
  /** Process creation time (epoch ms) when the source reports it; lets a stale parent link be proven. */
  createdAtMs?: number
}

export type ProcessTreeCutBy = 'creation-time' | 'midpoint'

export type ProcessTreeAnomaly = {
  rows: readonly ProcessTreeRow[]
  descendants: readonly ProcessTreeRow[]
  staleEdgesSkipped: number
  /** Length of the ppid cycle through the root, 0 when none. */
  cycleLength: number
  /** Number of the root's ancestors kept before the cut link. */
  cutIndex: number
  cutBy: ProcessTreeCutBy
  fresh: boolean
}

export type ProcessDescendantsResult<Row extends ProcessTreeRow> = {
  descendants: (Row & { depth: number })[]
  /** Parent links ignored: child older than its parent, or pointing at the root, an ancestor or a visited row. */
  staleEdgesSkipped: number
  cycleLength: number
  cutIndex: number
  cutBy: ProcessTreeCutBy
}

// Why: Win32 ParentProcessId can name a parent that already exited, and PIDs get reused, so the
// table can contain a cycle (an ancestor "child of" its own descendant). An unguarded walk then
// never ends and retains everything it allocates (R314 heap runaway).
export function collectProcessDescendants<Row extends ProcessTreeRow>(
  rows: readonly Row[],
  rootPid: number
): ProcessDescendantsResult<Row> {
  const rowsByPid = new Map<number, Row>()
  for (const row of rows) {
    if (!rowsByPid.has(row.pid)) {
      rowsByPid.set(row.pid, row)
    }
  }
  // Why: a parent is always created before its child, so a child older than the row now holding
  // its parent's PID proves that PID was recycled and the link is stale.
  const isOlderThanParent = (row: Row): boolean => {
    const parent = rowsByPid.get(row.ppid)
    return (
      row.createdAtMs !== undefined &&
      parent?.createdAtMs !== undefined &&
      row.createdAtMs < parent.createdAtMs
    )
  }

  const childrenByParent = new Map<number, Row[]>()
  let staleEdgesSkipped = 0
  let creationTimeCuts = 0
  for (const row of rows) {
    if (row.pid === rootPid) {
      continue
    }
    if (isOlderThanParent(row)) {
      staleEdgesSkipped += 1
      creationTimeCuts += 1
      continue
    }
    const children = childrenByParent.get(row.ppid)
    if (children) {
      children.push(row)
    } else {
      childrenByParent.set(row.ppid, [row])
    }
  }

  const upWalk = walkUpFromRoot(rowsByPid, rootPid, rows.length, isOlderThanParent)
  const ancestors = new Set(upWalk.ancestors)
  const visited = new Set<number>([rootPid])
  const descendants: (Row & { depth: number })[] = []
  const stack: { row: Row; depth: number }[] = []
  const pushChildren = (parentPid: number, depth: number): void => {
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (visited.has(child.pid) || ancestors.has(child.pid)) {
        staleEdgesSkipped += 1
        continue
      }
      visited.add(child.pid)
      stack.push({ row: child, depth })
    }
  }
  pushChildren(rootPid, 1)
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    pushChildren(row.pid, depth + 1)
  }
  return {
    descendants,
    staleEdgesSkipped,
    cycleLength: upWalk.cycleLength,
    cutIndex: upWalk.ancestors.length,
    cutBy: upWalk.usedMidpoint || creationTimeCuts === 0 ? 'midpoint' : 'creation-time'
  }
}

function walkUpFromRoot<Row extends ProcessTreeRow>(
  rowsByPid: ReadonlyMap<number, Row>,
  rootPid: number,
  maxSteps: number,
  isOlderThanParent: (row: Row) => boolean
): { ancestors: number[]; cycleLength: number; usedMidpoint: boolean } {
  const chain: number[] = []
  const seen = new Set<number>([rootPid])
  const rootRow = rowsByPid.get(rootPid)
  let child = rootRow
  let current = rowsByPid.get(rootRow?.ppid ?? Number.NaN)
  let cutByCreationTime = false
  while (child && current && !seen.has(current.pid) && chain.length < maxSteps) {
    if (isOlderThanParent(child)) {
      cutByCreationTime = true
      break
    }
    chain.push(current.pid)
    seen.add(current.pid)
    child = current
    current = rowsByPid.get(current.ppid)
  }
  if (!cutByCreationTime && child && current && isOlderThanParent(child)) {
    cutByCreationTime = true
  }
  if (cutByCreationTime) {
    // Why: the raw cycle length (ignoring ages) only feeds diagnostics.
    return {
      ancestors: chain,
      cycleLength: rawCycleLength(rowsByPid, rootPid, maxSteps),
      usedMidpoint: false
    }
  }
  // Why: a chain that returns to the root is a cycle, and without creation times ppid alone cannot say which
  // link is stale. Each member belongs to whichever side of the root it is nearer; the midpoint link is cut.
  const closesOnRoot = child !== undefined && current?.pid === rootPid
  if (!closesOnRoot) {
    return { ancestors: chain, cycleLength: 0, usedMidpoint: false }
  }
  const ancestorCount = Math.floor((chain.length + 1) / 2)
  return {
    ancestors: chain.slice(0, ancestorCount),
    cycleLength: chain.length + 1,
    usedMidpoint: true
  }
}

function rawCycleLength<Row extends ProcessTreeRow>(
  rowsByPid: ReadonlyMap<number, Row>,
  rootPid: number,
  maxSteps: number
): number {
  const seen = new Set<number>([rootPid])
  let steps = 0
  let current = rowsByPid.get(rowsByPid.get(rootPid)?.ppid ?? Number.NaN)
  while (current && steps < maxSteps) {
    if (current.pid === rootPid) {
      return steps + 1
    }
    if (seen.has(current.pid)) {
      return 0
    }
    seen.add(current.pid)
    steps += 1
    current = rowsByPid.get(current.ppid)
  }
  return 0
}
