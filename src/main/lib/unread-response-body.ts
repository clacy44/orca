// Ruling 29 (CLI import boundary): the implementation lives in src/shared so both cli and
// main call sites can import it; this re-export keeps existing main/* imports unchanged.
export { cancelUnreadResponseBody } from '../../shared/fetch-response-body'
