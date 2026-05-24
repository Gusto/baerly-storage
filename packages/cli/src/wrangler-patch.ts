/**
 * Surgical wrangler.jsonc helpers used by `baerly init` and
 * `baerly deploy`. All functions are pure (no I/O) — callers do
 * the file read/write. Built on `jsonc-parser` so comments and
 * trailing commas survive round-trips.
 */

import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
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

/**
 * Input spec for a single R2 binding to add or verify in
 * `wrangler.jsonc`. Mirrors `R2BindingDeclaration` in shape but
 * represents caller intent rather than a parsed declaration.
 */
export interface R2BindingSpec {
  readonly binding: string;
  readonly bucket_name: string;
}

/**
 * Flat string→string map of `vars` entries to merge into
 * `wrangler.jsonc`. Existing keys are never overwritten (user wins).
 */
export interface VarsSpec {
  readonly [key: string]: string;
}

/**
 * Result returned by `patchWranglerJsonc`. `text` is the updated
 * JSONC source; `changes` is a human-readable summary of what was
 * added (empty when the file was already up to date).
 */
export interface PatchResult {
  readonly text: string;
  readonly changes: readonly string[];
}

/**
 * Read the `name` field from a `wrangler.jsonc` source string.
 * Returns `undefined` on malformed JSONC or when the field is absent.
 * Never throws — designed for caller-friendly inspection.
 */
export const readWranglerName = (source: string): string | undefined => {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true }) as
    | { name?: unknown }
    | undefined;
  if (errors.length > 0 || typeof parsed?.name !== "string") {
    return undefined;
  }
  return parsed.name;
};

/**
 * Read the `main` field from a `wrangler.jsonc` source string.
 * Returns `undefined` on malformed JSONC or when the field is absent.
 * Never throws — designed for caller-friendly inspection.
 */
export const readWranglerMain = (source: string): string | undefined => {
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true }) as
    | { main?: unknown }
    | undefined;
  if (errors.length > 0 || typeof parsed?.main !== "string") {
    return undefined;
  }
  return parsed.main;
};

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: "\n" } as const;

/**
 * Idempotently patch a `wrangler.jsonc` source string:
 *
 * - Appends an R2 binding to `r2_buckets[]` unless an entry with
 *   the same `binding` name already exists (user wins).
 * - Merges `vars` keys, skipping any key already present (user wins).
 *
 * Comments and trailing commas are preserved by `jsonc-parser`.
 *
 * @throws BaerlyError code="InvalidConfig" — malformed JSONC or
 *   invalid `r2_buckets` / `vars` shape.
 */
export const patchWranglerJsonc = (
  source: string,
  binding: R2BindingSpec,
  vars: VarsSpec,
): PatchResult => {
  const existingBindings = parseR2Bindings(source);

  const errors: ParseError[] = [];
  const entry = parse(source, errors, { allowTrailingComma: true }) as
    | { vars?: unknown }
    | undefined;

  const rawVars = entry?.vars;
  if (rawVars !== undefined) {
    if (typeof rawVars !== "object" || rawVars === null || Array.isArray(rawVars)) {
      throw new BaerlyError("InvalidConfig", "wrangler.jsonc: vars must be an object");
    }
  }
  const existingVars = (rawVars ?? {}) as Record<string, unknown>;

  const changes: string[] = [];
  let text = source;

  const bindingAlreadyDeclared = existingBindings.some((b) => b.binding === binding.binding);
  if (!bindingAlreadyDeclared) {
    const edits = modify(text, ["r2_buckets", -1], binding, {
      formattingOptions: FORMATTING_OPTIONS,
    });
    text = applyEdits(text, edits);
    changes.push(`added r2 binding ${binding.binding} → ${binding.bucket_name}`);
  }

  const addedVarKeys: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in existingVars)) {
      const edits = modify(text, ["vars", key], value, { formattingOptions: FORMATTING_OPTIONS });
      text = applyEdits(text, edits);
      addedVarKeys.push(key);
    }
  }
  if (addedVarKeys.length > 0) {
    changes.push(`merged vars: ${addedVarKeys.join(", ")}`);
  }

  return { text, changes };
};
