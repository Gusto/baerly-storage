import { useCallback } from "react";
import type { DocumentData } from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { useMutation, type UseMutationResult } from "./use-mutation.ts";

export interface UseUpdateOptions {
  /** Table to update in. */
  readonly table: string;
}

export type UseUpdateResult<T extends DocumentData> = UseMutationResult<
  [id: string, patch: Partial<T>],
  { readonly modified: number }
>;

/**
 * Mutation hook for `client.table(...).update(id, patch)`. Issues
 * `PATCH /v1/t/:table/:id` with JSON-merge-patch semantics — keys
 * present in `patch` are set, keys explicitly set to `null` are
 * deleted, omitted keys are left unchanged.
 *
 * Single-row update by `_id`; the hook signature is `mutate(id, patch)`
 * and mirrors {@link ClientTable.update}.
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
export const useUpdate = <T extends DocumentData = DocumentData>(
  opts: UseUpdateOptions,
): UseUpdateResult<T> => {
  const { table } = opts;
  const client = useBaerlyClient();
  return useMutation(
    useCallback(
      (signal, id: string, patch: Partial<T>) =>
        client.table<T>(table).update(id, patch, { signal }),
      [client, table],
    ),
  );
};
