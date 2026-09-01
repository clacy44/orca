/* Why: the unified tab/tab-group slice of the persisted workspace session.
 * Split out of workspace-session-schema.ts to keep that file inside its line
 * budget; the schemas themselves are unchanged. */
import { z } from 'zod'
import type { TabGroupLayoutNode } from './tab-types'

// ─── Unified tab model ──────────────────────────────────────────────

const tabContentTypeSchema = z.enum([
  'terminal',
  'editor',
  'diff',
  'conflict-review',
  'check-details',
  'browser',
  'simulator'
])

export const workspaceVisibleTabTypeSchema = z.enum(['terminal', 'editor', 'browser', 'simulator'])

export const tabSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  groupId: z.string(),
  worktreeId: z.string(),
  contentType: tabContentTypeSchema,
  label: z.string(),
  generatedLabel: z.string().nullable().optional(),
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
  customLabel: z.string().nullable(),
  color: z.string().nullable(),
  sortOrder: z.number(),
  createdAt: z.number(),
  isPreview: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  // Why: persist the per-tab native-chat view mode so 'chat' survives reload /
  // session restore. `.catch('terminal')` tolerates unknown future values (a
  // newer build that wrote an unrecognized mode) by degrading to the safe
  // default instead of failing the whole-session parse. Legacy/missing stays
  // undefined → 'terminal' in the renderer.
  viewMode: z.enum(['terminal', 'chat']).catch('terminal').optional()
})

export const tabGroupSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
  activeTabId: z.string().nullable(),
  tabOrder: z.array(z.string()),
  recentTabIds: z.array(z.string()).optional()
})

const tabGroupSplitDirectionSchema = z.enum(['horizontal', 'vertical'])

export const tabGroupLayoutNodeSchema: z.ZodType<TabGroupLayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('leaf'),
      groupId: z.string()
    }),
    z.object({
      type: z.literal('split'),
      direction: tabGroupSplitDirectionSchema,
      first: tabGroupLayoutNodeSchema,
      second: tabGroupLayoutNodeSchema,
      ratio: z.number().optional()
    })
  ])
)
