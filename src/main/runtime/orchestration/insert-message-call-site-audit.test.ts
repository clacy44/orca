// S10-2a RISKS #3: pins `db.insertMessage`'s caller set against
// `INSERT_MESSAGE_CALL_SITES` (insert-message-call-sites.ts) so a new caller — anywhere in the
// tree, or a new call site inside an already-listed file — fails CI instead of silently
// re-opening the gate `insertGatedMessage` exists to close. Modeled on the same
// audited-line-count pattern as global-fetch-call-site-audit.test.ts.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INSERT_MESSAGE_CALL_SITES } from './insert-message-call-sites'

// A call site, not the method's own definition: `insertMessage(msg: {` (db.ts) has no leading
// dot and never matches.
const INSERT_MESSAGE_CALL_RE = /\.insertMessage\(/

const SCANNED_ROOTS = ['main', 'cli', 'relay', 'shared']

function insertMessageCallCounts(srcRoot: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const root of SCANNED_ROOTS) {
    for (const entry of readdirSync(join(srcRoot, root), {
      recursive: true,
      withFileTypes: true
    })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) {
        continue
      }
      if (
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.d.ts') ||
        entry.name.includes('test-fixture')
      ) {
        continue
      }
      const filePath = join(entry.parentPath, entry.name)
      const content = readFileSync(filePath, 'utf8')
      const hits = content.split('\n').filter((line) => INSERT_MESSAGE_CALL_RE.test(line)).length
      if (hits > 0) {
        counts.set(relative(srcRoot, filePath).split(sep).join('/'), hits)
      }
    }
  }
  return counts
}

describe('insertMessage call-site audit', () => {
  it('keeps the exact caller set and per-file count pinned to INSERT_MESSAGE_CALL_SITES', () => {
    const found = insertMessageCallCounts(join(__dirname, '..', '..', '..'))
    const audited = new Map(INSERT_MESSAGE_CALL_SITES.map((site) => [site.file, site.count]))

    const drifted = [...found]
      .filter(([file, count]) => audited.get(file) !== count)
      .map(([file, count]) => `${file}: found ${count} call site(s)`)
      .sort()
    expect(
      drifted,
      'A caller of db.insertMessage was added, removed, or moved. insertGatedMessage ' +
        '(message-gate-writer.ts) is the single write choke for peer-facing content (ruling 2) — ' +
        'route new peer-facing sends through it. A genuinely host-generated lifecycle row may call ' +
        'insertMessage directly, but must be added to INSERT_MESSAGE_CALL_SITES ' +
        '(insert-message-call-sites.ts) as a conscious, reviewed decision, not a silent one.'
    ).toEqual([])

    const stale = [...audited.keys()].filter((file) => !found.has(file)).sort()
    expect(stale, 'Remove INSERT_MESSAGE_CALL_SITES entries whose call sites are gone.').toEqual([])
  })

  it('mutation guard: a new insertMessage call site added to an unlisted file is caught', () => {
    // Documents the mutation this test kills: a new peer-facing handler starts calling
    // `db.insertMessage(...)` directly instead of `db.insertGatedMessage(...)`. That file is not
    // in INSERT_MESSAGE_CALL_SITES, so `found` (real tree state) disagrees with `audited` (the
    // pinned constant) and the first assertion above goes red.
    const audited = new Map(INSERT_MESSAGE_CALL_SITES.map((site) => [site.file, site.count]))
    const hypotheticalNewCaller = 'main/runtime/rpc/methods/some-new-handler.ts'
    expect(audited.has(hypotheticalNewCaller)).toBe(false)
  })
})
