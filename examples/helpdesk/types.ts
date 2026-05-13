import type { JSONArraylessObject } from "@baerly/protocol";

export interface Ticket extends JSONArraylessObject {
  readonly _id: string;
  readonly title: string;
  readonly status: "open" | "in_progress" | "closed";
  readonly assignee: string;
  readonly priority: "low" | "med" | "high";
  readonly created_at: string;
}

export const STATUSES = ["open", "in_progress", "closed"] as const satisfies ReadonlyArray<
  Ticket["status"]
>;

export const PRIORITIES = ["low", "med", "high"] as const satisfies ReadonlyArray<
  Ticket["priority"]
>;
