import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

export type RuntimePairingCopyTarget = 'web' | 'pairing'

const COPIED_FEEDBACK_RESET_MS = 1400

/**
 * Clipboard feedback for the generated runtime pairing links: which row last reported "copied", and the
 * timer that clears it. Split out from the generator so that component owns only the credential flow.
 */
export function useRuntimePairingLinkCopy(): {
  copiedTarget: RuntimePairingCopyTarget | null
  setContainerNode: (node: HTMLDivElement | null) => void
  copyGeneratedUrl: (target: RuntimePairingCopyTarget, value: string) => Promise<void>
} {
  const [copiedTarget, setCopiedTarget] = useState<RuntimePairingCopyTarget | null>(null)
  const resetTimerRef = useRef<number | null>(null)
  const mountedRef = useMountedRef()

  const clearResetTimer = useCallback((): void => {
    if (resetTimerRef.current === null) {
      return
    }
    window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
  }, [])

  const setContainerNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: copy feedback timers are owned by this settings surface; clear
      // them when Settings collapses or navigates away.
      if (!node) {
        clearResetTimer()
      }
    },
    [clearResetTimer]
  )

  const copyGeneratedUrl = useCallback(
    async (target: RuntimePairingCopyTarget, value: string): Promise<void> => {
      try {
        await window.api.ui.writeClipboardText(value)
        if (!mountedRef.current) {
          return
        }
        clearResetTimer()
        setCopiedTarget(target)
        resetTimerRef.current = window.setTimeout(() => {
          resetTimerRef.current = null
          if (mountedRef.current) {
            setCopiedTarget((current) => (current === target ? null : current))
          }
        }, COPIED_FEEDBACK_RESET_MS)
        toast.success(
          target === 'web'
            ? translate(
                'auto.components.settings.RuntimePairingUrlGenerator.13704d635e',
                'Copied web client URL.'
              )
            : translate(
                'auto.components.settings.RuntimePairingUrlGenerator.df0aa45a86',
                'Copied pairing URL.'
              )
        )
      } catch (error) {
        if (mountedRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.d6c081adf4',
                  'Failed to copy URL.'
                )
          )
        }
      }
    },
    [clearResetTimer, mountedRef]
  )

  return { copiedTarget, setContainerNode, copyGeneratedUrl }
}
