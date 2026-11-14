/**
 * @internal — adapter wiring for observability: the maintenance-warning
 * sink adapters hand to their maintenance dispatch, and the canonical-line
 * flush for verifier-rejected requests.
 *
 * Mirrors `_internal/testing`: intentionally NOT in `publishConfig.exports`,
 * so the published package does not surface it.
 */
export { flushUnauthorizedAndRespond } from "../observability/canonical.ts";
export { logMaintenanceWarning } from "../observability/logger.ts";
