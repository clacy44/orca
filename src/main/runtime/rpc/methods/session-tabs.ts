import { z } from 'zod'
import { resolveRuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  ActivateTab,
  CreateTerminalTab,
  MoveTab,
  SaveMarkdownTab,
  SessionTabsUnsubscribe,
  SetTabProps,
  UpdatePaneLayout,
  WorktreeTabSelectorWithDeviceSelections
} from './session-tabs-schemas'
import { SESSION_TAB_CLOSE_METHODS } from './session-tab-close-methods'
import { projectSessionTabsForClient } from './session-tab-device-selections'

export const SESSION_TAB_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'session.tabs.list',
    params: WorktreeTabSelectorWithDeviceSelections,
    handler: async (params, ctx) =>
      projectSessionTabsForClient(
        await ctx.runtime.listMobileSessionTabs(params.worktree, ctx.pairedDeviceId),
        ctx,
        params.includeDeviceSelections === true
      )
  }),
  defineMethod({
    name: 'session.tabs.listAll',
    params: null,
    handler: async (_params, ctx) => ({
      // Why never here: listAll has no params to opt in with, so it stays byte-identical by construction.
      snapshots: (await ctx.runtime.listAllMobileSessionTabs(ctx.pairedDeviceId)).map((snapshot) =>
        projectSessionTabsForClient(snapshot, ctx, false)
      )
    })
  }),
  defineMethod({
    name: 'session.tabs.activate',
    params: ActivateTab,
    handler: async (params, { runtime, clientKind, pairedDeviceId }) =>
      runtime.activateMobileSessionTab(params.worktree, params.tabId, params.leafId, {
        notifyClients: params.notifyClients !== false,
        // Why: the tap spends this as caller identity as well as a navigation id — the materialize
        // reattaches an existing pane and the adopt predicate is its only gate (§2a row 35).
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        clientNavigationId: pairedDeviceId,
        ...(params.intent ? { intent: params.intent } : {}),
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          notifyClients: params.notifyClients,
          clientKind
        })
      })
  }),
  ...SESSION_TAB_CLOSE_METHODS,
  defineMethod({
    name: 'session.tabs.createTerminal',
    params: CreateTerminalTab,
    handler: async (params, { runtime, signal, clientKind, pairedDeviceId }) =>
      runtime.createMobileSessionTerminal(params.worktree, {
        credentialLane: runtime.resolveCallerCredentialLane(pairedDeviceId),
        afterTabId: params.afterTabId,
        targetGroupId: params.targetGroupId,
        command: params.command,
        cwd: params.cwd,
        ...(params.env ? { env: params.env } : {}),
        ...(params.envToDelete ? { envToDelete: params.envToDelete } : {}),
        startupCommandDelivery: params.startupCommandDelivery,
        agent: params.agent,
        ...(params.agentPrompt !== undefined ? { agentPrompt: params.agentPrompt } : {}),
        ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
        ...(params.launchToken ? { launchToken: params.launchToken } : {}),
        ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
        ...(params.viewMode ? { viewMode: params.viewMode } : {}),
        activate: params.activate,
        select: params.select,
        clientNavigationId: pairedDeviceId,
        navigation: resolveRuntimeNavigationTarget({
          navigation: params.navigation,
          clientKind
        }),
        clientMutationId: params.clientMutationId,
        // Why: a dead client connection must cancel the surface wait instead
        // of running down the timeout and rolling back a live tab (#7718).
        signal
      })
  }),
  defineMethod({
    name: 'session.tabs.move',
    params: MoveTab,
    handler: async (params, { runtime }) => {
      const base = {
        tabId: params.tabId,
        targetGroupId: params.targetGroupId
      }
      if (params.kind === 'reorder') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'reorder',
          tabOrder: params.tabOrder
        })
      }
      if (params.kind === 'split') {
        return runtime.moveMobileSessionTab(params.worktree, {
          ...base,
          kind: 'split',
          splitDirection: params.splitDirection
        })
      }
      return runtime.moveMobileSessionTab(params.worktree, {
        ...base,
        kind: 'move-to-group',
        index: params.index
      })
    }
  }),
  defineMethod({
    name: 'session.tabs.updatePaneLayout',
    params: UpdatePaneLayout,
    handler: async (params, { runtime }) =>
      runtime.updateMobileSessionPaneLayout(params.worktree, {
        tabId: params.tabId,
        root: params.root,
        expandedLeafId: params.expandedLeafId ?? null,
        titlesByLeafId: params.titlesByLeafId
      })
  }),
  defineMethod({
    name: 'session.tabs.setTabProps',
    params: SetTabProps,
    handler: async (params, { runtime }) =>
      runtime.setMobileSessionTabProps(params.worktree, {
        tabId: params.tabId,
        ...(params.color !== undefined ? { color: params.color } : {}),
        ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {}),
        ...(params.viewMode !== undefined ? { viewMode: params.viewMode } : {})
      })
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribe',
    params: WorktreeTabSelectorWithDeviceSelections,
    handler: async (params, ctx, emit) => {
      const { runtime, connectionId, requestId, pairedDeviceId } = ctx
      let subscribedWorktree: string | null = null
      let unsubscribe = (): void => {}
      let closed = false
      let initialized = false
      const initial = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
      if (closed) {
        return
      }
      subscribedWorktree = initial.worktree
      const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:${subscribedWorktree}`
      const subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
      // Why: shared-control can carry multiple subscribers for one worktree on
      // one socket; include the RPC id so one subscriber cannot evict another.
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          unsubscribe()
          if (initialized) {
            emit({ type: 'end' })
          }
        },
        connectionId
      )
      if (closed) {
        return
      }
      emit({
        type: 'snapshot',
        ...projectSessionTabsForClient(initial, ctx, params.includeDeviceSelections === true)
      })
      initialized = true
      if (closed) {
        return
      }

      unsubscribe = runtime.onMobileSessionTabsChanged(
        (snapshot) => {
          if (snapshot.worktree === subscribedWorktree) {
            emit({
              type: 'updated',
              ...projectSessionTabsForClient(snapshot, ctx, params.includeDeviceSelections === true)
            })
          }
        },
        pairedDeviceId,
        // Why declared on the subscription: a peer switching tabs is a change only this subscriber
        // asked to hear about, so the W9 cadence has to know who opted in before it fans anything out.
        { consumesDeviceSelections: params.includeDeviceSelections === true }
      )
      if (closed) {
        unsubscribe()
      }
    }
  }),
  defineMethod({
    name: 'session.tabs.unsubscribe',
    params: SessionTabsUnsubscribe,
    handler: async (params, { runtime, connectionId, pairedDeviceId }) => {
      const snapshot = await runtime.listMobileSessionTabs(params.worktree, pairedDeviceId)
      const connection = connectionId ?? 'local'
      if (params.subscriptionId) {
        runtime.cleanupSubscription(
          `session.tabs:${connection}:${snapshot.worktree}:${params.subscriptionId}`
        )
        return { unsubscribed: true }
      }
      runtime.cleanupSubscription(`session.tabs:${connection}:${params.worktree}`)
      runtime.cleanupSubscription(`session.tabs:${connection}:${snapshot.worktree}`)
      runtime.cleanupSubscriptionsByPrefix(`session.tabs:${connection}:${snapshot.worktree}:`)
      return { unsubscribed: true }
    }
  }),
  defineStreamingMethod({
    name: 'session.tabs.subscribeAll',
    params: null,
    handler: async (_params, ctx, emit) => {
      const { runtime, connectionId, requestId, pairedDeviceId } = ctx
      let unsubscribe = (): void => {}
      let closed = false
      // Why: initial listAll errors should return one RPC error, not a leaked
      // subscription cleanup that later emits a stray end frame.
      let initialized = false
      const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:*`
      const subscriptionId = requestId ? `${cleanupPrefix}:${requestId}` : cleanupPrefix
      // Why: shared-control can carry multiple all-tab subscribers on one
      // socket; include the RPC id so closing one does not evict siblings.
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          unsubscribe()
          if (initialized) {
            emit({ type: 'end' })
          }
        },
        connectionId
      )

      if (closed) {
        return
      }
      const snapshots = await Promise.resolve(
        runtime.listAllMobileSessionTabs(pairedDeviceId)
      ).catch((error) => {
        runtime.cleanupSubscription(subscriptionId)
        throw error
      })
      if (closed) {
        return
      }
      emit({
        type: 'snapshots',
        snapshots: snapshots.map((snapshot) => projectSessionTabsForClient(snapshot, ctx, false))
      })
      initialized = true

      if (closed) {
        return
      }
      unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
        emit({ type: 'updated', ...projectSessionTabsForClient(snapshot, ctx, false) })
      }, pairedDeviceId)
    }
  }),
  defineMethod({
    name: 'session.tabs.unsubscribeAll',
    params: z
      .object({
        subscriptionId: z.string().min(1).optional()
      })
      .nullish(),
    handler: async (params, { runtime, connectionId }) => {
      const cleanupPrefix = `session.tabs:${connectionId ?? 'local'}:*`
      if (params?.subscriptionId) {
        runtime.cleanupSubscription(`${cleanupPrefix}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      runtime.cleanupSubscription(cleanupPrefix)
      runtime.cleanupSubscriptionsByPrefix(`${cleanupPrefix}:`)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'markdown.readTab',
    params: ActivateTab,
    handler: async (params, { runtime }) =>
      runtime.readMobileMarkdownTab(params.worktree, params.tabId)
  }),
  defineMethod({
    name: 'markdown.saveTab',
    params: SaveMarkdownTab,
    handler: async (params, { runtime }) =>
      runtime.saveMobileMarkdownTab(
        params.worktree,
        params.tabId,
        params.baseVersion,
        params.content
      )
  })
]
