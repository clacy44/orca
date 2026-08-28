// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LaneAccountListRow } from './LaneAccountListRow'
import type { LaneAccountRow } from '../../../../shared/claude-lane-login-rpc'

const ACTIVE: LaneAccountRow = {
  laneAccountId: '11111111-1111-4111-8111-111111111111',
  email: 'a@example.com',
  label: 'Work',
  active: true
}
const INACTIVE: LaneAccountRow = {
  laneAccountId: '22222222-2222-4222-8222-222222222222',
  email: 'b@example.com',
  label: null,
  active: false
}

describe('LaneAccountListRow', () => {
  afterEach(cleanup)

  it('shows the Active badge and never the Switch button on the active account', () => {
    render(<LaneAccountListRow account={ACTIVE} onSwitch={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByTestId('lane-account-active-badge')).toBeTruthy()
    expect(screen.queryByTestId('lane-account-switch-button')).toBeNull()
  })

  it('disables Remove on the active account (§3 row 6: removing the active login is refused)', () => {
    render(<LaneAccountListRow account={ACTIVE} onSwitch={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByTestId('lane-account-remove-button').hasAttribute('disabled')).toBe(true)
  })

  it('an inactive account offers Switch and an enabled Remove', async () => {
    const onSwitch = vi.fn(async () => {})
    render(<LaneAccountListRow account={INACTIVE} onSwitch={onSwitch} onRemove={vi.fn()} />)
    expect(screen.getByTestId('lane-account-remove-button').hasAttribute('disabled')).toBe(false)
    await userEvent.click(screen.getByTestId('lane-account-switch-button'))
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })
})
