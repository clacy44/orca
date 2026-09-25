// [G1-10z B4 repair; G1-10z attempt-2 Q7 repair] Before B4, `orca serve` never ran the
// succession startup scan or loaded the retired-handle index at all (only the desktop-only sweep
// body did) — a stuck sealed/launching record wedged the chair's `succeed` call forever on serve,
// and a retired handle's mail was never rewritten. `chair-succession-startup-hook.test.ts` proves
// the hook's OWN behaviour (calling it directly, "the way orca serve's call site reaches it" per
// its own docstring) but never proves the serve call site still reaches it — attempt-1's B4 test
// called the hook directly and could not have caught a regression that deleted or reordered the
// serve branch's call. `src/main/index.ts` is a ~3800-line Electron bootstrap module with heavy
// module-scope `app`/`BrowserWindow` side effects on import (verified: no other test in this repo
// imports it directly) — importing it here to execute the real serve branch is not a safe,
// narrow test. Instead this asserts the WIRING textually, the same call-site-audit idiom
// `global-fetch-call-site-audit.test.ts` already uses in this repo: the serve branch's ONE call
// site (`if (serveOptions) { … await runStartupRestoreSweep(runtime) … }`) calls
// `runStartupRestoreSweep`, never `runStartupRestoreSweepBody` (the desktop-only variant with no
// lock acquire/release) — and `runStartupRestoreSweep`'s own definition calls
// `runChairSuccessionStartupHook` as its first statement, before the ordinary pane restore sweep
// (D-R215 step 9's own order). A regression in either link breaks this test.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX_PATH = join(__dirname, 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf8')

function functionBody(name: string): string {
  const startMatch = source.match(new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{`))
  if (!startMatch || startMatch.index === undefined) {
    throw new Error(`function ${name} not found in index.ts`)
  }
  let depth = 1
  let i = startMatch.index + startMatch[0].length
  const bodyStart = i
  for (; i < source.length && depth > 0; i += 1) {
    if (source[i] === '{') {
      depth += 1
    } else if (source[i] === '}') {
      depth -= 1
    }
  }
  return source.slice(bodyStart, i)
}

describe('index.ts serve branch: the succession startup hook is reachable on the serve path', () => {
  it('runStartupRestoreSweep (the serve-branch function) calls runChairSuccessionStartupHook as its first statement', () => {
    const body = functionBody('runStartupRestoreSweep')
    const firstStatement = body.trim().split('\n')[0]?.trim() ?? ''
    expect(firstStatement).toBe('await runChairSuccessionStartupHook(runtimeService)')
  })

  it('the `if (serveOptions)` startup block calls runStartupRestoreSweep(runtime), not the desktop-only runStartupRestoreSweepBody', () => {
    const serveBlockStart = source.indexOf('if (serveOptions) {')
    expect(serveBlockStart).toBeGreaterThan(-1)
    // Bounded window past the serve branch's opening brace — generous enough to cover the
    // startup-sweep call (measured: ~30 lines past the branch open at 361c170171) without
    // scanning the whole rest of the file for an unrelated match.
    const window = source.slice(serveBlockStart, serveBlockStart + 4000)
    expect(window).toContain('await runStartupRestoreSweep(runtime)')
    expect(window).not.toContain('runStartupRestoreSweepBody(runtime)')
  })

  it('runChairSuccessionStartupHook is imported from the shared hook module (both serve and desktop call the SAME function)', () => {
    expect(source).toContain(
      "import { runChairSuccessionStartupHook } from './startup/chair-succession-startup-hook'"
    )
  })
})
