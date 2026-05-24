/**
 * Surgical wrangler.jsonc helpers used by `baerly init` and
 * `baerly deploy`. All functions are pure (no I/O) — callers do
 * the file read/write. Built on `jsonc-parser` so comments and
 * trailing commas survive round-trips.
 */

import { parse, type ParseError } from "jsonc-parser";
import { BaerlyError } from "@baerly/protocol";

/**
 * Declared R2 binding extracted from a `wrangler.jsonc` source.
 * Subset of the wrangler schema — we only consume `binding` and
 * `bucket_name`, not the optional preview/jurisdiction fields.
 */
export interface R2BindingDeclaration {
  readonly binding: string;
  readonly bucket_name: string;
}

/**
 * Parse declared `r2_buckets[]` from a `wrangler.jsonc` source
 * string. Tolerates comments + trailing commas via `jsonc-parser`.
 *
 * @throws BaerlyError code="InvalidConfig" — malformed JSONC or
 *   invalid `r2_buckets` shape.
 */
export const parseR2Bindings = (source: string): readonly R2BindingDeclaration[] => {
  const errors: ParseError[] = [];
  const obj = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as
    | { r2_buckets?: unknown }
    | undefined;
  if (errors.length > 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `wrangler.jsonc parse error at offset ${errors[0]!.offset}: ${errors[0]!.error}`,
    );
  }
  if (obj === undefined || typeof obj !== "object") {
    throw new BaerlyError("InvalidConfig", `wrangler.jsonc did not parse to an object`);
  }
  const buckets = obj.r2_buckets;
  if (buckets === undefined) {
    return [];
  }
  if (!Array.isArray(buckets)) {
    throw new BaerlyError("InvalidConfig", `wrangler.jsonc: r2_buckets must be an array`);
  }
  const out: R2BindingDeclaration[] = [];
  for (const b of buckets) {
    if (b === null || typeof b !== "object") {
      throw new BaerlyError("InvalidConfig", `wrangler.jsonc: r2_buckets entry must be an object`);
    }
    const entry = b as { binding?: unknown; bucket_name?: unknown };
    if (typeof entry.binding !== "string" || entry.binding.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `wrangler.jsonc: r2_buckets[].binding must be a non-empty string`,
      );
    }
    if (typeof entry.bucket_name !== "string" || entry.bucket_name.length === 0) {
      throw new BaerlyError(
        "InvalidConfig",
        `wrangler.jsonc: r2_buckets[].bucket_name must be a non-empty string`,
      );
    }
    out.push({ binding: entry.binding, bucket_name: entry.bucket_name });
  }
  return out;
};
