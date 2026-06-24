import type { BaerlyErrorCode } from "./errors.ts";

/** Canonical per-code corrective action; `errorEnvelope` falls back to this and it crosses the wire as `resolution`. Actionable codes only — context-sensitive codes use throw-site overrides. */
export const CODE_RESOLUTIONS: Partial<Record<BaerlyErrorCode, string>> = {
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
