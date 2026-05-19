export { createBaerlyClient } from "./client.ts";
export type {
  BaerlyClient,
  BaerlyClientOptions,
  ClientQuery,
  ClientTable,
  TerminalOptions,
} from "./client.ts";
export { BaerlyClientError } from "./errors.ts";
export type { Fetcher } from "./request.ts";
export type {
  BaerlyErrorCode,
  ConsistencyLevel,
  DocumentData,
  LogEntry,
  OrderSpec,
  Predicate,
} from "@baerly/protocol";
