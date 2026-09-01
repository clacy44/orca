/* Why: the workspace session JSON is written to disk by older builds and read
 * back by newer ones. A field type flip (e.g. ptyId going from string to an
 * object) or a truncated write could poison Zustand state and crash the
 * renderer on mount. Schema-validating at the read boundary gives us a single
 * "reject and fall back to defaults" point so garbage never reaches React.
 *
 * Policy: be tolerant of extra fields (future builds may add more) but strict
 * about the types of fields we actually read. Where a field holds a collection
 * of independent records, tolerance is declared on the field itself (see
 * ./zod-salvage): a corrupt entry is dropped and the rest of the session
 * survives, because one bad tab record must not cost every worktree its state.
 * Only a payload that is not a session at all falls back to defaults.
 */
import { z } from 'zod'
import type { WorkspaceKey } from './folder-workspace-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'
import { isWorkspaceKey } from './workspace-scope'
import {
  browserHistoryEntriesSchema,
  browserPageSchema,
  browserWorkspaceSchema
} from './workspace-session-browser-schema'
import { sleepingAgentSessionsByPaneKeySchema } from './workspace-session-sleeping-agents'
import {
  tabGroupLayoutNodeSchema,
  tabGroupSchema,
  tabSchema,
  workspaceVisibleTabTypeSchema
} from './workspace-session-tab-group-schema'
import {
  leafStringsSchema,
  terminalLayoutSnapshotSchema,
  terminalTabIdSchema,
  terminalTabSchema
} from './workspace-session-terminal-schema'
import { salvagedField, salvagedOptional, salvagingArray, salvagingRecord } from './zod-salvage'

const workspaceKeySchema = z.custom<WorkspaceKey>(
  (value) => typeof value === 'string' && isWorkspaceKey(value)
)

// ─── Editor ─────────────────────────────────────────────────────────

const persistedOpenFileSchema = z.object({
  filePath: z.string(),
  relativePath: z.string(),
  worktreeId: z.string(),
  language: z.string(),
  isPreview: z.boolean().optional(),
  runtimeEnvironmentId: z.string().nullable().optional(),
  externalSshTargetId: z.string().trim().min(1).optional(),
  dirtyDraftContent: z.string().optional(),
  lastKnownDiskSignature: z.string().optional(),
  readOnly: z.boolean().optional(),
  liveTail: z.boolean().optional()
})

// ─── Workspace session ──────────────────────────────────────────────

const terminalSurfaceTombstoneSchema = z.object({
  worktreeId: z.string(),
  parentTabId: terminalTabIdSchema,
  leafId: z.string(),
  ptyId: z.string(),
  incarnationId: z.string().min(1).max(128),
  retiredAt: z.number().finite().nonnegative()
})

const worktreeIdSchema = z.string()

export const workspaceSessionStateSchema: z.ZodType<WorkspaceSessionState> = z.object({
  activeRepoId: salvagedField('activeRepoId', z.string().nullable(), () => null),
  activeWorkspaceKey: salvagedOptional('activeWorkspaceKey', workspaceKeySchema.nullable()),
  activeWorkspaceExecutionHostId: salvagedOptional(
    'activeWorkspaceExecutionHostId',
    z
      .custom<ExecutionHostId>(
        (value) => typeof value === 'string' && Boolean(parseExecutionHostId(value))
      )
      .nullable()
  ),
  activeWorktreeId: salvagedField('activeWorktreeId', z.string().nullable(), () => null),
  activeTabId: salvagedField('activeTabId', z.string().nullable(), () => null),
  tabsByWorktree: salvagedField(
    'tabsByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(terminalTabSchema)),
    () => ({})
  ),
  terminalLayoutsByTabId: salvagedField(
    'terminalLayoutsByTabId',
    salvagingRecord(terminalTabIdSchema, terminalLayoutSnapshotSchema),
    () => ({})
  ),
  activeWorktreeIdsOnShutdown: salvagedOptional(
    'activeWorktreeIdsOnShutdown',
    salvagingArray(worktreeIdSchema)
  ),
  openFilesByWorktree: salvagedOptional(
    'openFilesByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(persistedOpenFileSchema))
  ),
  activeFileIdByWorktree: salvagedOptional(
    'activeFileIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string().nullable())
  ),
  markdownFrontmatterVisible: salvagedOptional(
    'markdownFrontmatterVisible',
    salvagingRecord(z.string(), z.boolean())
  ),
  browserTabsByWorktree: salvagedOptional(
    'browserTabsByWorktree',
    salvagingRecord(worktreeIdSchema, salvagingArray(browserWorkspaceSchema))
  ),
  browserPagesByWorkspace: salvagedOptional(
    'browserPagesByWorkspace',
    salvagingRecord(z.string(), salvagingArray(browserPageSchema))
  ),
  activeBrowserTabIdByWorktree: salvagedOptional(
    'activeBrowserTabIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string().nullable())
  ),
  activeTabTypeByWorktree: salvagedOptional(
    'activeTabTypeByWorktree',
    salvagingRecord(worktreeIdSchema, workspaceVisibleTabTypeSchema)
  ),
  browserUrlHistory: salvagedOptional('browserUrlHistory', browserHistoryEntriesSchema),
  activeTabIdByWorktree: salvagedOptional(
    'activeTabIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string().nullable())
  ),
  unifiedTabs: salvagedOptional(
    'unifiedTabs',
    salvagingRecord(worktreeIdSchema, salvagingArray(tabSchema))
  ),
  tabGroups: salvagedOptional(
    'tabGroups',
    salvagingRecord(worktreeIdSchema, salvagingArray(tabGroupSchema))
  ),
  tabGroupLayouts: salvagedOptional(
    'tabGroupLayouts',
    salvagingRecord(worktreeIdSchema, tabGroupLayoutNodeSchema)
  ),
  activeGroupIdByWorktree: salvagedOptional(
    'activeGroupIdByWorktree',
    salvagingRecord(worktreeIdSchema, z.string())
  ),
  activeConnectionIdsAtShutdown: salvagedOptional(
    'activeConnectionIdsAtShutdown',
    salvagingArray(z.string())
  ),
  remoteSessionIdsByTabId: salvagedOptional(
    'remoteSessionIdsByTabId',
    salvagingRecord(terminalTabIdSchema, z.string())
  ),
  // Why: the sort comparator in order-empty-query-worktrees.ts would produce NaN
  // (undefined sort order) from a NaN or Infinity persisted here.
  lastVisitedAtByWorktreeId: salvagedOptional(
    'lastVisitedAtByWorktreeId',
    salvagingRecord(worktreeIdSchema, z.number().finite().nonnegative())
  ),
  defaultTerminalTabsAppliedByWorktreeId: salvagedOptional(
    'defaultTerminalTabsAppliedByWorktreeId',
    salvagingRecord(worktreeIdSchema, z.literal(true))
  ),
  sleepingAgentSessionsByPaneKey: salvagedOptional(
    'sleepingAgentSessionsByPaneKey',
    sleepingAgentSessionsByPaneKeySchema
  ),
  terminalPtyIncarnationsByPaneKey: salvagedOptional(
    'terminalPtyIncarnationsByPaneKey',
    salvagingRecord(z.string(), z.string().min(1).max(128))
  ),
  terminalRolesByPaneKey: salvagedOptional('terminalRolesByPaneKey', leafStringsSchema),
  terminalLaunchTokenHashesByPaneKey: salvagedOptional(
    'terminalLaunchTokenHashesByPaneKey',
    salvagingRecord(z.string(), z.string().regex(/^[0-9a-f]{64}$/))
  ),
  terminalTopologyRevisionByRepoId: salvagedOptional(
    'terminalTopologyRevisionByRepoId',
    salvagingRecord(z.string(), z.number().int().nonnegative())
  ),
  terminalSurfaceTombstonesByPaneKey: salvagedOptional(
    'terminalSurfaceTombstonesByPaneKey',
    salvagingRecord(z.string(), terminalSurfaceTombstoneSchema)
  )
})

export type ParsedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState }
  | { ok: false; error: string }

/** Why: keep the error compact — a zod issue dump is noisy and most of the time
 *  only the first divergent field is actionable for debugging. */
export function describeWorkspaceSessionError(error: z.ZodError): string {
  const firstIssue = error.issues[0]
  const path = firstIssue?.path.join('.') || '<root>'
  return `${path}: ${firstIssue?.message ?? 'invalid session'}`
}

export const WORKSPACE_SESSION_UNVALIDATABLE = '<root>: session could not be validated'

/** safeParse, or null when the validator itself could not run.
 *  Why: safeParse is documented not to throw, but a payload holding hundreds of
 *  thousands of bad records overflows the stack while zod materializes an issue
 *  per field. This parse runs in the Store constructor, so an escaping RangeError
 *  is a launch failure the user cannot recover from without deleting their
 *  profile — exactly the "never throw into main" contract at the top of this file. */
export function safeParseWorkspaceSession(
  raw: unknown
): ReturnType<typeof workspaceSessionStateSchema.safeParse> | null {
  try {
    return workspaceSessionStateSchema.safeParse(raw)
  } catch {
    return null
  }
}

/** Validate raw JSON as a WorkspaceSessionState. Returns a discriminated union
 *  so callers can fall back to defaults on failure without a try/catch. */
export function parseWorkspaceSession(raw: unknown): ParsedWorkspaceSession {
  const result = safeParseWorkspaceSession(raw)
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: describeWorkspaceSessionError(result.error) }
}
