// The Ticket interface shared by every web component. Mirrors the
// shape `seed.ts` writes; eventually generated from
// `baerly.config.ts` by ticket 38, but inlined here so the example
// is self-contained.
import type { JSONArraylessObject } from "@baerly/protocol";

export interface Ticket extends JSONArraylessObject {
  readonly _id: string;
  readonly title: string;
  readonly status: "open" | "in_progress" | "closed";
  readonly assignee: string;
  readonly priority: "low" | "med" | "high";
  readonly created_at: string;
}
