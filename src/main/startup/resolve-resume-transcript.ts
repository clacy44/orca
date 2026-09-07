// S10-21c B2 (design §2 S4): a thin wrapper over session-file-resolver.ts's
// `resolveSessionFilePath` — never modifies that function. Feeds the restore sweep's
// `RestoreSweepDeps#resolveResumeTranscript`: "does this session id name a real conversation,
// or just the `bridge-session` stub Claude Code writes for `--session-id X` before any turn?"
import { readFile } from 'node:fs/promises'
import {
  resolveSessionFilePath,
  type ResolveSessionFileOptions
} from '../native-chat/session-file-resolver'

/** `hasTurn` is true iff the transcript carries >=1 JSON record whose `type` is not
 * `'bridge-session'` — the stub's exact, verified shape (267 B, 1 line,
 * `{"type":"bridge-session",...}`, no other record). An unparseable line is, by that same
 * definition, not equal to the stub record, so it counts as a turn rather than being silently
 * treated as absent. No records at all (empty/whitespace-only file) means `hasTurn` is false.
 * `options` is test-only injectability (mirrors `resolveSessionFilePath`'s own tests) — the
 * production `RestoreSweepDeps` wiring calls this with just the first two arguments. */
export async function resolveResumeTranscript(
  agentType: string,
  sessionId: string,
  options: ResolveSessionFileOptions = {}
): Promise<{ path: string; hasTurn: boolean } | null> {
  const path = await resolveSessionFilePath(agentType, sessionId, options)
  if (!path) {
    return null
  }
  const raw = await readFile(path, 'utf8')
  let hasTurn = false
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      hasTurn = true
      break
    }
    if ((record as { type?: unknown } | null)?.type !== 'bridge-session') {
      hasTurn = true
      break
    }
  }
  return { path, hasTurn }
}
