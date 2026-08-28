import { useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, Linking } from 'react-native'
import { colors, spacing } from '../theme/mobile-theme'
import {
  cancelLaneLogin,
  IDLE_LANE_LOGIN_STATE,
  startLaneLogin,
  submitLaneLoginCode,
  type LaneLoginRequestClient,
  type LaneLoginState
} from './lane-login-request'

/**
 * S9-L2 (design rev 38 §2l): the minimal phone login flow — a URL (tappable link; a QR is a
 * desktop-only affordance per S9-L2's split, the phone IS the scanning device) and a code field.
 * Kept deliberately small: `mobile/app/h/[hostId]/accounts.tsx` sits at the hard 400-line ceiling.
 */
export type LaneLoginScreenProps = {
  client: LaneLoginRequestClient
  onCompleted: (email: string) => void
  onClose: () => void
}

export function LaneLoginScreen({ client, onCompleted, onClose }: LaneLoginScreenProps) {
  const [expectedEmail, setExpectedEmail] = useState('')
  const [code, setCode] = useState('')
  const [state, setState] = useState<LaneLoginState>(IDLE_LANE_LOGIN_STATE)
  const busy = state.stage === 'starting' || state.stage === 'submitting'

  const start = async () => {
    setState({ stage: 'starting' })
    setState(await startLaneLogin(client, expectedEmail.trim()))
  }

  const submit = async () => {
    if (state.stage !== 'awaiting-code') {
      return
    }
    const { loginSessionId } = state
    setState({ ...state, stage: 'submitting' })
    const next = await submitLaneLoginCode(client, loginSessionId, code.trim())
    setState(next)
    if (next.stage === 'completed') {
      onCompleted(next.email)
    }
  }

  const cancel = async () => {
    if (state.stage === 'awaiting-code' || state.stage === 'submitting') {
      await cancelLaneLogin(client, state.loginSessionId)
    }
    onClose()
  }

  return (
    <View style={{ padding: spacing.md, gap: spacing.sm }} testID="lane-login-screen">
      {state.stage === 'idle' || state.stage === 'starting' ? (
        <>
          <Text style={{ color: colors.textPrimary }}>Expected account email</Text>
          <TextInput
            testID="lane-login-expected-email-input"
            value={expectedEmail}
            onChangeText={setExpectedEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="name@example.com"
            style={{ borderWidth: 1, borderColor: colors.borderSubtle, padding: spacing.sm }}
          />
          <Pressable
            testID="lane-login-start-button"
            disabled={expectedEmail.trim().length === 0 || busy}
            onPress={() => void start()}
          >
            {busy ? <ActivityIndicator /> : <Text>Start login</Text>}
          </Pressable>
        </>
      ) : null}

      {state.stage === 'awaiting-code' || state.stage === 'submitting' ? (
        <>
          <Pressable
            testID="lane-login-authorize-url"
            onPress={() => void Linking.openURL(state.authorizeUrl)}
          >
            <Text style={{ color: colors.accentBlue }}>{state.authorizeUrl}</Text>
          </Pressable>
          <TextInput
            testID="lane-login-code-input"
            value={code}
            onChangeText={setCode}
            placeholder="Code from the browser"
            style={{ borderWidth: 1, borderColor: colors.borderSubtle, padding: spacing.sm }}
          />
          <Pressable testID="lane-login-cancel-button" onPress={() => void cancel()}>
            <Text>Cancel</Text>
          </Pressable>
          <Pressable
            testID="lane-login-submit-code-button"
            disabled={code.trim().length === 0 || busy}
            onPress={() => void submit()}
          >
            {busy ? <ActivityIndicator /> : <Text>Submit code</Text>}
          </Pressable>
        </>
      ) : null}

      {state.stage === 'error' ? (
        <Text testID="lane-login-error" style={{ color: colors.statusRed }}>
          {state.message}
        </Text>
      ) : null}

      {state.stage === 'completed' ? (
        <Text testID="lane-login-completed">Signed in to {state.email}.</Text>
      ) : null}
    </View>
  )
}
