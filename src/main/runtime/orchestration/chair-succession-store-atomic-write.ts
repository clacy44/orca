// S10-22a WAVE 1: split out of chair-succession-store.ts (line ratchet) — atomic (tmp + rename)
// directory/file writes, shared by every succession-store writer.
import { mkdir, chmod, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/** Creates `dir` (and any missing parents) then forces its own mode to 0700 — `mkdir`'s
 * `recursive` option only reliably applies `mode` to the final path segment across Node
 * versions/umasks, so this `chmod`s explicitly rather than trusting that. */
export async function ensureDirMode0700(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o700)
}

/** Atomic write: unique tmp name in the same directory, write, rename over the target, and clean
 * up the tmp file if anything before the rename throws — never leaves a partial target and never
 * leaves a stray tmp file behind on failure. */
export async function writeAtomic(target: string, contents: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
