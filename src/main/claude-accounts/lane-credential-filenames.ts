/**
 * The two filenames every lane-credential writer, sweeper and reader must agree on byte-for-byte.
 *
 * Split out of `principal-lane-credential-sweep.ts` so `lane-credential-writer.ts` need not
 * import that module at all — it otherwise closed an import cycle back through
 * `principal-lane-account-store.ts` (S9-L1 B2's `purgeLaneAccountStore`, wired into
 * `wipeLaneCredentials`).
 */
export const LANE_CREDENTIALS_FILENAME = '.credentials.json'
export const LANE_CONFIG_FILENAME = '.claude.json'
