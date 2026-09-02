import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import {
  RuntimePairingGeneratorForm,
  type RuntimePairingIntent
} from './RuntimePairingGeneratorForm'

function renderForm(
  intent: RuntimePairingIntent,
  selectedAddress: string,
  generated?: {
    address: string
    runtimePairingUrl: string
    webClientUrl: string
  },
  profile: 'full' | 'peer' | null = 'full'
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RuntimePairingGeneratorForm
        deviceName="Ana"
        profile={profile}
        intent={intent}
        loopbackAddress="127.0.0.1"
        networkInterfaces={[{ name: 'tailscale0', address: '100.76.32.125' }]}
        selectedAddress={selectedAddress}
        refreshingNetworkInterfaces={false}
        isGeneratingPairing={false}
        webClientUrl={generated?.webClientUrl ?? null}
        runtimePairingUrl={generated?.runtimePairingUrl ?? null}
        copiedTarget={null}
        generatedAddress={generated?.address ?? null}
        onDeviceNameChange={vi.fn()}
        onProfileChange={vi.fn()}
        onIntentChange={vi.fn()}
        onSelectedAddressChange={vi.fn()}
        onRefreshNetworkInterfaces={vi.fn()}
        onGenerate={vi.fn()}
        onCopy={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('RuntimePairingGeneratorForm', () => {
  it('carries the name into the device-name field', () => {
    const markup = renderForm('another', '100.76.32.125')
    expect(markup).toContain('id="runtime-pairing-device-name"')
    expect(markup).toContain('value="Ana"')
  })

  it('uses detected interfaces for another-device intent', () => {
    const markup = renderForm('another', '100.76.32.125')
    expect(markup).toContain('role="combobox"')
    expect(markup).not.toContain('id="runtime-pairing-custom-address"')
  })

  it('requires a dedicated value for custom-address intent', () => {
    const emptyMarkup = renderForm('custom', '')
    expect(emptyMarkup).toContain('id="runtime-pairing-custom-address"')
    expect(emptyMarkup).toContain('disabled=""')

    const populatedMarkup = renderForm('custom', 'openclaw.example.ts.net')
    expect(populatedMarkup).toContain('value="openclaw.example.ts.net"')
    expect(populatedMarkup).not.toContain('disabled=""')
  })

  it('hides generated links after the selected address changes', () => {
    const markup = renderForm('another', '100.76.32.125', {
      address: '192.168.1.10',
      runtimePairingUrl: 'orca://pair?code=stale-secret',
      webClientUrl: 'https://example.test/?pair=stale-secret'
    })

    expect(markup).toContain('The connection address changed.')
    expect(markup).not.toContain('stale-secret')
  })

  // S10-19 W-6: a named link requires an explicit profile choice — no preselection, and
  // Generate stays disabled until one is picked.
  it('shows the profile choice for a named link with no preselection, and disables Generate', () => {
    const markup = renderForm('another', '100.76.32.125', undefined, null)
    expect(markup).toContain('runtime-pairing-profile')
    expect(markup).not.toMatch(/name="runtime-pairing-profile"[^>]*checked=""/)
    expect(markup).toContain('disabled=""')
  })

  it('enables Generate once a profile is chosen', () => {
    const markup = renderForm('another', '100.76.32.125', undefined, 'peer')
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('no browser URL')
  })
})
