// [R200/R185] INV-P-LAUNCH-EDGE: a shell that titles itself after the command it is about to
// run is not the agent. oh-my-zsh preexec emits the FULL command line as OSC2 and the command
// NAME as OSC1 (lib/termsupport.zsh:21-22, :99-102), and extractAllOscTitles feeds both to the
// detector in byte order (terminal-output-side-effects.ts:194-199). Pure and file-local so it
// is unit testable without the runtime harness — same precedent as
// orchestration/launch-prompt-fence.ts.
import { AGENT_NAMES } from './agent-name-token-match'
import { COMMAND_TOKEN_SCAN_MAX_CHARS, getCommandTokenPathBasename } from './command-token-scanner'

const BARE_AGENT_NAME_TITLE_RE = new RegExp(
  `^(?:${AGENT_NAMES.join('|')})(?:\\.(?:exe|cmd|bat|ps1))?$`,
  'i'
)
const WINDOWS_EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.ps1']
// Why: omz preexec picks the first word that is not an assignment, a flag, or one of these
// wrappers (lib/termsupport.zsh:99).
const PREEXEC_SKIPPED_WRAPPERS = new Set(['sudo', 'ssh', 'mosh', 'rake', 'env', 'nohup', 'exec'])
const PREEXEC_TOKEN_SCAN_LIMIT = 8
// zsh `%100>...>` appends this where it truncated (lib/termsupport.zsh:102).
const TRUNCATION_MARKERS = ['...', '…']
const MIN_TRUNCATED_PREFIX = 8

/** True when `title`, trimmed, is EXACTLY one agent-name token (optionally with a Windows
 *  executable suffix). Never a substring, never a decorated title: `claude` yes, `✳ claude`,
 *  `claude ready`, `Codex ready` no.
 *  [C3] With `agentName` given, matches only THAT name (`.exe`/`.cmd`/`.bat`/`.ps1` tolerated) —
 *  not any AGENT_NAMES token. Omit `agentName` to keep the general (any-agent) shape. */
export function isBareAgentNameTitle(title: string, agentName?: string): boolean {
  const trimmed = title.trim()
  if (agentName === undefined) {
    return BARE_AGENT_NAME_TITLE_RE.test(trimmed)
  }
  const trimmedLower = trimmed.toLowerCase()
  const nameLower = agentName.toLowerCase()
  if (trimmedLower === nameLower) {
    return true
  }
  return WINDOWS_EXECUTABLE_SUFFIXES.some((suffix) => trimmedLower === nameLower + suffix)
}

/** True when `title` is the shell's own echo of `launchCommand` — the full line (OSC2, possibly
 *  zsh-truncated), or the command name the shell derives for the tab title (OSC1). */
export function isLaunchCommandEchoTitle(
  title: string,
  launchCommand: string | null | undefined
): boolean {
  if (typeof launchCommand !== 'string') {
    return false
  }
  const command = launchCommand.trim()
  const trimmed = title.trim()
  if (command.length === 0 || trimmed.length === 0) {
    return false
  }
  if (trimmed === command) {
    return true
  }
  for (const marker of TRUNCATION_MARKERS) {
    if (trimmed.length > marker.length && trimmed.endsWith(marker)) {
      const prefix = trimmed.slice(0, -marker.length)
      if (prefix.length >= MIN_TRUNCATED_PREFIX && command.startsWith(prefix)) {
        return true
      }
    }
  }
  const name = shellPreexecCommandName(command)
  return name.length > 0 && trimmed.toLowerCase() === name.toLowerCase()
}

function shellPreexecCommandName(command: string): string {
  const scanned = command.slice(0, COMMAND_TOKEN_SCAN_MAX_CHARS)
  let inspected = 0
  for (const rawToken of scanned.split(/\s+/)) {
    if (rawToken.length === 0) {
      continue
    }
    if (inspected >= PREEXEC_TOKEN_SCAN_LIMIT) {
      return ''
    }
    inspected += 1
    if (rawToken.startsWith('-') || rawToken.includes('=')) {
      continue
    }
    const base = getCommandTokenPathBasename(rawToken.replace(/^["']|["']$/g, ''))
    if (base.length === 0 || PREEXEC_SKIPPED_WRAPPERS.has(base.toLowerCase())) {
      continue
    }
    return base
  }
  return ''
}
