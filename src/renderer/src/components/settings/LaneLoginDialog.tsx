// S9-L2 (design rev 38 §2l/§3/§6): "Sign this lane into an account" — the login-quartet flow.
// Labelled with the principal, the lane and the expected account, which is §4's fourth binding
// and therefore not decoration: the human must see WHO this login is for and WHICH account they
// are about to authenticate as before Orca ever opens a browser.
import { useEffect, useState, type ReactElement } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useLaneLoginQr } from './use-lane-login-qr'

type LaneLoginDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  environmentId: string
  principalLabel: string
  laneLabel: string
  onCompleted: () => void
}

type Stage =
  | { kind: 'expect-email' }
  | { kind: 'starting' }
  | { kind: 'awaiting-code'; loginSessionId: string; authorizeUrl: string; expiresAt: number }
  | { kind: 'submitting'; loginSessionId: string; authorizeUrl: string; expiresAt: number }
  | { kind: 'error'; message: string }
  | { kind: 'completed'; email: string }

export function LaneLoginDialog({
  open,
  onOpenChange,
  environmentId,
  principalLabel,
  laneLabel,
  onCompleted
}: LaneLoginDialogProps): ReactElement {
  const [expectedEmail, setExpectedEmail] = useState('')
  const [code, setCode] = useState('')
  const [stage, setStage] = useState<Stage>({ kind: 'expect-email' })
  const qrDataUrl = useLaneLoginQr(
    stage.kind === 'awaiting-code' || stage.kind === 'submitting' ? stage.authorizeUrl : null
  )

  useEffect(() => {
    if (!open) {
      setExpectedEmail('')
      setCode('')
      setStage({ kind: 'expect-email' })
    }
  }, [open])

  const startLogin = async (): Promise<void> => {
    setStage({ kind: 'starting' })
    const response = await window.api.laneLogin.start(environmentId, expectedEmail.trim())
    if ('refused' in response) {
      setStage({ kind: 'error', message: response.refused.message })
      return
    }
    setStage({
      kind: 'awaiting-code',
      loginSessionId: response.loginSessionId,
      authorizeUrl: response.authorizeUrl,
      expiresAt: response.expiresAt
    })
  }

  const submitCode = async (): Promise<void> => {
    if (stage.kind !== 'awaiting-code') {
      return
    }
    const { loginSessionId, authorizeUrl, expiresAt } = stage
    setStage({ kind: 'submitting', loginSessionId, authorizeUrl, expiresAt })
    const response = await window.api.laneLogin.submitCode(
      environmentId,
      loginSessionId,
      code.trim()
    )
    if ('refused' in response) {
      setStage({ kind: 'error', message: response.refused.message })
      return
    }
    if (response.status === 'rejected') {
      setStage({
        kind: 'error',
        message: translate(
          'auto.components.settings.LaneLoginDialog.codeRejected',
          'That code was not accepted ({{value0}} attempt(s) left). Check the code and try again.',
          { value0: String(response.attemptsRemaining) }
        )
      })
      return
    }
    setStage({ kind: 'completed', email: response.identity?.email ?? expectedEmail.trim() })
    toast.success(
      translate('auto.components.settings.LaneLoginDialog.signedIn', 'Signed in to {{value0}}.', {
        value0: response.identity?.email ?? expectedEmail.trim()
      })
    )
    onCompleted()
  }

  const cancelLogin = async (): Promise<void> => {
    if (stage.kind === 'awaiting-code' || stage.kind === 'submitting') {
      await window.api.laneLogin.cancel(environmentId, stage.loginSessionId)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : void cancelLogin())}>
      <DialogContent className="sm:max-w-md" data-testid="lane-login-dialog">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.settings.LaneLoginDialog.title',
              'Sign this lane into an account'
            )}
          </DialogTitle>
          <DialogDescription data-testid="lane-login-binding">
            {translate(
              'auto.components.settings.LaneLoginDialog.binding',
              'Signing in {{value0}}’s lane on {{value1}}.',
              { value0: principalLabel, value1: laneLabel }
            )}
          </DialogDescription>
        </DialogHeader>

        {stage.kind === 'expect-email' || stage.kind === 'starting' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="lane-login-expected-email">
                {translate(
                  'auto.components.settings.LaneLoginDialog.expectedEmailLabel',
                  'Expected account email'
                )}
              </Label>
              <Input
                id="lane-login-expected-email"
                type="email"
                autoFocus
                value={expectedEmail}
                onChange={(event) => setExpectedEmail(event.target.value)}
                placeholder={translate(
                  'auto.components.settings.LaneLoginDialog.expectedEmailPlaceholder',
                  'name@example.com'
                )}
                data-testid="lane-login-expected-email-input"
              />
              <p className="text-muted-foreground text-xs">
                {translate(
                  'auto.components.settings.LaneLoginDialog.expectedEmailHint',
                  'If you sign in as a different account, Orca refuses the login and removes it.'
                )}
              </p>
            </div>
            <DialogFooter>
              <Button
                onClick={() => void startLogin()}
                disabled={!isEmailShaped(expectedEmail) || stage.kind === 'starting'}
                data-testid="lane-login-start-button"
              >
                {stage.kind === 'starting' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  translate('auto.components.settings.LaneLoginDialog.startButton', 'Start login')
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {stage.kind === 'awaiting-code' || stage.kind === 'submitting' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">
                {translate(
                  'auto.components.settings.LaneLoginDialog.openUrlHint',
                  'Open this link in any browser — a phone works too — and sign in as {{value0}}.',
                  { value0: expectedEmail.trim() }
                )}
              </p>
              <a
                href={stage.authorizeUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary block truncate text-xs underline"
                data-testid="lane-login-authorize-url"
              >
                {stage.authorizeUrl}
              </a>
              {qrDataUrl ? (
                <div className="flex justify-center rounded-lg border border-border/60 bg-white p-3">
                  <img
                    src={qrDataUrl}
                    alt={translate(
                      'auto.components.settings.LaneLoginDialog.qrAlt',
                      'QR code for the login link'
                    )}
                    className="block"
                    style={{ width: 160, height: 160, imageRendering: 'pixelated' }}
                  />
                </div>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lane-login-code">
                {translate(
                  'auto.components.settings.LaneLoginDialog.codeLabel',
                  'Code from the browser'
                )}
              </Label>
              <Input
                id="lane-login-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoFocus
                data-testid="lane-login-code-input"
              />
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => void cancelLogin()}
                data-testid="lane-login-cancel-button"
              >
                {translate('auto.components.settings.LaneLoginDialog.cancelButton', 'Cancel')}
              </Button>
              <Button
                onClick={() => void submitCode()}
                disabled={code.trim().length === 0 || stage.kind === 'submitting'}
                data-testid="lane-login-submit-code-button"
              >
                {stage.kind === 'submitting' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  translate(
                    'auto.components.settings.LaneLoginDialog.submitCodeButton',
                    'Submit code'
                  )
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {stage.kind === 'error' ? (
          <div className="space-y-3">
            <p className="text-destructive text-sm" role="alert" data-testid="lane-login-error">
              {stage.message}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStage({ kind: 'expect-email' })}>
                {translate('auto.components.settings.LaneLoginDialog.tryAgainButton', 'Try again')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {stage.kind === 'completed' ? (
          <div className="space-y-3">
            <p className="text-sm" data-testid="lane-login-completed">
              {translate(
                'auto.components.settings.LaneLoginDialog.completed',
                'Signed in to {{value0}}.',
                { value0: stage.email }
              )}
            </p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>
                {translate('auto.components.settings.LaneLoginDialog.doneButton', 'Done')}
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function isEmailShaped(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
}
