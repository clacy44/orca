import { StyleSheet, Text, View } from 'react-native'
import { colors, typography } from '../theme/mobile-theme'

// Why a non-interactive strip and not a chip with an action: a phone is never held and can never take a
// terminal back (§3), so anything tappable here would promise arbitration this client does not have.
export function MobileTerminalPresenceBanner({ summary }: { readonly summary: string | null }) {
  if (!summary) {
    return null
  }
  return (
    <View style={styles.banner} pointerEvents="none" accessibilityLabel={summary}>
      <Text style={styles.text} numberOfLines={1}>
        {summary}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 6,
    left: 8,
    zIndex: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    paddingHorizontal: 8,
    paddingVertical: 3
  },
  text: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  }
})
