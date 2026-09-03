// S10-16 (Ruling 29, C8e — D-B13 packaging failure). THE REGISTER
// (src/main/runtime/orchestration/link-binding-constants.ts) is main-process-only and cannot
// ship under the CLI's packaged path (electron-builder does not bundle src/main for the CLI
// entrypoint). These three constants are the ones a CLI consumer (environment-link-binding.ts's
// relative-time rendering) needs, so THIS is their one definition site — src/shared is on both
// the CLI's and the main process's packaged closure. The register re-exports them unchanged
// (never redeclares) so every existing main-side import keeps working; no value is duplicated
// and no value changes.
export const LINK_BINDING_STATUS_MS_PER_SECOND = 1_000
export const LINK_BINDING_STATUS_SECONDS_PER_MINUTE = 60
export const LINK_BINDING_STATUS_SECONDS_PER_HOUR = 3_600
