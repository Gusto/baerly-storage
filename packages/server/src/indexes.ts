/**
 * Secondary index declarations: the runtime check on the
 * {@link IndexDefinition} shape, whose type lives in `@baerly/protocol`.
 *
 * A declaration changes no storage call and no read result. Reads and
 * insert uniqueness take membership from the snapshot plus the committed
 * log, and the writer maintains no index objects. Validation keeps the
 * declared names and shapes reserved for an index-aware format;
 * {@link validateIndexDefinition} runs at `Db.create` (`./config.ts`).
 *
 * Buckets written before 0.7 may hold inert marker objects under
 * `<collection>/index/`. Nothing reads, writes or reclaims them.
 */

import { BaerlyError, type IndexDefinition, validateWire } from "@baerly/protocol";
import { assertNameNotReserved } from "./names.ts";

export type { IndexDefinition };

/** Path-safe segment name. */
const INDEX_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Reject malformed {@link IndexDefinition} shapes synchronously, at
 * `Db.create`. See docs/adr/003-layout-versioning-cordon.md.
 *
 * @throws BaerlyError code="InvalidConfig" — reserved leading-`_` `name`,
 *   or an `on` field is a dotted path (only top-level fields are accepted).
 * @throws BaerlyError code="SchemaError" — `name` fails the regex, or `on` is empty.
 */
export const validateIndexDefinition = (def: IndexDefinition): void => {
  assertNameNotReserved(def.name, "index.name");
  if (!INDEX_NAME_RE.test(def.name)) {
    throw new BaerlyError(
      "SchemaError",
      `index.name must match /^[a-z][a-z0-9_]*$/; got ${JSON.stringify(def.name)}`,
    );
  }
  if (typeof def.on === "string") {
    if (def.on.length === 0) {
      throw new BaerlyError("SchemaError", `index ${def.name}.on must be non-empty`);
    }
  } else if (def.on.length === 0) {
    throw new BaerlyError("SchemaError", `index ${def.name}.on must be non-empty array`);
  }
  for (const field of typeof def.on === "string" ? [def.on] : def.on) {
    if (field.includes(".")) {
      throw new BaerlyError(
        "InvalidConfig",
        `index ${def.name}.on must name top-level fields; dotted paths are not supported (got ${JSON.stringify(field)})`,
      );
    }
  }
  if (def.predicate !== undefined) {
    try {
      validateWire(def.predicate);
    } catch (error) {
      // Surface as SchemaError so the failure mode matches the rest
      // of validateIndexDefinition (a `Db.create`-time bail-out).
      if (error instanceof BaerlyError) {
        throw new BaerlyError(
          "SchemaError",
          `index ${def.name}.predicate is invalid: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
};
