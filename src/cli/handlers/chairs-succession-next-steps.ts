// G1 attempt-3 repair F10: split out of chairs-succession.ts (line ratchet) — the
// succession/checkpoint refusal-code next-steps map and the post-takeover WARNINGS guidance
// map, both pure data, no I/O.
// Why this map, not raw RPC refusals: `format.ts`'s `formatCliError` already renders any
// `nextSteps` the runtime attaches to `error.data` (src/cli/format.ts:87-90,134-138) — this map
// only fills the gap for succession/checkpoint refusal codes where the runtime sends none, the
// same pattern `computer-use-error-recovery.ts` uses for `computer` command codes (cited at
// src/cli/format.ts:94).
export const SUCCESSION_NEXT_STEPS: Record<string, string[]> = {
  succession_not_a_chair: [
    'Run this from a chair pane; only a Run-bound chair may call `orca chairs succeed`.'
  ],
  succession_no_run: [
    'Bind a Run first (`orca orchestration run-use --id <run>` or create one), then retry.'
  ],
  succession_legacy_run: [
    'This Run predates succession support; finish it without succession, or migrate the Run before retrying.'
  ],
  succession_active_dispatch: [
    'Wait for the outstanding dispatch to settle, or release it, before retrying `orca chairs succeed`.'
  ],
  succession_in_flight: [
    'A succession for this chair is already sealed or launching; run `orca chairs resume-context` on the successor, or wait for it to resolve, before starting another.'
  ],
  succession_charter_missing: [
    "Set the chair's manifest `succession.charterPath` to an existing charter file, then retry."
  ],
  succession_unacked_delivery: [
    'Acknowledge the listed delivery ids (pass each with `--ack <id>`), then retry.'
  ],
  checkpoint_schema: [
    "Make the checkpoint's first non-empty line read exactly `schema: orca.chair-checkpoint/1`."
  ],
  checkpoint_sections: [
    'Fix the checkpoint to have exactly the eight required `## ` headings, in order, with exact titles.'
  ],
  checkpoint_empty_section: ['Fill in the empty section, or write the literal `none`, then retry.'],
  checkpoint_fence_line: [
    'Remove the code-fence delimiter (```` ``` ```` or `~~~`) from the checkpoint body.'
  ],
  checkpoint_tag_line: ['Remove the line that looks like a system tag from the checkpoint body.'],
  checkpoint_too_large: [
    'Shorten the checkpoint: each section must fit 8 KiB and the whole file 32 KiB.'
  ],
  checkpoint_secret_shape: ['Remove the credential-shaped text from the checkpoint, then retry.'],
  checkpoint_unsupported_claim: [
    'Cite the approving message id (`msg_` + 12 hex) for any claimed owner approval, or remove the claim.'
  ],
  succession_unknown: [
    'Check the succession id; it may already have resolved or expired. Use the id your launch context named.'
  ],
  succession_wrong_pane: [
    'Run `orca chairs succession-accept` from the successor pane the succession named, not this one.'
  ],
  succession_not_launching: [
    'This succession is not awaiting acceptance (already confirmed or aborted); nothing to accept.'
  ],
  succession_expired: [
    'The acceptance window passed and the succession was aborted; ask the incumbent chair to run `orca chairs succeed` again.'
  ],
  succession_takeover_failed: [
    'Both panes may be down: run `orca chairs restore` twice, ten seconds apart, then retry from the restored chair.'
  ],
  // G1 repair round (attempt 2), N8: five refusals reachable after the wave-2 pass with no map
  // entry — the runtime sent no `nextSteps` for any of them, so a caller saw a bare error code.
  succession_incumbent_exit_timeout: [
    'stand down: this pane is not the chair — do not send or receive chair traffic from it',
    'ask the incumbent (or a human) to check whether the old pane is actually dead',
    'once confirmed dead, a fresh `orca chairs succeed` from the incumbent (if reachable) or manual recovery can retry'
  ],
  succession_run_moved: [
    'The incumbent no longer holds the Run this succession was sealed for; ask the incumbent to re-run `orca chairs succeed` against its CURRENT Run.'
  ],
  succession_unknown_ack: [
    '--ack named an id with no outstanding delivery; drop it (or fix the typo) and retry.'
  ],
  succession_lane_unsupported: [
    'Chair succession (slice 1) only supports the host default lane; move this pane off its named credential lane before retrying.'
  ],
  resume_context_too_large: [
    'Shorten the checkpoint or the board state so the rendered resume context fits the size cap, then retry.'
  ],
  // G1 attempt-3 repair F10: two refusal codes this round can newly reach the caller with no map
  // entry — charter_invalid (embed-mode charter validation, chair-checkpoint.ts) and runtime_busy
  // (the long-poll admission cap, runtime-rpc.ts).
  charter_invalid: [
    "Fix the chair's charter (fence/tag/CR-class-line/size rules — same shape as a checkpoint) at its succession.charterPath, then retry."
  ],
  runtime_busy: [
    'The host is at its long-poll capacity; wait a few seconds and retry (a backoff, not a permanent refusal).'
  ],
  // H8 (G1-10z attempt-4): the directory-cap refusal (seal time and the dead-pane takeover) had
  // no map entry, so a caller at the cap saw a bare error code with no guidance.
  succession_directory_full: [
    'The agent directory is at its cap; retire an unused agent (`orca agents retire`) or free a slot, then retry.'
  ]
}

// G1 attempt-3 repair F10: `WARNINGS` used to just name the failed step — print what to check by
// hand for each one, not just its bare identifier.
export const WARNING_GUIDANCE: Record<string, string> = {
  runBindFailed:
    'run may still be bound to the retired pane; check with `orca orchestration run-use --id <run>`',
  retiredHandleAppendFailed:
    'retired-handles.json may be missing this entry; the old handle may still receive mail',
  manifestWriteFailed:
    "chairs.json's lastSessionId was not updated; a reboot's `chairs restore` may resume the pre-succession session",
  confirmTransitionFailed:
    'the succession record may still read `confirming`; a restart resolves it via the startup scan',
  purgeFailed:
    'old succession directories/retired handles were not trimmed this time; harmless, retried on the next confirm',
  resumeContextReadFailed:
    'resume-context.md could not be read; run `orca chairs resume-context` to fetch it separately'
}
