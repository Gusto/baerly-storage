export * from "./compactor";
export * from "./contract";
export * from "./db";
export * from "./gc";
export * from "./http/router";
export {
  longPollSince,
  listEventsSince,
  type LongPollSinceOptions,
  type ListEventsSinceOptions,
} from "./http/since";
export * from "./maintenance";
export * from "./query";
export * from "./server-writer";
export * from "./table";

/**
 * Re-export of {@link claimWriter} from `@baerly/protocol`. Bumping
 * the fence causes any in-flight {@link ServerWriter} commit
 * holding the prior epoch to fail-fast with
 * `MPS3Error{code:"Conflict"}` after its CAS PUT lands (the
 * stale writer's CAS itself may succeed — the fence check is
 * post-write — but the commit return is aborted before the
 * caller observes success). Reserved for admin rotation
 * workflows and initial provisioning. Do NOT call from a
 * normal write path; the fence is split-brain prevention, not
 * a retry primitive.
 */
export { claimWriter } from "@baerly/protocol";

/**
 * Re-export of {@link MPS3Error} and its discriminator type from
 * `@baerly/protocol`. Every failure thrown through this surface is
 * an `MPS3Error`; consumers branch on `error.code` (a
 * {@link MPS3ErrorCode}) rather than `instanceof` chains.
 */
export { MPS3Error, type MPS3ErrorCode } from "@baerly/protocol";

/**
 * Re-export of the locked predicate-AST `Table<T>` and `Query<T>`
 * interfaces from `@baerly/protocol`. These name the read/write
 * handles returned by `Db.table(...)`; consumers that destructure
 * the chain (`type T = Awaited<ReturnType<...>>`) need the named
 * types.
 */
export type { Table, Query } from "@baerly/protocol";
