// S10-21a C3-v2: split out so the lock module and the classification module can both throw a
// typed refusal without importing the (larger) admission orchestrator.
export class LaunchAdmissionRefusedError extends Error {
  readonly reasonCode: string
  constructor(reasonCode: string) {
    super(`launch admission refused: ${reasonCode}`)
    this.name = 'LaunchAdmissionRefusedError'
    this.reasonCode = reasonCode
  }
}
