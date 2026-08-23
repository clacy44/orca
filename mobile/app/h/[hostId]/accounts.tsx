import { useEffect, useState, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Alert
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, RefreshCw, User } from 'lucide-react-native'
import { loadHosts } from '../../../src/transport/host-store'
import { useHostClient } from '../../../src/transport/client-context'
import { colors, spacing } from '../../../src/theme/mobile-theme'
import { styles } from '../../../src/accounts/mobile-accounts-screen-styles'
import { useNow } from '../../../src/hooks/use-now'
import {
  type AccountsSnapshot,
  type ProviderKey,
  decodeAccountsSnapshot
} from '../../../src/components/AccountUsage'
import { useCodexResetCreditAction } from '../../../src/components/use-codex-reset-credit-action'
import { ProviderAccountSection } from '../../../src/accounts/ProviderAccountSection'
import { useHostStatusGates } from '../../../src/transport/host-status-gates'
import {
  IDLE_SWITCH_STATE,
  NO_LANE,
  isLaneAccountLoaded,
  readLaneProjection,
  reduceSwitchRequest,
  resolveClaudeSwitchCall,
  type MobileLaneProjection,
  type SwitchRequestState
} from '../../../src/accounts/lane-delegated-switch-request'

export default function AccountsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()

  // Why: shared client per host. See docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const [hostName, setHostName] = useState<string>('')
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)
  const [clockEnabled, setClockEnabled] = useState(false)
  // §2l: the phone's lane is whatever the host publishes for THIS caller; an old host publishes
  // none and every branch below stays on today's behaviour.
  const [lane, setLane] = useState<MobileLaneProjection>(NO_LANE)
  const [switchState, setSwitchState] = useState<SwitchRequestState>(IDLE_SWITCH_STATE)
  const { hostCapabilities } = useHostStatusGates({ hostId, client, connState })

  const acceptSnapshot = useCallback((nextSnapshot: AccountsSnapshot, raw?: unknown) => {
    setSnapshot(nextSnapshot)
    setLane(readLaneProjection(raw))
    setError(null)
  }, [])
  const rejectInvalidSnapshot = useCallback(() => {
    // Why: a stale snapshot can expose a finite reset action for the wrong
    // account; fail closed if a host sends a shape this mobile cannot prove.
    setSnapshot(null)
    setError('Invalid accounts snapshot from host')
  }, [])
  const {
    supported: codexResetSupported,
    resetting: resettingCodex,
    resetScope,
    scopeLabel: resetScopeLabel,
    confirmReset: confirmCodexReset
  } = useCodexResetCreditAction({
    client,
    connected: connState === 'connected',
    hostId,
    snapshot,
    accountMutationBusy: busyAccountId !== null,
    onSnapshot: acceptSnapshot
  })

  useFocusEffect(
    useCallback(() => {
      setClockEnabled(true)
      return () => setClockEnabled(false)
    }, [])
  )
  // Why: snapshot pushes only arrive when the desktop's rate-limit poll completes.
  const now = useNow(60_000, clockEnabled)

  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }
      setHostName(host.name)
    })
    return () => {
      stale = true
    }
  }, [hostId])

  // Why: subscribe to streaming snapshot updates so usage bars refresh in
  // place when the desktop's rate-limit poll completes (every 5 min) or
  // when the user switches accounts. Falls back to a one-shot accounts.list
  // if the subscription stream errors.
  useEffect(() => {
    if (!client || connState !== 'connected') {
      return
    }
    const unsubscribe = client.subscribe('accounts.subscribe', null, (payload) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      const evt = payload as { type?: string; snapshot?: unknown }
      if (evt.type === 'ready' || evt.type === 'snapshot') {
        try {
          acceptSnapshot(decodeAccountsSnapshot(evt.snapshot), evt.snapshot)
        } catch {
          rejectInvalidSnapshot()
        }
      }
    })
    return unsubscribe
  }, [acceptSnapshot, client, connState, rejectInvalidSnapshot])

  // §2l step 4: the switch outcome arrives on this stream. The `pending` reply is not an outcome.
  useEffect(() => {
    if (!client || connState !== 'connected' || !lane.holdsLane) {
      return
    }
    return client.subscribe('accounts.lane.statusSubscribe', null, (frame) => {
      setSwitchState((state) => reduceSwitchRequest(state, { type: 'lane-frame', frame }))
    })
  }, [client, connState, lane.holdsLane])

  const requestLaneSwitch = useCallback(
    async (delegatedAccountId: string | null) => {
      const call = resolveClaudeSwitchCall({
        lane,
        accountId: null,
        delegatedAccountId,
        hostCapabilities
      })
      if (!client || call.method !== 'accounts.lane.requestSwitch') {
        Alert.alert(
          'Could not switch account',
          call.method === null && call.reason === 'unsupported-host'
            ? 'This host is too old to switch your own Claude account from here. Update Orca on the host.'
            : 'That account is not offered for switching from this device yet. Tick it in Orca on your desktop.'
        )
        return
      }
      const res = await client.sendRequest(call.method, call.params)
      const requestId = res.ok ? ((res.result as { requestId?: string }).requestId ?? null) : null
      setSwitchState((state) =>
        reduceSwitchRequest(
          state,
          res.ok
            ? { type: 'requested', requestId, delegatedAccountId: call.params.delegatedAccountId }
            : { type: 'refused', message: res.error.message }
        )
      )
    },
    [client, hostCapabilities, lane]
  )

  const refresh = useCallback(async () => {
    if (!client) {
      return
    }
    setRefreshing(true)
    try {
      const res = await client.sendRequest('accounts.list')
      if (res.ok) {
        acceptSnapshot(decodeAccountsSnapshot(res.result), res.result)
      } else {
        setError(res.error.message)
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'Invalid accounts snapshot from host') {
        rejectInvalidSnapshot()
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRefreshing(false)
    }
  }, [acceptSnapshot, client, rejectInvalidSnapshot])

  const selectAccount = useCallback(
    async (provider: ProviderKey, accountId: string | null) => {
      if (!client) {
        return
      }
      // §2d refuses this caller's `selectClaude` outright once it holds a lane, so the phone must
      // not send one: its own account moves through the delegated list below instead.
      if (provider === 'claude' && lane.holdsLane) {
        Alert.alert(
          'Switch in your own lane',
          "This host keeps your Claude account separate from everyone else's. Pick one of your own accounts below."
        )
        return
      }
      const codexTarget = provider === 'codex' ? snapshot?.rateLimits.codexTarget : null
      if (provider === 'codex' && !codexTarget) {
        return
      }
      setBusyAccountId(accountId ?? `${provider}:default`)
      const method =
        provider === 'claude'
          ? 'accounts.selectClaude'
          : codexTarget?.runtime === 'wsl'
            ? 'accounts.selectCodexForTarget'
            : 'accounts.selectCodex'
      try {
        // Why: old hosts silently strip unknown target fields. Use the distinct
        // targeted RPC for WSL so version skew fails before mutating host state.
        const params =
          codexTarget?.runtime === 'wsl' ? { accountId, target: codexTarget } : { accountId }
        const res = await client.sendRequest(method, params)
        if (!res.ok) {
          Alert.alert('Could not switch account', res.error.message)
        } else {
          // Why: optimistic refresh — the streaming subscription will also
          // emit, but a one-shot keeps the UI responsive even if the stream
          // is temporarily disconnected.
          await refresh()
        }
      } catch (e) {
        Alert.alert('Could not switch account', e instanceof Error ? e.message : String(e))
      } finally {
        setBusyAccountId(null)
      }
    },
    [client, lane, refresh, requestLaneSwitch, snapshot]
  )

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.heading}>Accounts</Text>
          {hostName ? (
            <Text style={styles.subheading} numberOfLines={1}>
              {hostName}
            </Text>
          ) : null}
        </View>
        <Pressable
          style={styles.iconButton}
          onPress={refresh}
          disabled={!client || refreshing || connState !== 'connected'}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <RefreshCw size={18} color={colors.textSecondary} />
          )}
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xl }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textSecondary}
          />
        }
      >
        {connState !== 'connected' && !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>Connecting to {hostName || 'host'}…</Text>
          </View>
        ) : error && !snapshot ? (
          <View style={styles.placeholder}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : !snapshot ? (
          <View style={styles.placeholder}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.placeholderText}>Loading accounts…</Text>
          </View>
        ) : (
          <>
            {(['claude', 'codex'] as const).map((provider) => (
              <ProviderAccountSection
                key={provider}
                provider={provider}
                title={provider === 'claude' ? 'Claude' : 'Codex'}
                snapshot={snapshot}
                now={now}
                busyAccountId={busyAccountId}
                resettingCodex={resettingCodex}
                connState={connState}
                selectAccount={selectAccount}
                codexResetSupported={codexResetSupported}
                resetScope={resetScope}
                resetScopeLabel={resetScopeLabel}
                confirmCodexReset={confirmCodexReset}
              />
            ))}
            {lane.holdsLane ? (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionHeading}>Your Claude accounts</Text>
                </View>
                <View style={styles.card}>
                  {lane.delegable.map((entry, index) => (
                    <View key={entry.delegatedAccountId}>
                      {index > 0 ? <View style={styles.separator} /> : null}
                      <Pressable
                        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                        onPress={() => void requestLaneSwitch(entry.delegatedAccountId)}
                        disabled={switchState.status === 'pending' || connState !== 'connected'}
                      >
                        <View style={styles.rowMain}>
                          <Text style={styles.rowTitle} numberOfLines={1}>
                            {entry.displayName ?? entry.email ?? 'Claude account'}
                          </Text>
                          <Text style={styles.rowSubtitle}>
                            {isLaneAccountLoaded(lane, entry.delegatedAccountId)
                              ? 'Loaded on this host'
                              : 'Switch through your desktop'}
                          </Text>
                        </View>
                      </Pressable>
                    </View>
                  ))}
                  {lane.delegable.length === 0 ? (
                    <View style={styles.row}>
                      <Text style={styles.rowSubtitle}>
                        No accounts offered yet. Tick the ones you want on your desktop.
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            ) : null}
            {switchState.status === 'pending' ? (
              <View style={styles.footerHint}>
                <Text style={styles.footerHintText}>
                  Asking your desktop to switch this account…
                </Text>
              </View>
            ) : null}
            {switchState.status === 'failed' ? (
              <View style={styles.footerHint}>
                <Text style={styles.errorText}>{switchState.message}</Text>
              </View>
            ) : null}
            <View style={styles.footerHint}>
              <User size={14} color={colors.textMuted} />
              <Text style={styles.footerHintText}>
                Add or re-authenticate accounts from desktop Settings → Accounts.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}
