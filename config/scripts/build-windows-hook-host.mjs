#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  // Why: electron-builder treats a skipped native build like success and can
  // continue toward a Windows package whose declared orca-hook-host.exe does not exist.
  throw new Error(
    'Windows hook host compilation requires a Windows host; refusing to package without it.'
  )
}

const repoRoot = resolve(import.meta.dirname, '../..')
const sourcePath = join(repoRoot, 'native', 'windows-hook-host', 'OrcaHookHost.cs')
const outputPath = readArg('--output') ?? defaultOutputPath(repoRoot)
const compilerPath = findFrameworkCompiler(process.env)

if (!compilerPath) {
  throw new Error('Unable to find the .NET Framework C# compiler required for orca-hook-host.exe.')
}

mkdirSync(dirname(outputPath), { recursive: true })
const result = spawnSync(
  compilerPath,
  ['/nologo', '/target:winexe', '/optimize+', '/warnaserror+', `/out:${outputPath}`, sourcePath],
  { cwd: repoRoot, stdio: 'inherit' }
)

if (result.signal) {
  process.kill(process.pid, result.signal)
}
if (result.error) {
  throw result.error
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

function defaultOutputPath(projectRoot) {
  return join(projectRoot, 'native', 'windows-hook-host', '.build', 'orca-hook-host.exe')
}

function findFrameworkCompiler(env) {
  const windowsDirectory = env.WINDIR ?? env.SystemRoot
  if (!windowsDirectory) {
    return null
  }
  const candidates = [
    join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}
