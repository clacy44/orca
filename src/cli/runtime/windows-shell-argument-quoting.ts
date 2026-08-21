import { RuntimeClientError } from './types'

// Why: Node joins argv with spaces and never quotes under `shell: true` (the Windows .cmd/.bat shim
// case), so an unquoted value with spaces reaches the child as two tokens and cmd.exe metacharacters in
// it execute. `--pair-name` is the first serve flag whose value is arbitrary human text.
const NEEDS_CMD_QUOTING = /[\s&|<>^()]/

// Why: cmd expands %VAR% inside quotes too and has no command-line escape for `%` (the same reason Rust
// refuses `%` and CR in batch-file arguments), so refuse instead of passing a value that would mutate. A
// literal `"` is refused for the same reason: cmd would read it as the end of the quoted run.
const UNQUOTABLE_FOR_CMD = /["%\r\n]/

/** Quotes one argv token for a cmd.exe shim launch; throws when the token cannot be quoted safely. */
export function quoteWindowsShellArgument(argument: string): string {
  if (UNQUOTABLE_FOR_CMD.test(argument)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Arguments passed through a Windows command shim cannot contain ", % or line breaks.'
    )
  }
  if (argument.length > 0 && !NEEDS_CMD_QUOTING.test(argument)) {
    return argument
  }
  // Why: CommandLineToArgvW lets a trailing backslash run escape the closing quote, so double it.
  return `"${argument.replace(/(\\+)$/, '$1$1')}"`
}
