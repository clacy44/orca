import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'

export const AGENT_PROMPT_BRACKETED_PASTE_START = '\x1b[200~'
export const AGENT_PROMPT_BRACKETED_PASTE_END = '\x1b[201~'
export const AGENT_PROMPT_SUBMIT = '\r'

const DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS = 500
const WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS = 1_500

// Why: ConPTY renders long bracketed pastes more slowly; an early Enter leaves the task in the agent input buffer.
export function getAgentPromptSubmitDelayMs(platform: NodeJS.Platform): number {
  return platform === 'win32'
    ? WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS
    : DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS
}

export const AGENT_PROMPT_SUBMIT_DELAY_MS = getAgentPromptSubmitDelayMs(process.platform)

const ESCAPE = '\x1b'
const INERT_ESCAPE = '<ESC>'

export function sanitizeAgentPromptText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}${INERT_ESCAPE}`
    start = escapeIndex + ESCAPE.length
    escapeIndex = text.indexOf(ESCAPE, start)
  }
  return sanitized + text.slice(start)
}

export function buildAgentPromptPasteBytes(prompt: string): string {
  return `${AGENT_PROMPT_BRACKETED_PASTE_START}${sanitizeAgentPromptText(prompt)}${AGENT_PROMPT_BRACKETED_PASTE_END}`
}

export function buildAgentPromptSubmitBytes(): string {
  return AGENT_PROMPT_SUBMIT
}

// S10-19 W-3 (Ruling 24(a) FULL profile): the ONE byte set stripped from a peer-supplied taskSpec
// before the full-profile paste, so exactly one host submit ('\r', the paste's own trailing
// Enter) ever reaches the pane — sanitizeAgentPromptText (above) neutralises ESC only and is not
// sufficient on its own (a raw '\r'/'\n' self-submits at a cooked-mode shell; '\x04' is EOF).
export const AGENT_PROMPT_SUBMIT_BYTES: readonly string[] = [
  '\r',
  '\n',
  '\x04',
  ESCAPE,
  ...Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).filter(
    (c) => c !== '\r' && c !== '\n' && c !== ESCAPE
  )
]

export function stripAgentPromptSubmitBytes(text: string): string {
  let result = ''
  for (const char of text) {
    if (!AGENT_PROMPT_SUBMIT_BYTES.includes(char)) {
      result += char
    }
  }
  return result
}

export function* iterateAgentPromptPasteChunks(
  prompt: string,
  maxChunkBytes = TERMINAL_INPUT_CHUNK_MAX_BYTES
): Generator<string> {
  yield* iterateTerminalInputChunks(buildAgentPromptPasteBytes(prompt), maxChunkBytes)
}
