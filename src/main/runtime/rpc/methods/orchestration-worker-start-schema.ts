import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

export const OptionalWorkerLaunchPreference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
  .optional()

// Why non-negative rather than positive: 0 is the explicit disable of the liveness window (A1
// section 3), so rejecting it would leave a coordinator no way to turn the escalation off.
const OptionalLivenessWindowMs = z
  .unknown()
  .transform((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined
  )
  .pipe(z.union([z.number(), z.undefined()]))
  .optional()

export const WorkerStartParams = z.object({
  task: requiredString('Missing --task'),
  on: OptionalString,
  run: OptionalString,
  from: requiredString('Missing --from'),
  worktree: OptionalString,
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  comment: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  retryOf: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  livenessWindowMs: OptionalLivenessWindowMs,
  devMode: z.boolean().optional()
})

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
