import { PAIRING_DEVICE_NAME_MAX_LENGTH } from '../../../../shared/pairing-device-name'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

// Why: the host only ever learns a client's name at pairing time (DeviceEntry.name is set by whoever
// mints the grant), so this field is the one chance to attach a person to the link being generated.
export function RuntimePairingDeviceNameField({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label htmlFor="runtime-pairing-device-name">
        {translate(
          'auto.components.settings.RuntimePairingUrlGenerator.deviceNameLabel',
          'Who is this link for?'
        )}
      </Label>
      <Input
        id="runtime-pairing-device-name"
        value={value}
        // Why: the host caps the name anyway (it is persisted and later broadcast as a presence label),
        // so stop at the same length here rather than silently truncating what the field shows.
        maxLength={PAIRING_DEVICE_NAME_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        placeholder={translate(
          'auto.components.settings.RuntimePairingUrlGenerator.deviceNamePlaceholder',
          'A person or device name'
        )}
        aria-describedby="runtime-pairing-device-name-help"
      />
      <p id="runtime-pairing-device-name-help" className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.RuntimePairingUrlGenerator.deviceNameHelp',
          'Each named link gets its own revocable grant, so two people never share one identity. Leave blank for an unnamed link.'
        )}
      </p>
    </div>
  )
}
