import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'
import { ClaudeIcon, OpenAIIcon } from '../components/AgentIcons'
import {
  type AccountsSnapshot,
  type ProviderKey,
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  UsageBar
} from '../components/AccountUsage'
import {
  getActiveCodexAccountIdForRateLimitTarget,
  getCodexResetCreditSummary
} from '../components/codex-reset-credit'
import { CodexResetCreditAction } from '../components/CodexResetCreditAction'

/**
 * The provider card, lifted out of the accounts screen (S9 §6's S9b extraction).
 *
 * It moved because the screen is at a HARD 400-line `.tsx` ceiling that no per-file bump may
 * lift, and §2l's delegated-switch wiring does not fit under it otherwise. Everything it used to
 * close over is now an explicit prop, and it imports the same style module the screen does, so no
 * style block moved and no second copy exists.
 */
export type ProviderAccountSectionProps = {
  provider: ProviderKey
  title: string
  snapshot: AccountsSnapshot
  now: number
  busyAccountId: string | null
  resettingCodex: boolean
  connState: string
  selectAccount: (provider: ProviderKey, accountId: string | null) => void
  codexResetSupported: boolean
  resetScope: unknown
  resetScopeLabel: string | null
  confirmCodexReset: () => void
}

export function ProviderAccountSection({
  provider,
  title,
  snapshot,
  now,
  busyAccountId,
  resettingCodex,
  connState,
  selectAccount,
  codexResetSupported,
  resetScope,
  resetScopeLabel,
  confirmCodexReset
}: ProviderAccountSectionProps) {
  const state = provider === 'claude' ? snapshot.claude : snapshot.codex
  const activeAccountId =
    provider === 'codex' && snapshot.codex.activeAccountIdsByRuntime
      ? getActiveCodexAccountIdForRateLimitTarget(snapshot)
      : state.activeAccountId
  const activeUsage = getActiveProviderRateLimits(snapshot, provider)
  const activeSessionBar = getUsageBarState(activeUsage, 'session')
  const activeWeeklyBar = getUsageBarState(activeUsage, 'weekly')
  const resetCredit = provider === 'codex' ? getCodexResetCreditSummary(activeUsage, now) : null
  const Icon = provider === 'claude' ? ClaudeIcon : OpenAIIcon
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Icon size={14} />
        <Text style={styles.sectionHeading}>{title}</Text>
      </View>
      <View style={styles.card}>
        {/* System default row */}
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => selectAccount(provider, null)}
          disabled={busyAccountId !== null || resettingCodex || connState !== 'connected'}
        >
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>System default</Text>
            <Text style={styles.rowSubtitle}>Use the agent's own login</Text>
            {/* Why: when system default is the active selection, activeUsage
                holds the system-default login's rate limits — surface them
                here so non-managed users still see their usage. */}
            {activeAccountId === null && hasActiveProviderUsage(activeUsage) ? (
              <View style={styles.usageRow}>
                <UsageBar
                  label="5h"
                  usedPercent={activeSessionBar.usedPercent}
                  unavailable={activeSessionBar.unavailable}
                  loading={activeSessionBar.loading}
                  resetText={getWindowResetLabel(activeUsage, 'session', now)}
                />
                <UsageBar
                  label="7d"
                  usedPercent={activeWeeklyBar.usedPercent}
                  unavailable={activeWeeklyBar.unavailable}
                  loading={activeWeeklyBar.loading}
                  resetText={getWindowResetLabel(activeUsage, 'weekly', now)}
                />
              </View>
            ) : null}
          </View>
          <View style={styles.rowTrailing}>
            {activeAccountId === null ? (
              <Check size={16} color={colors.accentBlue} />
            ) : busyAccountId === `${provider}:default` ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : null}
          </View>
        </Pressable>

        {state.accounts.map((account) => {
          const isActive = activeAccountId === account.id
          const inactiveEntry = !isActive
            ? getInactiveProviderUsage(snapshot, provider, account.id)
            : null
          const usage = isActive ? activeUsage : (inactiveEntry?.rateLimits ?? null)
          const isFetching =
            (isActive && usage?.status === 'fetching') ||
            (!isActive && inactiveEntry?.isFetching === true)
          const sessionBar = getUsageBarState(usage, 'session', isFetching)
          const weeklyBar = getUsageBarState(usage, 'weekly', isFetching)
          return (
            <View key={account.id}>
              <View style={styles.separator} />
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => selectAccount(provider, account.id)}
                disabled={
                  busyAccountId !== null || resettingCodex || connState !== 'connected' || isActive
                }
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {account.email}
                  </Text>
                  <View style={styles.usageRow}>
                    <UsageBar
                      label="5h"
                      usedPercent={sessionBar.usedPercent}
                      unavailable={sessionBar.unavailable}
                      loading={sessionBar.loading}
                      resetText={getWindowResetLabel(usage, 'session', now)}
                    />
                    <UsageBar
                      label="7d"
                      usedPercent={weeklyBar.usedPercent}
                      unavailable={weeklyBar.unavailable}
                      loading={weeklyBar.loading}
                      resetText={getWindowResetLabel(usage, 'weekly', now)}
                    />
                  </View>
                  {usage?.error ? (
                    <Text style={styles.errorText} numberOfLines={1}>
                      {usage.error}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.rowTrailing}>
                  {isActive ? (
                    <Check size={16} color={colors.accentBlue} />
                  ) : busyAccountId === account.id ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : null}
                </View>
              </Pressable>
            </View>
          )
        })}
        {resetCredit && codexResetSupported && resetScope && connState === 'connected' ? (
          <CodexResetCreditAction
            summary={resetCredit}
            scopeLabel={resetScopeLabel}
            busy={resettingCodex}
            disabled={resettingCodex || busyAccountId !== null || connState !== 'connected'}
            onPress={confirmCodexReset}
          />
        ) : null}
      </View>
    </View>
  )
}
