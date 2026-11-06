import type { BaerlyErrorCode } from "./errors.ts";

/** Canonical per-code corrective action; `errorEnvelope` falls back to this and it crosses the wire as `resolution`. Actionable codes only. One canonical action per actionable code; a throw site may pass a more specific resolution (CLI `restore`), never a different retry meaning. */
export const CODE_RESOLUTIONS: Partial<Record<BaerlyErrorCode, string>> = {
  WriteConflict:
    "Another write changed this data first and this commit did not land. Re-read, then retry.",
  AlreadyExists:
    "Do not retry. A row with this _id is already committed: insert with a different _id or omit _id to auto-generate one, or use update or replace to change the existing row; after an AmbiguousCommit retry, re-read that row instead.",
  AmbiguousCommit:
    "Do not retry automatically. Re-read the row named by the error's _id; absence does not prove the write failed. A deliberate retry may repeat logical work; retry an insert with the same _id, and treat AlreadyExists on that retry as a committed row to re-read.",
  CapacityExceeded:
    "Do not retry unchanged. Delete or shrink rows to make room; if every write is refused, the collection has outgrown this host: export it with baerly admin dump, or move it to a larger host.",
  MaintenancePending:
    "Retry after the delay in retryAfter (Retry-After header, seconds): maintenance is catching up on this collection and this write was not committed.",
  PayloadTooLarge: "Reduce the request body below the server's body-size cap (1 MiB default).",
  Unauthorized: "Send a valid Authorization header for the server's configured auth method.",
  AccessDenied: "These credentials are denied for this tenant prefix or bucket policy.",
  NotFound: "No row matches this id; create it first or treat this as a miss.",
};

/** Resolution for a malformed `?where=` / `?order=` query value. */
export const WHERE_ORDER_JSON_RESOLUTION: string =
  "Pass a URL-encoded JSON object as the ?where= / ?order= value.";

/** Resolution for an empty / malformed / unwrapped write body. */
export const WRITE_BODY_SHAPE_RESOLUTION: string =
  'Send a JSON body shaped { "doc": { ... } } for POST/PUT, or { "patch": { ... } } for PATCH.';
