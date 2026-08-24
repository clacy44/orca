import { useEffect } from 'react'
import { startTerminalCredentialLaneFeed } from './terminal-credential-lane-feed'

// Why local-only (S9 §2h/§10(d)): the shared host this design is built for is the desktop's OWN box,
// whose panes key the store by raw pty id — the same ids `terminal.list` returns for the local
// target. A remote host's lane status arrives over the pre-existing `accounts.lane.status` path
// instead, and feeding it here would mis-key against the environment-prefixed pane ids. Mounted once
// by the terminal container so the lane store stays hydrated for every local pane's chip.
export function useTerminalCredentialLaneFeed(): void {
  useEffect(() => startTerminalCredentialLaneFeed({ kind: 'local' }), [])
}
