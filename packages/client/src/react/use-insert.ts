import { useCallback } from "react";
import type { JSONArraylessObject } from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { useMutation, type UseMutationResult } from "./use-mutation.ts";

export interface UseInsertOptions {
  /** Table to insert into. */
  readonly table: string;
}

export type UseInsertResult<T extends JSONArraylessObject> = UseMutationResult<
  [doc: Partial<T> & JSONArraylessObject],
  { readonly _id: string }
>;

/**
 * Mutation hook for `client.table(...).insert(doc)`.
 *
 * - `mutate(doc)` issues `POST /v1/t/:table` and resolves with the
 *   server-assigned `{ _id }`.
 * - `isPending` is `true` while a call is in flight.
 * - `error` is the last rejection, surfaced on the next render. Call
 *   `reset()` to clear it without firing a new call.
 * - Calling `mutate` again before the previous call resolves aborts
 *   the previous request. Unmount also aborts the in-flight call.
 *
 * @example
 * ```tsx
 * const { mutate: addTicket, isPending, error } = useInsert<Ticket>({ table: "tickets" });
 *
 * return (
 *   <form onSubmit={async (e) => {
 *     e.preventDefault();
 *     await addTicket({ title, status, priority, assignee });
 *     onDone();
 *   }}>
 *     <button disabled={isPending}>{isPending ? "Saving…" : "Save"}</button>
 *     {error && <p style={{ color: "crimson" }}>{error.message}</p>}
 *   </form>
 * );
 * ```
 */
export const useInsert = <T extends JSONArraylessObject = JSONArraylessObject>(
  opts: UseInsertOptions,
): UseInsertResult<T> => {
  const { table } = opts;
  const client = useBaerlyClient();
  return useMutation(
    useCallback(
      (signal, doc: Partial<T> & JSONArraylessObject) =>
        client.table<T>(table).insert(doc, { signal }),
      [client, table],
    ),
  );
};
