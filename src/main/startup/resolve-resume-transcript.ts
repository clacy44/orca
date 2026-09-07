// S10-21c B2 (design §2 S4; B2b, D-R145 medium 5/low 9): a thin wrapper over
// session-file-resolver.ts's `resolveSessionFilePath` — never modifies that function. Feeds the
// restore sweep's `RestoreSweepDeps#resolveResumeTranscript`: "does this session id name a real
// conversation, or just the `bridge-session` stub Claude Code writes for `--session-id X`
// before any turn?" B2b bounds the read (real transcripts on this box run tens of MB) and
// distinguishes "this resolver doesn't cover the agent type yet" from "covered and absent".
import { open, stat } from 'node:fs/promises'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import {
  resolveSessionFilePath,
  type ResolveSessionFileOptions
} from '../native-chat/session-file-resolver'

/** [D-R145 medium 5] The discriminator only ever needs the first non-stub record, which lands in
 * the first few hundred bytes of a real conversation — 64 KiB bounds the read+split cost
 * regardless of how large the transcript actually is. */
const PREFLIGHT_READ_BYTES = 64 * 1024

/** `hasTurn` is true iff the bounded read prefix carries >=1 COMPLETE JSON record whose `type`
 * is not `'bridge-session'` — the stub's exact, verified shape (267 B, 1 line,
 * `{"type":"bridge-session",...}`, no other record). An unparseable line is, by that same
 * definition, not equal to the stub record, so it counts as a turn rather than being silently
 * treated as absent. No records at all (empty/whitespace-only file) means `hasTurn` is false.
 * [D-R145 medium 5] When every COMPLETE record in the read prefix is a stub AND the file
 * continues beyond the prefix, `hasTurn` is true — a stub-only transcript is always exactly
 * 267 B, so a larger file is provably a real conversation the bounded read merely could not
 * finish scanning; refusing it would be a false negative, never a loosened check (a stub-only
 * file, unaffected — it is never larger than the prefix). `options` is test-only injectability
 * (mirrors `resolveSessionFilePath`'s own tests) — the production `RestoreSweepDeps` wiring
 * calls this with just the first two arguments.
 * [D-R145 low 9] Returns `{coverage: 'uncovered'}` — a THIRD state, distinct from both a hit and
 * a miss — when `resolveNativeChatTranscriptAgent` does not cover `agentType` yet: today that
 * resolver would return `null` for both "not covered" and "covered but absent", indistinguishably,
 * which would refuse every restore for an agent type this module simply hasn't been taught. */
export async function resolveResumeTranscript(
  agentType: string,
  sessionId: string,
  options: ResolveSessionFileOptions = {}
): Promise<{ path: string; hasTurn: boolean } | { coverage: 'uncovered' } | null> {
  if (!resolveNativeChatTranscriptAgent(agentType)) {
    return { coverage: 'uncovered' }
  }
  const path = await resolveSessionFilePath(agentType, sessionId, options)
  if (!path) {
    return null
  }
  const fileStat = await stat(path)
  const readLength = Math.min(fileStat.size, PREFLIGHT_READ_BYTES)
  const truncated = readLength < fileStat.size
  let raw = ''
  if (readLength > 0) {
    const handle = await open(path, 'r')
    try {
      const buf = Buffer.alloc(readLength)
      await handle.read(buf, 0, readLength, 0)
      raw = buf.toString('utf8')
    } finally {
      await handle.close()
    }
  }
  const lines = raw.split('\n')
  // A truncated read may have cut the final line mid-record — drop it rather than risk parsing
  // a partial JSON fragment as "not the stub" on incomplete evidence.
  const completeLines = truncated ? lines.slice(0, -1) : lines
  let hasTurn = false
  for (const line of completeLines) {
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
  if (!hasTurn && truncated) {
    hasTurn = true
  }
  return { path, hasTurn }
}
