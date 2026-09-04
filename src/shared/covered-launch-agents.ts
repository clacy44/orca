// S10-21a C3-v2 (errata 5(p) §B, §C.3, §C.4; errata 5(o)/(r)). Pure, testable argv-token
// predicates shared between the launch-admission classifier (agent-launch-admission.ts) and the
// resume-command guard (agent-resume-launch-command.ts). No DB, no IPC, no Node built-ins — this
// file is safe to import from renderer-adjacent code without pulling in main-process weight.

/** [errata 5(o)] The set of agents this slice classifies as COVERED. A future agent joins only
 * after the same argv/env/settings/project-file/stdin probe errata 5(t) ran for claude
 * (§1.4's per-agent verification task). */
export const COVERED_LAUNCH_AGENTS: ReadonlySet<string> = new Set(['claude'])

export function isCoveredLaunchAgent(launchAgent: string | undefined): boolean {
  return launchAgent !== undefined && COVERED_LAUNCH_AGENTS.has(launchAgent)
}

/** [errata 5(p) §C.4 step 5a] Exact-match only — a false positive here refuses a launch outright
 * (never ordered around), so no conservative superset is safe. A repo-wide grep at `14d813fd25`
 * finds zero non-test emissions of this shape. */
export function isSessionIdRefusalToken(token: string): boolean {
  return token === '--session-id' || token.startsWith('--session-id=')
}

/** [errata 5(p) §C.4 step 5b] Exact-match only, same reasoning as `isSessionIdRefusalToken`. */
export function isForkSessionRefusalToken(token: string): boolean {
  return token === '--fork-session' || token.startsWith('--fork-session=')
}

/** [errata 5(p) §C.4 "Effective resume id"] A DELIBERATE superset of the repo's strip guard
 * (`agent-resume-launch-command.ts`'s `isClaudeResumeSelector`, which omits the joined `-r<id>`
 * form because *stripping* a false positive would cut live syntax). Admission classifies rather
 * than strips, so a false positive here only costs coverage on one exotic command — it never
 * breaks a launch. Matches `--resume`, `--resume=<v>`, `--continue`, `--continue=<v>`, and —
 * conservatively — any single-dash token whose first character is `r` or `c` (`-r`, `-r=<v>`,
 * `-r<v>`, `-c`, `-c=<v>`, `-c<v>` included). */
export function isResumeSelectorToken(token: string): boolean {
  if (token === '--resume' || token.startsWith('--resume=')) {
    return true
  }
  if (token === '--continue' || token.startsWith('--continue=')) {
    return true
  }
  return /^-[rc]/.test(token)
}

/** [errata 5(u)] `--continue`/`-c` resolve to the most-recently-ACTIVE session of the *project*,
 * never by id, so they can never carry a matchable id and can never satisfy SELF_RESUME. */
export function isContinueSelectorToken(token: string): boolean {
  return (
    token === '--continue' ||
    token.startsWith('--continue=') ||
    (token.startsWith('-c') && !token.startsWith('--'))
  )
}

/** [errata 5(p) §C.4 "Effective resume id"] Whether `--resume`/`-r` rides its id joined to the
 * selector (`--resume=<v>` / `-r<v>` / `-r=<v>`) rather than as the following token. */
export function resumeSelectorJoinedId(token: string): string | undefined {
  if (token.startsWith('--resume=')) {
    return token.slice('--resume='.length)
  }
  if (token.startsWith('-r=')) {
    return token.slice('-r='.length)
  }
  if (/^-r./.test(token)) {
    return token.slice('-r'.length)
  }
  return undefined
}
