/**
 * Failure plumbing shared by validators that report through a caller-bound
 * `fail` function, so each keeps its own message prefix while the check
 * itself exists once (`post-image-identity.ts`).
 */

/** Failure polarity of a codec check: caller ingress vs. stored data. */
export type CodecCode = "InvalidConfig" | "InvalidResponse";

/** Artifact-scoped failure constructor bound by each codec. */
export type CodecFail = (code: CodecCode, message: string, cause?: unknown) => never;
