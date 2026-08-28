// S9-L2 (design rev 38 §2l): the authorize URL is also shown as a QR — the browser that completes
// it may be a phone, not this desktop — following `use-mobile-install-qr.ts`'s render shape.
import { useEffect, useState } from 'react'
import QRCodeBrowser from 'qrcode/lib/browser'

export function useLaneLoginQr(authorizeUrl: string | null): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!authorizeUrl) {
      setDataUrl(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const url = await QRCodeBrowser.toDataURL(authorizeUrl, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 200
        })
        if (!cancelled) {
          setDataUrl(url)
        }
      } catch {
        if (!cancelled) {
          setDataUrl(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [authorizeUrl])

  return dataUrl
}
