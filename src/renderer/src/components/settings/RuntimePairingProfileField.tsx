import { translate } from '@/i18n/i18n'

// S10-19 W-6: split out of RuntimePairingGeneratorForm.tsx to stay under the max-lines ratchet.
// Shown only once a name is entered — no preselection (Ruling 20(d)).
type RuntimePairingProfileFieldProps = {
  deviceName: string
  profile: 'full' | 'peer' | null
  onProfileChange: (profile: 'full' | 'peer') => void
}

export function RuntimePairingProfileField({
  deviceName,
  profile,
  onProfileChange
}: RuntimePairingProfileFieldProps): React.JSX.Element | null {
  if (deviceName.trim() === '') {
    return null
  }
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {translate(
          'auto.components.settings.RuntimePairingUrlGenerator.profileQuestion',
          'What can this link do?'
        )}
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            [
              'full',
              translate(
                'auto.components.settings.RuntimePairingUrlGenerator.profileFull',
                'Full runtime access'
              ),
              translate(
                'auto.components.settings.RuntimePairingUrlGenerator.profileFullHelp',
                'Ordinary runtime access — panes, files, everything this device already grants.'
              )
            ],
            [
              'peer',
              translate(
                'auto.components.settings.RuntimePairingUrlGenerator.profilePeer',
                'Federation peer'
              ),
              translate(
                'auto.components.settings.RuntimePairingUrlGenerator.profilePeerHelp',
                'Least-privilege: can only dispatch and answer a startup prompt — no pane, no file access.'
              )
            ]
          ] as const
        ).map(([value, label, description]) => (
          <label
            key={value}
            className="flex cursor-pointer gap-2 rounded-md border border-border p-3 has-[:checked]:border-ring has-[:checked]:ring-1 has-[:checked]:ring-ring"
          >
            <input
              type="radio"
              name="runtime-pairing-profile"
              value={value}
              checked={profile === value}
              onChange={() => onProfileChange(value)}
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="block text-xs font-medium">{label}</span>
              <span className="block text-[11px] text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </div>
      {profile === 'peer' ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimePairingUrlGenerator.profilePeerNoWebClient',
            'A federation-peer link has no browser URL — it is Orca-to-Orca only.'
          )}
        </p>
      ) : null}
    </fieldset>
  )
}
