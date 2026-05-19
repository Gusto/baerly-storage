import { useCallback } from "react";
import type { JSONArraylessObject, Predicate } from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { useMutation, type UseMutationResult } from "./use-mutation.ts";

export interface UseUpdateOptions {
  /** Table to update in. */
  readonly table: string;
}

export type UseUpdateResult<T extends JSONArraylessObject> = UseMutationResult<
  [id: string, patch: Partial<T>],
  { readonly modified: number }
>;

/**
 * Mutation hook for `client.table(...).where({ _id }).update(patch)`.
 * Issues `PATCH /v1/t/:table/:id` with JSON-merge-patch semantics —
 * keys present in `patch` are set, keys explicitly set to `null` are
 * deleted, omitted keys are left unchanged.
 *
 * The day-one HTTP constraint is single-row update by `_id`; the
 * hook mirrors it (`mutate(id, patch)`). When the server grows a
 * multi-row PATCH route, the signature will widen — until then,
 * passing anything but a row id will throw `BaerlyClientError`.
 *
 * @example
 * ```tsx
 * const { mutate: updateStatus, isPending } = useUpdate<Ticket>({ table: "tickets" });
 *
 * <button
 *   disabled={isPending}
 *   onClick={() => void updateStatus(ticket._id, { status: "closed" })}
 * >
 *   Close ticket
 * </button>
 * ```
 */
export const useUpdate = <T extends JSONArraylessObject = JSONArraylessObject>(
  opts: UseUpdateOptions,
): UseUpdateResult<T> => {
  const { table } = opts;
  const client = useBaerlyClient();
  return useMutation(
    useCallback(
      (signal, id: string, patch: Partial<T>) =>
        client
          .table<T>(table)
          .where({ _id: id } as Predicate<T>)
          .update(patch, { signal }),
      [client, table],
    ),
  );
};
