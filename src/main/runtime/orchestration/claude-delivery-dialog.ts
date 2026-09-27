// [I-24-1 S-24-1; G1-10z4 A2-B1, A2-B2] Claude Code's own dialogs, recognised for the pointer
// delivery gate on principled signals only (orca-runtime.ts: claudeDeliveryDialogBlocks before the
// pointer and before the delayed Enter on every delivery path, detectDeliveryBlockedModal on the
// mid-turn and R2 paths). Pure and file-local — no orca-runtime.ts import, same convention as
// delivery-starvation.ts and launch-prompt-fence.ts.
//
// Two independent signals, each sufficient to withhold:
//  (i)  the pane's newest Claude hook row is `waiting`/`blocked` (PermissionRequest,
//       AskUserQuestion) AND it was received at or after the pane's latest live Claude prompt
//       title. A row older than that title was superseded by Claude itself returning to its own
//       prompt, so it is stale and must not block: a `waiting` row is sticky (nothing clears it
//       after an Esc), and blocking on it forever re-created the starvation this gate exists to
//       end (A2-B1 Q4). No prompt title observed yet (e.g. just after a main restart) means the
//       row cannot be shown stale, so it blocks.
//  (ii) the current screen shows a Claude select menu: a row that STARTS (after whitespace or a
//       box border) with the ❯ cursor followed by `<digits>.`, with a second numbered option row
//       within CLAUDE_MENU_SIBLING_WINDOW_ROWS rows of it on either side (the cursor may sit on the
//       last option) — or one of the two observed exact phrases: the question menu's
//       "Enter to select" footer and the folder-trust dialog's unnumbered "Yes, I trust this folder"
//       option. A bare `>` never counts: Claude renders transcript prompts, code and version
//       arrows with it (A2-B1).
// Before (ii) runs, every whitespace-insensitive occurrence of a FULL pointer line the runtime
// itself wrote is blanked out of the screen (maskEchoedPointerLines): Claude echoes typed input,
// so a sender-chosen subject would otherwise let the host's own pointer trip the check and strand
// every later delivery (A2-B2). The mask needs the whole framed line (`[from: …] "…" thread:…`, or
// a host-constant footer), so a real dialog row can never be blanked by a subject that merely
// repeats its text.

export const CLAUDE_MENU_SIBLING_WINDOW_ROWS = 6

/** How long the delayed Enter is held (re-checked every submit delay) while a Claude dialog covers
 *  the composer the pointer was typed into. A dialog answered inside the hold gets the pointer
 *  submitted after it; one that outlasts it ends the delivery withheld and rolled back (the
 *  pointer text then stays unsubmitted in the composer — see orca-runtime.ts's Enter timer). */
export const DELIVERY_ENTER_HOLD_MAX_MS = 30_000

const SELECTED_OPTION_ROW_RE = /^[\s│┃]*❯\s*\d+\./
const OPTION_ROW_RE = /^[\s│┃]*\d+\.\s+\S/
const EXACT_PHRASE_RES = [/enter\s+to\s+select/i, /yes,\s+i\s+trust\s+this\s+folder/i]
// Whitespace and the vertical box borders Claude draws round its composer: dropped from both the
// screen and the pointer before matching, so a wrapped or boxed echo still matches its line.
const MATCH_IGNORED_UNIT_RE = /[\s│┃]/

/** How many recently written pointer lines are kept per pty for masking — a few screens' worth of
 *  pointers (at most three message lines plus framing each), bounded so a long-lived pane never
 *  accumulates an unbounded mask. */
export const RECENT_POINTER_LINES_MAX = 24

/** The non-empty, trimmed lines of a pointer payload as the runtime wrote it. */
export function pointerLinesOf(payload: string): string[] {
  return payload
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** `previous` with `lines` appended (a line already kept moves to the end), capped to the newest
 *  RECENT_POINTER_LINES_MAX. */
export function appendRecentPointerLines(
  previous: readonly string[] | undefined,
  lines: readonly string[]
): string[] {
  const kept = (previous ?? []).filter((line) => !lines.includes(line))
  return [...kept, ...lines].slice(-RECENT_POINTER_LINES_MAX)
}

function matchKey(text: string): string {
  let key = ''
  for (const unit of text) {
    if (!MATCH_IGNORED_UNIT_RE.test(unit)) {
      key += unit
    }
  }
  return key
}

/** Blanks every occurrence of a full `pointerLines` entry in `rows`, matching with whitespace and
 *  box borders ignored (so a line wrapped across rows, or drawn inside a border, still matches).
 *  Characters outside a full-line occurrence are never touched. */
export function maskEchoedPointerLines(
  rows: readonly string[],
  pointerLines: readonly string[]
): string[] {
  const keys = [...new Set(pointerLines.map(matchKey))].filter((key) => key.length > 0)
  if (keys.length === 0) {
    return [...rows]
  }
  // One flat string of the kept UTF-16 units, with each unit's origin, so an index from indexOf
  // maps straight back to a row and column.
  let flat = ''
  const originRow: number[] = []
  const originCol: number[] = []
  rows.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col += 1) {
      const unit = row[col] as string
      if (!MATCH_IGNORED_UNIT_RE.test(unit)) {
        flat += unit
        originRow.push(rowIndex)
        originCol.push(col)
      }
    }
  })
  const masked = rows.map((row) => row.split(''))
  for (const key of keys) {
    let from = 0
    for (let at = flat.indexOf(key, from); at !== -1; at = flat.indexOf(key, from)) {
      for (let k = at; k < at + key.length; k += 1) {
        const rowUnits = masked[originRow[k] as number] as string[]
        rowUnits[originCol[k] as number] = ' '
      }
      from = at + key.length
    }
  }
  return masked.map((units) => units.join(''))
}

/** Signal (ii) — see the file comment. `rows` should already be masked. */
export function isClaudeDialogOnScreen(rows: readonly string[]): boolean {
  for (let i = 0; i < rows.length; i += 1) {
    if (!SELECTED_OPTION_ROW_RE.test(rows[i] as string)) {
      continue
    }
    const first = Math.max(0, i - CLAUDE_MENU_SIBLING_WINDOW_ROWS)
    const last = Math.min(rows.length - 1, i + CLAUDE_MENU_SIBLING_WINDOW_ROWS)
    for (let j = first; j <= last; j += 1) {
      if (j !== i && OPTION_ROW_RE.test(rows[j] as string)) {
        return true
      }
    }
  }
  const text = rows.join('\n')
  return EXACT_PHRASE_RES.some((re) => re.test(text))
}

/** The one shape signal (i) needs off a hook snapshot row (a subset of AgentStatusIpcPayload). */
export type ClaudeDialogHookRow = {
  readonly paneKey: string | null
  readonly agentType?: string
  readonly state: string
  readonly receivedAt: number | null
}

/** Signal (i) — see the file comment. `lastClaudePromptTitleAt` is the epoch ms of the pane's
 *  latest live Claude prompt title in this runtime, or null when none was observed. */
export function isClaudeHookDialogPending(
  rows: readonly ClaudeDialogHookRow[],
  paneKey: string | null,
  lastClaudePromptTitleAt: number | null
): boolean {
  if (!paneKey) {
    return false
  }
  let newest: ClaudeDialogHookRow | undefined
  for (const row of rows) {
    if (row.paneKey !== paneKey || row.agentType !== 'claude') {
      continue
    }
    if (!newest || (row.receivedAt ?? 0) > (newest.receivedAt ?? 0)) {
      newest = row
    }
  }
  if (!newest || (newest.state !== 'waiting' && newest.state !== 'blocked')) {
    return false
  }
  return lastClaudePromptTitleAt === null || (newest.receivedAt ?? 0) >= lastClaudePromptTitleAt
}
