// Why this charset: no quotes, `%`, `!`, `^`, `&`, `$`, commas or apostrophes, so the text is inert under posix, PowerShell and cmd quoting.
export const DAEMON_DEATH_REANCHOR_PROMPT_CHARSET = /^[A-Za-z .-]+$/

// Host-authored text for a chair relaunched after its terminal host died or Orca restarted; it rides argv after `--resume <id>`, never keystrokes.
export const DAEMON_DEATH_REANCHOR_PROMPT =
  'Orca relaunched this session because the process running it ended when its terminal host died or when Orca or the machine restarted. Treat any tool call or subagent or background shell that was in flight as not finished. Run your re-anchor ritual now. Then check your ledger for that work and resume what did not finish.'
