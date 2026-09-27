// Why: unit tests must not depend on the integrity level of the shell running them (CI Windows runners are elevated [I]).
import { configureHostIntegrityForTests } from '../../src/main/host-integrity/host-integrity-guard'

configureHostIntegrityForTests({ probe: async () => ({ level: 'n/a', detail: 'vitest default' }) })
