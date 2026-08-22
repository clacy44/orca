// Why a frozen list and not a review note: the cross-version harness covers the terminal stream only, so
// nothing else in the tree would fail if presence grew a frame the relay has to carry. §2.7 reasons the
// relay case out on paper — this is what holds that reasoning to the code.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TerminalStreamOpcode } from '../../shared/terminal-stream-protocol'
import { isValidMobileE2EEAuthVersion } from './rpc/mobile-e2ee-auth-validation'

// The relay control link's whole vocabulary as of B2. Presence rides no control message: it is host
// content on already-multiplexed data sockets.
const RELAY_CONTROL_MESSAGE_TYPES = [
  'conn-open',
  'control-error',
  'device-credential-install-status-result',
  'device-credential-installed',
  'device-resume-confirmed',
  'device-revoked',
  'drain',
  'host-challenge',
  'host-hello-ack',
  'invite-created',
  'ping'
]

describe('presence adds no relay frame type', () => {
  it('leaves the relay control message vocabulary unchanged', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./relay/relay-control-protocol.ts', import.meta.url)),
      'utf8'
    )
    const declared = Array.from(source.matchAll(/type:\s*z\.literal\('([^']+)'\)/g)).map(
      (match) => match[1]
    )
    expect(Array.from(new Set(declared)).toSorted()).toEqual(RELAY_CONTROL_MESSAGE_TYPES)
  })

  // Why the exact key set: the v2 auth frame is transcript-bound, so a presence capability smuggled into
  // it would not merely be ignored — it would fail authentication for every phone that sent it.
  it('leaves the e2ee v2 auth frame exact', () => {
    const v2Session = { transcriptHashB64: 'hash' } as never
    expect(
      isValidMobileE2EEAuthVersion(
        { type: 'e2ee_auth', deviceToken: 'tok', v: 2, transcriptHashB64: 'hash' },
        v2Session
      )
    ).toBe(true)
    expect(
      isValidMobileE2EEAuthVersion(
        {
          type: 'e2ee_auth',
          deviceToken: 'tok',
          v: 2,
          transcriptHashB64: 'hash',
          clientCapabilities: { presence: 1 }
        },
        v2Session
      )
    ).toBe(false)
  })

  // Presence rides an existing JSON stream event (`driver-changed`'s channel), which is exactly why it
  // needed no opcode — and why nothing may quietly add one later.
  it('leaves the terminal stream opcode allowlist unchanged', () => {
    expect(
      Object.values(TerminalStreamOpcode)
        .filter((value): value is number => typeof value === 'number')
        .toSorted((left, right) => left - right)
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  })
})
