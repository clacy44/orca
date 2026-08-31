// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: {
        tabAutoGenerateTitle: false,
        promptCacheTimerEnabled: false,
        promptCacheTtlMs: 0
      },
      tabsByWorktree: {},
      cacheTimerByKey: {}
    })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))

afterEach(() => {
  cleanup()
})

const NOW = 120_000

function makeAgent(overrides: Partial<DashboardAgentRowData> = {}): DashboardAgentRowData {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'Fix the thing',
    updatedAt: 60_000,
    stateStartedAt: 60_000,
    agentType: 'claude',
    paneKey,
    stateHistory: []
  }
  return {
    paneKey,
    entry,
    tab,
    agentType: 'claude',
    state: 'done',
    startedAt: 60_000,
    rowSource: 'retained',
    ...overrides
  }
}

describe('CompactAgentRow dismiss control', () => {
  it('shows a dismiss button for a retained row and calls onDismiss with its paneKey', async () => {
    const onDismiss = vi.fn()
    render(
      <CompactAgentRow
        agent={makeAgent({ paneKey: 'tab-9:leaf-2' })}
        now={NOW}
        onActivate={vi.fn()}
        onDismiss={onDismiss}
      />
    )

    const button = screen.getByRole('button', { name: 'Dismiss agent' })
    await userEvent.click(button)

    expect(onDismiss).toHaveBeenCalledWith('tab-9:leaf-2')
  })

  it('reveals the dismiss button on row hover via group-hover classes', () => {
    render(
      <CompactAgentRow agent={makeAgent()} now={NOW} onActivate={vi.fn()} onDismiss={vi.fn()} />
    )

    const button = screen.getByRole('button', { name: 'Dismiss agent' })
    expect(button.className).toContain('can-hover:opacity-0')
    expect(button.className).toContain('group-hover/compact-agent-row:opacity-100')
  })

  it('does not render a dismiss button when onDismiss is not provided', () => {
    render(<CompactAgentRow agent={makeAgent()} now={NOW} onActivate={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Dismiss agent' })).not.toBeInTheDocument()
  })

  it('does not render a dismiss button for a live row', () => {
    render(
      <CompactAgentRow
        agent={makeAgent({ rowSource: 'live' })}
        now={NOW}
        onActivate={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'Dismiss agent' })).not.toBeInTheDocument()
  })

  it('does not render a dismiss button for a subagent child row', () => {
    render(
      <CompactAgentRow
        agent={makeAgent({ rowSource: 'subagent' })}
        now={NOW}
        onActivate={vi.fn()}
        onDismiss={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'Dismiss agent' })).not.toBeInTheDocument()
  })

  it('does not render a dismiss button while the row is a send target', () => {
    render(
      <CompactAgentRow
        agent={makeAgent()}
        now={NOW}
        onActivate={vi.fn()}
        onDismiss={vi.fn()}
        sendTargetStatus="disabled"
      />
    )

    expect(screen.queryByRole('button', { name: 'Dismiss agent' })).not.toBeInTheDocument()
  })
})
