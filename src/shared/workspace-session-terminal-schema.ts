/* Why: the terminal slice of the persisted workspace session — pane layout,
 * per-tab layout snapshot, and the legacy terminal-tab record. Split out of
 * workspace-session-schema.ts to keep that file inside its line budget; the
 * schemas themselves are unchanged. */
import { z } from 'zod'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'
import type { TuiAgent } from './tui-agent'
import { isValidTerminalTabId } from './terminal-tab-id'
import { isTuiAgent } from './tui-agent-config'
import { salvagedOptional, salvagingRecord } from './zod-salvage'

// ─── Terminal pane layout (recursive) ───────────────────────────────

const terminalPaneSplitDirectionSchema = z.enum(['vertical', 'horizontal'])
export const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')

// Why: z.lazy + type annotation keeps the recursive inference working without
// forcing zod to resolve the whole tree at definition time.
const terminalPaneLayoutNodeSchema: z.ZodType<TerminalPaneLayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('leaf'),
      leafId: z.string()
    }),
    z.object({
      type: z.literal('split'),
      direction: terminalPaneSplitDirectionSchema,
      first: terminalPaneLayoutNodeSchema,
      second: terminalPaneLayoutNodeSchema,
      ratio: z.number().optional()
    })
  ])
)

export const leafStringsSchema = salvagingRecord(z.string(), z.string())

export const terminalLayoutSnapshotSchema = z.object({
  root: terminalPaneLayoutNodeSchema.nullable(),
  activeLeafId: z.string().nullable(),
  expandedLeafId: z.string().nullable(),
  ptyIdsByLeafId: salvagedOptional('ptyIdsByLeafId', leafStringsSchema),
  buffersByLeafId: salvagedOptional('buffersByLeafId', leafStringsSchema),
  scrollbackRefsByLeafId: salvagedOptional('scrollbackRefsByLeafId', leafStringsSchema),
  titlesByLeafId: salvagedOptional('titlesByLeafId', leafStringsSchema)
})

// ─── Terminal tab (legacy) ──────────────────────────────────────────

export const terminalTabSchema = z.object({
  id: terminalTabIdSchema,
  ptyId: z.string().nullable(),
  worktreeId: z.string(),
  title: z.string(),
  defaultTitle: z.string().optional(),
  generatedTitle: z.string().nullable().optional(),
  aiVaultTitle: z
    .object({
      agent: z.enum(['claude', 'codex']),
      sessionId: z.string(),
      title: z.string()
    })
    .nullable()
    .optional()
    .catch(undefined),
  quickCommandLabel: z.string().nullable().optional(),
  customTitle: z.string().nullable(),
  color: z.string().nullable(),
  isPinned: z.boolean().optional(),
  sortOrder: z.number(),
  createdAt: z.number(),
  generation: z.number().optional(),
  startupCwd: z.string().min(1).optional(),
  // Why: persist the launched agent so a restored idle agent tab keeps its
  // provider icon before any hook fires. `.catch(undefined)` keeps a stale or
  // unknown agent id from failing the whole-session parse (which would reset
  // every terminal/editor/browser to defaults).
  launchAgent: z
    .custom<TuiAgent>((v) => isTuiAgent(v))
    .optional()
    .catch(undefined)
})
