// S10-21a C3-v2c (errata 5(p) v2.1 §C.5, T44; extended D-R104 F-14). `LaunchAdmission`'s
// `kind: 'host-resume'` variant is a non-wire, in-process descriptor — no RPC/IPC params schema,
// renderer, relay, preload or shared module may ever name it (only `agent-launch-admission.ts`'s
// own type declaration does, and the sweep that will construct one, C3a-v2, is not landed yet).
// This fails if the literal `'host-resume'` appears in any rpc/ipc-schema/relay/renderer/preload/
// shared module.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
// [D-R104 F-14] Extended to src/preload and src/shared — the fence's own name promises
// "no rpc/ipc-schema/relay/renderer module", but a wire-adjacent module reachable from
// preload or shared code is exactly as capable of carrying the literal onto the wire.
const FORBIDDEN_ROOTS = [
  resolve(REPO_ROOT, 'src', 'main', 'runtime', 'rpc'),
  resolve(REPO_ROOT, 'src', 'relay'),
  resolve(REPO_ROOT, 'src', 'renderer'),
  resolve(REPO_ROOT, 'src', 'preload'),
  resolve(REPO_ROOT, 'src', 'shared')
]
// ipc/*: every module EXCEPT the admission descriptor's own type declaration and this fence's own
// source (which necessarily names the literal it scans for).
const IPC_ROOT = resolve(REPO_ROOT, 'src', 'main', 'ipc')
const IPC_ALLOWED_FILES = new Set(
  [
    'agent-launch-admission.ts',
    'agent-launch-admission.test.ts',
    'agent-launch-admission-host-resume-literal-fence.test.ts'
  ].map((f) => join(IPC_ROOT, f))
)

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(path)
    }
    return entry.isFile() && (path.endsWith('.ts') || path.endsWith('.tsx')) ? [path] : []
  })
}

const HOST_RESUME_LITERAL_RE = /['"]host-resume['"]/

type Offense = { file: string }

function findOffenses(): Offense[] {
  const offenses: Offense[] = []
  const roots = [...FORBIDDEN_ROOTS, IPC_ROOT]
  for (const root of roots) {
    for (const file of listSourceFiles(root)) {
      if (root === IPC_ROOT && IPC_ALLOWED_FILES.has(file)) {
        continue
      }
      const source = readFileSync(file, 'utf-8')
      if (HOST_RESUME_LITERAL_RE.test(source)) {
        offenses.push({ file: file.slice(REPO_ROOT.length + 1) })
      }
    }
  }
  return offenses
}

describe("'host-resume' literal fence (T44)", () => {
  it('the guard scans a non-empty set of files (matcher sanity)', () => {
    const totalFiles = [...FORBIDDEN_ROOTS, IPC_ROOT].reduce(
      (n, root) => n + listSourceFiles(root).length,
      0
    )
    expect(totalFiles).toBeGreaterThan(0)
  })

  it('no rpc/ipc-schema/relay/renderer module names the host-resume literal', () => {
    expect(findOffenses()).toEqual([])
  })
})
