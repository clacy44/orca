import { describe, expect, it } from 'vitest'
import { APPIMAGE_CLI_COMMAND_NAMES } from '../main/startup/appimage-cli-command-names'
import { specPaths } from './command-spec'
import { COMMAND_SPECS } from './specs'

// Why this test lives under src/cli: the AppImage redirect hand-copies the CLI's top-level verb
// names into a plain array because the main tsconfig cannot import the CLI project, so the parity
// check has to run from the CLI side. It fails when a spec grows a new top-level verb (or an
// alias with a different one) that a direct `<AppImage> <verb> …` launch on Linux would silently
// fail to recognize — falling through to a normal desktop-app boot, which hits the Electron
// single-instance lock (exit 3) whenever a `serve` is already running (stablyai/orca).

const topLevelVerbs = [
  ...new Set(COMMAND_SPECS.flatMap((spec) => specPaths(spec).map((path) => path[0])))
].sort()
const allowListedNames = new Set(APPIMAGE_CLI_COMMAND_NAMES)

describe('AppImage CLI command-name allow-list parity with the CLI spec registry', () => {
  it('has verbs to compare against', () => {
    expect(topLevelVerbs.length).toBeGreaterThan(0)
  })

  it.each(topLevelVerbs)('allow-lists the %s verb for direct AppImage CLI launches', (verb) => {
    expect(allowListedNames).toContain(verb)
  })
})
