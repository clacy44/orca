/** The three identity fields Orca parses out of a Claude credential blob (S9 §2b). */
export type ClaudeCredentialIdentity = {
  accountUuid: string | null
  email: string | null
  organizationUuid: string | null
}
