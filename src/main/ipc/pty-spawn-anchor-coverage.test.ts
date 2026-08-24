import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_DIR = join(__dirname, '..')

/**
 * Every `.spawn(` above the provider layer, with the reason each one is not a lane edge.
 *
 * §2's claim is repo-wide — "every terminal PTY in `src/main` is created by exactly three
 * `provider.spawn` calls above the provider layer" — so counting inside `ipc/pty.ts` alone would
 * stay green for a spawn added in a sibling module. A new entry here is not a failure by itself;
 * it is the classification this test exists to force.
 */
const SPAWN_SITES_ABOVE_THE_PROVIDER_LAYER: Record<string, number> = {
  // The anchor: `computeLaneLaunch` then `provider.spawn`, for both fresh-spawn edges.
  'ipc/lane-pinned-spawn.ts': 1,
  // The exempt reattach — `attachOnly: true`, no command, and it proves the same incarnation.
  'ipc/pty.ts': 1,
  // Above pty.ts, not beside it: both route into the controller edge that reaches the anchor.
  'runtime/orca-runtime.ts': 2,
  // node-pty directly, for a usage probe rather than a terminal pane (§2m(5)'s collapse sites).
  'rate-limits/claude-pty.ts': 1,
  'rate-limits/codex-fetcher.ts': 1,
  // child_process, not a PTY at all.
  'linux-lid-sleep-assertion.ts': 1,
  'macos-system-sleep-assertion.ts': 1
}

/** `providers/` is the layer itself; `daemon/` implements `IPtyProvider` and passes opts verbatim. */
const PROVIDER_LAYER_DIRS = ['providers', 'daemon']

function sourceFilesAboveTheProviderLayer(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!PROVIDER_LAYER_DIRS.includes(relative(MAIN_DIR, path))) {
        files.push(...sourceFilesAboveTheProviderLayer(path))
      }
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      files.push(path)
    }
  }
  return files
}

function countSpawnCalls(source: string): number {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => line.includes('.spawn(')).length
}

describe('spawn-anchor coverage of src/main', () => {
  it('has no `.spawn(` above the provider layer that is not a classified site', () => {
    const found: Record<string, number> = {}
    for (const file of sourceFilesAboveTheProviderLayer(MAIN_DIR)) {
      const calls = countSpawnCalls(readFileSync(file, 'utf8'))
      if (calls > 0) {
        found[relative(MAIN_DIR, file).split(sep).join('/')] = calls
      }
    }

    expect(found).toEqual(SPAWN_SITES_ABOVE_THE_PROVIDER_LAYER)
  })

  it('reaches a provider for a fresh process only through spawnWithLane', () => {
    const source = readFileSync(join(__dirname, 'pty.ts'), 'utf8')

    expect(source.match(/spawnWithLane\(/g) ?? []).toHaveLength(2)
    expect(source.match(/provider\.spawn\(/g) ?? []).toHaveLength(1)
  })

  it('exempts exactly one call — the reattach, which proves it reattached', () => {
    const source = readFileSync(join(__dirname, 'pty.ts'), 'utf8')
    const reattach = source.slice(source.indexOf('await provider.spawn({'))

    expect(reattach.slice(0, 400)).toContain('attachOnly: true')
    expect(source).toContain("throw new Error('terminal_pane_owner_changed')")
  })
})
