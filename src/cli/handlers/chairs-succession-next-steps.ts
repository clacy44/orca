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
  // W-D1-DR1 F2 (Q5): the incumbent pane is ALWAYS already closed by the time this reaches the
  // caller (F1 confirms it dead before the takeover ever runs) — tell the reader that plainly
  // rather than "both panes may be down", which is false for the pane that is reading this.
  succession_takeover_failed: [
    'the incumbent chair pane is already closed and this pane was NOT registered as the chair — do not send or receive chair traffic from it',
    'recover the chair with `orca chairs restore`, run twice at least 10 s apart; chairs.json still names the pre-succession session, so restore resumes the incumbent conversation in a new pane',
    'once the restored chair is up, end this session; the restored chair can retry `orca chairs succeed`'
  ],
  // G1 repair round (attempt 2), N8: five refusals reachable after the wave-2 pass with no map
  // entry — the runtime sent no `nextSteps` for any of them, so a caller saw a bare error code.
  succession_incumbent_exit_timeout: [
    'stand down: this pane is not the chair — do not send or receive chair traffic from it',
    'ask the incumbent (or a human) to check whether the old pane is actually dead',
    'if the old pane later dies on its own, nobody holds the chair: recover with `orca chairs restore`, run twice at least 10 s apart, then retry `orca chairs succeed` from the restored chair'
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
  // H8 (G1-10z attempt-4): the seal-time directory-cap refusal had no map entry, so a caller at
  // the cap saw a bare error code with no guidance. [G1-10z polish-recheck N5 correction] a
  // takeover at the cap throws `succession_takeover_failed`, not this code — see that entry's
  // own comment.
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
    'resume-context.md could not be read; run `orca chairs resume-context` to fetch it separately',
  // [G1-10z polish-recheck N5 repair] H4's guarded post-confirm reads/audits reach the CLI as
  // bare warning ids with no guidance, the same gap H8/H9's fix closed for other warnings.
  outstandingDeliveryReadFailed:
    'outstanding mailbox/run deliveries could not be checked; check your mailbox by hand (`orca orchestration inbox`) before assuming nothing is waiting',
  runGenerationReadFailed:
    "the Run's consumer generation could not be read; treat it as unknown and re-check with `orca orchestration run-use --id <run>` before relying on it",
  confirmedAuditFailed:
    'the `confirmed` audit entry was not written; the succession record itself is still confirmed, only the audit trail is short one entry',
  // [G1-10z polish-recheck N2 repair]
  takeoverCommittedDespiteThrow:
    'the takeover actually committed even though a post-commit step threw; the identity, Run and manifest are on the successor — double check the manifest and Run coordinator match'
}
