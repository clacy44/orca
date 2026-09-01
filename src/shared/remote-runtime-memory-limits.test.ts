import { describe, expect, it } from 'vitest'
import {
  isRemoteRuntimeBinaryFrameWithinLimit,
  measureRemoteRuntimeSubscriptionParams,
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES,
  serializeRemoteRuntimePayload,
  serializeRemoteRuntimeRpcRequest
} from './remote-runtime-memory-limits'

describe('remote runtime memory limits', () => {
  it('accepts exact outbound JSON bytes and rejects the next byte', () => {
    expect(
      serializeRemoteRuntimePayload('x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 2))
    ).toHaveLength(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES)

    expect(() =>
      serializeRemoteRuntimePayload('x'.repeat(REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES - 1))
    ).toThrow(`exceeds ${REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES} bytes`)
  })

  it('accepts exact retained parameter bytes and rejects the next byte', () => {
    expect(
      measureRemoteRuntimeSubscriptionParams(
        'x'.repeat(REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES - 2)
      )
    ).toBe(REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES)

    expect(() =>
      measureRemoteRuntimeSubscriptionParams(
        'x'.repeat(REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES - 1)
      )
    ).toThrow(`exceed ${REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES} bytes`)
  })

  it('accepts an exact outbound binary frame and rejects the next byte', () => {
    expect(
      isRemoteRuntimeBinaryFrameWithinLimit(
        new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES)
      )
    ).toBe(true)
    expect(
      isRemoteRuntimeBinaryFrameWithinLimit(
        new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1)
      )
    ).toBe(false)
  })

  // S10-18: this is the only egress of orchestrationCompatibilityEvidence to a REMOTE runtime —
  // a launch-token preimage and the host stamp (connectionIncarnation/attachmentId are
  // classified as secrets and attachmentId is a bearer lookup key) must never reach the wire,
  // even though both were present in the envelope handed in.
  it('drops launchToken and host from orchestrationCompatibilityEvidence and keeps the other fields', () => {
    const serialized = serializeRemoteRuntimeRpcRequest({
      requestId: 'req-1',
      deviceToken: 'device-token',
      method: 'orchestration.federationPull',
      params: { dispatchId: 'dispatch-1' },
      envelope: {
        orchestrationCapability: 'capability',
        orchestrationContractVersion: 1,
        orchestrationRequestId: 'request-1',
        compatibilityInvocationId: 'compatibility-1',
        orchestrationCompatibilityEvidence: {
          terminalHandle: 'term-1',
          paneKey: 'pane-1',
          launchToken: 'launch-1',
          host: { kind: 'wsl', hostId: 'host-1', distro: 'ubuntu' }
        }
      }
    })

    const parsed = JSON.parse(serialized)
    expect(parsed.orchestrationCompatibilityEvidence).toEqual({
      terminalHandle: 'term-1',
      paneKey: 'pane-1'
    })
    expect(serialized).not.toContain('launch-1')
    expect(serialized).not.toContain('host-1')
    expect(parsed.orchestrationCapability).toBe('capability')
    expect(parsed.compatibilityInvocationId).toBe('compatibility-1')
  })

  it('leaves orchestrationCompatibilityEvidence undefined when no envelope evidence is given', () => {
    const serialized = serializeRemoteRuntimeRpcRequest({
      requestId: 'req-2',
      deviceToken: 'device-token',
      method: 'status.get',
      params: undefined
    })

    const parsed = JSON.parse(serialized)
    expect(parsed.orchestrationCompatibilityEvidence).toBeUndefined()
  })
})
