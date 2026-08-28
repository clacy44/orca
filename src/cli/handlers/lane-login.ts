import { createInterface } from 'node:readline/promises'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  formatAccountList,
  personName,
  resolveLaneAccount,
  resolvePerson,
  type LaneAccount
} from '../lane-format'
import {
  assertLaneSupported,
  optionalStringFlag,
  readStatus,
  rejectRemoteSelectionFlags,
  requireStringFlag
} from './lane'

/**
 * `orca lane login/logout/accounts/use` (S9-L1 §modules E) — split out of `lane.ts` for its
 * 300-line ratchet. The host-inline login flow: same per-lane session map and write queue a
 * paired grant's `accounts.lane.login*` RPCs use (`lane-login-authority.ts`'s `*Inline` methods),
 * never a copy or a parallel path.
 */

type LaneLoginStartResult = { loginSessionId: string; authorizeUrl: string; expiresAt: number }
type LaneLoginSubmitCodeResult = {
  status: 'completed' | 'rejected'
  identity: { email: string; uuid?: string; organization?: string } | null
  attemptsRemaining: number
}

/** `--code` unset: prompt on THIS terminal, exactly as `orca account add` does — the code never
 * touches a log line or a flag another process on the box could read off the command line. */
async function promptForLoginCode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('Paste the code from the authorization page: ')).trim()
  } finally {
    rl.close()
  }
}

export const LANE_LOGIN_HANDLERS: Record<string, CommandHandler> = {
  'lane login': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const personSelector = requireStringFlag(ctx, 'person')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const principalId = resolvePerson(snapshot.principals, personSelector)

    if (ctx.flags.has('cancel')) {
      const result = await ctx.client.call<{ cancelled: true }>('accounts.lane.loginCancelInline', {
        principalId
      })
      printResult(
        result,
        ctx.json,
        () =>
          `Cancelled the in-flight login for ${personName(snapshot.principals, principalId)}'s lane`
      )
      return
    }

    const expectedEmail = requireStringFlag(ctx, 'email')
    // Non-null only for a scripted run: a wrong scripted code cannot be corrected interactively,
    // so it is a script failure (thrown), never a silent retry loop.
    const scriptedCode = optionalStringFlag(ctx, 'code')

    const started = await ctx.client.call<LaneLoginStartResult>('accounts.lane.loginStartInline', {
      principalId,
      expectedEmail
    })
    if (ctx.json) {
      // Emitted as soon as the session exists, well before the code prompt below blocks on
      // stdin — a scripted `--json --code` caller has nothing else to learn the authorize URL
      // from. The FINAL result line (below, unchanged) still carries the login outcome.
      console.log(
        JSON.stringify({
          event: 'login-started',
          loginSessionId: started.result.loginSessionId,
          authorizeUrl: started.result.authorizeUrl,
          expiresAt: started.result.expiresAt
        })
      )
    } else {
      console.log(
        `Sign in to Claude as ${expectedEmail} for ${personName(snapshot.principals, principalId)}:\n  ${started.result.authorizeUrl}`
      )
    }

    for (;;) {
      const code = scriptedCode ?? (await promptForLoginCode())
      const submitted = await ctx.client.call<LaneLoginSubmitCodeResult>(
        'accounts.lane.loginSubmitCodeInline',
        { principalId, loginSessionId: started.result.loginSessionId, code }
      )
      if (submitted.result.status === 'completed') {
        printResult(
          submitted,
          ctx.json,
          (value) =>
            `Signed ${personName(snapshot.principals, principalId)}'s lane in as ${value.identity?.email ?? expectedEmail}`
        )
        return
      }
      if (scriptedCode !== null) {
        throw new RuntimeClientError(
          'invalid_argument',
          `That code was not accepted (${submitted.result.attemptsRemaining} attempt(s) left). Re-run with a fresh --code.`
        )
      }
      console.log(
        `That code was not accepted. ${submitted.result.attemptsRemaining} attempt(s) left.`
      )
    }
  },
  'lane logout': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const personSelector = requireStringFlag(ctx, 'person')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const result = await ctx.client.call<{ cleared: string[] }>('accounts.lane.logoutInline', {
      principalId
    })
    printResult(
      result,
      ctx.json,
      (value) =>
        `Logged ${personName(snapshot.principals, principalId)}'s lane out (cleared ${value.cleared.length} item(s))`
    )
  },
  'lane accounts': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const personSelector = requireStringFlag(ctx, 'person')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const result = await ctx.client.call<{ accounts: LaneAccount[] }>(
      'accounts.lane.listAccountsInline',
      { principalId }
    )
    printResult(result, ctx.json, (value) => formatAccountList(value.accounts))
  },
  'lane use': async (ctx) => {
    rejectRemoteSelectionFlags(ctx)
    const personSelector = requireStringFlag(ctx, 'person')
    const accountSelector = requireStringFlag(ctx, 'account')
    await assertLaneSupported(ctx.client)
    const snapshot = await readStatus(ctx.client)
    const principalId = resolvePerson(snapshot.principals, personSelector)
    const accountsResult = await ctx.client.call<{ accounts: LaneAccount[] }>(
      'accounts.lane.listAccountsInline',
      { principalId }
    )
    const account = resolveLaneAccount(accountsResult.result.accounts, accountSelector)
    const result = await ctx.client.call<{ active: string }>('accounts.lane.selectAccountInline', {
      principalId,
      laneAccountId: account.laneAccountId
    })
    printResult(
      result,
      ctx.json,
      () => `Switched ${personName(snapshot.principals, principalId)}'s lane to ${account.email}`
    )
  }
}
