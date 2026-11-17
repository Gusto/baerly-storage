export { createBaerlyClient } from "./client.ts";
export type {
  BaerlyClient,
  BaerlyClientOptions,
  ClientQuery,
  ClientCollection,
  TerminalOptions,
} from "./client.ts";
export type { BaerlyWarning, Fetcher } from "./request.ts";
export { BaerlyError } from "@baerly/protocol";
export type {
  BaerlyErrorCode,
  BaerlyErrorOptions,
  DocumentData,
  LogEntry,
  MergePatch,
  OrderSpec,
  Predicate,
  PredicateArg,
} from "@baerly/protocol";
