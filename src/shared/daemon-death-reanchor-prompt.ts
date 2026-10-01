// Why this charset: no quotes, `%`, `!`, `^`, `&`, `$`, commas or apostrophes, so the text is inert under posix, PowerShell and cmd quoting.
export const DAEMON_DEATH_REANCHOR_PROMPT_CHARSET = /^[A-Za-z .-]+$/

// Host-authored text for a chair relaunched after its terminal host died; it rides argv after `--resume <id>`, never keystrokes.
export const DAEMON_DEATH_REANCHOR_PROMPT =
  'Orca relaunched this session because its terminal host process died. Run your re-anchor ritual now. Then check your ledger for subagents or background tasks that were running when the host died and resume any that did not finish.'
