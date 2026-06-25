export { deepEqualDocumentValue } from "./_internals.ts";
export {
  type PredicateArg,
  type PredicateBuilder,
  makeBuilder,
  wireFromBuilder,
} from "./builder.ts";
export { matchesWire } from "./matches.ts";
export { mergePredicateWires } from "./merge.ts";
export { normalizeObject, normalizePredicateArg } from "./normalize.ts";
export { validateWire } from "./validate.ts";
export {
  EMPTY_PREDICATE_WIRE,
  PREDICATE_OPS,
  type PredicateClause,
  type PredicateOpName,
  type PredicateWire,
} from "./wire.ts";
