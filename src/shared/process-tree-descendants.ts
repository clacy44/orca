export type ProcessTreeRow = { pid: number; ppid: number }

export type ProcessTreeAnomaly = {
  rows: readonly ProcessTreeRow[]
  descendants: readonly ProcessTreeRow[]
  staleEdgesSkipped: number
  fresh: boolean
}

export type ProcessDescendantsResult<Row extends ProcessTreeRow> = {
  descendants: (Row & { depth: number })[]
  /** Parent links ignored because they pointed at the root, an ancestor or an already-visited row. */
  staleEdgesSkipped: number
}

// Why: Win32 ParentProcessId can name a parent that already exited, and PIDs get reused, so the
// table can contain a cycle (an ancestor "child of" its own descendant). An unguarded walk then
// never ends and retains everything it allocates (R314 heap runaway).
export function collectProcessDescendants<Row extends ProcessTreeRow>(
  rows: readonly Row[],
  rootPid: number
): ProcessDescendantsResult<Row> {
  const childrenByParent = new Map<number, Row[]>()
  const rowsByPid = new Map<number, Row>()
  for (const row of rows) {
    if (!rowsByPid.has(row.pid)) {
      rowsByPid.set(row.pid, row)
    }
    if (row.pid === rootPid) {
      continue
    }
    const children = childrenByParent.get(row.ppid)
    if (children) {
      children.push(row)
    } else {
      childrenByParent.set(row.ppid, [row])
    }
  }

  const ancestors = collectRootAncestors(rowsByPid, rootPid, rows.length)
  const visited = new Set<number>([rootPid])
  let staleEdgesSkipped = 0
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
  return { descendants, staleEdgesSkipped }
}

function collectRootAncestors<Row extends ProcessTreeRow>(
  rowsByPid: ReadonlyMap<number, Row>,
  rootPid: number,
  maxSteps: number
): Set<number> {
  const chain: number[] = []
  const seen = new Set<number>([rootPid])
  let current = rowsByPid.get(rowsByPid.get(rootPid)?.ppid ?? Number.NaN)
  while (current && !seen.has(current.pid) && chain.length < maxSteps) {
    chain.push(current.pid)
    seen.add(current.pid)
    current = rowsByPid.get(current.ppid)
  }
  // Why: a chain that returns to the root is a cycle, and ppid alone cannot say which link is stale.
  // Each member belongs to whichever side of the root it is nearer; the midpoint link is cut.
  const closesOnRoot = current?.pid === rootPid
  const ancestorCount = closesOnRoot ? Math.floor((chain.length + 1) / 2) : chain.length
  return new Set(chain.slice(0, ancestorCount))
}
