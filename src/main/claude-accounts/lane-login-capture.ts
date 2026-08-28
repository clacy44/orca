/**
 * The post-exit tail of a lane login (S9-L1 A4, §sessionStateMachine, §storeLayout). Owns
 * obligation (4′): a login is promoted into the lane's ACTIVE credential only after identity
 * verification (I6) passes AND a fresh, in-turn re-check finds the session still capturable.
 *
 * Two phases, and the boundary between them is the whole point:
 *  - OUTSIDE any write queue: `claude auth status --json` runs in the login's OWN isolated
 *    directory and is compared against the caller's `expectedEmail`. A mismatch or anything
 *    unverifiable (no identity, a parse failure, an unexpected shape) sweeps the directory and
 *    returns without ever entering a queue — no fallback to `oauth-account.json` (that file does
 *    not exist yet at this point; it is this module's own output).
 *  - INSIDE one `authState.serializeLaneWrite` turn: the session is re-checked (not the
 *    wipe-pending mark — that mark is advisory here, cleared in the wipe's own continuation
 *    after its queue turn resolves, so checking it ALONE would admit a write into a lane the
 *    wipe just certified empty), the credential is promoted into `<lane>/.credentials.json`, the
 *    index row is written, and only THEN is the session marked captured.
 */
import { rmSync } from 'node:fs'
import {
  ClaudeLaneRefusal,
  CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES
} from '../../shared/claude-lane-refusals'
import {
  spawnClaudeCliChildProcess,
  type ClaudeCliChildProcessConfigDir
} from './claude-cli-child-process'
import { readClaudeManagedAuthFile, writeClaudeManagedAuthFile } from './managed-auth-path'
import {
  getLaneAccountsRoot,
  readLaneAccountIndex,
  writeLaneAccountIndex,
  type LaneAccountIndexRow
} from './lane-account-index'
import { resolveContainedLaneAccountEntry } from './principal-lane-account-store'
import { isLaneWipePending } from './lane-wipe-pending'
import { beginClaudeAuthSwitch, endClaudeAuthSwitch } from './live-pty-gate'
import type { LaneAuthState } from './lane-auth-state'
import type { LaneCredentialWriter } from './lane-credential-writer'

/** Bounded probe, not `service.ts`'s ratcheted `STATUS_TIMEOUT_MS` — same value, re-declared. */
const AUTH_STATUS_TIMEOUT_MS = 20_000

export type LaneLoginCaptureResult =
  | { kind: 'captured'; email: string }
  | { kind: 'identity_mismatch' }

export type LaneLoginCaptureContext = {
  laneId: string
  laneDir: string
  laneAccountId: string
  /** `<lane>/claude-accounts/<laneAccountId>/auth` — the login's own isolated CLAUDE_CONFIG_DIR. */
  authDir: string
  expectedEmail: string
  authState: Pick<LaneAuthState, 'serializeLaneWrite'>
  writer: Pick<LaneCredentialWriter, 'writeCredentials' | 'writeOauthAccount'>
  /**
   * Re-checked INSIDE the write-queue turn, never before it — precedence, not queue order, is
   * what makes the fence safe (§sessionStateMachine "PRECEDENCE, why queue order carries no
   * weight"). True only for a session in `live` or `child-exited` — NOT "still `live`", which
   * would refuse every capture, since this turn always runs after the child has exited.
   */
  isStillCapturable(): boolean
  /** Called INSIDE the turn, strictly after the index row is written — that write IS `captured`. */
  onCaptured(): void
}

export async function captureLaneLogin(
  ctx: LaneLoginCaptureContext
): Promise<LaneLoginCaptureResult> {
  const statusOutput = await runAuthStatusJson(ctx.authDir)
  const email = extractStatusEmail(statusOutput)
  const credentialsJson = readClaudeManagedAuthFile(ctx.authDir, '.credentials.json')
  // I6: no fallback to oauth-account.json when `auth status` is silent or the shape is wrong —
  // that is the exact defect this module exists to not repeat (service.ts's `resolveIdentity`).
  if (email === null || email !== ctx.expectedEmail || credentialsJson === null) {
    sweepLaneAccountDir(ctx.laneDir, ctx.laneAccountId)
    return { kind: 'identity_mismatch' }
  }
  const oauthAccount = readOauthAccountFromAuthDir(ctx.authDir)
  writeClaudeManagedAuthFile(
    ctx.authDir,
    'oauth-account.json',
    `${JSON.stringify(oauthAccount, null, 2)}\n`
  )

  return ctx.authState.serializeLaneWrite(ctx.laneId, async () => {
    if (!ctx.isStillCapturable()) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.login_cancelled',
        CLAUDE_LANE_LOGIN_REFUSAL_SENTENCES['accounts.lane.login_cancelled']
      )
    }
    if (isLaneWipePending(ctx.laneId)) {
      throw new ClaudeLaneRefusal(
        'accounts.lane.wipe_in_progress',
        'Orca is clearing this credential lane on the host right now, so it did not finish signing this login in. Nothing was written; sign in again once the lane is ready.'
      )
    }
    beginClaudeAuthSwitch(ctx.laneId)
    try {
      await ctx.writer.writeCredentials(ctx.laneDir, credentialsJson)
      ctx.writer.writeOauthAccount(ctx.laneDir, oauthAccount)
      writeLaneAccountIndex(getLaneAccountsRoot(ctx.laneDir), nextIndexRows(ctx, email))
      // The row above is what "captured" means — nothing earlier in this function is.
      ctx.onCaptured()
    } finally {
      endClaudeAuthSwitch(ctx.laneId)
    }
    return { kind: 'captured', email }
  })
}

function nextIndexRows(ctx: LaneLoginCaptureContext, email: string): LaneAccountIndexRow[] {
  const laneAccountsRoot = getLaneAccountsRoot(ctx.laneDir)
  const rows = readLaneAccountIndex(laneAccountsRoot).map((row) => ({ ...row, active: false }))
  rows.push({
    laneAccountId: ctx.laneAccountId,
    email,
    label: null,
    active: true,
    capturedAt: new Date().toISOString()
  })
  return rows
}

/** A failed or timed-out probe reads as no identity (unverifiable), never as a crash. */
function runAuthStatusJson(authDir: string): Promise<string> {
  return new Promise((resolve) => {
    let buffer = ''
    const configDir: ClaudeCliChildProcessConfigDir = {
      windowsPath: authDir,
      linuxPath: null,
      wslDistro: null
    }
    const { result } = spawnClaudeCliChildProcess(
      ['auth', 'status', '--json'],
      configDir,
      AUTH_STATUS_TIMEOUT_MS,
      { onStdoutChunk: (chunk) => (buffer += chunk) }
    )
    result.then(
      () => resolve(buffer),
      () => resolve(buffer)
    )
  })
}

function extractStatusEmail(statusOutput: string): string | null {
  try {
    const parsed: unknown = JSON.parse(statusOutput)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const email = (parsed as Record<string, unknown>).email
    return typeof email === 'string' && email.trim() !== '' ? email : null
  } catch {
    return null
  }
}

/** Reads the CLI's own written config for the `oauthAccount` block it left in the auth dir. */
function readOauthAccountFromAuthDir(authDir: string): unknown {
  for (const filename of ['.claude.json', '.config.json'] as const) {
    const text = readClaudeManagedAuthFile(authDir, filename)
    if (text === null) {
      continue
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed.oauthAccount) {
        return parsed.oauthAccount
      }
    } catch {
      continue
    }
  }
  return null
}

function sweepLaneAccountDir(laneDir: string, laneAccountId: string): void {
  const laneAccountsRoot = getLaneAccountsRoot(laneDir)
  const contained = resolveContainedLaneAccountEntry(laneAccountsRoot, laneAccountId)
  if (contained) {
    rmSync(contained, { recursive: true, force: true })
  }
}
