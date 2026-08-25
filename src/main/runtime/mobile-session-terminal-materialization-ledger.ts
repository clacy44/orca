// Tracks which mobile-session terminal tab ids already materialized a PTY
// (RC4/B6): once a dead-PTY tab spawns a serve-<uuid> session, later
// activations reattach to that same id instead of minting a fresh one.
export class MobileSessionTerminalMaterializationLedger {
  private readonly sessionIdByTabId = new Map<string, string>()

  get(tabId: string): string | undefined {
    return this.sessionIdByTabId.get(tabId)
  }

  record(tabId: string, sessionId: string): void {
    this.sessionIdByTabId.set(tabId, sessionId)
  }

  forget(tabId: string): void {
    this.sessionIdByTabId.delete(tabId)
  }
}
