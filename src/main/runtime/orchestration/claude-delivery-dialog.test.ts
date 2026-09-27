import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MENU_SIBLING_WINDOW_ROWS,
  RECENT_POINTER_LINES_MAX,
  appendRecentPointerLines,
  isClaudeDialogOnScreen,
  isClaudeHookDialogPending,
  maskEchoedPointerLines,
  pointerLinesOf,
  type ClaudeDialogHookRow
} from './claude-delivery-dialog'

// Observed Claude Code v2.1.283 dialog shapes (I-24-1 brief b1) and the G1 P3 variants.
const PERMISSION_PROMPT = [
  'Bash command',
  '  rm -rf build',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again",
  '  3. No (esc)'
]
const CURSOR_ON_LAST_OPTION = [
  'Do you want to proceed?',
  '  1. Yes',
  "  2. Yes, and don't ask again",
  '❯ 3. No, and tell Claude what to do differently (esc)'
]
const BOXED_PROMPT = [
  '╭──────────────────────────╮',
  '│ Do you want to proceed?  │',
  '│ ❯ 1. Yes                 │',
  '│   2. No                  │',
  '╰──────────────────────────╯'
]
const QUESTION_MENU = [
  '☐ Command intent',
  "❯ 1. It's safe/reversible — go ahead",
  '  2. Stop and ask me',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
]
const TRUST_DIALOG = [
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ No, exit',
  '  Yes, I trust this folder'
]
// A host-constant pointer framing line (formatter.ts) standing in for any footer.
const FOOTER_LINE = '[delivered while busy — your pane never reported idle]'

describe('signal (ii): a ❯-led numbered option row with a sibling option row, or an exact phrase', () => {
  it.each([
    ['permission prompt, cursor on option 1', PERMISSION_PROMPT],
    ['cursor on the LAST option (sibling rows above it)', CURSOR_ON_LAST_OPTION],
    ['a boxed prompt (rows start with a border glyph)', BOXED_PROMPT],
    ['the question menu', QUESTION_MENU],
    ['the unnumbered folder-trust dialog (exact phrase)', TRUST_DIALOG],
    ['"Enter to select" wrapped across two rows', ['press Enter to', 'select · Esc to cancel']]
  ])('a real dialog is recognised: %s', (_name, rows) => {
    expect(isClaudeDialogOnScreen(rows)).toBe(true)
  })

  it.each([
    [
      "A2-B1: the owner's numbered prompt echoed with Claude's `>` prefix",
      ['> 1. refactor the parser', '  2. add tests', '⏺ Both done; tests pass.', '> ']
    ],
    [
      'A2-B1: code in a reply',
      ['⏺ Changed the threshold:', '    if (ratio > 0.5) {', '      return retry()', '    }']
    ],
    ['A2-B1: a version arrow', ['⏺ Bumped lodash 4.17.20 -> 4.17.21 and reran the suite.', '> ']],
    ['a lone ❯ numbered row with no sibling option row', ['❯ 1. only one', 'plain text', '> ']],
    ['❯ in the middle of a line', ['status: ok ❯ 1. next', '  2. other']],
    ['A2-B2: a subject carrying `> 2.`', ['> [from: agent-7] "p95 > 2.5s regression" thread:none']],
    ['"do you want to" prose without a menu', ['⏺ Do you want to merge this now?', '> ']]
  ])('ordinary screen text is not a dialog: %s', (_name, rows) => {
    expect(isClaudeDialogOnScreen(rows)).toBe(false)
  })

  it(`the sibling option row must be within ${CLAUDE_MENU_SIBLING_WINDOW_ROWS} rows`, () => {
    const gap = Array.from({ length: CLAUDE_MENU_SIBLING_WINDOW_ROWS }, (_, i) => `note ${i}`)
    expect(isClaudeDialogOnScreen(['❯ 1. Yes', ...gap.slice(1), '  2. No'])).toBe(true)
    expect(isClaudeDialogOnScreen(['❯ 1. Yes', ...gap, '  2. No'])).toBe(false)
  })
})

describe('Y-window-1: the sibling option row window is six rows, on either side', () => {
  const rowsWithSiblingAt = (offset: number): string[] => {
    const notes = Array.from({ length: Math.abs(offset) - 1 }, (_, i) => `note ${i}`)
    return offset > 0 ? ['❯ 1. Yes', ...notes, '  2. No'] : ['  1. Yes', ...notes, '❯ 2. No']
  }

  it.each([6, -6])('a sibling option row %i rows from the ❯ row counts', (offset) => {
    expect(isClaudeDialogOnScreen(rowsWithSiblingAt(offset))).toBe(true)
  })

  it.each([7, -7])('a sibling option row %i rows from the ❯ row does not', (offset) => {
    expect(isClaudeDialogOnScreen(rowsWithSiblingAt(offset))).toBe(false)
  })
})

describe('signal (iii): the host masks its own pointer lines, and only whole lines', () => {
  const trustSubjectLine = '[from: agent-7] "do you trust this folder layout?" thread:none'
  const selectSubjectLine = '[from: agent-7] "Enter to select the build target" thread:none'

  it('A2-B2: an echoed pointer line is blanked, so its subject cannot trip a phrase marker', () => {
    const screen = ['⏺ Done.', `> ${selectSubjectLine}`, `  ${FOOTER_LINE}`]
    expect(isClaudeDialogOnScreen(screen)).toBe(true)
    const masked = maskEchoedPointerLines(
      screen,
      pointerLinesOf(`\n${selectSubjectLine}\n${FOOTER_LINE}\n`)
    )
    expect(isClaudeDialogOnScreen(masked)).toBe(false)
    expect(masked[0]).toBe('⏺ Done.')
    expect(masked[1]?.trim()).toBe('>')
    expect(masked[2]?.trim()).toBe('')
  })

  it('a pointer line wrapped across rows and drawn inside a border is still blanked', () => {
    const screen = ['│ > [from: agent-7] "Enter to │', '│   select the build target" thread:none │']
    const masked = maskEchoedPointerLines(screen, [selectSubjectLine])
    expect(masked.join('').replace(/[\s│>]/g, '')).toBe('')
  })

  it('a subject that repeats a real dialog row never blanks that row (no shadowing)', () => {
    const shadowLine = '[from: agent-7] "Yes, I trust this folder" thread:none'
    const masked = maskEchoedPointerLines(TRUST_DIALOG, [shadowLine, trustSubjectLine])
    expect(masked).toEqual(TRUST_DIALOG)
    expect(isClaudeDialogOnScreen(masked)).toBe(true)
  })

  it('a truncated echo (not the whole line) is left alone', () => {
    const screen = ['> [from: agent-7] "Enter to select the build…']
    expect(maskEchoedPointerLines(screen, [selectSubjectLine])).toEqual(screen)
  })

  it('no pointer lines leaves the screen as it was', () => {
    expect(maskEchoedPointerLines(PERMISSION_PROMPT, [])).toEqual(PERMISSION_PROMPT)
  })
})

describe('signal (i): a waiting/blocked Claude row blocks only if not older than the latest prompt title', () => {
  const row = (
    state: string,
    receivedAt: number,
    extra: Partial<ClaudeDialogHookRow> = {}
  ): ClaudeDialogHookRow => ({ paneKey: 'tab:1', agentType: 'claude', state, receivedAt, ...extra })

  it('A2-B1 Q4: a waiting row older than the latest live prompt title is stale and does not block', () => {
    expect(isClaudeHookDialogPending([row('waiting', 1_000)], 'tab:1', 5_000)).toBe(false)
  })

  it('a waiting or blocked row newer than (or tied with) the latest prompt title blocks', () => {
    expect(isClaudeHookDialogPending([row('waiting', 6_000)], 'tab:1', 5_000)).toBe(true)
    expect(isClaudeHookDialogPending([row('blocked', 6_000)], 'tab:1', 5_000)).toBe(true)
    expect(isClaudeHookDialogPending([row('waiting', 5_000)], 'tab:1', 5_000)).toBe(true)
  })

  it('no prompt title observed yet: a waiting row cannot be shown stale, so it blocks', () => {
    expect(isClaudeHookDialogPending([row('waiting', 1_000)], 'tab:1', null)).toBe(true)
  })

  it('only the NEWEST Claude row for the pane counts', () => {
    expect(
      isClaudeHookDialogPending([row('waiting', 1_000), row('done', 2_000)], 'tab:1', null)
    ).toBe(false)
  })

  it('other panes and other agents never block', () => {
    const otherPane = row('waiting', 9_000, { paneKey: 'tab:2' })
    const otherAgent = row('waiting', 9_000, { agentType: 'codex' })
    expect(isClaudeHookDialogPending([otherPane], 'tab:1', null)).toBe(false)
    expect(isClaudeHookDialogPending([otherAgent], 'tab:1', null)).toBe(false)
    expect(isClaudeHookDialogPending([row('waiting', 9_000)], null, null)).toBe(false)
  })
})

describe('recent pointer lines', () => {
  it('appends, moves a repeated line to the end, and keeps only the newest lines', () => {
    expect(appendRecentPointerLines(['a', 'b'], ['a', 'c'])).toEqual(['b', 'a', 'c'])
    const many = Array.from({ length: RECENT_POINTER_LINES_MAX + 5 }, (_, i) => `l${i}`)
    const kept = appendRecentPointerLines(undefined, many)
    expect(kept).toHaveLength(RECENT_POINTER_LINES_MAX)
    expect(kept.at(-1)).toBe(`l${RECENT_POINTER_LINES_MAX + 4}`)
  })

  it('pointerLinesOf drops the blank framing lines of a payload', () => {
    expect(pointerLinesOf(`\n[from: x] "s" thread:none\n${FOOTER_LINE}\n`)).toEqual([
      '[from: x] "s" thread:none',
      FOOTER_LINE
    ])
  })
})
